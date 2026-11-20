"""Fixed Foundry IQ operations for the Topic Graph API console."""

from inspect import getsource
import json
from pathlib import Path
from pprint import pformat
import re
import struct
from time import perf_counter

import lab


QUESTION = "What are the main themes across these meetings?"
ENTITY_OPERATIONS = {"source", "status", "natural", "gql"}
ENTITY_SELECT = "uid,snippet,snippet_parent_id,blob_url"


def topic_memberships(snapshot, chunks):
    """Decode the builder's TGLM v3 leaf-to-graph-ordinal map."""
    data = memoryview(snapshot)
    if len(data) < 12 or data[:4] != b"TGLM":
        raise ValueError("Invalid Topic Graph membership artifact.")
    version, leaf_count = struct.unpack_from("<II", data, 4)
    if version != 3 or leaf_count > (len(data) - 12) // 8:
        raise ValueError("Unsupported Topic Graph membership format.")
    keys = dict(zip(chunks["ordinals"], chunks["keys"], strict=True))
    offset = 12
    result, seen = {}, set()
    for _ in range(leaf_count):
        if offset + 8 > len(data):
            raise ValueError("Truncated Topic Graph membership artifact.")
        topic, count = struct.unpack_from("<II", data, offset)
        offset += 8
        if topic in result or count > (len(data) - offset) // 4:
            raise ValueError("Invalid Topic Graph membership entry.")
        ordinals = struct.unpack_from(f"<{count}I", data, offset)
        offset += count * 4
        if len(set(ordinals)) != count or seen.intersection(ordinals) or not keys.keys() >= set(ordinals):
            raise ValueError("Invalid or repeated chunk ordinal in Topic Graph membership.")
        seen.update(ordinals)
        result[topic] = [keys[ordinal] for ordinal in ordinals]
    if offset != len(data) or seen != keys.keys():
        raise ValueError("Topic Graph membership does not cover the build's chunk keys.")
    return result


def topic_linkage():
    build = Path(lab.os.getenv("GRAPH_TOPIC_BUILD_DIR") or
                 lab.HERE.parent / "official-iq-plugin" / "notes-build")
    if not (build / "run-manifest.json").is_file():
        raise ValueError("Builder membership files are unavailable. Set GRAPH_TOPIC_BUILD_DIR to the build folder for this published graph.")

    def read(path):
        return json.loads(path.read_text(encoding="utf-8-sig"))

    manifest = read(build / "run-manifest.json")
    release_id = manifest["latestRelease"]
    release = next((r for r in manifest["releases"] if r["id"] == release_id), {})
    structure_id = release.get("structureId", "")
    if not re.fullmatch(r"[a-f0-9]{12}", release_id) or not re.fullmatch(r"[a-f0-9]{64}", structure_id):
        raise ValueError("The Topic Graph build has no supported exported release.")
    structure = build / "step-06-structures" / structure_id
    source = read(structure / "context.json")["source"]
    endpoint = lab.search_endpoint().rstrip("/")
    if source["endpoint"].rstrip("/") != endpoint:
        raise ValueError("The builder files belong to a different Search service.")
    content, vector, key = source["indexName"], source["vectorField"], source["keyField"]
    schema = lab.request("GET", lab.object_url("indexes", content), endpoint=endpoint)
    profile_name = next((f.get("topicGraphProfile") for f in schema["fields"] if f["name"] == vector), None)
    profile = next((p for p in (schema.get("vectorSearch", {}).get("topicGraphProfiles") or [])
                    if p["name"] == profile_name), None)
    if not profile:
        raise ValueError("The build's content index has no linked topic graph profile.")
    topic_index = profile["indexName"]
    lookup = lab.object_url("indexes", topic_index) + "/docs/search"
    fields = ("id", "predicate", "subject_id", "object_id", "subject_id_display_name", "object_id_display_name")
    path = build / "releases" / f"{release_id}.documents.jsonl"
    with path.open(encoding="utf-8-sig") as file:
        # Bound this demo view and reject partial release comparisons.
        from itertools import islice
        exported = [json.loads(line) for line in islice((line for line in file if line.strip()), 501)]
    if not 1 <= len(exported) <= 500:
        raise ValueError("The playground supports up to 500 records in a published topic release.")
    live = lab.request("POST", lookup, {"search": "*", "top": len(exported) + 1,
                                       "count": True, "select": ",".join(fields)}, endpoint=endpoint)
    rows = live["value"]
    def signatures(records):
        return {tuple(row.get(field) or "" for field in fields[:4]) for row in records}

    if live.get("@odata.count") != len(exported) or len(rows) != len(exported) or signatures(rows) != signatures(exported):
        raise ValueError("The builder release does not match the live companion topic index (TOPIC_INDEX_NAME).")
    members = topic_memberships((structure / "leaf-members.bin").read_bytes(), read(structure / "chunks.json"))
    hierarchy = read(structure / "hierarchy.json")["topics"]
    child_edges = {(row["subject_id"], row["object_id"]) for row in rows if row["predicate"] == "HasSubTopic"}
    if child_edges != {(f"topic:{t['parent']}", f"topic:{t['id']}") for t in hierarchy if t["parent"] is not None}:
        raise ValueError("The builder hierarchy does not match the live topic edges.")
    labels = {}
    for row in rows:
        for side in ("subject", "object"):
            identifier, label = row[f"{side}_id"], row.get(f"{side}_id_display_name")
            if identifier.startswith("topic:") and label and label != identifier:
                labels[identifier] = label
    return {"contentIndex": content, "topicIndex": topic_index, "vectorField": vector, "profile": profile_name,
            "keyField": key, "release": release_id,
            "topics": [{"id": t["id"], "parent": t["parent"], "count": t["memberCount"],
                        "label": labels.get(f"topic:{t['id']}", f"Topic {t['id']}"),
                        "chunks": members.get(t["id"], [])} for t in hierarchy]}


def entity_defaults():
    endpoint = lab.search_endpoint()
    source, base = lab.names("entity")
    chat = lab.foundry_model()["azureOpenAIParameters"]
    values = {"SEARCH_ENDPOINT": endpoint, "API_VERSION": lab.API, "KNOWLEDGE_SOURCE_NAME": source,
              "KNOWLEDGE_BASE_NAME": base, "GRAPH_INDEX_NAME": "", "CONTAINER_NAME": "",
              "STORAGE_RESOURCE_ID": lab.os.getenv("GRAPH_DEMO_STORAGE_ID", ""),
              "MODEL_ENDPOINT": chat["resourceUri"], "CHAT_DEPLOYMENT": chat["deploymentId"],
              "CHAT_MODEL": chat["modelName"], "EMBEDDING_DEPLOYMENT": "text-embedding-3-large",
              "QUESTION": "Which organizations use Azure AI Search? Include supporting evidence.",
              "GQL": ("MATCH (org:Organization)-[edge]->(product:Product) "
                      "WHERE edge.predicate = 'uses' AND product.name = 'Azure AI Search' "
                      "RETURN org.name AS organization, product.name AS product LIMIT 10")}
    result = {"variables": values, "ontology": {
        "python": f"RELATIONS = {pformat(lab.RELATIONS, width=100)}\n\n{getsource(lab.ontology)}",
        "jsonLd": lab.ontology(),
    }}
    try:
        params = lab.request("GET", lab.object_url("knowledgesources", source), endpoint=endpoint)["azureBlobParameters"]
        values["CONTAINER_NAME"] = params["containerName"]
        values["GRAPH_INDEX_NAME"] = (params.get("createdResources") or {}).get("graphIndex", "")
    except (ValueError, KeyError) as exc:
        return {**result, "warning": f"Could not load the active Entity Graph source: {exc}"}
    return {**result, "warning": "" if values["GRAPH_INDEX_NAME"] else
            "The source has not reported its managed graph index yet."}


def source_body(source, index, vector, content, pool, extra_fields=()):
    return {"name": source, "kind": "searchIndex", "resultsProcessing": "none",
            "searchIndexParameters": {
                "searchIndexName": index, "searchFields": [{"name": vector}],
                "sourceDataFields": [{"name": field} for field in (content, *extra_fields)],
                "topicGraph": {"kind": "balanced", "minDiversityPoolSize": pool},
            }}


def base_body(base, source):
    return {"name": base, "knowledgeSources": [{"name": source}],
            "retrievalReasoningEffort": {"kind": "minimal"}, "outputMode": "extractiveData"}


def vector_body(question, fields, select, strategy, top=8, override=None):
    vector = {"kind": "text", "text": question, "fields": fields, "k": top}
    if strategy != "balanced":
        vector["topicGraph"] = override or {"kind": strategy}
    return {"vectorQueries": [vector], "select": select, "top": top}


def defaults():
    endpoint = lab.search_endpoint()
    source, base = lab.names("topic")
    values = {"SEARCH_ENDPOINT": endpoint, "API_VERSION": lab.API, "KNOWLEDGE_SOURCE_NAME": source,
              "KNOWLEDGE_BASE_NAME": base, "CONTENT_INDEX_NAME": "", "TOPIC_INDEX_NAME": "",
              "VECTOR_FIELD_NAME": "embedding", "CONTENT_FIELD_NAME": "content",
              "QUESTION": QUESTION, "MIN_DIVERSITY_POOL_SIZE": "1000",
              "DIVERSITY_FACTOR": "0.1", "TOP": "8"}
    try:
        params = lab.request("GET", lab.object_url("knowledgesources", source),
                             endpoint=endpoint)["searchIndexParameters"]
        values["CONTENT_INDEX_NAME"] = params["searchIndexName"]
        values["VECTOR_FIELD_NAME"] = params["searchFields"][0]["name"]
        values["CONTENT_FIELD_NAME"] = params["sourceDataFields"][0]["name"]
        pool = (params.get("topicGraph") or {}).get("minDiversityPoolSize")
        if pool is not None:
            values["MIN_DIVERSITY_POOL_SIZE"] = str(pool)
        index = lab.request("GET", lab.object_url("indexes", values["CONTENT_INDEX_NAME"]), endpoint=endpoint)
        profile = next((f.get("topicGraphProfile") for f in index["fields"]
                        if f["name"] == values["VECTOR_FIELD_NAME"]), None)
        values["TOPIC_INDEX_NAME"] = next((p["indexName"] for p in index["vectorSearch"]["topicGraphProfiles"]
                                          if p["name"] == profile), "")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        return {"variables": values, "warning": f"Could not discover all Azure defaults: {exc}"}
    return {"variables": values, "warning": "" if values["TOPIC_INDEX_NAME"] else
            "No linked topic index was found. Check the content index's topicGraphProfile."}


def build_request(operation, values, *, entity=False):
    def field(name, pattern=None, limit=1600):
        value = values.get(name)
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit or (
            pattern and not re.fullmatch(pattern, value.strip())
        ):
            raise ValueError(f"Enter a valid {name}.")
        return value.strip()

    def number(name, low, high, parser):
        try:
            value = parser(field(name, limit=16))
        except ValueError as exc:
            raise ValueError(f"{name} must be between {low} and {high}.") from exc
        if not low <= value <= high:
            raise ValueError(f"{name} must be between {low} and {high}.")
        return value

    endpoint = field("SEARCH_ENDPOINT", r"https://[a-z0-9][a-z0-9-]{0,59}\.search\.windows\.net/?").rstrip("/")
    version = field("API_VERSION", r"\d{4}-\d{2}-\d{2}(-preview)?", 18)
    name_pattern = r"[a-z0-9][a-z0-9_-]{0,127}"
    field_pattern = r"[A-Za-z][A-Za-z0-9_]{0,127}"

    def name(key):
        return field(key, name_pattern)

    def obj(kind, key):
        return lab.object_url(kind, name(key))

    def pool():
        return number("MIN_DIVERSITY_POOL_SIZE", 250, 10000, int)

    def output_mode():
        mode = values.get("OUTPUT_MODE", "extractiveData")
        if mode not in ("extractiveData", "answerSynthesis"):
            raise ValueError("Select Extracted evidence or Synthesized answer.")
        return mode

    def override(kind):
        return ({"kind": kind, "diversityFactor": number("DIVERSITY_FACTOR", 0, 1, float),
                 "minDiversityPoolSize": pool()} if kind == "diverse" else {"kind": kind})

    reads = {"content": ("indexes", "CONTENT_INDEX_NAME"), "topics": ("indexes", "TOPIC_INDEX_NAME"),
             "source": ("knowledgesources", "KNOWLEDGE_SOURCE_NAME"),
             "base": ("knowledgebases", "KNOWLEDGE_BASE_NAME")}
    method, body = "GET", None
    if entity:
        if operation in ("source", "status"):
            path = obj("knowledgesources", "KNOWLEDGE_SOURCE_NAME") + ("/status" if operation == "status" else "")
        elif operation == "natural":
            method, path = "POST", obj("knowledgebases", "KNOWLEDGE_BASE_NAME") + "/retrieve"
            body = {"messages": [{"role": "user", "content": [{"type": "text", "text": field("QUESTION")}]}],
                    "includeActivity": True, "outputMode": output_mode(), "maxRuntimeInSeconds": 60,
                    "knowledgeSourceParams": [{"kind": "azureBlob", "knowledgeSourceName": name("KNOWLEDGE_SOURCE_NAME"),
                                               "includeReferences": True, "includeReferenceSourceData": True,
                                               "failOnError": True, "graphParameters": {"includeQuery": True,
                                               "provenance": {"kind": "hydrate",
                                                              "hydrateDocuments": {"select": ENTITY_SELECT, "top": 10}}}}]}
        elif operation == "gql":
            method, path = "POST", obj("indexes", "GRAPH_INDEX_NAME") + "/docs/search.graph"
            body = {"gql": field("GQL"), "includeStatistics": True, "includeDiagnostics": True,
                    "provenance": {"kind": "hydrate", "maxEvidencePerRow": 10,
                                   "hydrateDocuments": {"select": ENTITY_SELECT}}}
        else:
            raise ValueError("Select an Entity Graph tutorial operation.")
    elif operation in reads:
        path = obj(*reads[operation])
    elif operation == "create-source":
        method, path = "PUT", obj("knowledgesources", "KNOWLEDGE_SOURCE_NAME")
        body = source_body(name("KNOWLEDGE_SOURCE_NAME"), name("CONTENT_INDEX_NAME"),
                           field("VECTOR_FIELD_NAME", field_pattern), field("CONTENT_FIELD_NAME", field_pattern),
                           pool())
    elif operation == "create-base":
        method, path = "PUT", obj("knowledgebases", "KNOWLEDGE_BASE_NAME")
        body = base_body(name("KNOWLEDGE_BASE_NAME"), name("KNOWLEDGE_SOURCE_NAME"))
    elif operation in ("stored", "diverse", "none"):
        method, path = "POST", obj("knowledgebases", "KNOWLEDGE_BASE_NAME") + "/retrieve"
        source = {"knowledgeSourceName": name("KNOWLEDGE_SOURCE_NAME"), "kind": "searchIndex",
                  "includeReferences": True, "includeReferenceSourceData": True}
        if operation != "stored":
            source["topicGraph"] = override(operation)
        body = {"intents": [{"type": "semantic", "search": field("QUESTION")}],
                "retrievalReasoningEffort": {"kind": "minimal"}, "outputMode": output_mode(),
                "includeActivity": True, "knowledgeSourceParams": [source]}
    elif operation in ("vector-balanced", "vector-diverse", "vector-none"):
        method, path = "POST", obj("indexes", "CONTENT_INDEX_NAME") + "/docs/search"
        kind = operation.removeprefix("vector-")
        body = vector_body(field("QUESTION"), field("VECTOR_FIELD_NAME", field_pattern),
                           field("CONTENT_FIELD_NAME", field_pattern), kind, number("TOP", 1, 50, int),
                           override(kind) if kind != "balanced" else None)
    else:
        raise ValueError("Select a supported Topic Graph operation.")
    return {"endpoint": endpoint, "apiVersion": version, "method": method, "path": path, "body": body}


def redact(value):
    if isinstance(value, dict):
        return {key: ("[redacted]" if item and key.lower() in {
            "apikey", "connectionstring", "authorization", "accesstoken", "clientsecret", "applicationsecret",
            "password", "header"
        } else redact(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def console(data, *, entity=False):
    values, operation = data.get("variables"), data.get("operation")
    if not isinstance(values, dict) or not isinstance(operation, str):
        raise ValueError("Select an operation and provide its variables.")
    if entity and operation not in ENTITY_OPERATIONS:
        raise ValueError("Select an Entity Graph tutorial operation.")
    spec = build_request(operation, values, entity=entity)
    result = {"request": spec}
    if data.get("preview") is True:
        return result
    create = spec["method"] == "PUT"
    if create:
        target = spec["body"]["name"]
        active_source, active_base = lab.names("topic")
        if not target.endswith("-api-test") or target in (active_source, active_base):
            raise ValueError("Use a new knowledge source or base name ending in -api-test. Existing resources are not updated.")
        if data.get("confirmCreate") is not True:
            raise ValueError("Confirm that you want to create a test resource.")
    started = perf_counter()
    response = lab.request(spec["method"], spec["path"], spec["body"], create=create,
                           endpoint=spec["endpoint"], api_version=spec["apiVersion"], capture=True)
    return {**result, "azure": redact(response), "elapsedMs": round((perf_counter() - started) * 1000)}
