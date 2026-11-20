import argparse
import base64
from collections import Counter
from functools import lru_cache
from hashlib import sha256
import json
from ipaddress import ip_address, ip_network
import os
from pathlib import Path
from pprint import pformat
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID, NAMESPACE_URL, uuid5
from xml.etree import ElementTree

HERE = Path(__file__).parent
API = "2026-11-01-preview"
SYNTHETIC = [
    ("Pilot scope", "summary", "Avery Chen works for Contoso Robotics. Contoso Robotics uses Azure AI Search. The pilot measures citation coverage and retrieval quality."),
    ("Pilot scope", "transcript", "Avery: Let's compare citation coverage with and without topic sampling before the pilot."),
    ("Platform readiness", "summary", "Jordan Davis works for Fabrikam Analytics. Fabrikam Analytics uses Microsoft Fabric. The team reviewed migration sequencing and warehouse readiness."),
    ("Access review", "summary", "Contoso Robotics uses Microsoft Entra ID. The access review focused on role assignments, managed identity and private networking."),
    ("Platform readiness", "transcript", "[ ]00:01:00 | SpeakerId=Jordan Davis: Microsoft Fabric includes Dataflows Gen2."),
    ("Support handoff", "summary", "Riley Diaz works for Northwind Research. Northwind Research uses Azure Monitor. Support agreed on incident ownership and alert routing."),
]
RELATIONS = [
    ("Person", "worksFor", "Organization", "Explicit employment or affiliation. Do not infer this from attendance."),
    ("Person", "mentions", "Product", "An attributed mention of a product. A mention is not use or endorsement."),
    ("Organization", "uses", "Product", "Explicit current product use by a named organization, not a proposal or passing mention."),
    ("Product", "hasFeature", "ProductFeature", "An explicitly described capability of this product."),
]
GQL = (
    "MATCH (person:Person)-[job]->(org:Organization)-[usage]->(product:Product) "
    "WHERE job.predicate = 'worksFor' AND usage.predicate = 'uses' "
    "RETURN person.name AS person, org.name AS organization, product.name AS product LIMIT 25"
)
PRODUCTS = {
    "Microsoft Fabric": (("Microsoft Fabric", "Fabric"), ("Dataflows Gen2", "OneLake", "Mirroring", "Direct Lake")),
    "Data Factory": (("Data Factory", "ADF"), ("Copy activity", "Copy job", "Dataflows Gen2", "Dataflow Gen2")),
    "Power BI": (("Power BI", "PowerBI"), ("Direct Lake", "Semantic model", "Paginated reports")),
    "Azure AI Search": (("Azure AI Search", "Foundry IQ"), ("Semantic ranker", "Topic graph", "Entity graph")),
    "Microsoft Entra ID": (("Microsoft Entra ID", "Entra ID"), ("Conditional Access",)),
    "Azure Monitor": (("Azure Monitor",), ("Log Analytics", "Application Insights")),
}
ORGANIZATIONS = ("Microsoft", "Contoso Robotics", "Fabrikam Analytics", "Northwind Research")
RETRIEVER_POLICIES = [
    {"id": "ca-leave", "title": "Canadian parental leave", "jurisdiction": "CA",
     "content": "Canadian employees receive four weeks of paid parental leave."},
    {"id": "ca-request", "title": "Canadian leave requests", "jurisdiction": "CA",
     "content": "Canadian employees submit parental leave requests through the HR portal at least 30 days before leave."},
]


@lru_cache
def notes_config():
    path = Path(os.getenv("NOTEASSISTANT_CONFIG", r"C:\git\NoteAssistantUI\App.config"))
    allowed = {"RootFolder", "SolutionName", "AzureTenantID"}
    return {
        e.attrib["key"]: e.attrib["value"]
        for e in ElementTree.parse(path).findall("./appSettings/add")
        if e.get("key") in allowed
    }


@lru_cache
def azure_config():
    path = Path(os.getenv(
        "GRAPH_AZURE_CONFIG", r"C:\git\xaml-markdown-editor-1\src\MarkdownEditor.App\appsettings.json"
    ))
    with path.open(encoding="utf-8-sig") as file:
        settings = json.load(file)
    if not isinstance(settings, dict):
        raise ValueError(f"{path} must contain a JSON object.")

    def setting(section, key):
        values = settings.get(section)
        value = values.get(key) if isinstance(values, dict) else None
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Missing {section}:{key} in {path}.")
        return value.strip()

    return {
        "search": setting("KnowledgeBase", "SearchEndpoint"),
        "project": setting("Copilot", "FoundryProjectEndpoint"),
        "chat": setting("Copilot", "ModelDeployment"),
        "modelScope": setting("Copilot", "FoundryModelResourceId"),
    }


def note_sessions():
    c = notes_config()
    root = Path(os.getenv("NOTEASSISTANT_NOTES", str(Path(c["RootFolder"]) / c["SolutionName"]))).resolve()
    names = [("live-recap.json", "summary"), ("transcript.json", "transcript")]
    folders = sorted((p for p in root.iterdir() if p.is_dir() and p.resolve().parent == root),
                     key=lambda p: (-p.stat().st_mtime, p.name))
    sessions = {}
    for folder in folders:
        directory = folder.resolve() / ".json"
        paths = [(directory / name, kind) for name, kind in names]
        if directory.resolve() != directory or not all(p.is_file() and p.resolve() == p for p, _ in paths):
            continue
        key = sha256(folder.name.encode("utf-8")).hexdigest()[:32]
        sessions[key] = (folder.name, f"Session {len(sessions) + 1:02}", paths)
    return sessions


def note_catalog():
    sessions = note_sessions()
    return {"sessions": [{"id": key, "title": title, "label": label}
                         for key, (title, label, _) in sessions.items()],
            "defaults": list(sessions)[:4]}


def note_text(path, kind):
    collection = "messages" if kind == "transcript" else "sections"
    try:
        data = json.loads(path.read_bytes())
    except (ValueError, UnicodeError) as exc:
        raise ValueError(f"{path.parent.parent.name}: {path.name} is not valid JSON.") from exc
    records = data.get(collection) if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise ValueError(f"{path.parent.parent.name}: {path.name} is missing the {collection} array.")

    def field(record, key):
        value = record.get(key) if isinstance(record, dict) else None
        return " ".join(value.split()) if isinstance(value, str) else ""

    lines = []
    for record in records:
        if kind == "transcript":
            text = field(record, "text")
            if not text or "window capture" in text.casefold():
                continue
            speaker = field(record, "displaySpeakerName") or field(record, "speakerId")
            timestamp = re.search(r"\d{2}:\d{2}:\d{2}", field(record, "timestamp"))
            time_label = timestamp[0] if timestamp else "--:--:--"
            lines.append(f"[ ]{time_label} | SpeakerId={speaker}: {text}" if speaker else text)
        else:
            lines.extend(field(record, key) for key in ("headline", "summary"))
            details = record.get("details") if isinstance(record, dict) else None
            if isinstance(details, list):
                for detail in details:
                    lines.extend(field(detail, key) for key in ("headline", "description"))
    text = "\n".join(line for line in lines if line)
    if not text:
        raise ValueError(f"{path.parent.parent.name}: {path.name} has no {kind} text.")
    return text[:12_000]


def samples(selection=None):
    sessions = note_sessions()
    if not sessions:
        raise ValueError("No session with both .json/transcript.json and .json/live-recap.json was found.")
    if selection is None:
        selected = set(list(sessions)[:4])
    else:
        if not isinstance(selection, list) or not all(isinstance(key, str) and key in sessions for key in selection):
            raise ValueError("Some selected sessions are unavailable. Reload the source menu and select them again.")
        selected = set(selection)
    if not selected:
        raise ValueError("Select at least one session in Configure NoteAssistant sources.")
    for key, (_, label, paths) in sessions.items():
        if key not in selected:
            continue
        for p, kind in paths:
            yield (label, kind, note_text(p, kind), {
                "documentUrl": f"/api/notes/document/{key}/{kind}",
                "documentName": p.name,
            })


STOP = set(("with from that this they their have what which are and the for you was were will not "
            "can use uses about your main across meeting plus should et det der som til med har ikke "
            "jeg han hun den dem eller også speaker summary transcript session").split())


def words(text):
    return [w for w in re.findall(r"[^\W\d_]{3,}", text.casefold()) if w not in STOP]


def local_topics(corpus, question, strategy):
    query = set(words(question))
    groups = {}
    for title, kind, body, *document in corpus:
        groups.setdefault(title, [])
        chunks = [body[i:i + 850] for i in range(0, len(body), 850) if body[i:i + 850].strip()]
        groups[title].extend((kind, chunk, document[0] if document else {}) for chunk in chunks)
    labels = {
        title: " / ".join(w for w, _ in Counter(words(" ".join(t for _, t, _ in chunks))).most_common(3))
        for title, chunks in groups.items()
    }
    ranked = sorted(
        ((len(query.intersection(words(text))), title, kind, text, document) for title, chunks in groups.items()
         for kind, text, document in chunks), key=lambda row: -row[0]
    )
    phases = ["keyword"] * len(ranked)
    if strategy != "none":
        seen = set()
        first, rest = [], []
        for row in ranked:
            (rest if row[1] in seen else first).append(row)
            seen.add(row[1])
        ranked = first + rest
        phases = ["session-first"] * len(first) + ["additional"] * len(rest)
    result = ranked[:(4 if strategy == "balanced" else 6)]
    return {"groups": labels, "references": [
        {"keywordScore": score, "rankingPhase": phase,
         "sourceData": {"session": title, "kind": kind, "topic": labels[title], "content": text, **document}}
        for (score, title, kind, text, document), phase in zip(result, phases)
    ]}


def phrase_match(names):
    alternatives = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    return rf"(?<!\w)(?:{alternatives})(?!\w)"


PRODUCT_NAMES = {alias.casefold(): product for product, (aliases, _) in PRODUCTS.items() for alias in aliases}
PRODUCT_MATCH = re.compile(phrase_match(PRODUCT_NAMES), re.I)
ORG_MATCH = phrase_match(ORGANIZATIONS)
ORG_USE = re.compile(rf"^(?P<org>{ORG_MATCH})\s+(?:uses|is using)\s+(?P<product>{PRODUCT_MATCH.pattern})", re.I)
SPEAKER_MATCH = re.compile(r"^\[[! ]?\]\s*(?:\d\d:\d\d:\d\d|--:--:--)\s*\|\s*Speaker(?:Id)?\s*=\s*(.+?):\s+(.+)", re.I)


def local_entity_graph(corpus, question):
    nodes, edges = {}, {}

    def entity(kind, name, scope=""):
        key = (kind, name.casefold(), scope)
        if key not in nodes:
            nodes[key] = {"id": f"n{len(nodes)}", "kind": kind, "label": name, "scope": scope}
        return nodes[key]["id"]

    def link(source, relation, target, session, kind, evidence, document):
        key = (source, relation, target)
        edge = edges.setdefault(key, {"source": source, "relation": relation, "target": target, "evidence": []})
        citation = {"session": session, "kind": kind, "text": evidence[:650], **document}
        if len(edge["evidence"]) < 3 and citation not in edge["evidence"]:
            edge["evidence"].append(citation)

    for session, kind, body, *documents in corpus:
        document = documents[0] if documents else {}
        for line in body.splitlines():
            attributed = SPEAKER_MATCH.match(line) if kind == "transcript" else None
            speaker, content = (attributed[1].strip(), attributed[2]) if attributed else ("", line)
            for sentence in re.split(r"(?<=[.!?])\s+", content):
                sentence = sentence.strip(" \t-*#")
                use = ORG_USE.match(sentence)
                if use:
                    link(entity("Organization", use["org"]), "Uses",
                         entity("Product", PRODUCT_NAMES[use["product"].casefold()]), session, kind, sentence, document)
                for match in PRODUCT_MATCH.finditer(sentence):
                    product = PRODUCT_NAMES[match[0].casefold()]
                    product_id = entity("Product", product)
                    if speaker:
                        link(entity("Person", speaker, session), "Mentions", product_id, session, kind, sentence, document)
                    for feature in PRODUCTS[product][1]:
                        if re.search(rf"^{phrase_match(PRODUCTS[product][0])}\s+(?:includes|supports|offers|provides)\s+"
                                     + phrase_match((feature,)), sentence, re.I):
                            link(product_id, "Has feature", entity("ProductFeature", feature, product),
                                 session, kind, sentence, document)

    focus = set(words(question)) - {"person", "organization", "organisation", "product", "products", "feature",
                                    "features", "mentioned", "mentions", "used", "uses", "people", "show"}
    matching = {n["id"] for n in nodes.values() if focus.intersection(words(n["label"]))}
    if matching:
        nearby = matching | {e["source"] for e in edges.values() if e["target"] in matching}
        nearby |= {e["target"] for e in edges.values() if e["source"] in matching}
        selected = [e for e in edges.values() if e["source"] in nearby and e["target"] in nearby][:30]
    else:
        nearby = {n["id"] for n in nodes.values()}
        selected = list(edges.values())[:30]
    visible = {point for e in selected for point in (e["source"], e["target"])}
    if not visible:
        visible = {n["id"] for n in nodes.values() if n["id"] in nearby}
    return {"entityGraph": {"nodes": [n for n in nodes.values() if n["id"] in visible][:60],
                            "edges": selected}}


def ontology():
    return {
        "@context": {"owl": "http://www.w3.org/2002/07/owl#",
                     "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
                     "ex": "https://schema.search.azure.com/entities#"},
        "@graph": [
            {"@id": f"ex:{kind}", "@type": "owl:Class", "rdfs:comment": description}
            for kind, description in {
                "Person": "A named real or fictional person, not a generic speaker label.",
                "Organization": "A named organization, employer or company.",
                "Product": "A named software product or cloud service.",
                "ProductFeature": "A named capability that the source explicitly associates with a product.",
            }.items()
        ] + [
            {"@id": f"ex:{rel}", "@type": "owl:ObjectProperty", "rdfs:comment": desc,
             "rdfs:domain": {"@id": f"ex:{src}"}, "rdfs:range": {"@id": f"ex:{dst}"}}
            for src, rel, dst, desc in RELATIONS
        ],
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_token_lock = threading.Lock()
_tokens = {}


def azure_token(resource):
    with _token_lock:
        cached = _tokens.get(resource)
        if cached and cached[1] > time.time() + 120:
            return cached[0]
        tenant = notes_config()["AzureTenantID"]
        if not re.fullmatch(r"[a-fA-F0-9-]{36}", tenant):
            raise ValueError("Invalid Entra tenant ID in App.config.")
        az = shutil.which("az")
        if not az:
            raise ValueError("Install Azure CLI to use live mode.")
        try:
            response = subprocess.run(
                [az, "account", "get-access-token", "--tenant", tenant, "--resource", resource,
                 "--output", "json", "--only-show-errors"], capture_output=True, check=True, timeout=30,
            )
            credential = json.loads(response.stdout)
            _tokens[resource] = (credential["accessToken"], int(credential.get("expires_on", 0)))
        except (subprocess.SubprocessError, KeyError, ValueError) as exc:
            raise ValueError(f"Entra sign-in failed. Run az login --tenant {tenant}.") from exc
        return _tokens[resource][0]


def search_endpoint():
    endpoint = deployed_endpoint() or (os.getenv("GRAPH_SEARCH_ENDPOINT") or azure_config()["search"]).rstrip("/")
    if not re.fullmatch(r"https://[a-z0-9-]+\.search\.windows\.net", endpoint):
        raise ValueError("Use an HTTPS Azure AI Search endpoint (*.search.windows.net).")
    return endpoint


DEPLOYED_TARGET = HERE / ".graph-suite-endpoint"


def deployed_endpoint():
    if DEPLOYED_TARGET.is_file():
        target = DEPLOYED_TARGET.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"https://graph-lab-[a-f0-9]{16}\.search\.windows\.net", target):
            raise ValueError("Invalid saved Graph Lab deployment endpoint.")
        return target
    return None


class AzureError(ValueError):
    def __init__(self, service, status, message):
        super().__init__(f"{service} HTTP {status}: {str(message)[:1200]}")
        self.status = status


def azure_request(service, resource, url, method, body=None, create=False, *, capture=False, if_match=None):
    headers = {"Authorization": f"Bearer {azure_token(resource)}", "Content-Type": "application/json"}
    if create:
        headers["If-None-Match"] = "*"
    if if_match is not None:
        headers["If-Match"] = if_match
    req = Request(url,
                  data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with build_opener(NoRedirect).open(req, timeout=100) as response:
            data = response.read()
            parsed = json.loads(data) if data else (None if capture else {})
            if capture:
                return {"status": response.status, "requestId": response.headers.get("request-id")
                        or response.headers.get("x-ms-request-id"), "body": parsed}
            return parsed
    except HTTPError as exc:
        if capture:
            try:
                parsed = json.load(exc)
            except (ValueError, UnicodeError):
                parsed = {"error": str(exc.reason)}
            return {"status": exc.code, "requestId": exc.headers.get("request-id")
                    or exc.headers.get("x-ms-request-id"), "body": parsed}
        try:
            error = json.load(exc).get("error", {})
            message = error.get("message", exc.reason)
            details = error.get("details", [])
            if isinstance(details, list):
                extra = [item["message"] for item in details if isinstance(item, dict)
                         and isinstance(item.get("message"), str) and item["message"] != message]
                message = " ".join(dict.fromkeys([str(message), *extra]))
        except (ValueError, AttributeError):
            message = exc.reason
        raise AzureError(service, exc.code, message) from exc
    except (URLError, TimeoutError) as exc:
        raise ValueError(f"Could not reach {service}: {exc.reason if isinstance(exc, URLError) else exc}") from exc


def search_request_url(path, endpoint=None, api_version=API):
    return (endpoint or search_endpoint()) + path + f"?api-version={api_version}"


def request(method, path, body=None, create=False, *, endpoint=None, api_version=API, capture=False, if_match=None):
    return azure_request("Azure AI Search", "https://search.azure.com",
                         search_request_url(path, endpoint, api_version), method, body, create,
                         capture=capture, if_match=if_match)


def arm(method, path, version, body=None, create=False, *, query=""):
    return azure_request("Azure Resource Manager", "https://management.azure.com/",
                         f"https://management.azure.com{path}?api-version={version}{query}", method, body, create)


def names(mode):
    prefix = os.getenv("GRAPH_PREFIX", "note-graph-lab")
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,28}[a-z0-9]", prefix):
        raise ValueError("GRAPH_PREFIX must be 4–30 lowercase Search-safe characters.")
    return f"{prefix}-{mode}-ks", f"{prefix}-{mode}-kb"


def object_url(collection, name):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}", name):
        raise ValueError("Invalid Azure AI Search resource name.")
    return f"/{collection}('{name}')"


def foundry_model(deployment=None, model_name=None):
    settings = azure_config()
    host = urlsplit(settings["project"]).hostname
    if not host or not host.endswith(".services.ai.azure.com"):
        raise ValueError("Copilot:FoundryProjectEndpoint must specify a Microsoft Foundry project endpoint.")
    deployment = deployment or settings["chat"]
    return {"kind": "azureOpenAI", "azureOpenAIParameters": {
        "resourceUri": f"https://{host.removesuffix('.services.ai.azure.com')}.openai.azure.com",
        "deploymentId": deployment, "modelName": model_name or deployment,
    }}


RETRIEVER_QUESTION = "What parental leave do Canadian employees receive and how do they request it?"
RETRIEVER_TARGET = HERE / ".retriever-endpoint"


def retriever_endpoint():
    suite = deployed_endpoint()
    if RETRIEVER_TARGET.is_file() and (
        not suite or RETRIEVER_TARGET.stat().st_mtime_ns > DEPLOYED_TARGET.stat().st_mtime_ns
    ):
        target = RETRIEVER_TARGET.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"https://graph-lab-[0-9a-f]{16}\.search\.windows\.net", target):
            raise ValueError("Invalid saved Retriever endpoint.")
        return target
    return suite or search_endpoint()


def query_request(path, body, *, preview, endpoint=None, lookup=None):
    if not preview:
        return request("POST", path, body, endpoint=endpoint)
    endpoint = endpoint or search_endpoint()
    python = f"from lab import request\n\nendpoint = {endpoint!r}\n"
    if lookup:
        python += (f"\n# The app reads this source to resolve the index used below.\n"
                   f"request('GET', {lookup!r}, endpoint=endpoint, api_version={API!r})\n")
    python += (f"\nbody = {pformat(body, sort_dicts=False)}\n"
               f"result = request('POST', {path!r}, body, endpoint=endpoint, api_version={API!r})")
    return {"python": python, "body": body, "method": "POST", "url": search_request_url(path, endpoint),
            "lookup": search_request_url(lookup, endpoint) if lookup else None}


def retriever_query(question, strategy, *, endpoint=None, preview=False):
    _, base = names("retriever")
    return query_request(object_url("knowledgebases", base) + "/retrieve", {
        "intents": [{"type": "semantic", "search": question}],
        "retrievalReasoningEffort": {"kind": "minimal"},
        "outputMode": "answerSynthesis" if strategy == "answer" else "extractiveData",
        "includeActivity": True,
        "maxRuntimeInSeconds": 60,
    }, preview=preview, endpoint=endpoint or retriever_endpoint())


RETRIEVER_TARGETS = {
    "policy-index": ("retriever", "index", "Policy content index", "searchIndexName"),
    "topic-index": ("topic", "index", "Topic-linked content index", "searchIndexName"),
    "entity-chunks": ("entity", "index", "Entity source chunk index", "index"),
    "entity-graph": ("entity", "index", "Entity graph records index", "graphIndex"),
    "policy-kb": ("retriever", "knowledge base", "Content KB (policies)", None),
    "topic-kb": ("topic", "knowledge base", "Topic KB", None),
    "entity-kb": ("entity", "knowledge base", "Entity Graph KB", None),
}


def retriever_target(target, *, sources=None):
    if not isinstance(target, str) or target not in RETRIEVER_TARGETS:
        raise ValueError("Select a Retriever 1 target from the dropdown.")
    mode, kind, label, resource_key = RETRIEVER_TARGETS[target]
    endpoint = retriever_endpoint() if mode == "retriever" else search_endpoint()
    source, base = names(mode)
    result = {"id": target, "label": label, "kind": kind, "endpoint": endpoint}
    if kind == "knowledge base":
        result["name"] = base
        definition = request("GET", object_url("knowledgebases", base), endpoint=endpoint)
        if not any(model.get("kind") == "microsoftRetriever1" for model in definition.get("models") or []):
            result["unavailable"] = "This knowledge base is not configured with microsoftRetriever1."
    else:
        if sources is None:
            sources = {}
        if mode not in sources:
            sources[mode] = request("GET", object_url("knowledgesources", source), endpoint=endpoint)
        definition = sources[mode]
        if mode == "entity":
            params = definition.get("azureBlobParameters") or {}
            name = (params.get("createdResources") or {}).get(resource_key)
        else:
            name = (definition.get("searchIndexParameters") or {}).get(resource_key)
        if not name:
            raise ValueError(f"{label} has not reported its index name yet.")
        result["name"] = name
    return result


def retriever_targets():
    sources, targets = {}, []
    for target, (_, kind, label, _) in RETRIEVER_TARGETS.items():
        try:
            targets.append(retriever_target(target, sources=sources))
        except ValueError as exc:
            targets.append({"id": target, "label": label, "kind": kind, "unavailable": str(exc)})
    return {"targets": targets}


def retriever_playground(data):
    question = data.get("question")
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 1600:
        raise ValueError("Enter a question of 1–1,600 characters.")
    question = question.strip()
    target = retriever_target(data.get("target"))
    if target.get("unavailable"):
        raise ValueError(target["unavailable"])
    effort = data.get("reasoningEffort", "minimal")
    if effort not in ("minimal", "low") or (target["kind"] == "index" and "reasoningEffort" in data):
        raise ValueError("Select Minimal or Low reasoning for a knowledge base only.")
    endpoint, name = target["endpoint"], target["name"]
    if target["kind"] == "index":
        path = object_url("indexes", name) + "/docs/search"
        schema = request("GET", object_url("indexes", name), endpoint=endpoint)
        fields = [f["name"] for f in schema["fields"] if f.get("retrievable") is not False
                  and f["type"] == "Edm.String" and f.get("dimensions") is None]
        if not fields:
            raise ValueError("The index has no retrievable text fields.")
        body = {"search": question, "queryType": "agentic", "debug": "agentic",
                "agenticOptions": {"maxRuntimeInSeconds": 60}, "top": 5, "select": ",".join(fields)}
    else:
        path = object_url("knowledgebases", name) + "/retrieve"
        body = {"intents": [{"type": "semantic", "search": question}],
                "retrievalReasoningEffort": {"kind": effort}, "outputMode": "extractiveData",
                "includeActivity": True, "maxRuntimeInSeconds": 60}
    preview = query_request(path, body, preview=True, endpoint=endpoint)
    return {"target": target, "request": preview,
            "azure": request("POST", path, body, endpoint=endpoint, capture=True)}


def provision_retriever(confirm, *, endpoint=None, resume=False):
    source, base = names("retriever")
    index = source.removesuffix("-ks") + "-idx"
    if not confirm:
        raise ValueError(f"Would create {index}, {source} and {base} on {search_endpoint()} using only fictional policies. Rerun with --confirm.")
    index_path = object_url("indexes", index)

    def create(path, definition):
        try:
            request("PUT", path, definition, create=True, endpoint=endpoint)
        except AzureError as exc:
            if not resume or exc.status not in (409, 412):
                raise
            request("GET", path, endpoint=endpoint)

    fields = [
        {"name": name, "type": "Edm.String", "retrievable": True, **properties}
        for name, properties in [("id", {"key": True}), ("title", {"searchable": True}),
                                 ("content", {"searchable": True}), ("jurisdiction", {"filterable": True})]
    ]
    create(index_path, {"name": index, "fields": fields, "semantic": {
        "defaultConfiguration": "policy",
        "configurations": [{"name": "policy", "prioritizedFields": {
            "titleField": {"fieldName": "title"}, "prioritizedContentFields": [{"fieldName": "content"}],
        }}],
    }})
    uploaded = request("POST", index_path + "/docs/index", {
        "value": [{"@search.action": "upload", **doc} for doc in RETRIEVER_POLICIES],
    }, endpoint=endpoint).get("value", [])
    if len(uploaded) != len(RETRIEVER_POLICIES) or not all(row.get("status") is True for row in uploaded):
        raise ValueError(f"Index {index} was created, but not all fictional documents were indexed.")
    create(object_url("knowledgesources", source), {
        "name": source, "kind": "searchIndex", "searchIndexParameters": {
            "searchIndexName": index, "sourceDataFields": [{"name": field["name"]} for field in fields],
        },
    })
    create(object_url("knowledgebases", base), {
        "name": base, "knowledgeSources": [{"name": source}],
        "models": [{"kind": "microsoftRetriever1"}, foundry_model()],
        "retrievalReasoningEffort": {"kind": "minimal"}, "outputMode": "extractiveData",
        "answerInstructions": "Answer using only retrieved evidence. Cite the sources and say when evidence is insufficient.",
    })
    print(f"Created {index}, {source} and {base} with fictional policies.")


SETUP_LOCK = threading.Lock()
SETUP_STATE = {"status": "idle", "message": ""}
ARM_SEARCH_API = "2026-09-01-preview"


def setup_status(**values):
    with SETUP_LOCK:
        SETUP_STATE.update(values)
        return SETUP_STATE.copy()


def setup_inventory(*, full):
    endpoint = search_endpoint() if full else retriever_endpoint()
    hostname = urlsplit(endpoint).hostname
    name = hostname.split(".")[0]
    settings = azure_config()
    model_scope = settings["modelScope"]
    subscription = str(UUID(model_scope.split("/")[2]))
    storage = os.getenv("GRAPH_DEMO_STORAGE_ID", "")
    values = {"subscription": subscription, "storage": storage}
    checks = {}

    def check(key, action):
        try:
            status, details = action()
        except AzureError as exc:
            status, details = ("Not found" if exc.status == 404 else "Not verified",
                               str(exc).split(":", 1)[0])
        except (ValueError, KeyError, OSError) as exc:
            status, details = "Not verified", str(exc)
        checks[key] = {"status": status, "details": details}

    def search_service():
        selector = quote(f"resourceType eq 'Microsoft.Search/searchServices' and name eq '{name}'", safe="")
        matches = arm("GET", f"/subscriptions/{subscription}/resources", "2021-04-01",
                      query=f"&$filter={selector}")["value"]
        if not matches:
            return "Not found", f"{name} was not found in the configured subscription."
        search = arm("GET", matches[0]["id"], ARM_SEARCH_API)
        values.update(subscription=search["id"].split("/")[2], resourceGroup=search["id"].split("/")[4],
                      region=re.sub(r"\s+", "", search["location"].lower()))
        props = search["properties"]
        ready = (props.get("provisioningState") == "Succeeded" and props.get("disableLocalAuth")
                 and props.get("knowledgeRetrieval") == "standard"
                 and search.get("identity", {}).get("principalId"))
        return ("Deployed" if ready else "Needs review",
                f"{name} in {values['resourceGroup']} ({values['region']})")

    def prerequisites():
        models = [settings["chat"]] + (["text-embedding-3-large"] if full else [])
        deployments = [arm("GET", f"{model_scope}/deployments/{quote(model, safe='')}", "2024-10-01")
                       for model in models]
        ready = all(d["properties"].get("provisioningState") == "Succeeded" for d in deployments)
        return ("Available" if ready else "Needs review", ", ".join(models))

    def read(collection, resource):
        return request("GET", object_url(collection, resource), endpoint=endpoint)

    def source_and_base(mode, definition=None):
        source, base = names(mode)
        if definition is None:
            definition = read("knowledgesources", source)
        kb = read("knowledgebases", base)
        if source not in {entry["name"] for entry in kb.get("knowledgeSources", [])}:
            raise ValueError(f"{base} does not reference {source}.")
        return source, base, definition, kb

    def check_retriever():
        source, base, definition, _ = source_and_base("retriever")
        index = definition["searchIndexParameters"]["searchIndexName"]
        read("indexes", index)
        return "Deployed", f"{index}, {source}, {base}"

    check("search", search_service)
    check("preflight", prerequisites)
    check("retriever", check_retriever)
    checks["roles"] = {"status": "Not verified", "details": "Resource reads do not verify all effective Search, Foundry, or Storage role assignments."}
    checks["activate"] = {"status": "Configured", "details": endpoint}
    if full:
        from suite_deploy import STORAGE_API
        entity_source, _ = names("entity")
        entity = {}

        def check_entity():
            definition = read("knowledgesources", entity_source)
            entity.update(definition["azureBlobParameters"])
            source, base, _, _ = source_and_base("entity", definition)
            managed = entity.get("createdResources") or {}
            indexes = [managed.get("index"), managed.get("graphIndex")]
            if not all(indexes):
                return "Needs review", f"{source} and {base} exist; managed indexes were not reported."
            for index in indexes:
                read("indexes", index)
            sync_state = request("GET", object_url("knowledgesources", source) + "/status",
                                 endpoint=endpoint).get("lastSynchronizationState") or {}
            ready = sync_state.get("itemsUpdatesProcessed") and not sync_state.get("itemsUpdatesFailed")
            return ("Deployed" if ready else "Needs review", f"{source}, {base}, {', '.join(indexes)}"
                    + ("" if ready else "; successful synchronization not confirmed"))

        def check_storage():
            if not re.fullmatch(r"/subscriptions/[a-f0-9-]{36}/resourceGroups/[\w.()-]+/providers/"
                                r"Microsoft\.Storage/storageAccounts/[a-z0-9]{3,24}", storage, re.I):
                return "Not verified", "No approved Blob account is configured."
            arm("GET", storage, STORAGE_API)
            container = entity.get("containerName")
            if not isinstance(container, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", container):
                return "Needs review", "Blob account exists; no deployed Entity Graph container was resolved."
            blob = arm("GET", storage + f"/blobServices/default/containers/{container}", STORAGE_API)
            configs = arm("GET", storage + "/networkSecurityPerimeterConfigurations", STORAGE_API)["value"]
            addresses = [ip_address(value) for value in socket.gethostbyname_ex(hostname)[2]]
            private = blob["properties"].get("publicAccess", "None") == "None"
            for config in configs:
                props = config["properties"]
                profile = props["profile"]
                prefixes = [ip_network(prefix, strict=False) for rule in profile.get("accessRules", [])
                            if rule.get("properties", {}).get("direction") == "Inbound"
                            for prefix in rule["properties"].get("addressPrefixes", [])]
                if (private and props.get("provisioningState") == "Succeeded" and not props.get("provisioningIssues")
                        and addresses and all(any(ip in network for network in prefixes) for ip in addresses)):
                    return "Deployed", f"Private container {container} on the configured account; Search IP allowed by {profile['name']}"
            return "Needs review", f"{container} exists; private access and an active Search IP rule were not both verified."

        def check_topic_indexes():
            source, _ = names("topic")
            params = read("knowledgesources", source)["searchIndexParameters"]
            content = params["searchIndexName"]
            schema = read("indexes", content)
            fields = {ref["name"] for ref in params["searchFields"]}
            profiles = {field.get("topicGraphProfile") for field in schema["fields"] if field["name"] in fields}
            topics = [profile["indexName"] for profile in schema["vectorSearch"].get("topicGraphProfiles", [])
                      if profile["name"] in profiles]
            if not topics:
                return "Needs review", f"{content} exists but no linked topic index was found."
            for index in topics:
                read("indexes", index)
            return "Deployed", ", ".join([content, *topics])

        def check_topic_retrieval():
            source, base, _, kb = source_and_base("topic")
            if not any(model.get("kind") == "microsoftRetriever1" for model in kb.get("models") or []):
                return "Needs review", f"{base} exists but is not configured with Retriever 1."
            return "Deployed", f"{source}, {base} (Retriever 1)"

        check("entity", check_entity)
        check("storage", check_storage)
        check("topic-indexes", check_topic_indexes)
        check("topic-retrieval", check_topic_retrieval)
    return {"endpoint": endpoint, "values": values, "checks": checks}


def wait_for(action, *, timeout=480, retry_statuses=(403, 404, 429, 502, 503)):
    deadline = time.monotonic() + timeout
    while True:
        try:
            result = action()
            if result is not None:
                return result
            if time.monotonic() >= deadline:
                raise ValueError("Azure operation timed out; inspect the resource and retry setup.")
        except AzureError as exc:
            if exc.status not in retry_statuses or time.monotonic() >= deadline:
                raise
        time.sleep(8)


def setup_retriever(subscription, group, region, *, suite=None):
    offerings = arm("POST", "/providers/Microsoft.Search/fetchOfferings", ARM_SEARCH_API)
    if not any(r.get("regionName") == region
               and any(f.get("name") == "MicrosoftRetriever" for f in r.get("features", []))
               for r in offerings.get("regions", [])):
        raise ValueError(f"Azure does not advertise Microsoft Retriever 1 in {region}. No resources were created.")
    rg_scope = f"/subscriptions/{subscription}/resourceGroups/{quote(group, safe='')}"
    identity = f"{rg_scope.lower()}/{region}" + (f"/suite/{suite['storage'].lower()}" if suite else "")
    name = "graph-lab-" + uuid5(NAMESPACE_URL, identity).hex[:16]
    search_scope = rg_scope + f"/providers/Microsoft.Search/searchServices/{name}"
    endpoint = f"https://{name}.search.windows.net"
    setup_status(resource=name, resourceGroup=group, message="Checking resource group and Foundry deployment…")
    arm("GET", rg_scope, "2021-04-01")
    settings = azure_config()
    model_scope = settings["modelScope"]
    if not re.fullmatch(r"/subscriptions/[a-f0-9-]+/resourceGroups/[\w.()-]+/providers/Microsoft\.CognitiveServices/accounts/[\w-]+", model_scope, re.I):
        raise ValueError("FoundryModelResourceId must be an Azure Cognitive Services account resource ID.")
    deployment = arm("GET", model_scope + "/deployments/" + quote(settings["chat"], safe=""), "2024-10-01")
    if deployment["properties"].get("provisioningState") != "Succeeded":
        raise ValueError("The configured Foundry model deployment is not ready.")
    token_segment = azure_token("https://management.azure.com/").split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(token_segment + "=" * (-len(token_segment) % 4)))
    principal = str(UUID(claims["oid"]))
    if claims.get("idtyp") == "app":
        raise ValueError("Sign in to Azure CLI as a user to use browser setup.")

    setup_status(phase="search", message=f"Creating or resuming {name} with Standard Knowledge Retrieval…")
    tag = "suite" if suite else "retriever"
    try:
        existing = arm("GET", search_scope, ARM_SEARCH_API)
    except AzureError as exc:
        if exc.status != 404:
            raise
        arm("PUT", search_scope, ARM_SEARCH_API, {
            "location": region, "sku": {"name": "basic"},
            "identity": {"type": "SystemAssigned"}, "tags": {"graph-lab": tag},
            "properties": {"replicaCount": 1, "partitionCount": 1, "disableLocalAuth": True,
                           "semanticSearch": "free", "knowledgeRetrieval": "standard",
                           **({"networkRuleSet": {"ipRules": [{"value": suite["clientIp"]}]}}
                              if suite else {})},
        }, create=True)
    else:
        if (existing.get("tags", {}).get("graph-lab") != tag
                or not existing.get("properties", {}).get("disableLocalAuth")
                or existing.get("properties", {}).get("knowledgeRetrieval") != "standard"):
            raise ValueError("An existing service with the demo name is not configured for this demo; it was not changed.")
        if suite and suite["clientIp"] not in {
            entry["value"].removesuffix("/32")
            for entry in existing["properties"].get("networkRuleSet", {}).get("ipRules", [])
        }:
            raise ValueError("The existing demo Search service does not allow this client IP; no inbound rules were changed.")

    def ready():
        service = arm("GET", search_scope, ARM_SEARCH_API)
        state = service.get("properties", {}).get("provisioningState")
        if state in ("Failed", "Canceled"):
            raise ValueError(f"Search provisioning ended in state {state}. Inspect {name} in the Azure portal.")
        if state == "Succeeded":
            if service["properties"].get("knowledgeRetrieval") != "standard" or not service["properties"].get("disableLocalAuth"):
                raise ValueError("Azure did not apply Standard Knowledge Retrieval and Entra-only authentication.")
            if service.get("identity", {}).get("principalId"):
                return service["identity"]["principalId"]
        return None

    search_principal = wait_for(ready)
    setup_status(phase="roles", message="Assigning Search data roles and Foundry model access…")

    def role(scope, object_id, kind, definition):
        assignment = uuid5(NAMESPACE_URL, f"{scope.lower()}/{object_id}/{definition}")
        role_id = "/".join(scope.split("/")[:3]) + "/providers/Microsoft.Authorization/roleDefinitions/" + definition
        try:
            arm("PUT", f"{scope}/providers/Microsoft.Authorization/roleAssignments/{assignment}", "2022-04-01", {
                "properties": {"roleDefinitionId": role_id, "principalId": object_id, "principalType": kind},
            })
        except AzureError as exc:
            if exc.status != 409 or "RoleAssignmentExists" not in str(exc):
                raise

    role(search_scope, principal, "User", "7ca78c08-252a-4471-8644-bb5ff32d4ba0")
    role(search_scope, principal, "User", "8ebe5a00-799e-43f5-93ac-243d3dce84a7")
    role(model_scope, search_principal, "ServicePrincipal", "a97b65f3-24c7-4388-baec-2e87135dc908")
    if suite:
        role(model_scope, search_principal, "ServicePrincipal", "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd")
        role(model_scope, principal, "User", "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd")
    setup_status(message="Waiting for Search permissions to propagate…")
    wait_for(lambda: request("GET", "/indexes", endpoint=endpoint))
    setup_status(phase="retriever", message="Creating the Retriever knowledge base and indexing fictional policies…")

    def provision_sample():
        provision_retriever(True, endpoint=endpoint, resume=True)
        return True

    wait_for(provision_sample)
    setup_status(message="Checking for a generated answer and Retriever 1 activity…")

    def verify():
        result = retriever_query(RETRIEVER_QUESTION, "answer", endpoint=endpoint)
        planning = any(a.get("type") == "modelQueryPlanning" and not a.get("error")
                       and (a.get("model") or {}).get("modelName") == "microsoft-retriever-1"
                       for a in result.get("activity", []))
        answered = any(isinstance(c.get("text"), str) and c["text"].strip()
                       for m in result.get("response", []) for c in m.get("content", []))
        return True if planning and answered and result.get("references") else None

    wait_for(verify, timeout=180)
    if suite:
        suite["deploy_remaining"](endpoint, search_scope, search_principal, principal, role)
    setup_status(phase="activate", message="Saving the verified Search endpoint to Graph Lab…")
    if suite:
        temp = DEPLOYED_TARGET.with_suffix(".tmp")
        temp.write_text(endpoint, encoding="utf-8")
        temp.replace(DEPLOYED_TARGET)
        setup_status(status="ready", message=f"Topic Graph, Entity Graph and Retriever 1 are ready on {name}.",
                     endpoint=endpoint, suite=True)
        return
    temp = RETRIEVER_TARGET.with_suffix(".tmp")
    temp.write_text(endpoint, encoding="utf-8")
    temp.replace(RETRIEVER_TARGET)
    setup_status(status="ready", message=f"Retriever 1 is ready on {name}.", endpoint=endpoint)


def start_setup(data, *, full=False):
    subscription, group, region = (data.get(key) for key in ("subscription", "resourceGroup", "region"))
    if (not all(isinstance(value, str) for value in (subscription, group, region))
            or not re.fullmatch(r"[a-f0-9-]{36}", subscription, re.I)
            or not re.fullmatch(r"[\w.()-]{1,90}(?<!\.)", group)
            or not re.fullmatch(r"[a-z][a-z0-9]{1,29}", region)
            or data.get("costAccepted") is not True):
        raise ValueError("Enter a subscription ID, existing resource group, and Azure region code, and accept charges.")
    subscription = str(UUID(subscription))
    suite = None
    if full:
        from suite_deploy import prepare_request
        suite = prepare_request(data)
    with SETUP_LOCK:
        if SETUP_STATE["status"] == "running":
            raise ValueError("A deployment is already running.")
        SETUP_STATE.clear()
        SETUP_STATE.update(status="running", phase="preflight", message="Checking deployment prerequisites…", suite=full)

    def run():
        try:
            if suite:
                from suite_deploy import preflight
                preflight(suite)
            setup_retriever(subscription, group, region, suite=suite)
        except (ValueError, KeyError, OSError, IndexError, subprocess.SubprocessError) as exc:
            setup_status(status="failed", message=f"{exc} Check the resource group for partial resources before retrying.")

    threading.Thread(target=run, daemon=True).start()
    return setup_status()


def live_query(mode, question, strategy, *, preview=False):
    source, base = names(mode)
    source_path = object_url("knowledgesources", source)
    if mode == "topic":
        from topic_api import vector_body
        params = request("GET", source_path)["searchIndexParameters"]
        fields = ",".join(field["name"] for field in params["searchFields"])
        select = ",".join(field["name"] for field in params["sourceDataFields"])
        index = params["searchIndexName"]
        result = query_request(object_url("indexes", index) + "/docs/search",
                               vector_body(question, fields, select, strategy),
                               preview=preview, lookup=source_path)
        if preview:
            return result
        documents = {"summary": "live-recap.json", "transcript": "transcript.json"}
        hits = []
        for row in result["value"]:
            key, kind = row.get("session_id"), row.get("source_kind")
            source_data = dict(row)
            if isinstance(key, str) and re.fullmatch(r"[a-f0-9]{32}", key) and kind in documents:
                source_data.update(documentName=documents[kind], documentUrl=f"/api/notes/document/{key}/{kind}")
            hits.append({"docKey": row.get("id"), "sourceData": source_data,
                         "@search.score": row.get("@search.score")})
        return {"references": hits, "topicSearch": {"index": index, "mode": strategy}}
    hydrate = {"kind": "hydrate", "hydrateDocuments": {"select": "uid,snippet,snippet_parent_id,blob_url"}}
    if mode == "entity" and strategy == "direct":
        definition = request("GET", source_path)
        graph = definition["azureBlobParameters"].get("createdResources", {}).get("graphIndex")
        if not graph:
            raise ValueError("The managed graph index is not ready. Check ingestion status.")
        return query_request(object_url("indexes", graph) + "/docs/search.graph", {
            "gql": GQL, "includeStatistics": True, "includeDiagnostics": True,
            "provenance": {**hydrate, "maxEvidencePerRow": 3},
        }, preview=preview, lookup=source_path)
    source_params = {"kind": "azureBlob",
                     "knowledgeSourceName": source, "includeReferences": True,
                     "includeReferenceSourceData": True, "failOnError": True}
    body = {"outputMode": "extractiveData", "includeActivity": True,
            "maxRuntimeInSeconds": 60, "knowledgeSourceParams": [source_params]}
    body["messages"] = [{"role": "user", "content": [{"type": "text", "text": question}]}]
    source_params["graphParameters"] = {"includeQuery": True, "provenance": {
        **hydrate, "hydrateDocuments": {**hydrate["hydrateDocuments"], "top": 8},
    }}
    return query_request(object_url("knowledgebases", base) + "/retrieve", body, preview=preview)


def index_browser(data):
    services = {"search": search_endpoint()}
    retriever = retriever_endpoint()
    if retriever != services["search"]:
        services["retriever"] = retriever
    action = data.get("action")
    if action == "services":
        return {"services": [{"id": key, "endpoint": endpoint} for key, endpoint in services.items()]}
    service = data.get("service")
    if not isinstance(service, str) or service not in services:
        raise ValueError("Select a configured Search service.")
    endpoint = services[service]
    if action == "indexes":
        result = request("GET", "/indexes", endpoint=endpoint)
        return {"indexes": sorted(item["name"] for item in result["value"])}
    if action != "documents":
        raise ValueError("Select a supported index browser action.")
    index, text, page = data.get("index"), data.get("search", ""), data.get("page", 0)
    if not isinstance(index, str) or not isinstance(text, str) or len(text) > 400:
        raise ValueError("Select an index and enter up to 400 characters of search text.")
    page_size = 10
    if type(page) is not int or not 0 <= page <= 100000 // page_size:
        raise ValueError("Azure AI Search limits browsing to an offset of 100,000.")
    path = object_url("indexes", index)
    fields = request("GET", path, endpoint=endpoint)["fields"]

    def display_fields(items, prefix=""):
        for field in items:
            if field.get("retrievable") is False or field.get("dimensions") is not None:
                continue
            name = prefix + field["name"]
            if field.get("fields"):
                yield from display_fields(field["fields"], name + "/")
            else:
                yield name

    selected = list(display_fields(fields))
    if not selected:
        raise ValueError("This index has no retrievable non-vector fields.")
    key = next((field for field in fields if field.get("key")), {})
    term = text.strip()
    body = {"search": term or "*", "queryType": "simple", "count": True,
            "select": ",".join(selected), "skip": page * page_size, "top": page_size + 1}
    string_fields = {f["name"]: f for f in fields if f["type"] == "Edm.String" and f["name"] in selected}
    chunk_fields = [name for name in ("snippet", "content") if string_fields.get(name, {}).get("searchable")
                    and (name == "snippet" or "session_id" in string_fields)]
    exact_field = None
    exact = re.fullmatch(r'(?:"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\s*:\s*(.+)', term)
    if exact and (name := exact[1] or exact[2]) in string_fields:
        if not string_fields[name].get("filterable"):
            raise ValueError(f"{name} does not support exact filtering. Search for keywords instead.")
        value = exact[3]
        if value.startswith('"'):
            try:
                value, end = json.JSONDecoder().raw_decode(value)
                if exact[3][end:].strip() not in ("", ","):
                    raise ValueError
            except ValueError:
                raise ValueError(f'Paste the full value, for example "{name}": "value".') from None
        escaped = value.replace("'", "''")
        body.update(search="*", filter=f"{name} eq '{escaped}'")
        exact_field = name
    elif term and term != "*":
        body["searchMode"] = "all"
        if chunk_fields:
            body["searchFields"] = ",".join(chunk_fields)
    if body["search"] == "*" and key.get("sortable"):
        body["orderby"] = key["name"] + " asc"
    result = request("POST", path + "/docs/search", body, endpoint=endpoint)
    rows = result["value"]
    return {"documents": rows[:page_size], "count": result.get("@odata.count"), "keyField": key.get("name"),
            "exactField": exact_field, "chunkFields": chunk_fields,
            "relationshipIndex": {"subject", "predicate", "object"} <= string_fields.keys(),
            "start": page * page_size, "hasNext": len(rows) > page_size and page < 100000 // page_size}


def provision(args, *, endpoint=None, resume=False):
    source, base = names(args.mode)
    src_path, kb_path = object_url("knowledgesources", source), object_url("knowledgebases", base)
    kb = {"name": base, "knowledgeSources": [{"name": source}], "outputMode": "extractiveData"}
    src = {"name": source, "resultsProcessing": "none"}
    if args.mode == "topic":
        from topic_api import base_body, source_body
        definition = request("GET", object_url("indexes", args.content_index), endpoint=endpoint)
        fields = {f["name"]: f for f in definition["fields"]}
        vector = fields.get(args.vector, {})
        profiles = definition.get("vectorSearch", {}).get("topicGraphProfiles", [])
        topic_index = next((p["indexName"] for p in profiles if p["name"] == vector.get("topicGraphProfile")), None)
        if not topic_index or fields.get(args.content, {}).get("retrievable") is not True:
            raise ValueError("Content index must have a bound topic graph profile and a retrievable text field.")
        request("GET", object_url("indexes", topic_index), endpoint=endpoint)
        src = source_body(source, args.content_index, args.vector, args.content, 1000)
        kb = base_body(base, source)
        kb["models"] = [{"kind": "microsoftRetriever1"}, foundry_model()]
    else:
        if not re.fullmatch(r"/subscriptions/[\w-]+/resourceGroups/[\w.()-]+/providers/Microsoft\.Storage/storageAccounts/[a-z0-9]{3,24}", args.storage_id, re.I):
            raise ValueError("Pass the full Blob storage account Resource ID.")
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]", args.container):
            raise ValueError("Invalid Blob container name.")
        embedding_deployment = args.embedding
        chat = foundry_model(args.chat, args.chat_model)
        src.update(kind="azureBlob", azureBlobParameters={
            "connectionString": f"ResourceId={args.storage_id}", "containerName": args.container,
            "ingestionParameters": {"contentExtractionMode": "minimal", "disableImageVerbalization": True,
                                    "chatCompletionModel": chat,
                                    "embeddingModel": foundry_model(embedding_deployment, args.embedding_model)},
            "graphExtraction": {"graphName": source, "pageDegreeOfParallelism": 2,
                                "ontology": {"kind": "inline", "value": json.dumps(ontology())}},
        })
        kb.update(models=[{"kind": "microsoftRetriever1"}, chat], retrievalReasoningEffort={"kind": "low"},
                  retrievalInstructions="Use graph_search for relationship questions. Traverse the graph instead of ordinary text search.")
    if not args.confirm:
        raise ValueError(f"Would create {source} and {base} on {search_endpoint()}. Review the target and rerun with --confirm.")
    def create(path, definition):
        try:
            request("PUT", path, definition, create=True, endpoint=endpoint)
        except AzureError as exc:
            if not resume or exc.status not in (409, 412):
                raise
            existing = request("GET", path, endpoint=endpoint)
            if "kind" in definition and existing.get("kind") != definition["kind"]:
                raise ValueError(f"{path} exists with a different kind.")
            if "knowledgeSources" in definition and (
                [item["name"] for item in existing.get("knowledgeSources", [])]
                != [item["name"] for item in definition["knowledgeSources"]]
            ):
                raise ValueError(f"{path} references a different knowledge source.")
            if "azureBlobParameters" in definition and (
                existing["azureBlobParameters"]["containerName"] != definition["azureBlobParameters"]["containerName"]
            ):
                raise ValueError(f"{path} uses another Blob container.")
            if "searchIndexParameters" in definition and (
                existing["searchIndexParameters"]["searchIndexName"] != definition["searchIndexParameters"]["searchIndexName"]
            ):
                raise ValueError(f"{path} uses another content index.")
            if path == kb_path:
                models = existing.get("models") or []
                if not any(model.get("kind") == "microsoftRetriever1" for model in models):
                    etag = existing.get("@odata.etag")
                    if not etag:
                        raise ValueError(f"{path} did not return an ETag; refusing to overwrite the existing base.")
                    update = {key: value for key, value in existing.items() if not key.startswith("@odata.")}
                    update["models"] = [{"kind": "microsoftRetriever1"}, *models]
                    request("PUT", path, update, endpoint=endpoint, if_match=etag)

    create(src_path, src)
    print(f"Knowledge source ready: {source}.")
    create(kb_path, kb)
    print(f"Knowledge base ready: {base}.")


class Handler(BaseHTTPRequestHandler):
    def response(self, status, data, content_type="application/json; charset=utf-8"):
        payload = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def permitted(self):
        host = f"127.0.0.1:{self.server.server_port}"
        origin = self.headers.get("Origin")
        if self.headers.get("Host") != host or (origin and origin != f"http://{host}"):
            self.response(403, {"error": "Only same-origin loopback access is allowed."})
            return False
        return True

    def do_GET(self):
        if not self.permitted():
            return
        static = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
                  "/app.js": ("app.js", "text/javascript"), "/topic-api.js": ("topic-api.js", "text/javascript"),
                  "/index-browser.js": ("index-browser.js", "text/javascript"),
                  "/vendor/cytoscape.min.js": (os.path.join("vendor", "cytoscape.min.js"), "text/javascript")}
        if self.path in static:
            file, mime = static[self.path]
            self.response(200, (HERE / file).read_bytes(), f"{mime}; charset=utf-8")
        elif self.path == "/api/config":
            self.handle_action(lambda: {"endpoint": search_endpoint(), "apiVersion": API,
                                       "retrieverEndpoint": retriever_endpoint(),
                                       "demoStorage": os.getenv("GRAPH_DEMO_STORAGE_ID", ""),
                                       "subscription": azure_config()["modelScope"].split("/")[2]})
        elif self.path in {"/api/retriever/setup", "/api/deploy"}:
            self.handle_action(setup_status)
        elif self.path == "/api/retriever/targets":
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.response(403, {"error": "Open the Retriever 1 playground from Graph Lab."})
                return
            self.handle_action(retriever_targets)
        elif self.path in {"/api/deploy/inventory", "/api/retriever/setup/inventory"}:
            self.handle_action(lambda: setup_inventory(full=self.path == "/api/deploy/inventory"))
        elif self.path == "/api/topic-console/defaults":
            from topic_api import defaults
            self.handle_action(defaults)
        elif self.path == "/api/topic-linkage":
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.response(403, {"error": "Open the Topic Graph playground from Graph Lab."})
                return
            from topic_api import topic_linkage
            self.handle_action(topic_linkage)
        elif self.path == "/api/entity-console/defaults":
            from topic_api import entity_defaults
            self.handle_action(entity_defaults)
        elif self.path == "/api/notes/sources":
            self.handle_action(note_catalog)
        elif match := re.fullmatch(r"/api/notes/document/([a-f0-9]{32})/(summary|transcript)", self.path):
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.response(403, {"error": "Open documents from Graph Lab."})
                return
            try:
                session = note_sessions().get(match[1])
                file = next((p for p, kind in session[2] if kind == match[2]), None) if session else None
                if file is None:
                    self.response(404, {"error": "Source document not found."})
                    return
                content = file.read_bytes()
            except OSError:
                self.response(404, {"error": "Source document is no longer available."})
                return
            self.response(200, content, "application/json; charset=utf-8")
        else:
            self.response(404, {"error": "Not found."})

    def handle_action(self, operation):
        try:
            self.response(200, operation())
        except (ValueError, OSError, ImportError, KeyError) as exc:
            self.response(400, {"error": str(exc)})

    def do_POST(self):
        if not self.permitted():
            return
        if self.path not in {"/api/query", "/api/query/preview", "/api/status", "/api/retriever/setup", "/api/deploy",
                             "/api/topic-console", "/api/entity-console", "/api/index-browser", "/api/retriever/run"}:
            self.response(404, {"error": "Not found."})
            return

        def run():
            length = int(self.headers.get("Content-Length", "0"))
            limit = 131072 if self.path == "/api/query" else 8192
            if self.headers.get_content_type() != "application/json" or not 1 <= length <= limit:
                raise ValueError(f"Expected a JSON request up to {limit // 1024} KB.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object.")
            preview = self.path == "/api/query/preview"
            if preview and self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                raise ValueError("Open the query preview from the loopback web UI.")
            if self.path == "/api/index-browser":
                if self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                    raise ValueError("Use the Index Browser from the loopback web UI.")
                return index_browser(data)
            if self.path == "/api/retriever/run":
                if self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                    raise ValueError("Use the Retriever 1 playground from the loopback web UI.")
                return retriever_playground(data)
            if self.path in {"/api/topic-console", "/api/entity-console"}:
                if self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                    raise ValueError("Use the graph API examples from the loopback web UI.")
                from topic_api import console
                return console(data, entity=self.path == "/api/entity-console")
            if self.path in {"/api/retriever/setup", "/api/deploy"}:
                if self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
                    raise ValueError("Start provisioning from the loopback web UI.")
                return start_setup(data, full=self.path == "/api/deploy")
            mode = data.get("mode")
            if mode not in ("topic", "entity", "retriever"):
                raise ValueError("Select Topic, Entity, or Retriever 1.")
            if self.path == "/api/status":
                source, base = names(mode)
                endpoint = retriever_endpoint() if mode == "retriever" else None
                definition = request("GET", object_url("knowledgesources", source), endpoint=endpoint)
                kb = request("GET", object_url("knowledgebases", base), endpoint=endpoint)
                if mode == "retriever":
                    return {"source": source, "base": base,
                            "endpoint": endpoint,
                            "index": definition["searchIndexParameters"]["searchIndexName"],
                            "modelKinds": [model["kind"] for model in kb["models"]]}
                if mode == "topic":
                    return {"source": source, "base": base, "topicGraph": definition["searchIndexParameters"]["topicGraph"]}
                return {"source": source, "base": base,
                        "createdResources": definition["azureBlobParameters"].get("createdResources"),
                        "ingestion": request("GET", object_url("knowledgesources", source) + "/status")}
            dataset, strategy = data.get("dataset"), data.get("strategy")
            if mode == "retriever":
                question = data.get("question")
                if dataset != "azure" or strategy not in ("answer", "extractive"):
                    raise ValueError("Microsoft Retriever 1 requires live Foundry IQ and a supported output mode.")
                if not isinstance(question, str) or not 1 <= len(question.strip()) <= 1600:
                    raise ValueError("Enter a question of 1–1,600 characters.")
                return retriever_query(question.strip(), strategy, preview=preview)
            if dataset != "azure" or strategy not in (
                ("balanced", "diverse", "none") if mode == "topic" else ("natural", "direct")
            ):
                raise ValueError("Unsupported dataset or strategy.")
            question = data.get("question", "")
            if not isinstance(question, str) or len(question) > 1600 or (strategy != "direct" and not question.strip()):
                raise ValueError("Enter a question of 1–1,600 characters.")
            return live_query(mode, question.strip(), strategy, preview=preview)

        self.handle_action(run)


def main():
    parser = argparse.ArgumentParser(description="NoteAssistant Foundry IQ graph lab")
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    export = commands.add_parser("export")
    export.add_argument("directory", type=Path)
    export.add_argument("--dataset", choices=("synthetic", "notes"), default="synthetic")
    setup = commands.add_parser("provision")
    modes = setup.add_subparsers(dest="mode", required=True)
    topic = modes.add_parser("topic")
    topic.add_argument("--content-index", required=True)
    topic.add_argument("--content", default="content")
    topic.add_argument("--vector", default="embedding")
    entity = modes.add_parser("entity")
    entity.add_argument("--storage-id", required=True)
    entity.add_argument("--container", required=True)
    entity.add_argument("--chat")
    entity.add_argument("--chat-model")
    entity.add_argument("--embedding", default="text-embedding-3-large")
    entity.add_argument("--embedding-model")
    retriever = modes.add_parser("retriever")
    for mode in (topic, entity, retriever):
        mode.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "provision":
            if args.mode == "retriever":
                provision_retriever(args.confirm)
            else:
                provision(args)
        elif args.command == "export":
            corpus = list(samples()) if args.dataset == "notes" else SYNTHETIC
            args.directory.mkdir(parents=True, exist_ok=False)
            for i, (title, kind, text, *_) in enumerate(corpus, 1):
                (args.directory / f"{i:02}-{kind}.txt").write_text(f"{title} ({kind})\n\n{text}", encoding="utf-8")
            print(f"Exported {len(corpus)} text files locally. Nothing was uploaded.")
        else:
            server = ThreadingHTTPServer(("127.0.0.1", getattr(args, "port", 8765)), Handler)
            print(f"Open http://127.0.0.1:{server.server_port}", flush=True)
            with server:
                server.serve_forever()
    except (ValueError, OSError, ImportError, KeyError) as exc:
        parser.exit(1, f"{exc}\n")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.modules.setdefault("lab", sys.modules[__name__])
    main()
