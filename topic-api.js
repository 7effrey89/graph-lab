{
  const get = id => document.getElementById(`topic-api-${id}`);
  const variables = [
    ["SEARCH_ENDPOINT", "Azure AI Search HTTPS endpoint"], ["API_VERSION", "Search REST API version"],
    ["CONTENT_INDEX_NAME", "Content index"], ["TOPIC_INDEX_NAME", "Companion topic index (TOPIC_INDEX_NAME)"],
    ["VECTOR_FIELD_NAME", "Vector field"], ["CONTENT_FIELD_NAME", "Returned text field"],
    ["KNOWLEDGE_SOURCE_NAME", "Knowledge source"], ["KNOWLEDGE_BASE_NAME", "Knowledge base"],
    ["QUESTION", "Question"], ["MIN_DIVERSITY_POOL_SIZE", "Minimum diversity pool size"],
    ["DIVERSITY_FACTOR", "Diversity factor"], ["TOP", "Direct vector result count"],
  ];
  const steps = {
    content: ["set-up-requests", "Read the content index to check its vectorizer and topic profile.",
      "# Read the vector field's topicGraphProfile on the content index.\nindex_client.get_index(os.environ[\"CONTENT_INDEX_NAME\"])"],
    topics: ["set-up-requests", "Read the topic index referenced by the content profile.",
      "# Use the indexName from the matching profile on the content index.\nindex_client.get_index(os.environ[\"TOPIC_INDEX_NAME\"])"],
    "create-source": ["create-the-knowledge-source", "Create a separate searchIndex source with stored Balanced settings.",
      `# Reference the vector content index, not the companion topic index (TOPIC_INDEX_NAME).
params = SearchIndexKnowledgeSourceParameters(
    search_index_name=os.environ["CONTENT_INDEX_NAME"],
    search_fields=[SearchIndexFieldReference(name=os.environ["VECTOR_FIELD_NAME"])],
    source_data_fields=[SearchIndexFieldReference(name=os.environ["CONTENT_FIELD_NAME"])],
    topic_graph=BalancedVectorQueryTopicGraph(
        min_diversity_pool_size=int(os.environ["MIN_DIVERSITY_POOL_SIZE"])
    ),
)
topic_source = SearchIndexKnowledgeSource(
    name=os.environ["KNOWLEDGE_SOURCE_NAME"],
    results_processing="none",
    search_index_parameters=params,
)
# Learn uses create-or-update. Graph Lab uses a create-only REST request.
index_client.create_or_update_knowledge_source(topic_source)`],
    source: ["create-the-knowledge-source", "Inspect the stored index, fields and topicGraph settings.",
      "index_client.get_knowledge_source(os.environ[\"KNOWLEDGE_SOURCE_NAME\"])"],
    "create-base": ["attach-the-source-to-a-knowledge-base", "Create a separate extractive knowledge base that references the selected source.",
      `# A knowledge base references the source by name, not the indexes directly.
topic_base = KnowledgeBase(
    name=os.environ["KNOWLEDGE_BASE_NAME"],
    knowledge_sources=[KnowledgeSourceReference(name=os.environ["KNOWLEDGE_SOURCE_NAME"])],
    retrieval_reasoning_effort=KnowledgeRetrievalMinimalReasoningEffort(),
    output_mode=KnowledgeRetrievalOutputMode.EXTRACTIVE_DATA,
)
# Learn uses create-or-update. Graph Lab uses a create-only REST request.
index_client.create_or_update_knowledge_base(topic_base)`],
    base: ["attach-the-source-to-a-knowledge-base", "Verify the source reference, reasoning effort and output mode.",
      "index_client.get_knowledge_base(os.environ[\"KNOWLEDGE_BASE_NAME\"])"],
    stored: ["retrieve-with-the-stored-settings", "Leave topicGraph out of the request to use the source's stored settings.",
      `# Leave topic_graph unset to use the source's saved sampling settings.
source_params = SearchIndexKnowledgeSourceParams(
    knowledge_source_name=os.environ["KNOWLEDGE_SOURCE_NAME"],
    include_references=True,
    include_reference_source_data=True,
)
request = KnowledgeBaseRetrievalRequest(
    intents=[KnowledgeRetrievalSemanticIntent(search=os.environ["QUESTION"])],
    retrieval_reasoning_effort=KnowledgeRetrievalMinimalReasoningEffort(),
    output_mode=KnowledgeRetrievalOutputMode.EXTRACTIVE_DATA,
    include_activity=True,
    knowledge_source_params=[source_params],
)
retrieval_client.retrieve(request)`],
    diverse: ["override-topic-selection-for-one-request", "Set diversityFactor and minDiversityPoolSize for this request only.",
      "# Override sampling on the request without updating the saved source.\nsource_params.topic_graph = DiverseVectorQueryTopicGraph(\n    diversity_factor=float(os.environ[\"DIVERSITY_FACTOR\"]),\n    min_diversity_pool_size=int(os.environ[\"MIN_DIVERSITY_POOL_SIZE\"]),\n)\nretrieval_client.retrieve(request)"],
    none: ["disable-topic-sampling-for-one-request", "Disable sampling for this request without changing the source.",
      "# Explicitly disable sampling; omitting the override uses the saved settings.\nsource_params.topic_graph = NoneVectorQueryTopicGraph()\nretrieval_client.retrieve(request)"],
  };
  const inputs = {};
  for (const [name, description] of variables) {
    const label = document.createElement("label");
    label.textContent = description;
    const code = document.createElement("code");
    code.textContent = name;
    const input = document.createElement(name === "QUESTION" ? "textarea" : "input");
    input.name = name;
    input.maxLength = name === "QUESTION" ? 1600 : 128;
    input.autocomplete = "off";
    if (name === "QUESTION") input.rows = 2;
    label.append(code, input);
    get("variables").append(label);
    inputs[name] = input;
  }

  function operation() {
    return get("operation").value;
  }

  function displayOperation() {
    const selected = operation();
    const step = steps[selected];
    get("confirm-label").hidden = !selected.startsWith("create-");
    get("confirm").checked = false;
    get("operation-note").textContent = step?.[1] ||
      "This uses /docs/search directly, not the knowledge-base API. Graph Lab uses the vector field profile when no override is sent.";
    get("learn").hash = step?.[0] || "set-up-requests";
    renderCode(get("sdk"), step?.[2] ||
      "# Graph Lab extension: direct vector search.\n# See the REST and Python helper snippets above.", "python");
  }

  async function jsonRequest(path, options) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  const linkPart = id => document.getElementById(`topic-link-${id}`);
  const linkSelect = linkPart("select");
  const linkChunkSelect = linkPart("chunk-select");
  const linkDiagram = linkPart("diagram");
  let linkData;
  let linkGraph;
  let linkGraphLaidOut = false;
  let chunkRequest;

  function resizeTopicLink() {
    if (!linkGraph || !linkDiagram.clientWidth) return;
    linkGraph.resize();
    if (!linkGraphLaidOut) {
      linkGraph.layout({name: "breadthfirst", directed: true, roots: "node.topic-root",
        avoidOverlap: true, spacingFactor: 1.15, padding: 18, animate: false}).run();
      linkGraphLaidOut = true;
    }
  }
  new ResizeObserver(resizeTopicLink).observe(linkDiagram);

  function showLinkInspection(title, message, value) {
    linkPart("chunk-title").textContent = title;
    linkPart("chunk-status").textContent = message;
    const json = linkPart("json");
    json.hidden = value === undefined;
    if (value !== undefined) {
      renderCode(json, JSON.stringify(value, null, 2), "json");
      json.scrollTop = 0;
    }
  }

  async function showLinkedChunk(key) {
    chunkRequest?.abort();
    const request = new AbortController();
    chunkRequest = request;
    showLinkInspection(key, "Reading this chunk from Azure Search…");
    const inspector = linkPart("chunk");
    const top = inspector.getBoundingClientRect().top;
    if (top < document.querySelector(".process-header").getBoundingClientRect().bottom ||
        top + 120 > window.innerHeight) {
      inspector.scrollIntoView({block: "start"});
    }
    try {
      const {documents} = await jsonRequest("/api/index-browser", {
        method: "POST", headers: {"Content-Type": "application/json"}, signal: request.signal,
        body: JSON.stringify({action: "documents", service: "search", index: linkData.contentIndex,
          search: `${linkData.keyField}: ${JSON.stringify(key)}`}),
      });
      if (request.signal.aborted) return;
      const doc = documents.find(row => row[linkData.keyField] === key);
      if (!doc) throw new Error("This build member no longer exists in the content index.");
      showLinkInspection(key, "Live Search document · retrievable non-vector fields", doc);
    } catch (error) {
      if (!request.signal.aborted) showLinkInspection(key, error.message);
    }
  }

  function drawTopicLink() {
    chunkRequest?.abort();
    showLinkInspection("Graph inspector", "Select a chunk or a HasSubTopic arrow to inspect it.");
    const topics = linkData.topics;
    const focus = topics.find(topic => String(topic.id) === linkSelect.value);
    const shown = new Set(focus ? [focus.id] : topics.map(topic => topic.id));
    if (focus) {
      for (const id of shown) {
        for (const topic of topics) if (topic.parent === id) shown.add(topic.id);
      }
    }
    const chunkKeys = [...new Set(topics.flatMap(topic => topic.chunks))];
    const chunkNumbers = new Map(chunkKeys.map((key, index) => [key, index + 1]));
    const chunks = new Map();
    const elements = [];
    for (const topic of topics.filter(topic => shown.has(topic.id))) {
      const id = `topic:${topic.id}`;
      const hasParent = shown.has(topic.parent);
      elements.push({data: {id, label: `${topic.label} · ${topic.count}`, topicId: String(topic.id)},
        classes: hasParent ? "topic-node" : "topic-node topic-root"});
      if (hasParent) {
        elements.push({data: {source: `topic:${topic.parent}`, target: id, predicate: "HasSubTopic"},
          classes: "topic-edge"});
      }
      for (const key of topic.chunks) {
        const number = chunkNumbers.get(key);
        const chunkId = `chunk:${number}`;
        if (!chunks.has(chunkId)) {
          chunks.set(chunkId, key);
          elements.push({data: {id: chunkId, key, label: `Chunk ${number}`}, classes: "chunk-node"});
        }
        elements.push({data: {source: id, target: chunkId}, classes: "membership-edge"});
      }
    }
    linkChunkSelect.replaceChildren(new Option("Select a chunk", ""), ...Array.from(chunks,
      ([id, key]) => new Option(`Chunk ${chunkNumbers.get(key)} · ${key}`, id)));
    linkChunkSelect.disabled = !chunks.size;

    linkGraph?.destroy();
    linkGraphLaidOut = false;
    const graph = linkGraph = window.cytoscape({
      container: linkDiagram, elements, minZoom: .05, maxZoom: 4, autounselectify: true,
      layout: {name: "preset", fit: false},
      style: [
        {selector: "node", style: {label: "data(label)", color: "#eff6fc", "font-size": 13,
          "text-outline-color": "#0e151d", "text-outline-width": 2, "text-valign": "bottom",
          "text-margin-y": 4, "min-zoomed-font-size": 6}},
        {selector: ".topic-node", style: {"background-color": "#ad91ef", width: 26, height: 26,
          "text-wrap": "ellipsis", "text-max-width": 130}},
        {selector: ".chunk-node", style: {"background-color": "#70b7ff", shape: "round-rectangle",
          width: 18, height: 15}},
        {selector: "edge", style: {"curve-style": "bezier", width: 2}},
        {selector: ".topic-edge", style: {"line-color": "#ad91ef", "target-arrow-shape": "triangle",
          "target-arrow-color": "#ad91ef", label: "data(predicate)", color: "#e0d4ff", "font-size": 13,
          "text-outline-color": "#0e151d", "text-outline-width": 2, "text-margin-y": -8}},
        {selector: ".membership-edge", style: {"line-color": "#70b7ff", "line-style": "dashed", opacity: .65}},
        {selector: "node.is-picked", style: {"border-width": 3, "border-color": "#eff6fc"}},
        {selector: "edge.is-picked", style: {width: 4}},
      ],
    });
    function selectChunk(id) {
      graph.elements().removeClass("is-picked");
      linkChunkSelect.value = id;
      if (!id) {
        chunkRequest?.abort();
        showLinkInspection("Graph inspector", "Select a chunk or a HasSubTopic arrow to inspect it.");
        return;
      }
      graph.getElementById(id).addClass("is-picked");
      showLinkedChunk(chunks.get(id));
    }
    linkChunkSelect.onchange = () => selectChunk(linkChunkSelect.value);
    linkPart("fit").onclick = () => { resizeTopicLink(); if (elements.length) graph.fit(graph.elements(), 18); };
    graph.on("tap", "node.topic-node", event => {
      linkSelect.value = event.target.data("topicId");
      drawTopicLink();
    });
    graph.on("tap", "node.chunk-node", event => selectChunk(event.target.id()));
    graph.on("tap", "edge.topic-edge", event => {
      const {source, predicate, target} = event.target.data();
      chunkRequest?.abort();
      linkChunkSelect.value = "";
      graph.elements().removeClass("is-picked");
      event.target.addClass("is-picked");
      showLinkInspection(predicate, "Verified Azure Search topic edge · subject, predicate, and object",
        {subject_id: source, predicate, object_id: target});
    });
    graph.on("tap", "edge.membership-edge", event => selectChunk(event.target.data("target")));
    resizeTopicLink();
  }

  linkSelect.addEventListener("change", drawTopicLink);
  linkPart("load").addEventListener("click", async event => {
    const button = event.currentTarget;
    const status = linkPart("status");
    button.disabled = true;
    chunkRequest?.abort();
    linkPart("inspect").hidden = true;
    linkPart("chain").textContent = "";
    status.textContent = "Checking the live index link and builder release…";
    try {
      if (typeof window.cytoscape !== "function") throw new Error("Could not load the local Cytoscape.js bundle.");
      linkData = await jsonRequest("/api/topic-linkage");
      const {contentIndex, vectorField, profile, topicIndex, release, topics} = linkData;
      linkPart("chain").textContent = `${contentIndex}.${vectorField} → ${profile} → ${topicIndex}`;
      linkSelect.replaceChildren(new Option("All topics", ""), ...topics.map(topic => new Option(
        `${topic.label} (${topic.count} chunks)`, String(topic.id))));
      linkPart("inspect").hidden = false;
      drawTopicLink();
      status.textContent = `${topics.length} topics · verified builder release ${release}`;
      button.textContent = "Refresh linkage";
    } catch (error) {
      linkPart("inspect").hidden = true;
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function showSnippets({method, endpoint, path, apiVersion, body}) {
    const payload = JSON.stringify(body, null, 2);
    const create = method === "PUT";
    renderCode(get("http"), `${method} ${endpoint}${path}?api-version=${apiVersion}\nAuthorization: Bearer <server-side Entra token>`
      + (create ? "\nIf-None-Match: *" : "")
      + (body === null ? "" : `\nContent-Type: application/json\n\n${payload}`), "http");
    renderCode(get("python"), `import json\nfrom lab import request\n\n`
      + `endpoint = ${JSON.stringify(endpoint)}\napi_version = ${JSON.stringify(apiVersion)}\n`
      + (body === null ? "body = None\n" : `body = json.loads(${JSON.stringify(payload)})\n`)
      + `\n# The helper adds an Entra bearer token.${create ? " create=True prevents overwriting an existing resource." : ""}\n`
      + `result = request(${JSON.stringify(method)}, ${JSON.stringify(path)}, body,\n`
      + `                 endpoint=endpoint, api_version=api_version,${create ? " create=True," : ""}\n`
      + `                 capture=True)\nprint(json.dumps(result, indent=2))`, "python");
  }

  function busy(value) {
    for (const item of Object.values(inputs)) item.disabled = value;
    for (const id of ["operation", "reset", "preview", "confirm", "run"]) get(id).disabled = value;
  }

  async function send(preview) {
    busy(true);
    get("status").classList.remove("error");
    get("status").textContent = preview ? "Preparing snippets…" : "Waiting for Azure…";
    if (!preview) {
      get("response").textContent = "";
      get("response-meta").textContent = "Waiting for Azure…";
    }
    try {
      const {request, azure, elapsedMs} = await jsonRequest("/api/topic-console", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({operation: operation(), preview, confirmCreate: get("confirm").checked,
          variables: Object.fromEntries(variables.map(([name]) => [name, inputs[name].value]))}),
      });
      showSnippets(request);
      get("status").textContent = preview ? "Snippets reflect the current fields. No Azure request was sent." : "";
      if (azure) {
        get("response-meta").textContent = `Azure HTTP ${azure.status} · ${elapsedMs} ms`
          + (azure.requestId ? ` · Request ID: ${azure.requestId}` : "");
        if (azure.body === null) get("response").textContent = "(No response body)";
        else renderCode(get("response"), JSON.stringify(azure.body, null, 2), "json");
      }
    } catch (error) {
      get("status").textContent = error.message;
      get("status").classList.add("error");
      get("http").textContent = get("python").textContent = "";
      if (!preview) get("response-meta").textContent = "No Azure response.";
    } finally {
      busy(false);
    }
  }

  async function reset(defaultsRequest) {
    busy(true);
    get("defaults-status").textContent = "Reading active Azure configuration…";
    try {
      const {variables: defaults, warning} = await defaultsRequest;
      for (const [name, input] of Object.entries(inputs)) input.value = defaults[name] ?? "";
      get("defaults-status").textContent = warning || "Loaded from the active Topic Graph source and content index.";
    } catch (error) {
      get("defaults-status").textContent = error.message;
    } finally {
      busy(false);
    }
    await send(true);
  }

  get("form").addEventListener("submit", event => { event.preventDefault(); send(false); });
  get("preview").addEventListener("click", () => send(true));
  get("reset").addEventListener("click", () => reset(jsonRequest("/api/topic-console/defaults")));
  get("operation").addEventListener("change", () => { displayOperation(); send(true); });
  get("variables").addEventListener("input", () => {
    get("confirm").checked = false;
    get("status").classList.remove("error");
    get("status").textContent = "Fields edited. Update snippets to preview or run the API with the new values.";
  });

  function sdkSample(operation, values) {
    const literal = name => JSON.stringify(values[name].trim());
    const graphClass = {diverse: "DiverseVectorQueryTopicGraph", none: "NoneVectorQueryTopicGraph"}[operation];
    const override = operation === "diverse"
      ? `    topic_graph=${graphClass}(\n        diversity_factor=float(${literal("DIVERSITY_FACTOR")}),\n        min_diversity_pool_size=int(${literal("MIN_DIVERSITY_POOL_SIZE")}),\n    ),\n`
      : graphClass ? `    topic_graph=${graphClass}(),\n` : "";
    return `from azure.identity import DefaultAzureCredential
from azure.search.documents.knowledgebases import KnowledgeBaseRetrievalClient
from azure.search.documents.knowledgebases.models import (
    KnowledgeBaseRetrievalRequest,
    KnowledgeRetrievalMinimalReasoningEffort,
    KnowledgeRetrievalSemanticIntent,
    SearchIndexKnowledgeSourceParams,
)
${graphClass ? `from azure.search.documents.models import ${graphClass}\n` : ""}
client = KnowledgeBaseRetrievalClient(
    endpoint=${literal("SEARCH_ENDPOINT")},
    knowledge_base_name=${literal("KNOWLEDGE_BASE_NAME")},
    credential=DefaultAzureCredential(),
)
${graphClass ? "# Override topic sampling for this request only; the source stays unchanged." : "# Omitting topic_graph uses the saved sampling settings on the source."}
source = SearchIndexKnowledgeSourceParams(
    knowledge_source_name=${literal("KNOWLEDGE_SOURCE_NAME")},
    include_references=True,
    include_reference_source_data=True,
${override})
result = client.retrieve(KnowledgeBaseRetrievalRequest(
    intents=[KnowledgeRetrievalSemanticIntent(search=${literal("QUESTION")})],
    retrieval_reasoning_effort=KnowledgeRetrievalMinimalReasoningEffort(),
    output_mode=${JSON.stringify(values.OUTPUT_MODE ?? "extractiveData")},
    include_activity=True,
    knowledge_source_params=[source],
))`;
  }

  function projectedRelationships(gql, rows) {
    if (typeof gql !== "string" || !Array.isArray(rows)) return [];
    // Only draw simple directed MATCH paths whose two endpoint names are projected.
    const node = /\(\s*(\w+)\s*(?::\s*`?(\w+)`?\s*)?\)/;
    const edge = /-\[\s*(\w+)?\s*(?::\s*`?(\w+)`?\s*)?\]->/;
    const path = new RegExp(`^\\s*MATCH\\s+(${node.source}(?:\\s*${edge.source}\\s*${node.source})+)\\s+(?:WHERE\\s+([\\s\\S]+?)\\s+)?RETURN\\s+([\\s\\S]+?)\\s*;?\\s*$`, "i");
    const query = path.exec(gql);
    if (!query) return [];
    const pattern = query[1];
    const filter = query.at(-2);
    if (filter && /\b(?:MATCH|WITH|RETURN|UNION|UNWIND|OPTIONAL)\b/i.test(filter)) return [];
    const projection = query.at(-1).replace(/\s+(?:ORDER\s+BY|LIMIT|SKIP)\s+[\s\S]+$/i, "");
    const names = new Map();
    for (const column of projection.split(",")) {
      const property = /^\s*(\w+)\.name(?:\s+AS\s+`?(\w+)`?)?\s*$/i.exec(column);
      if (property) names.set(property[1], property[2] ?? `${property[1]}.name`);
    }
    const predicates = new Map();
    if (filter) {
      const conditions = filter.split(/\s+AND\s+/i).map(condition =>
        /^\s*(\w+)\.(\w+)\s*=\s*(['"])([^'"]*)\3\s*$/.exec(condition));
      if (conditions.every(Boolean)) {
        for (const [, alias, property, , value] of conditions) {
          if (property === "predicate" && /^\w+$/.test(value)) predicates.set(alias, value);
        }
      }
    }
    const nodes = [...pattern.matchAll(new RegExp(node.source, "g"))];
    const edges = [...pattern.matchAll(new RegExp(edge.source, "g"))];
    return edges.flatMap(([, alias, label], index) => {
      const [, from, fromType] = nodes[index];
      const [, to, toType] = nodes[index + 1];
      const predicate = label ?? predicates.get(alias);
      if (!predicate || !names.has(from) || !names.has(to)) return [];
      return rows.flatMap(row => {
        const source = row?.[names.get(from)], target = row?.[names.get(to)];
        return typeof source === "string" && source.trim() && typeof target === "string" && target.trim()
          ? [{source, fromType, predicate, target, toType}] : [];
      });
    });
  }

  function renderRelationshipDiagram(out, relationships, element) {
    const groups = new Map();
    for (const link of relationships) {
      const key = JSON.stringify([link.fromType, link.source, link.predicate]);
      if (!groups.has(key)) groups.set(key, {link, targets: new Map()});
      groups.get(key).targets.set(JSON.stringify([link.toType, link.target]), link);
    }
    let remaining = 40;
    const node = (name, type, role) => {
      const box = element("div", undefined, `entity-graph-node ${role}`);
      box.title = name;
      box.append(element("small", type || (role === "source" ? "Source" : "Target")), element("strong", name));
      return box;
    };
    for (const {link, targets} of groups.values()) {
      if (!remaining) break;
      const items = [...targets.values()].slice(0, remaining);
      remaining -= items.length;
      const group = element("div", undefined, "entity-graph-group");
      const relation = element("div", undefined, "entity-graph-relation");
      relation.append(element("span", link.predicate));
      const branch = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const height = items.length * 52, center = height / 2;
      branch.setAttribute("viewBox", `0 0 100 ${height}`);
      branch.setAttribute("preserveAspectRatio", "none");
      branch.setAttribute("aria-hidden", "true");
      items.forEach((_, i) => {
        const y = 26 + i * 52;
        const arrow = document.createElementNS(branch.namespaceURI, "path");
        arrow.setAttribute("d", `M0 ${center} C42 ${center} 50 ${y} 95 ${y} M88 ${y - 4} L95 ${y} L88 ${y + 4}`);
        branch.append(arrow);
      });
      relation.append(branch);
      const leaves = element("ul", undefined, "entity-graph-targets");
      for (const item of items) {
        const leaf = element("li");
        leaf.append(node(item.target, item.toType, "target"));
        leaves.append(leaf);
      }
      group.append(node(link.source, link.fromType, "source"), relation, leaves);
      out.append(group);
    }
    const total = [...groups.values()].reduce((count, group) => count + group.targets.size, 0);
    if (!total) out.append(element("p", "No drawable links. The query must return both endpoint names of a directed relationship. See Matches or Raw Azure JSON for the returned data.", "small"));
    else if (total > 40) out.append(element("p", `Showing the first 40 of ${total} links. See Matches for all returned rows.`, "small"));
  }

  function parseEmbeddedJson(value) {
    if (typeof value !== "string" || !/^\s*[\[{]/.test(value)) return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return value;
    }
  }

  function decodeEvidence(text) {
    const data = parseEmbeddedJson(text);
    const decodeItem = item => item && typeof item === "object" && typeof item.content === "string"
      ? {...item, content: parseEmbeddedJson(item.content)} : item;
    return Array.isArray(data) ? data.map(decodeItem) : decodeItem(data);
  }

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function renderEntityResults(out, diagram, body, gql) {
    const direct = typeof gql === "string";
    const graphReferences = Array.isArray(body?.references)
      ? body.references.filter(ref => ref.graphIndexName) : [];
    const rows = direct ? body?.value : graphReferences.flatMap(ref =>
      Array.isArray(ref.sourceData?.rows) ? ref.sourceData.rows : []);
    const chunks = direct ? Object.values(body?.["@search.graphProvenanceDocuments"] ?? {})
      : graphReferences.map(ref => ref.sourceData);
    const activityQueries = new Map((Array.isArray(body?.activity) ? body.activity : [])
      .filter(item => item.type === "graphSearch").map(item => [item.id, item.graphSearchArguments?.gql]));
    const relationships = direct ? projectedRelationships(gql, rows) : graphReferences.flatMap(ref =>
      projectedRelationships(activityQueries.get(ref.activitySource), ref.sourceData?.rows));
    diagram.replaceChildren(element("h5", "Returned relationships"));
    renderRelationshipDiagram(diagram, relationships, element);
    const matches = element("ol", undefined, "entity-match-list");
    for (const [i, row] of (rows ?? []).entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const pairs = Object.entries(row).filter(([key, value]) => !key.startsWith("@")
        && ["string", "number", "boolean"].includes(typeof value));
      const card = element("li");
      const fields = element("dl", undefined, "entity-match-fields");
      for (const [key, value] of pairs) {
        const field = element("div");
        field.append(element("dt", key.replaceAll("_", " ")), element("dd", String(value)));
        fields.append(field);
      }
      const json = element("details", undefined, "entity-match-json");
      json.append(element("summary", `Match ${i + 1} JSON`), element("pre", JSON.stringify(row, null, 2)));
      card.append(element("strong", `Match ${i + 1}`));
      if (pairs.length) card.append(fields);
      card.append(json);
      matches.append(card);
    }
    out.replaceChildren(element("h5", "Graph matches"),
      matches.childElementCount ? matches : element("p", "No displayable graph rows returned. See Text or Raw Azure JSON for details.", "small"));
    const snippets = [...new Set(chunks.map(chunk => chunk?.snippet)
      .filter(snippet => typeof snippet === "string" && snippet.trim()))];
    if (snippets.length) {
      const evidence = element("details");
      evidence.append(element("summary", `Supporting excerpts (${snippets.length})`));
      for (const snippet of snippets) evidence.append(element("blockquote", snippet));
      out.append(evidence);
      diagram.append(evidence.cloneNode(true));
    }
  }

  function addDemoSample(operation, title, defaults, example) {
    const template = document.getElementById("topic-retrieval-sample");
    const sample = template.content.firstElementChild.cloneNode(true);
    const find = selector => sample.querySelector(selector);
    const graph = example ? "entity" : "topic";
    sample.id = `${graph}-retrieval-${operation}`;
    const docLink = find(".topic-demo-learn");
    docLink.textContent = title;
    const [anchor, description] = example ? [example.anchor, example.description] : steps[operation];
    find(".topic-demo-description").textContent = description;
    docLink.href = example ? `${entityGuide}#${anchor}` : `${get("learn").href.split("#")[0]}#${anchor}`;
    const form = find("form");
    const run = find("button");
    const result = find(".topic-demo-result");
    const status = find(".topic-demo-status");
    const evidence = find(".topic-demo-evidence");
    const raw = find(".topic-demo-raw");
    const rawToggle = raw.querySelector("input");
    const rawCode = raw.querySelector("pre");
    let responseJson = "", formattedJson = "";
    const updateJson = () => {
      renderCode(rawCode, rawToggle.checked ? responseJson : formattedJson, "json");
      rawCode.scrollTop = 0;
    };
    rawToggle.addEventListener("change", updateJson);
    const activity = find(".topic-demo-activity");
    const viewChoice = find(".topic-demo-view-choice");
    const view = viewChoice.querySelector("select");
    const visual = find(".topic-demo-visual");
    const diagram = find(".topic-demo-graph");
    const canVisualize = graph === "entity" && ["natural", "gql"].includes(operation);
    const updateView = () => {
      visual.hidden = viewChoice.hidden || view.value !== "visual";
      diagram.hidden = viewChoice.hidden || view.value !== "graph";
      evidence.hidden = !(visual.hidden && diagram.hidden);
    };
    const resetResult = () => {
      viewChoice.hidden = true;
      visual.replaceChildren();
      diagram.replaceChildren();
      evidence.replaceChildren();
      activity.hidden = true;
      activity.querySelector("ul").replaceChildren();
      raw.hidden = true;
      rawToggle.checked = false;
      updateView();
    };
    view.addEventListener("change", updateView);
    const fields = example?.fields || ["SEARCH_ENDPOINT", "KNOWLEDGE_SOURCE_NAME", "KNOWLEDGE_BASE_NAME", "QUESTION"];
    const canSynthesize = graph === "entity" ? operation === "natural" : ["stored", "diverse", "none"].includes(operation);
    if (!example && operation === "diverse") fields.push("DIVERSITY_FACTOR", "MIN_DIVERSITY_POOL_SIZE");
    if (canSynthesize) fields.push("OUTPUT_MODE");
    for (const name of fields) {
      const label = document.createElement("label");
      label.textContent = name === "OUTPUT_MODE" ? "Output mode" : variables.find(([key]) => key === name)?.[1] || entityFields[name];
      if (name === "OUTPUT_MODE") {
        const select = document.createElement("select");
        select.name = name;
        select.add(new Option("Extracted evidence", "extractiveData"));
        select.add(new Option("Synthesized answer", "answerSynthesis"));
        label.append(select);
        find(".topic-api-grid").append(label);
        continue;
      }
      const multiline = name === "QUESTION" || name === "GQL";
      const input = document.createElement(multiline ? "textarea" : "input");
      input.name = name;
      input.required = true;
      input.autocomplete = "off";
      input.maxLength = multiline ? 1600 : name === "STORAGE_RESOURCE_ID" ? 250 : 128;
      if (multiline) input.rows = name === "GQL" ? 4 : 2;
      input.value = defaults[name] ?? "";
      label.append(input);
      find(".topic-api-grid").append(label);
    }
    const values = () => Object.fromEntries(new FormData(form));
    const updateCode = () => {
      const current = values();
      renderCode(find(".topic-demo-code"), example
        ? example.code(name => JSON.stringify(current[name].trim()))
        : sdkSample(operation, current), "python");
    };
    updateCode();
    document.getElementById(`${graph}-retrieval-samples`).append(sample);
    if (example?.previewOnly) {
      run.remove();
      result.remove();
      find(".topic-demo-layout").classList.add("preview-only");
      find("h4").textContent = "Python example (preview only)";
      form.addEventListener("input", updateCode);
      form.addEventListener("submit", event => event.preventDefault());
      return;
    }
    if (example?.codeLabel) find("h4").textContent = example.codeLabel;
    form.addEventListener("input", () => {
      updateCode();
      status.classList.remove("error");
      status.textContent = "Parameters changed. Execute to see the new response.";
      resetResult();
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (run.disabled) return;
      const parameters = {...values(), API_VERSION: defaults.API_VERSION || "2026-11-01-preview"};
      for (const control of form.elements) control.disabled = true;
      result.setAttribute("aria-busy", "true");
      status.classList.remove("error");
      status.textContent = "Waiting for Azure…";
      resetResult();
      try {
        const {azure, elapsedMs} = await jsonRequest(`/api/${graph}-console`, {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({operation, variables: parameters}),
        });
        const {status: http, requestId, body} = azure;
        const references = body?.references;
        const synthesized = parameters.OUTPUT_MODE === "answerSynthesis";
        status.textContent = `Azure HTTP ${http} · ${elapsedMs} ms`
          + (Array.isArray(references) ? ` · ${references.length} references` : "")
          + (operation === "gql" && Array.isArray(body?.value) ? ` · ${body.value.length} graph rows` : "")
          + (requestId ? ` · Request ID: ${requestId}` : "");
        status.classList.toggle("error", http >= 400);
        if (canSynthesize && http >= 200 && http < 300) {
          const activities = Array.isArray(body?.activity) ? body.activity.map(item => item?.type).filter(Boolean) : [];
          for (const type of activities) {
            const item = document.createElement("li");
            item.textContent = type;
            activity.querySelector("ul").append(item);
          }
          activity.hidden = !activities.length;
          activity.open = synthesized;
        }
        if (operation === "gql" && Array.isArray(body?.value)) {
          const rows = document.createElement("pre");
          rows.textContent = JSON.stringify(body.value, null, 2);
          evidence.append(rows);
        }
        const messages = Array.isArray(body?.response) ? body.response : [];
        const decoded = new Map();
        for (const message of messages) {
          for (const part of Array.isArray(message.content) ? message.content : []) {
            if (typeof part.text !== "string" || !part.text.trim()) continue;
            const text = document.createElement("pre");
            const value = synthesized ? part.text : decodeEvidence(part.text);
            if (value !== part.text) decoded.set(part, value);
            text.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            evidence.append(text);
          }
        }
        responseJson = JSON.stringify(body, null, 2);
        formattedJson = decoded.size ? JSON.stringify({...body, response: messages.map(message =>
          Array.isArray(message.content) ? {...message, content: message.content.map(part =>
            decoded.has(part) ? {...part, text: decoded.get(part)} : part)} : message)}, null, 2) : responseJson;
        rawToggle.closest("label").hidden = !decoded.size;
        updateJson();
        raw.hidden = false;
        raw.open = !evidence.childElementCount;
        if (canVisualize && http >= 200 && http < 300) {
          renderEntityResults(visual, diagram, body, operation === "gql" ? parameters.GQL : undefined);
          viewChoice.hidden = false;
          view.value = synthesized ? "text" : "visual";
          view.querySelector('[value="text"]').textContent = synthesized ? "Answer" : "Text";
          updateView();
        }
      } catch (error) {
        status.textContent = error.message;
        status.classList.add("error");
      } finally {
        for (const control of form.elements) control.disabled = false;
        result.setAttribute("aria-busy", "false");
      }
    });
  }

  async function loadDemo(defaultsRequest) {
    const status = document.getElementById("topic-retrieval-status");
    let defaults = {};
    try {
      const {variables, warning} = await defaultsRequest;
      defaults = {...variables, DIVERSITY_FACTOR: "0.1", MIN_DIVERSITY_POOL_SIZE: "1000"};
      status.textContent = warning || `Live defaults loaded · REST ${defaults.API_VERSION}`;
    } catch (error) {
      status.classList.add("error");
      status.textContent = `Could not load defaults: ${error.message}. Enter the parameters manually.`;
    }
    addDemoSample("stored", "Retrieve with the stored settings", defaults);
    addDemoSample("diverse", "Override topic selection for one request", defaults);
    addDemoSample("none", "Disable topic sampling for one request", defaults);
  }

  const entityGuide = "https://learn.microsoft.com/en-us/azure/search/agentic-knowledge-source-how-to-entity-graph?tabs=python";
  const entityFields = {
    GRAPH_INDEX_NAME: "Managed graph index", GQL: "GQL traversal", CONTAINER_NAME: "Blob container",
    STORAGE_RESOURCE_ID: "Blob account resource ID", MODEL_ENDPOINT: "Azure OpenAI endpoint",
    CHAT_DEPLOYMENT: "Chat deployment", CHAT_MODEL: "Chat model name", EMBEDDING_DEPLOYMENT: "Embedding deployment",
  };
  const entitySourceFields = ["SEARCH_ENDPOINT", "KNOWLEDGE_SOURCE_NAME"];
  const clientCode = p => `from azure.identity import DefaultAzureCredential
from azure.search.documents.indexes import SearchIndexClient

search_endpoint = ${p("SEARCH_ENDPOINT")}
source_name = ${p("KNOWLEDGE_SOURCE_NAME")}
# Authenticate to Search with Entra instead of a Search API key.
credential = DefaultAzureCredential()
index_client = SearchIndexClient(endpoint=search_endpoint, credential=credential)`;
  const entityExamples = [
    {operation: "setup", title: "Set up requests", anchor: "create-the-graph-enabled-knowledge-source",
      description: "Use the preview SDK and an Entra credential. Graph Lab executes the equivalent REST examples with your Azure CLI sign-in.",
      fields: entitySourceFields, previewOnly: true, code: clientCode},
    {operation: "create-source", title: "Create a graph-enabled knowledge source", anchor: "create-the-graph-enabled-knowledge-source",
      description: "Create a new source on approved Blob Storage. This example uses Graph Lab's JSON-LD ontology and starts extraction if run separately.",
      fields: [...entitySourceFields, "CONTAINER_NAME", "STORAGE_RESOURCE_ID", "MODEL_ENDPOINT", "CHAT_DEPLOYMENT",
        "CHAT_MODEL", "EMBEDDING_DEPLOYMENT"],
      previewOnly: true, code: p => `import json
from lab import ontology, object_url, request

endpoint = ${p("SEARCH_ENDPOINT")}
source = ${p("KNOWLEDGE_SOURCE_NAME")}

def model(deployment, model_name):
    return {"kind": "azureOpenAI", "azureOpenAIParameters": {
        "resourceUri": ${p("MODEL_ENDPOINT")}, "deploymentId": deployment,
        "modelName": model_name,
    }}

body = {
    "name": source,
    "kind": "azureBlob",
    "resultsProcessing": "none",
    "azureBlobParameters": {
        # A resource ID lets Search use its managed identity to read Blob Storage.
        "connectionString": "ResourceId=" + ${p("STORAGE_RESOURCE_ID")},
        "containerName": ${p("CONTAINER_NAME")},
        "ingestionParameters": {
            "contentExtractionMode": "minimal",
            "disableImageVerbalization": True,
            "chatCompletionModel": model(${p("CHAT_DEPLOYMENT")}, ${p("CHAT_MODEL")}),
            "embeddingModel": model(${p("EMBEDDING_DEPLOYMENT")}, "text-embedding-3-large"),
        },
        # The ontology tells Azure which entity types and relationships to extract.
        "graphExtraction": {
            "graphName": source, "pageDegreeOfParallelism": 2,
            "ontology": {"kind": "inline", "value": json.dumps(ontology())},
        },
    },
}
# Azure provisions the managed indexer, chunk index and graph index for this source.
result = request("PUT", object_url("knowledgesources", source), body,
                 endpoint=endpoint, create=True)`},
    {operation: "source", title: "Discover the managed indexes", anchor: "create-the-graph-enabled-knowledge-source",
      description: "Read the source definition. Find the graph and chunk indexes under createdResources.",
      fields: entitySourceFields, code: p => `${clientCode(p)}\n\n# Read createdResources.index and createdResources.graphIndex under azureBlobParameters.\nresult = index_client.get_knowledge_source(source_name)`},
    {operation: "status", title: "Verify extraction completes", anchor: "verify-extraction-completes",
      description: "Check that synchronization ended, no run is active, and itemsUpdatesFailed is zero.",
      fields: entitySourceFields, codeLabel: "Python REST example", code: p => `from lab import object_url, request

# Check synchronization for failed items before querying the managed graph.
path = object_url("knowledgesources", ${p("KNOWLEDGE_SOURCE_NAME")}) + "/status"
result = request("GET", path, endpoint=${p("SEARCH_ENDPOINT")})`},
    {operation: "create-base", title: "Attach the source to a knowledge base", anchor: "query-the-graph-through-a-knowledge-base",
      description: "Configure the query model separately from the extraction model. Use a new knowledge base.",
      fields: [...entitySourceFields, "KNOWLEDGE_BASE_NAME", "MODEL_ENDPOINT", "CHAT_DEPLOYMENT", "CHAT_MODEL"],
      previewOnly: true, code: p => `from lab import object_url, request

endpoint = ${p("SEARCH_ENDPOINT")}
base = ${p("KNOWLEDGE_BASE_NAME")}
body = {
    "name": base,
    "knowledgeSources": [{"name": ${p("KNOWLEDGE_SOURCE_NAME")}}],
    # This model supports knowledge-base retrieval, not Blob ingestion or extraction.
    "models": [{"kind": "azureOpenAI", "azureOpenAIParameters": {
        "resourceUri": ${p("MODEL_ENDPOINT")},
        "deploymentId": ${p("CHAT_DEPLOYMENT")},
        "modelName": ${p("CHAT_MODEL")},
    }}],
    "retrievalReasoningEffort": {"kind": "low"},
    "outputMode": "extractiveData",
    "retrievalInstructions": "Use graph_search to answer relationship questions.",
}
result = request("PUT", object_url("knowledgebases", base), body,
                 endpoint=endpoint, create=True)`},
    {operation: "natural", title: "Query the graph through a knowledge base", anchor: "query-the-graph-through-a-knowledge-base",
      description: "Send a relationship question to /retrieve. Raw JSON includes activity, generated GQL when reported, and source references.",
      fields: [...entitySourceFields, "KNOWLEDGE_BASE_NAME", "QUESTION"], code: p => `from azure.identity import DefaultAzureCredential
from azure.search.documents.knowledgebases import KnowledgeBaseRetrievalClient
from azure.search.documents.knowledgebases.models import (
    AgentRuntimeGraphHydrateDocumentsParams, AgentRuntimeGraphParams,
    AgentRuntimeGraphProvenanceParams, AzureBlobKnowledgeSourceParams,
    KnowledgeBaseMessage, KnowledgeBaseMessageTextContent, KnowledgeBaseRetrievalRequest,
)

# Hydrate graph evidence with the text and location of supporting source chunks.
hydration = AgentRuntimeGraphHydrateDocumentsParams(
    select="uid,snippet,snippet_parent_id,blob_url", top=10,
)
source = AzureBlobKnowledgeSourceParams(
    knowledge_source_name=${p("KNOWLEDGE_SOURCE_NAME")},
    include_references=True, include_reference_source_data=True, fail_on_error=True,
    graph_parameters=AgentRuntimeGraphParams(
        include_query=True, provenance=AgentRuntimeGraphProvenanceParams(
            kind="hydrate", hydrate_documents=hydration,
        ),
    ),
)
query = KnowledgeBaseRetrievalRequest(
    messages=[KnowledgeBaseMessage(
        role="user", content=[KnowledgeBaseMessageTextContent(text=${p("QUESTION")})],
    )],
    include_activity=True, output_mode=${p("OUTPUT_MODE")},
    max_runtime_in_seconds=60, knowledge_source_params=[source],
)
with KnowledgeBaseRetrievalClient(
    endpoint=${p("SEARCH_ENDPOINT")},
    knowledge_base_name=${p("KNOWLEDGE_BASE_NAME")},
    credential=DefaultAzureCredential(),
) as client:
    result = client.retrieve(query)`},
    {operation: "gql", title: "Query the graph directly with GQL", anchor: "query-the-graph-directly-with-gql",
      description: "Send your traversal to the managed index at /docs/search.graph. The default matches the fictional organization-to-product data.",
      fields: ["SEARCH_ENDPOINT", "GRAPH_INDEX_NAME", "GQL"], code: p => `from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.models import (
    GraphQueryProvenanceHydrateDocumentsParameters, GraphQueryProvenanceParameters,
)

gql = ${p("GQL")}
# Ask Search for supporting source chunks alongside each matching graph row.
evidence = GraphQueryProvenanceParameters(
    kind="hydrate", max_evidence_per_row=10,
    hydrate_documents=GraphQueryProvenanceHydrateDocumentsParameters(
        select="uid,snippet,snippet_parent_id,blob_url",
    ),
)
with SearchClient(${p("SEARCH_ENDPOINT")}, ${p("GRAPH_INDEX_NAME")},
                  DefaultAzureCredential()) as client:
    result = client.graph(gql=gql, include_statistics=True,
                          include_diagnostics=True, provenance=evidence)`},
  ];

  function renderOntologyGraph(ontology) {
    const entries = ontology["@graph"];
    const concepts = entries.filter(entry => entry["@type"] === "owl:Class");
    const positions = new Map(concepts.map((entry, i) => [entry["@id"], 30 + i * 74]));
    const relations = entries.filter(entry => entry["@type"] === "owl:ObjectProperty").map(entry => ({
      name: entry["@id"].split(":").at(-1),
      from: entry["rdfs:domain"]["@id"],
      to: entry["rdfs:range"]["@id"],
    }));
    const label = id => id.split(":").at(-1);
    function svg(tag, attributes = {}, text) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
      if (text !== undefined) el.textContent = text;
      return el;
    }

    const graph = svg("svg", {
      viewBox: `0 0 340 ${concepts.length * 74}`, role: "img", "aria-labelledby": "ontology-map-title ontology-map-desc",
    });
    const arrow = svg("marker", {id: "ontology-arrow", viewBox: "0 0 8 8", markerWidth: 7, markerHeight: 7,
      refX: 7, refY: 4, orient: "auto"});
    arrow.append(svg("polygon", {points: "0,0 8,4 0,8"}));
    const defs = svg("defs");
    defs.append(arrow);
    graph.append(svg("title", {id: "ontology-map-title"}, "Entity Graph ontology"),
      svg("desc", {id: "ontology-map-desc"}, relations.map(edge =>
        `${label(edge.from)} ${edge.name} ${label(edge.to)}.`).join(" ")), defs);
    for (const edge of relations) {
      const start = positions.get(edge.from);
      const end = positions.get(edge.to);
      const adjacent = end - start === 74;
      const middle = (start + end) / 2;
      graph.append(svg("path", {"marker-end": "url(#ontology-arrow)", d: adjacent
        ? `M 86 ${start + 18} V ${end - 18}`
        : `M 160 ${start} H 243 Q 256 ${start} 256 ${start + Math.sign(end - start) * 13} V ${end - Math.sign(end - start) * 13} Q 256 ${end} 243 ${end} H 160`}),
      svg("text", {class: "ontology-relation-label", x: adjacent ? 97 : 266, y: middle,
        "dominant-baseline": "middle"}, edge.name));
    }
    for (const concept of concepts) {
      const y = positions.get(concept["@id"]);
      const box = svg("g");
      box.append(svg("title", {}, concept["rdfs:comment"]),
        svg("rect", {x: 12, y: y - 18, width: 148, height: 36, rx: 8}),
        svg("text", {x: 86, y, "text-anchor": "middle", "dominant-baseline": "middle"}, label(concept["@id"])));
      graph.append(box);
    }
    document.getElementById("entity-ontology-graph").replaceChildren(graph);
  }

  const entityIndexPart = id => document.getElementById(`entity-index-${id}`);
  let entityGraph;

  async function readIndexRecords(index) {
    const readPage = page => jsonRequest("/api/index-browser", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({action: "documents", service: "search", index, page}),
    });
    const first = await readPage(0);
    const records = new Map();
    function collect(result) {
      if (result.keyField !== first.keyField || result.count !== first.count) {
        throw new Error(`${index} changed while loading. Refresh to try again.`);
      }
      for (const row of result.documents) {
        const key = row[first.keyField];
        if (typeof key !== "string" || records.has(key)) {
          throw new Error(`${index} returned missing or duplicate record keys. Refresh to try again.`);
        }
        records.set(key, row);
      }
    }
    collect(first);
    const pageSize = first.documents.length;
    for (let page = 1; records.size < first.count && pageSize; page += 4) {
      const end = Math.min(page + 4, Math.ceil(first.count / pageSize));
      if (end <= page) break;
      const pages = await Promise.all(Array.from({length: end - page}, (_, offset) => readPage(page + offset)));
      pages.forEach(collect);
    }
    if (records.size !== first.count) throw new Error(`Azure Search did not return every record from ${index}.`);
    return records;
  }

  function indexedEntityGraph(records) {
    const entities = new Map(), links = new Map();
    const entity = (row, field) => {
      const id = row[`${field}_id`], type = row[`${field}_type`];
      if (!id || !type) return null;
      const key = JSON.stringify([type, id]);
      if (!entities.has(key)) entities.set(key, {
        key, id, type, label: row[`${field}_id_display_name`] || id, links: [],
      });
      return entities.get(key);
    };
    let otherRecords = 0;
    for (const row of records) {
      const source = entity(row, "subject"), target = entity(row, "object");
      for (const item of new Set([source, target])) {
        if (item && row.chunk_id) (item.chunkIds ??= new Set()).add(row.chunk_id);
      }
      if (!source || !target || !row.predicate) { otherRecords++; continue; }
      const key = JSON.stringify([source.key, row.predicate, target.key]);
      if (!links.has(key)) {
        const link = {source, target, predicate: row.predicate, rows: []};
        links.set(key, link);
        source.links.push(link);
        if (target !== source) target.links.push(link);
      }
      links.get(key).rows.push(row);
    }
    const byName = (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    const ordered = [...entities.values()].sort(byName);
    return {entities, links, ordered, otherRecords};
  }

  function drawEntityIndex(records) {
    const {entities, links, ordered, otherRecords} = indexedEntityGraph(records);
    const types = [...new Set(ordered.map(item => item.type))].sort();
    const predicates = [...new Set([...links.values()].map(item => item.predicate))].sort();
    const palette = ["#6ecade", "#ffba70", "#c5a6fa", "#82d8a4", "#f7a4ba"];
    const colors = new Map(predicates.map((name, i) => [name, palette[i % palette.length]]));
    const typeColors = new Map(types.map((name, i) => [name, palette[i % palette.length]]));
    const picker = entityIndexPart("focus"), diagram = entityIndexPart("diagram"), inspector = entityIndexPart("inspector");
    picker.replaceChildren(new Option("All entities", ""), ...ordered.map(item =>
      new Option(`${item.label} · ${item.type}`, item.key)));
    entityIndexPart("legend").replaceChildren(...predicates.map(name => {
      const item = document.createElement("li");
      item.textContent = name;
      item.style.setProperty("--edge-color", colors.get(name));
      return item;
    }));

    const nodes = ordered.map((item, i) => {
      item.graphId = `n${i}`;
      return {data: {id: item.graphId, key: item.key, label: item.label, color: typeColors.get(item.type)}};
    });
    const edges = Array.from(links, ([key, link], i) => ({data: {
      id: `e${i}`, key, source: link.source.graphId, target: link.target.graphId,
      predicate: link.predicate, color: colors.get(link.predicate),
    }}));
    entityGraph?.destroy();
    const graph = entityGraph = window.cytoscape({
      container: diagram, elements: [...nodes, ...edges], minZoom: .05, maxZoom: 4,
      autounselectify: true,
      layout: {name: "cose", animate: false, fit: true, padding: 32, nodeRepulsion: 8000, idealEdgeLength: 80},
      style: [
        {selector: "node", style: {"background-color": "data(color)", width: 23, height: 23,
          label: "data(label)", color: "#eff6fc", "font-size": 13, "text-wrap": "ellipsis",
          "text-max-width": 115, "text-valign": "bottom", "text-margin-y": 4,
          "text-outline-color": "#0e151d", "text-outline-width": 2, "min-zoomed-font-size": 6}},
        {selector: "edge", style: {"curve-style": "bezier", "line-color": "data(color)",
          "target-arrow-shape": "triangle", "target-arrow-color": "data(color)", width: 2, opacity: .8}},
        {selector: ".is-muted", style: {opacity: .13}},
        {selector: "node.is-active", style: {"border-width": 3, "border-color": "#fff4d6"}},
        {selector: "edge.is-active", style: {width: 3, opacity: 1, label: "data(predicate)",
          color: "#eff6fc", "font-size": 13, "text-outline-color": "#0e151d", "text-outline-width": 2,
          "text-rotation": "autorotate", "min-zoomed-font-size": 7}},
        {selector: "edge.is-picked", style: {width: 5}},
      ],
    });

    function select(key, reveal = false, picked = null) {
      picker.value = key;
      const current = entities.get(key);
      const active = current ? graph.getElementById(current.graphId) : graph.collection();
      const neighborhood = active.closedNeighborhood();
      graph.batch(() => {
        graph.elements().removeClass("is-muted is-active is-picked");
        if (!current) return;
        graph.elements().difference(neighborhood).addClass("is-muted");
        active.union(neighborhood.edges()).addClass("is-active");
        if (picked) picked.addClass("is-picked");
      });
      inspector.replaceChildren();
      inspector.scrollTop = 0;
      const title = document.createElement("h4");
      title.textContent = current ? current.label : "Inspect a relationship";
      const hint = document.createElement("p");
      hint.className = "small";
      hint.textContent = current ? `${current.type} · ${current.id} · ${current.links.length} relationships`
        : "Select an entity in the diagram or dropdown to see its incoming and outgoing edges.";
      inspector.append(title, hint);
      for (const link of current?.links || []) {
        const entry = document.createElement("details");
        const heading = document.createElement("summary");
        heading.textContent = `${link.source.label} → ${link.predicate} → ${link.target.label} (${link.rows.length})`;
        entry.append(heading);
        entry.addEventListener("toggle", () => {
          if (!entry.open || entry.querySelector("pre")) return;
          const code = document.createElement("pre");
          code.tabIndex = 0;
          renderCode(code, JSON.stringify(link.rows, null, 2), "json");
          entry.append(code);
        });
        inspector.append(entry);
        if (picked && links.get(picked.data("key")) === link) {
          entry.open = true;
          entry.scrollIntoView({block: "nearest"});
        }
      }
      if (current && reveal) graph.fit(neighborhood, 42);
    }
    picker.onchange = () => select(picker.value, true);
    entityIndexPart("fit").onclick = () => { graph.resize(); graph.fit(graph.elements(), 32); };
    graph.on("tap", "node", event => select(event.target.data("key")));
    graph.on("tap", "edge", event => {
      const link = links.get(event.target.data("key"));
      select(link.source.key, false, event.target);
    });
    graph.on("tap", event => { if (event.target === graph) select(""); });
    select("");
    return {entities: entities.size, links: links.size, otherRecords};
  }

  entityIndexPart("load").addEventListener("click", async event => {
    const button = event.currentTarget, status = entityIndexPart("status"), content = entityIndexPart("content");
    button.disabled = true;
    content.hidden = true;
    status.classList.remove("error");
    status.textContent = "Reading all records from the managed graph index…";
    try {
      if (typeof window.cytoscape !== "function") throw new Error("Could not load the local Cytoscape.js bundle.");
      const {variables, warning} = await jsonRequest("/api/entity-console/defaults");
      const index = variables.GRAPH_INDEX_NAME;
      if (!index) throw new Error(warning || "The managed graph index is not ready.");
      const records = await readIndexRecords(index);
      if (!records.size) {
        status.textContent = `${index} contains no graph records yet.`;
        return;
      }
      content.hidden = false;
      const counts = drawEntityIndex(records.values());
      status.textContent = `${index} · ${counts.entities} entities · ${counts.links} directed edges · ${records.size} stored records`
        + (counts.otherRecords ? ` (${counts.otherRecords} without two entity endpoints)` : "");
      button.textContent = "Refresh full graph";
    } catch (error) {
      content.hidden = true;
      status.classList.add("error");
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  const combinedPart = id => document.getElementById(`combined-${id}`);
  const combinedDiagram = combinedPart("diagram");
  let combinedGraph;
  let combinedNeedsFit;
  new ResizeObserver(() => {
    if (!combinedDiagram.clientWidth || !combinedGraph) return;
    combinedGraph.resize();
    if (combinedNeedsFit) {
      combinedGraph.fit(28);
      combinedNeedsFit = false;
    }
  }).observe(combinedDiagram);

  const overlapWords = 12;
  const words = text => typeof text === "string" ? text.normalize("NFC").trim().split(/\s+/u) : [];
  const seed = (tokens, offset) => tokens.slice(offset, offset + overlapWords).join(" ");

  function topicPassages(topics, topicChunks, managedChunks, chunkIds) {
    const seeds = new Map(), passages = new Map();
    for (const topic of topics) {
      for (const topicChunk of topic.chunks) {
        const content = topicChunks.get(topicChunk)?.content;
        if (typeof content !== "string") throw new Error(`Topic member ${topicChunk} is missing from the content index.`);
        const tokens = words(content);
        for (let i = 0; i <= tokens.length - overlapWords; i++) {
          const value = seed(tokens, i);
          if (!seeds.has(value)) seeds.set(value, []);
          seeds.get(value).push({topic, topicChunk, tokens, start: i});
        }
      }
    }
    for (const entityChunk of chunkIds) {
      const tokens = words(managedChunks.get(entityChunk)?.snippet);
      const matches = [];
      for (let i = 0; i <= tokens.length - overlapWords; i++) {
        for (const match of seeds.get(seed(tokens, i)) || []) {
          const {topic, topicChunk, tokens: other, start} = match;
          // Earlier seeds on the same contiguous span already cover this one.
          if (i && start && tokens[i - 1] === other[start - 1]) continue;
          let length = overlapWords;
          while (i + length < tokens.length && start + length < other.length
              && tokens[i + length] === other[start + length]) length++;
          const passage = tokens.slice(i, i + length).join(" ");
          if (passage.length >= 80) matches.push({topic, topicChunk, entityChunk, passage});
        }
      }
      passages.set(entityChunk, matches);
    }
    return passages;
  }

  function circleRegions(groups, regions) {
    const count = groups.length;
    const shared = (a, b) => [...regions.values()].some(region => region.mask & (1 << a) && region.mask & (1 << b));
    if (count > 3 || (count === 3 && !(shared(0, 1) && shared(0, 2) && shared(1, 2)))) return null;
    const separation = count === 3 && !regions.has(7) ? 1.8 : 1.15;
    for (let radius = 150; radius <= 1800; radius *= 1.35) {
      const step = radius * separation;
      const centers = [{x: radius, y: radius}];
      if (count >= 2) centers.push({x: radius + step, y: radius});
      if (count === 3) centers.push({x: radius + step / 2, y: radius + step * Math.sqrt(3) / 2});
      const width = Math.max(...centers.map(p => p.x)) + radius;
      const height = Math.max(...centers.map(p => p.y)) + radius;
      const slots = new Map([...regions.keys()].map(mask => [mask, []]));
      for (let y = 22; y < height; y += 42) {
        for (let x = 56 + (Math.round(y / 42) % 2) * 56; x < width; x += 112) {
          let mask = 0, nearBorder = false;
          centers.forEach((p, index) => {
            const distance = Math.hypot(p.x - x, p.y - y);
            if (Math.abs(distance - radius) < 22) nearBorder = true;
            if (distance < radius) mask |= 1 << index;
          });
          if (!nearBorder) slots.get(mask)?.push({x, y});
        }
      }
      if ([...regions.values()].some(region => slots.get(region.mask).length < region.items.length)) continue;
      for (const positions of slots.values()) {
        const center = positions.reduce((acc, p) => ({
          x: acc.x + p.x / positions.length, y: acc.y + p.y / positions.length,
        }), {x: 0, y: 0});
        positions.sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
      }
      return {groups, regions, centers, radius, width, height, slots};
    }
    return null;
  }

  function combinedLayout(activeGroups) {
    const remaining = new Set(activeGroups), layouts = [];
    let separate = false;
    while (remaining.size) {
      const component = new Set([remaining.values().next().value]);
      for (const group of component) {
        for (const item of group.members) for (const other of item.placements.keys()) component.add(other);
        remaining.delete(group);
      }
      const groups = [...component], regions = new Map();
      if (groups.length <= 3) {
        for (const item of new Set(groups.flatMap(group => group.members))) {
          const mask = groups.reduce((bits, group, i) => item.placements.has(group) ? bits | (1 << i) : bits, 0);
          if (!regions.has(mask)) regions.set(mask, {mask, items: []});
          regions.get(mask).items.push(item);
        }
      }
      const layout = circleRegions(groups, regions);
      if (layout) layouts.push(layout);
      else {
        separate = true;
        for (const group of groups) {
          const isolated = circleRegions([group], new Map([[1, {mask: 1, items: group.members}]]));
          if (!isolated) throw new Error(`Too many entities to lay out the topic ${group.label}.`);
          layouts.push(isolated);
        }
      }
    }
    return {layouts, separate};
  }

  function drawCombinedGraph({ordered, links}, topics, topicChunks, managedChunks) {
    const chunkIds = new Set(ordered.flatMap(item => [...(item.chunkIds || [])]));
    const passages = topicPassages(topics, topicChunks, managedChunks, chunkIds);
    const palette = ["#ae8bfb", "#56cebf", "#ffba70", "#68aeff", "#f79ebf", "#a8cf72"];
    const groups = new Map(topics.filter(topic => topic.chunks.length).map((topic, i) => [
      topic.id, {id: `group-${i}`, label: topic.label, color: palette[i % palette.length], members: []},
    ]));
    const unmatched = {id: "group-unmatched", label: "No matched passage", color: "#b2becd", members: []};
    for (const item of ordered) {
      item.placements = new Map();
      if (item.label.trim() && item.label !== item.id) {
        const escaped = words(item.label).join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mention = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
        for (const chunk of item.chunkIds || []) {
          for (const match of passages.get(chunk)) {
            if (!mention.test(match.passage)) continue;
            const group = groups.get(match.topic.id);
            if (!item.placements.has(group)) item.placements.set(group, []);
            item.placements.get(group).push(match);
          }
        }
      }
      if (!item.placements.size) item.placements.set(unmatched, []);
      for (const group of item.placements.keys()) group.members.push(item);
      item.copies = new Map();
    }

    const activeGroups = [...groups.values(), unmatched].filter(group => group.members.length);
    const elements = [];
    const copies = new Map(), edgeRecords = new Map();
    const {layouts, separate} = combinedLayout(activeGroups);
    const note = combinedPart("layout-note");
    note.textContent = separate ? "Some topic memberships cannot be drawn accurately with circles. Those groups are shown separately with repeated entities." : "";
    note.hidden = !separate;
    let x = 0, y = 0, rowHeight = 0;
    const rowWidth = Math.max(1000, ...layouts.map(layout => layout.width)) * 1.25;
    for (const {groups: layoutGroups, regions, centers, radius, width, height, slots} of layouts) {
      if (x && x + width > rowWidth) { x = 0; y += rowHeight + 95; rowHeight = 0; }
      layoutGroups.forEach((group, i) => {
        const center = {x: x + centers[i].x, y: y + centers[i].y};
        group.center = center;
        group.radius = radius;
        const label = `${group.label} · ${group.members.length}`;
        elements.push({data: {id: group.id, label, color: group.color, diameter: radius * 2},
          position: center, locked: true,
          classes: group === unmatched ? "combined-circle combined-unmatched" : "combined-circle"});
        group.copyIds = [group.id];
      });
      for (const {mask, items} of regions.values()) {
        const memberships = layoutGroups.filter((_, i) => mask & (1 << i));
        items.forEach((item, i) => {
          const id = `combined-node-${copies.size}`, p = slots.get(mask)[i];
          copies.set(id, {item, memberships});
          for (const group of memberships) {
            group.copyIds.push(id);
            item.copies.set(group, id);
          }
          elements.push({data: {id, label: item.label, color: memberships.length > 1 ? "#eff6fc" : memberships[0].color},
            classes: "combined-node", position: {x: x + p.x, y: y + p.y}});
        });
      }
      x += width + 75;
      rowHeight = Math.max(rowHeight, height);
    }
    for (const link of links.values()) {
      const {source, target, predicate} = link;
      const shared = [...source.copies.keys()].find(group => target.copies.has(group));
      const id = `combined-edge-${edgeRecords.size}`;
      edgeRecords.set(id, link);
      elements.push({data: {id, predicate,
        source: shared ? source.copies.get(shared) : source.copies.values().next().value,
        target: shared ? target.copies.get(shared) : target.copies.values().next().value}});
    }

    combinedGraph?.destroy();
    const graph = combinedGraph = window.cytoscape({
      container: combinedDiagram, elements, layout: {name: "preset", padding: 28},
      autounselectify: true, minZoom: .02, maxZoom: 3,
      style: [
        {selector: "node, edge", style: {"z-index-compare": "manual"}},
        {selector: ".combined-circle", style: {shape: "ellipse", width: "data(diameter)", height: "data(diameter)",
          "background-color": "data(color)", "background-opacity": .26, "border-width": 3,
          "border-color": "data(color)", "border-opacity": .85, "z-index": 0,
          label: "data(label)", color: "data(color)", "font-size": 31, "font-weight": "bold",
          "text-valign": "top", "text-margin-y": -12, "text-wrap": "ellipsis", "text-max-width": "data(diameter)"}},
        {selector: ".combined-unmatched", style: {"background-opacity": 0, "border-width": 0}},
        {selector: "edge", style: {width: 2, opacity: .48, "z-index": 1,
          "curve-style": "bezier", "line-color": "#98a8bf", "target-arrow-shape": "triangle",
          "target-arrow-color": "#98a8bf", "arrow-scale": .9}},
        {selector: ".combined-node", style: {width: 19, height: 19, "background-color": "data(color)",
          "z-index": 3, label: "data(label)", color: "#eef6ff", "font-size": 14, "text-valign": "bottom",
          "text-margin-y": 3, "text-outline-color": "#0e151d", "text-outline-width": 2,
          "text-wrap": "ellipsis", "text-max-width": 104, "min-zoomed-font-size": 6}},
        {selector: "node.combined-picked", style: {"border-width": 4, "border-color": "#fff"}},
        {selector: "edge.combined-picked", style: {opacity: 1, width: 4, label: "data(predicate)",
          color: "#fff", "text-outline-color": "#0e151d", "text-outline-width": 2}},
      ],
    });
    const topicPicker = combinedPart("topic");
    const entityPicker = combinedPart("entity");
    const inspector = combinedPart("inspector");
    topicPicker.replaceChildren(new Option("All circles", ""), ...activeGroups.map(group =>
      new Option(`${group.label} (${group.members.length})`, group.id)));
    entityPicker.replaceChildren(new Option("Select an entity", ""), ...[...copies]
      .sort(([, a], [, b]) => a.item.label.localeCompare(b.item.label))
      .map(([id, {item, memberships}]) => new Option(
        `${item.label} · ${memberships.map(group => group.label).join(" + ")}`, id)));
    function fit(groupId = "") {
      combinedNeedsFit = !combinedDiagram.clientWidth;
      if (combinedNeedsFit) return;
      graph.resize();
      const group = activeGroups.find(item => item.id === groupId);
      const selection = group ? graph.collection(group.copyIds.map(id => graph.getElementById(id)[0])) : graph.elements();
      if (selection.length) graph.fit(selection, 28);
    }
    function inspect(id, reveal = false) {
      graph.elements().removeClass("combined-picked");
      entityPicker.value = id;
      const selected = copies.get(id);
      if (!selected) {
        inspector.replaceChildren(element("p", "Select an entity or a relationship."));
        return;
      }
      const {item, memberships} = selected;
      const node = graph.getElementById(id);
      for (const copy of item.copies.values()) graph.getElementById(copy).addClass("combined-picked");
      const title = element("h3", item.label);
      const data = element("p", `${item.type} · ${memberships.map(group => group.label).join(" + ")}`);
      data.className = "small";
      const evidence = [...item.placements].flatMap(([group, matches]) => matches.map(match => ({group, match})));
      inspector.replaceChildren(title, data);
      if (!evidence.length) inspector.append(element("p", "No shared passage qualified for this entity."));
      const opened = new Set();
      for (const {group, match} of evidence) {
        const entry = element("details");
        const source = element("p", `Entity source chunk: ${match.entityChunk}`);
        source.className = "small";
        entry.append(element("summary", `${group.label} · chunk ${match.topicChunk}`),
          element("blockquote", match.passage), source);
        entry.open = !opened.has(group);
        opened.add(group);
        inspector.append(entry);
      }
      inspector.scrollTop = 0;
      if (reveal) {
        topicPicker.value = memberships.length === 1 ? memberships[0].id : "";
        fit(topicPicker.value);
        graph.center(node);
      }
    }
    topicPicker.onchange = () => fit(topicPicker.value);
    entityPicker.onchange = () => inspect(entityPicker.value, true);
    combinedPart("fit").onclick = () => { topicPicker.value = ""; fit(); };
    const edgeToggle = combinedPart("edges");
    edgeToggle.onchange = () => graph.edges().style("display", edgeToggle.checked ? "element" : "none");
    edgeToggle.onchange();
    graph.on("tap", "node.combined-circle", event => {
      topicPicker.value = event.target.id();
      fit(topicPicker.value);
    });
    graph.on("tap", "node.combined-node", event => inspect(event.target.id()));
    graph.on("grab", "node.combined-node", ({target}) => target.scratch("_beforeDrag", {...target.position()}));
    graph.on("free", "node.combined-node", ({target}) => {
      const {memberships} = copies.get(target.id());
      const {x, y} = target.position();
      const valid = activeGroups.every(group => {
        const distance = Math.hypot(group.center.x - x, group.center.y - y);
        return memberships.includes(group) ? distance <= group.radius - 11 : distance >= group.radius + 11;
      });
      const previous = target.scratch("_beforeDrag");
      if (!valid && previous) target.position(previous);
    });
    graph.on("tap", "edge", event => {
      graph.elements().removeClass("combined-picked");
      event.target.addClass("combined-picked");
      entityPicker.value = "";
      const {source, target, predicate, rows} = edgeRecords.get(event.target.id());
      const pre = document.createElement("pre");
      pre.tabIndex = 0;
      renderCode(pre, JSON.stringify(rows, null, 2), "json");
      inspector.replaceChildren(element("h3", `${source.label} → ${predicate} → ${target.label}`),
        element("p", "Stored Entity Graph records. The arrow does not assert a topic relationship."), pre);
      inspector.scrollTop = 0;
    });
    inspect("");
    fit();
    return {circles: activeGroups.filter(group => group !== unmatched).length, unmatched: unmatched.members.length,
      shared: ordered.filter(item => item.placements.size > 1).length};
  }

  combinedPart("load").addEventListener("click", async event => {
    const button = event.currentTarget, status = combinedPart("status"), content = combinedPart("content");
    button.disabled = true;
    status.classList.remove("error");
    status.textContent = "Reading both graphs and their source chunks…";
    try {
      if (typeof window.cytoscape !== "function") throw new Error("Could not load the local Cytoscape.js bundle.");
      const [linkage, {variables}] = await Promise.all([
        jsonRequest("/api/topic-linkage"), jsonRequest("/api/entity-console/defaults"),
      ]);
      const {azure} = await jsonRequest("/api/entity-console", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({operation: "source", variables}),
      });
      const resources = azure.body?.azureBlobParameters?.createdResources;
      if (!resources?.index || !resources.graphIndex) {
        throw new Error("The active Entity Graph source did not return its managed chunk and graph indexes.");
      }
      const [graph, managed, topic] = await Promise.all([
        readIndexRecords(resources.graphIndex), readIndexRecords(resources.index), readIndexRecords(linkage.contentIndex),
      ]);
      const model = indexedEntityGraph(graph.values());
      if (!model.ordered.length) throw new Error("The managed graph index has no entities to show.");
      content.hidden = false;
      const counts = drawCombinedGraph(model, linkage.topics, topic, managed);
      status.textContent = `${counts.circles} topic circles · ${model.ordered.length - counts.unmatched} of ${model.ordered.length} entities matched · `
        + `${counts.shared} shared across topics · ${counts.unmatched} unmatched · ${model.links.size} stored relationships`;
      button.textContent = "Refresh combined graph";
    } catch (error) {
      content.hidden = true;
      status.classList.add("error");
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function openCombinedGraph() {
    const button = combinedPart("load");
    if (["#flow-combined", "#combined-graph"].includes(location.hash) && !combinedGraph && !button.disabled) button.click();
  }
  window.addEventListener("hashchange", openCombinedGraph);
  openCombinedGraph();

  async function loadEntityDemo() {
    const status = document.getElementById("entity-retrieval-load-status");
    const ontologyStatus = document.getElementById("entity-ontology-status");
    let defaults = {};
    try {
      const {variables, warning, ontology} = await jsonRequest("/api/entity-console/defaults");
      defaults = variables;
      status.textContent = warning || `Live defaults loaded · REST ${defaults.API_VERSION}`;
      renderCode(document.getElementById("entity-ontology-python"), ontology.python, "python");
      renderCode(document.getElementById("entity-ontology-json"), JSON.stringify(ontology.jsonLd, null, 2), "jsonld");
      renderOntologyGraph(ontology.jsonLd);
      document.getElementById("entity-ontology-code").hidden = false;
      ontologyStatus.hidden = true;
    } catch (error) {
      status.classList.add("error");
      status.textContent = `Could not load defaults: ${error.message}. Enter the parameters manually.`;
      ontologyStatus.classList.add("error");
      ontologyStatus.textContent = `Could not load the ontology definition: ${error.message}`;
    }
    for (const example of entityExamples) addDemoSample(example.operation, example.title, defaults, example);
  }

  const setupExamples = [
    ["Verify the saved topic index link", "content", "After linking, this read-only example follows the saved link: content vector field → topicGraphProfile → profile indexName.",
      ["SEARCH_ENDPOINT", "API_VERSION", "CONTENT_INDEX_NAME", "VECTOR_FIELD_NAME", "TOPIC_INDEX_NAME"], p => `import json
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from azure.identity import DefaultAzureCredential

search_endpoint = ${p("SEARCH_ENDPOINT")}.rstrip("/")
api_version = ${p("API_VERSION")}
content_index_name = ${p("CONTENT_INDEX_NAME")}
vector_field_name = ${p("VECTOR_FIELD_NAME")}
expected_topic_index = ${p("TOPIC_INDEX_NAME")}
credential = DefaultAzureCredential()

def read_index(name):
    # Read the preview schema over REST to access the topic graph fields.
    query = urlencode({"api-version": api_version})
    url = f"{search_endpoint}/indexes/{quote(name, safe='')}?{query}"
    token = credential.get_token("https://search.azure.com/.default").token
    with urlopen(Request(url, headers={"Authorization": f"Bearer {token}"}), timeout=30) as response:
        return json.load(response)

# The vector field names a profile; it does not name the topic index directly.
content_index = read_index(content_index_name)
vector_field = next(f for f in content_index["fields"] if f["name"] == vector_field_name)
profile_name = vector_field.get("topicGraphProfile")
if not profile_name:
    raise ValueError(f"{vector_field_name} has no topicGraphProfile")

# Resolve that profile on the content index to find the companion topic index (TOPIC_INDEX_NAME).
profiles = content_index.get("vectorSearch", {}).get("topicGraphProfiles", [])
profile = next((p for p in profiles if p["name"] == profile_name), None)
if not profile or not profile.get("indexName"):
    raise ValueError(f"Topic graph profile {profile_name!r} has no linked index")

linked_topic_index = profile["indexName"]
if linked_topic_index != expected_topic_index:
    raise ValueError(f"Schema links to {linked_topic_index!r}, not {expected_topic_index!r}")

# Read the resolved target to confirm the companion topic index (TOPIC_INDEX_NAME) exists.
topic_index = read_index(linked_topic_index)
print(f"{content_index_name}.{vector_field_name} -> {profile_name} -> {topic_index['name']}")`],
    ["Create the knowledge source", "create-source", "Point the source at the content index from the linking step and store Balanced topic sampling.",
      ["SEARCH_ENDPOINT", "CONTENT_INDEX_NAME", "KNOWLEDGE_SOURCE_NAME", "VECTOR_FIELD_NAME", "CONTENT_FIELD_NAME", "MIN_DIVERSITY_POOL_SIZE"], p => `from azure.identity import DefaultAzureCredential
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndexFieldReference, SearchIndexKnowledgeSource,
    SearchIndexKnowledgeSourceParameters,
)
from azure.search.documents.models import BalancedVectorQueryTopicGraph

index_client = SearchIndexClient(endpoint=${p("SEARCH_ENDPOINT")}, credential=DefaultAzureCredential())
source_name = ${p("KNOWLEDGE_SOURCE_NAME")}
# Use the content index, not the companion topic index (TOPIC_INDEX_NAME).
parameters = SearchIndexKnowledgeSourceParameters(
    search_index_name=${p("CONTENT_INDEX_NAME")},
    search_fields=[SearchIndexFieldReference(name=${p("VECTOR_FIELD_NAME")})],
    source_data_fields=[SearchIndexFieldReference(name=${p("CONTENT_FIELD_NAME")})],
    topic_graph=BalancedVectorQueryTopicGraph(
        min_diversity_pool_size=int(${p("MIN_DIVERSITY_POOL_SIZE")}),
    ),
)
source = SearchIndexKnowledgeSource(
    name=source_name, results_processing="none", search_index_parameters=parameters,
)
index_client.create_or_update_knowledge_source(source)`],
    ["Attach the source to a knowledge base", "create-base", "Supply the name of the source you created and configure extractive retrieval with minimal reasoning.",
      ["SEARCH_ENDPOINT", "KNOWLEDGE_SOURCE_NAME", "KNOWLEDGE_BASE_NAME"], p => `from azure.identity import DefaultAzureCredential
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import KnowledgeBase, KnowledgeSourceReference
from azure.search.documents.knowledgebases.models import (
    KnowledgeRetrievalMinimalReasoningEffort, KnowledgeRetrievalOutputMode,
)

index_client = SearchIndexClient(endpoint=${p("SEARCH_ENDPOINT")}, credential=DefaultAzureCredential())
base_name = ${p("KNOWLEDGE_BASE_NAME")}
# Attach the knowledge source by name; neither index is referenced directly here.
base = KnowledgeBase(
    name=base_name,
    knowledge_sources=[KnowledgeSourceReference(name=${p("KNOWLEDGE_SOURCE_NAME")})],
    retrieval_reasoning_effort=KnowledgeRetrievalMinimalReasoningEffort(),
    output_mode=KnowledgeRetrievalOutputMode.EXTRACTIVE_DATA,
)
index_client.create_or_update_knowledge_base(base)`],
  ];

  async function loadSetupExamples(defaultsRequest) {
    const reload = document.getElementById("setup-code-reload");
    const status = document.getElementById("setup-code-status");
    const container = document.getElementById("setup-code-samples");
    reload.disabled = true;
    status.textContent = "Reading active Topic Graph configuration…";
    let defaults = {API_VERSION: "2026-11-01-preview", MIN_DIVERSITY_POOL_SIZE: "1000"};
    try {
      const {variables, warning} = await defaultsRequest;
      defaults = variables;
      status.textContent = warning || `Loaded from the active Topic Graph. Graph Lab uses REST ${defaults.API_VERSION}.`;
    } catch (error) {
      status.textContent = `Could not load active values: ${error.message}. Enter values manually.`;
      if (container.childElementCount) return;
    } finally {
      reload.disabled = false;
    }
    container.replaceChildren(...setupExamples.map(([title, operation, description, fields, snippet]) => {
      const card = document.createElement("article");
      card.className = "topic-demo-sample";
      card.dataset.setupOperation = operation;
      const heading = document.createElement("h4");
      const link = document.createElement("a");
      link.className = "doc-title-link";
      link.href = `${get("learn").href.split("#")[0]}#${steps[operation][0]}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = title;
      heading.append(link);
      const note = document.createElement("p");
      note.className = "small";
      note.textContent = description;
      const grid = document.createElement("div");
      grid.className = "topic-api-grid";
      const code = document.createElement("pre");
      code.tabIndex = 0;
      code.setAttribute("aria-label", `${title} Python sample`);
      const fieldsByName = {};
      for (const name of fields) {
        const label = document.createElement("label");
        label.textContent = variables.find(([key]) => key === name)[1];
        const input = document.createElement("input");
        input.name = name;
        input.value = defaults[name] ?? "";
        input.maxLength = 128;
        input.autocomplete = "off";
        fieldsByName[name] = input;
        label.append(input);
        grid.append(label);
      }
      const update = () => renderCode(code, snippet(name => JSON.stringify(fieldsByName[name].value.trim())), "python");
      grid.addEventListener("input", update);
      update();
      card.append(heading, note, grid, code);
      return card;
    }));
  }

  displayOperation();
  const defaultsRequest = jsonRequest("/api/topic-console/defaults");
  loadDemo(defaultsRequest);
  loadEntityDemo();
  reset(defaultsRequest);
  loadSetupExamples(defaultsRequest);
  document.getElementById("setup-code-reload").addEventListener("click", () =>
    loadSetupExamples(jsonRequest("/api/topic-console/defaults")));
}
