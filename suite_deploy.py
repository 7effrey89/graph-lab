"""Provision the fictional Graph Lab corpus using native Azure and Microsoft tooling."""

import ipaddress
from email.utils import formatdate
import json
import os
from pathlib import Path
import re
import socket
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import lab


STORAGE_API = "2024-01-01"
NSP_API = "2025-01-01"
EMBEDDING = "text-embedding-3-large"
DIMENSIONS = 1536
TOPIC_THEMES = {
    "Search quality": (
        "Review search relevance with a labeled set of representative queries.",
        "Measure citation coverage across multiple types of source documents.",
        "Compare semantic ranking and vector relevance on ambiguous questions.",
        "Improve search recall by testing terminology and synonym variants.",
        "Audit retrieval evidence against the text of the original documents.",
        "Evaluate topic-aware sampling for broad research questions.",
    ),
    "Warehouse migration": (
        "Reconcile row counts after moving fact tables to the warehouse.",
        "Schedule warehouse cutover after validating incremental data loads.",
        "Check historical date keys for gaps before migrating finance reports.",
        "Compare query latency for the old and new warehouse tables.",
        "Run the daily ingestion pipeline against a staging warehouse.",
        "Document rollback steps for failed schema changes during cutover.",
    ),
    "Identity governance": (
        "Review role assignments for the managed identity on the storage account.",
        "Replace application secrets with short-lived Microsoft Entra tokens.",
        "Keep upload permissions scoped to the individual blob container.",
        "Require explicit approval before granting account-wide Blob Reader.",
        "Check the network security perimeter access logs for denied calls.",
        "Verify that local authentication and anonymous Blob access stay disabled.",
    ),
    "Service reliability": (
        "Add an alert for increased service latency during business hours.",
        "Track failed requests and timeouts in the operational dashboard.",
        "Confirm the on-call engineer can access the incident playbook.",
        "Run an incident drill to verify escalation and recovery timelines.",
        "Measure service availability after applying a rolling deployment.",
        "Document a recovery procedure for missing signals in Azure Monitor.",
    ),
}


def public_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ipaddress.AddressValueError, TypeError) as exc:
        raise ValueError("Enter one public IPv4 address, not a CIDR or range.") from exc
    if not address.is_global or address.is_multicast or not isinstance(value, str):
        raise ValueError("Enter one public IPv4 address, not a CIDR or range.")
    return str(address)


def prepare_request(data):
    storage = data.get("storage")
    if not isinstance(storage, str) or not re.fullmatch(
        r"/subscriptions/[a-f0-9-]{36}/resourceGroups/[\w.()-]{1,90}/providers/"
        r"Microsoft\.Storage/storageAccounts/[a-z0-9]{3,24}", storage, re.I
    ):
        raise ValueError("Enter the full Azure resource ID of the approved Blob account.")
    suite = {"storage": storage, "clientIp": public_ipv4(data.get("clientIp"))}
    suite["deploy_remaining"] = lambda *args: deploy_remaining(suite, *args)
    return suite


def builder_path():
    override = os.getenv("GRAPH_TOPICGRAPH_EXE")
    bundled = lab.HERE.parent / "official-iq-plugin" / "native-arm64" / "topicgraph.exe"
    executable = Path(override) if override else bundled
    if not executable.is_file():
        raise ValueError("Install Microsoft's Topic Graph build tool and set GRAPH_TOPICGRAPH_EXE to its executable.")
    if not override and lab.sha256(executable.read_bytes()).hexdigest() != (
        "d3a2eb8c4f6a864acf46eee08e7892eee77714c33b31d0c26ae87b2e043ec72a"
    ):
        raise ValueError("The bundled Topic Graph executable failed its SHA-256 integrity check.")
    return executable.resolve()


def exclusive_profile(storage):
    configs = lab.arm("GET", storage + "/networkSecurityPerimeterConfigurations", STORAGE_API)["value"]
    if len(configs) != 1:
        raise ValueError("The Blob account must be associated with exactly one approved Storage NSP.")
    props = configs[0]["properties"]
    if props.get("provisioningState") != "Succeeded" or props.get("provisioningIssues"):
        raise ValueError("The Blob account's NSP configuration is not healthy.")
    perimeter = props["networkSecurityPerimeter"]["id"]
    profile = perimeter + "/profiles/" + props["profile"]["name"]
    if not re.fullmatch(r"/subscriptions/[a-f0-9-]{36}/resourceGroups/[\w.()-]+/providers/"
                        r"Microsoft\.Network/networkSecurityPerimeters/[\w.-]+/profiles/[\w.-]+", profile, re.I):
        raise ValueError("Unexpected Storage NSP profile ID.")
    associations = lab.arm("GET", perimeter + "/resourceAssociations", NSP_API)
    if associations.get("nextLink"):
        raise ValueError("Cannot verify that the Storage NSP profile is dedicated to this account.")
    members = [item["properties"]["privateLinkResource"]["id"].casefold()
               for item in associations["value"]
               if item["properties"]["profile"]["id"].casefold() == profile.casefold()]
    if members != [storage.casefold()]:
        raise ValueError("The Storage NSP profile is shared. Use a dedicated approved profile; no rules were changed.")
    return profile


def preflight(suite):
    suite["builder"] = builder_path()
    storage = suite["storage"]
    account = lab.arm("GET", storage, STORAGE_API)
    properties = account["properties"]
    if (account.get("kind") != "StorageV2" or properties.get("isHnsEnabled")
            or properties.get("allowSharedKeyAccess") is not False
            or properties.get("allowBlobPublicAccess") is not False):
        raise ValueError("Use a non-HNS StorageV2 account with shared keys and anonymous Blob access disabled.")
    blob = lab.arm("GET", storage + "/blobServices/default", STORAGE_API)["properties"]
    if not blob.get("deleteRetentionPolicy", {}).get("enabled") or blob.get("isVersioningEnabled"):
        raise ValueError("The Blob account must have native Blob soft delete enabled and versioning disabled.")
    suite["profile"] = exclusive_profile(storage)
    suite["account"] = account["name"]
    suite["embedding"] = lab.foundry_model(EMBEDDING)["azureOpenAIParameters"]
    deployment = lab.arm("GET", lab.azure_config()["modelScope"] + f"/deployments/{EMBEDDING}", "2024-10-01")
    if (deployment["properties"].get("provisioningState") != "Succeeded"
            or deployment["properties"].get("model", {}).get("name") != EMBEDDING):
        raise ValueError(f"The configured Foundry account needs a ready {EMBEDDING} deployment.")


def ensure_rule(profile, resource_name, search_ip):
    path = f"{profile}/accessRules/{resource_name}-inbound"
    properties = {"direction": "Inbound", "addressPrefixes": [f"{search_ip}/32"]}
    try:
        existing = lab.arm("GET", path, NSP_API)
    except lab.AzureError as exc:
        if exc.status != 404:
            raise
        lab.arm("PUT", path, NSP_API, {"properties": properties}, create=True)
    else:
        old = existing["properties"]
        if any(old.get(key) != value for key, value in properties.items()):
            raise ValueError("The deployment's NSP rule does not match the current Search IP. Review it before retrying.")
    return resource_name + "-inbound"


def upload(endpoint, index, docs):
    for offset in range(0, len(docs), 100):
        batch = docs[offset:offset + 100]
        result = lab.request("POST", lab.object_url("indexes", index) + "/docs/index", {
            "value": [{"@search.action": "upload", **doc} for doc in batch],
        }, endpoint=endpoint)["value"]
        if len(result) != len(batch) or any(row.get("status") is not True for row in result):
            raise ValueError(f"Azure did not index every document in {index}.")


def create_index(endpoint, name, definition):
    path = lab.object_url("indexes", name)
    try:
        lab.request("PUT", path, {**definition, "name": name}, create=True, endpoint=endpoint)
    except lab.AzureError as exc:
        if exc.status not in (409, 412):
            raise
        found = lab.request("GET", path, endpoint=endpoint)
        if {(f["name"], f["type"]) for f in found["fields"]} != {
            (f["name"], f["type"]) for f in definition["fields"]
        }:
            raise ValueError(f"Existing index {name} has a different schema.")
    return path


def deploy_topic(suite, endpoint):
    source, _ = lab.names("topic")
    content = source.removesuffix("-ks") + "-demo-content"
    graph = source.removesuffix("-ks") + "-demo-graph"
    model = suite["embedding"]
    lab.setup_status(phase="topic-indexes", message="Creating the Topic Graph content index and embedding fictional documents…")
    definition = {"fields": [
        {"name": name, "type": "Edm.String", "retrievable": True, **properties}
        for name, properties in (("id", {"key": True, "filterable": True}),
                                 ("title", {"searchable": True}), ("content", {"searchable": True}))
    ] + [{"name": "embedding", "type": "Collection(Edm.Single)", "dimensions": DIMENSIONS,
          "searchable": True, "retrievable": True, "stored": True, "vectorSearchProfile": "content-profile"}],
        "vectorSearch": {
            "algorithms": [{"name": "hnsw", "kind": "hnsw", "hnswParameters": {"metric": "cosine"}}],
            "profiles": [{"name": "content-profile", "algorithm": "hnsw", "vectorizer": "entra-embedding"}],
            "vectorizers": [{"name": "entra-embedding", "kind": "azureOpenAI", "azureOpenAIParameters": model}],
        }}
    path = create_index(endpoint, content, definition)
    docs = [{"id": f"fixture-{i}-{j}", "title": title, "content": text}
            for i, (title, texts) in enumerate(TOPIC_THEMES.items()) for j, text in enumerate(texts)]
    url = f"{model['resourceUri']}/openai/deployments/{EMBEDDING}/embeddings?api-version=2024-10-21"
    embedding = lab.wait_for(lambda: lab.azure_request(
        "Foundry embeddings", "https://cognitiveservices.azure.com", url, "POST",
        {"input": [doc["content"] for doc in docs], "dimensions": DIMENSIONS}))
    vectors = {item["index"]: item["embedding"] for item in embedding["data"]}
    if set(vectors) != set(range(len(docs))) or any(len(v) != DIMENSIONS for v in vectors.values()):
        raise ValueError("Foundry returned an incomplete embedding batch.")
    upload(endpoint, content, [{**doc, "embedding": vectors[i]} for i, doc in enumerate(docs)])

    def visible():
        result = lab.request("GET", path + "/docs/$count", endpoint=endpoint)
        return True if result == len(docs) else None

    lab.wait_for(visible, timeout=180)
    lab.setup_status(message="Building and publishing the topic index with Microsoft's Topic Graph tool…")
    with TemporaryDirectory(prefix="graph-lab-topic-") as directory:
        build = Path(directory) / "topicGraph"
        task = subprocess.run([str(suite["builder"]), "build", "--fresh", "--endpoint", endpoint,
                               "--index", content, "--vector-field", "embedding",
                               "--text-field", "content", "--title-field", "title", "--doc-id-field", "id",
                               "--build-dir", str(build), "--ontology-dir", str(build / "releases"),
                               "--auth", "azureCli", "--minimum-sample-count", str(len(docs)),
                               "--view-ks", "3,5,8,12", "--max-leaf-size", "8"],
                              capture_output=True, text=True, timeout=360)
        if task.returncode:
            raise ValueError(f"Microsoft Topic Graph builder failed ({task.returncode}): "
                             f"{(task.stderr or task.stdout).strip()[-550:]}")
        manifest = json.loads((build / "run-manifest.json").read_text(encoding="utf-8-sig"))
        release = manifest["latestRelease"]
        if not re.fullmatch(r"[a-f0-9]{12}", release):
            raise ValueError("The Topic Graph builder did not produce a valid release.")
        artifacts = build / "releases"
        schema = json.loads((artifacts / f"{release}.schema.json").read_text(encoding="utf-8-sig"))
        graph_docs = [json.loads(line) for line in
                      (artifacts / f"{release}.documents.jsonl").read_text(encoding="utf-8-sig").splitlines()
                      if line.strip()]
        if not graph_docs:
            raise ValueError("The Topic Graph builder produced no graph documents.")
        create_index(endpoint, graph, schema)
        upload(endpoint, graph, graph_docs)
    definition["fields"][-1]["topicGraphProfile"] = "native-topics"
    definition["vectorSearch"]["topicGraphProfiles"] = [{
        "name": "native-topics", "indexName": graph, "defaultKind": "balanced",
        "defaultMinDiversityPoolSize": 1000,
    }]
    lab.request("PUT", path, {**definition, "name": content}, endpoint=endpoint)
    lab.setup_status(phase="topic-retrieval", message="Attaching the Topic Graph knowledge source to its knowledge base and verifying retrieval…")
    lab.provision(SimpleNamespace(mode="topic", content_index=content, content="content",
                                  vector="embedding", confirm=True), endpoint=endpoint, resume=True)

    def verify():
        response = lab.request("POST", path + "/docs/search", {
            "vectorQueries": [{"kind": "text", "text": "search relevance and evidence", "fields": "embedding", "k": 6,
                               "topicGraph": {"kind": "diverse"}}], "top": 6,
        }, endpoint=endpoint)
        return True if response.get("value") else None

    lab.wait_for(verify, timeout=180, retry_statuses=(400, 403, 404, 429, 502, 503))


def upload_probe(account, container):
    root = f"https://{account}.blob.core.windows.net"
    url = f"{root}/{container}/graph-lab-fictional.txt"
    headers = {"Authorization": f"Bearer {lab.azure_token('https://storage.azure.com/')}",
               "x-ms-version": "2023-11-03", "x-ms-date": formatdate(usegmt=True),
               "x-ms-blob-type": "BlockBlob",
               "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8"}
    text = "\n".join(f"{title}: {text}" for title, _, text in lab.SYNTHETIC)
    req = lab.Request(url, data=text.encode("utf-8"), headers=headers, method="PUT")
    try:
        with lab.build_opener(lab.NoRedirect).open(req, timeout=60):
            return True
    except lab.HTTPError as exc:
        code = exc.headers.get("x-ms-error-code")
        if (exc.code, code) == (412, "ConditionNotMet"):
            return True
        raise lab.AzureError("Azure Blob Storage", exc.code, code or exc.reason) from exc
    except (lab.URLError, TimeoutError) as exc:
        raise ValueError(f"Could not reach the approved Blob endpoint: {exc}") from exc


def deploy_remaining(suite, endpoint, search_scope, search_principal, principal, role):
    name = search_scope.rsplit("/", 1)[-1]
    container = name + "-entity"
    storage = suite["storage"]
    container_scope = storage + f"/blobServices/default/containers/{container}"
    lab.setup_status(phase="storage", message="Configuring the Storage NSP and creating a private fictional-data container…")
    profile = exclusive_profile(storage)
    if profile != suite["profile"]:
        raise ValueError("The Storage NSP profile changed during deployment; no rule was written.")
    addresses = {entry[4][0] for entry in socket.getaddrinfo(
        lab.urlsplit(endpoint).hostname, 443, socket.AF_INET, socket.SOCK_STREAM)}
    if len(addresses) != 1:
        raise ValueError("Search must resolve to one public IPv4 address for a narrowly scoped NSP rule.")
    ip = public_ipv4(addresses.pop())
    rule_name = ensure_rule(profile, name, ip)
    lab.setup_status(container=container, storageProfile=profile, perimeterRule=rule_name)

    def active_rule():
        result = lab.arm("GET", storage + "/networkSecurityPerimeterConfigurations", STORAGE_API)
        for entry in result["value"]:
            props = entry["properties"]
            if props.get("provisioningState") == "Succeeded" and not props.get("provisioningIssues"):
                for rule in props["profile"].get("accessRules", []):
                    if rule.get("name") == rule_name and f"{ip}/32" in rule.get("properties", {}).get("addressPrefixes", []):
                        return True
        return None

    lab.wait_for(active_rule)
    try:
        blob = lab.arm("GET", container_scope, STORAGE_API)
    except lab.AzureError as exc:
        if exc.status != 404:
            raise
        lab.arm("PUT", container_scope, STORAGE_API, {"properties": {"publicAccess": "None", "metadata": {
            "graphlabowner": name}}}, create=True)
    else:
        props = blob["properties"]
        if props.get("metadata", {}).get("graphlabowner") != name or props.get("publicAccess", "None") != "None":
            raise ValueError("Existing staging container is not the private container owned by this deployment.")
    role(storage, search_principal, "ServicePrincipal", "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1")
    role(container_scope, principal, "User", "ba92f5b4-2d11-453d-a403-e96b0029c9fe")
    lab.wait_for(lambda: upload_probe(suite["account"], container))

    lab.setup_status(phase="entity", message="Creating the managed Entity Graph and waiting for native extraction…")
    def provision_entity():
        lab.provision(SimpleNamespace(mode="entity", storage_id=storage, container=container, chat=None,
                                      chat_model=None, embedding=EMBEDDING, embedding_model=None,
                                      confirm=True), endpoint=endpoint, resume=True)
        return True

    lab.wait_for(provision_entity)
    source, _ = lab.names("entity")
    path = lab.object_url("knowledgesources", source)

    def verify_entity():
        status = lab.request("GET", path + "/status", endpoint=endpoint)
        last = status.get("lastSynchronizationState") or {}
        if last.get("itemsUpdatesFailed", 0):
            raise ValueError("Entity Graph sync reported failed items; inspect Azure status.")
        if not last.get("itemsUpdatesProcessed"):
            return None
        definition = lab.request("GET", path, endpoint=endpoint)
        graph = definition["azureBlobParameters"]["createdResources"]["graphIndex"]
        result = lab.request("POST", lab.object_url("indexes", graph) + "/docs/search.graph", {
            "gql": lab.GQL, "includeStatistics": True,
            "provenance": {"kind": "hydrate", "maxEvidencePerRow": 3,
                           "hydrateDocuments": {"select": "uid,snippet,blob_url"}},
        }, endpoint=endpoint)
        return True if any(row.get("@search.graphProvenance", {}).get("evidence")
                           for row in result.get("value", [])) else None

    lab.wait_for(verify_entity)
    deploy_topic(suite, endpoint)
