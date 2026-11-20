const $ = id => document.getElementById(id);
function renderCode(block, source, language) {
  const labels = {python: "Python", json: "JSON", jsonld: "JSON-LD", http: "HTTP / REST", shell: "Command line"};
  const tokens = {
    python: /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|if|import|in|is|lambda|None|not|or|pass|raise|return|True|try|while|with|yield)\b|\b\d+(?:\.\d+)?\b/g,
    json: /"(?:\\.|[^"\\])*"(?<key>\s*:)?|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b/gi,
    http: /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b|^[A-Za-z][\w-]*(?=:)|"(?:\\.|[^"\\])*"(?<key>\s*:)?|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b/gim,
    shell: /^\S+|--[\w-]+/gm,
  };
  const code = document.createElement("code");
  let end = 0;
  for (const match of source.matchAll(tokens[language === "jsonld" ? "json" : language])) {
    code.append(source.slice(end, match.index));
    const token = document.createElement("span");
    const value = match[0];
    token.className = `code-token-${match.groups?.key ? "key"
      : value.startsWith("#") ? "comment" : /^["']/.test(value) ? "string"
      : /^-?\d/.test(value) ? "number" : "keyword"}`;
    token.textContent = value;
    code.append(token);
    end = match.index + value.length;
  }
  code.append(source.slice(end));
  block.dataset.codeLanguage = labels[language];
  if (!block.hasAttribute("aria-label")) block.setAttribute("aria-label", labels[language]);
  block.replaceChildren(...(source ? [code] : []));
}

let mode = "topic";
let busy = false;
let endpoint = "";
let retrieverEndpoint = "";
let setupRunning = false;
let setupTimer;
let graphDataset = "azure";
let noteCatalog = null;
let noteLoading = false;
let noteSelection = new Set();
const noteStorageKey = "graph-lab.note-sources";
const modes = ["topic", "entity", "retriever"];
const options = {
  topic: [["balanced", "Balanced · stored settings"], ["diverse", "Diverse · sample across topics"], ["none", "Off · no topic sampling"]],
  entity: [["natural", "Natural language → graph retrieval"], ["direct", "Direct GQL · two-hop traversal"]],
  retriever: [["answer", "Generated answer with citations"], ["extractive", "Extractive evidence only"]]
};
const prompts = {
  topic: "What are the main themes across these meetings?",
  entity: "Which people work for organizations that use Azure AI Search? Include evidence.",
  retriever: "What parental leave do Canadian employees receive and how do they request it?"
};
const notesEntityPrompt = "Show product mentions, usage, and features.";

function node(tag, value, className) {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
}

function feedback(message, error = false) {
  $("feedback").textContent = message;
  $("feedback").classList.toggle("error", error);
}

function sync() {
  const data = $("dataset").value;
  const direct = $("strategy").value === "direct";
  $("badge").textContent = data === "azure" ? "Live · Microsoft Entra" : "Local preview";
  $("source-hint").textContent = mode === "retriever"
    ? `Uses fictional HR policies only.${retrieverEndpoint ? ` Search: ${retrieverEndpoint}.` : ""}`
    : data === "azure"
    ? `Queries go to ${endpoint || "the Azure AI Search endpoint from Markdown Editor settings"}. Requires provisioned graph resources.`
    : data === "notes"
      ? mode === "entity"
        ? "Finds product mentions, explicit organization usage, and product features. This is local extraction, not Foundry."
        : "Reads transcript.json and live-recap.json from the selected sessions. Labels and rankings are local heuristics, not Foundry output."
      : mode === "topic"
        ? "Fictional data with local keyword ranking and group sampling. This is not Foundry output."
        : "Fictional data with explicit relationships. This is not Foundry extraction.";
  $("status").hidden = data !== "azure";
  $("note-config").hidden = data !== "notes";
  $("topic-setup").hidden = mode !== "topic" || data !== "azure";
  $("question").disabled = direct || busy;
  $("question").placeholder = direct ? "Runs a fixed read-only traversal; no question required." : "";
  if (mode === "entity") $("strategy").options[1].textContent = data === "notes"
    ? "Direct · show extracted relationships" : data === "synthetic" ? "Direct · show sample relationships" : "Direct GQL · two-hop traversal";
  $("run").textContent = mode === "retriever" && $("strategy").value === "answer" ? "Generate answer"
    : direct ? "Run traversal" : "Run query";
  $("dataset").disabled = true;
  $("run").disabled = busy || (mode === "retriever" && setupRunning)
    || (data === "notes" && (!noteCatalog || !noteSelection.size));
  $("status").disabled = busy || (mode === "retriever" && setupRunning);
  for (const id of ["note-filter", "note-defaults", "note-clear"]) $(id).disabled = busy || noteLoading;
  for (const input of $("note-list").querySelectorAll("input")) input.disabled = busy;
}

function clear() {
  $("output").replaceChildren();
  $("elapsed").textContent = "";
  feedback("Run a query to inspect evidence and graph details.");
}

function setMode(next) {
  if (busy) return;
  if (next === "retriever" && mode !== "retriever") graphDataset = $("dataset").value;
  if (mode === "retriever" && next !== "retriever") $("dataset").value = graphDataset;
  mode = next;
  if (mode === "retriever") $("dataset").value = "azure";
  for (const id of modes) $(id).setAttribute("aria-pressed", String(id === mode));
  $("strategy").replaceChildren(...options[mode].map(([value, name]) => new Option(name, value)));
  $("question").value = mode === "entity" && $("dataset").value !== "azure" ? notesEntityPrompt : prompts[mode];
  clear();
  sync();
  syncProcessOverview();
  if (mode === "retriever") refreshSetup();
  if ($("dataset").value === "notes" && !noteCatalog) loadNoteCatalog();
}

function updateNoteCount() {
  $("note-count").textContent = `${noteSelection.size} selected of ${noteCatalog.sessions.length} sessions. Newest modified first.`;
}

function renderNoteCatalog() {
  if (!noteCatalog) return;
  const search = $("note-filter").value.trim().toLocaleLowerCase();
  const matches = noteCatalog.sessions.filter(session =>
    `${session.label} ${session.title}`.toLocaleLowerCase().includes(search));
  const rows = document.createDocumentFragment();
  for (const session of matches) {
    const label = node("label");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.value = session.id;
    checkbox.checked = noteSelection.has(session.id);
    label.append(checkbox, node("span", `${session.label} · ${session.title}`));
    rows.append(label);
  }
  if (!matches.length) rows.append(node("p", "No matching sessions.", "small"));
  $("note-list").replaceChildren(rows);
  updateNoteCount();
  sync();
}

async function loadNoteCatalog() {
  if (noteLoading) return;
  noteLoading = true;
  $("note-count").textContent = "Loading local sessions…";
  sync();
  try {
    const response = await fetch("/api/notes/sources");
    const catalog = await response.json();
    if (!response.ok) throw new Error(catalog.error || `HTTP ${response.status}`);
    const saved = localStorage.getItem(noteStorageKey);
    const ids = saved === null ? catalog.defaults : JSON.parse(saved);
    if (!Array.isArray(ids)) throw new Error("The saved source selection is invalid.");
    const available = new Set(catalog.sessions.map(session => session.id));
    noteSelection = new Set(ids.filter(id => available.has(id)));
    noteCatalog = catalog;
    renderNoteCatalog();
  } catch (error) {
    $("note-config").open = true;
    $("note-count").textContent = `Could not load sources: ${error.message}`;
    $("note-list").replaceChildren();
    const retry = node("button", "Retry");
    retry.type = "button";
    retry.addEventListener("click", loadNoteCatalog);
    $("note-list").append(retry);
  } finally {
    noteLoading = false;
    sync();
  }
}

function saveNoteSelection() {
  clear();
  updateNoteCount();
  try {
    localStorage.setItem(noteStorageKey, JSON.stringify([...noteSelection]));
  } catch (error) {
    $("note-count").textContent += " Could not save the selection for the next visit.";
  }
  sync();
}

function details(title, data) {
  const el = node("details");
  el.append(node("summary", title), node("pre", typeof data === "string" ? data : JSON.stringify(data, null, 2)));
  return el;
}

function sourceLink(source, reference = {}) {
  const local = /^\/api\/notes\/document\/[a-f0-9]{32}\/(?:summary|transcript)$/.test(source.documentUrl ?? "");
  const href = local ? source.documentUrl : source.blob_url || source.url || reference.sourceUrl || reference.url;
  if (!href) return null;
  const url = URL.canParse(href, window.location.origin) ? new URL(href, window.location.origin) : null;
  if (!url || (!local && (!/^https:\/\//i.test(href) || url.username || url.password))) return null;
  const link = node("a", source.documentName && local ? `Open ${source.documentName}` : "Open source document", "source-link");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function azureScores(result) {
  const score = result["@search.score"] ?? result.searchScore ?? result.score;
  const reranker = result["@search.rerankerScore"] ?? result.rerankerScore;
  return [
    Number.isFinite(score) ? `Search score ${score}` : "",
    Number.isFinite(reranker) ? `Reranker score ${reranker}` : "",
  ].filter(Boolean);
}

function renderNoteGraph(rows, refs, topic) {
  const groups = new Map();
  function add(session, label, target) {
    if (!groups.has(session)) groups.set(session, []);
    groups.get(session).push({label, target});
  }
  if (topic) {
    refs.forEach(({sourceData, keywordScore}, index) => {
      if (sourceData?.session) add(sourceData.session,
        `#${index + 1} ${sourceData.kind} · score ${keywordScore}`, `graph-ref-${index}`);
    });
  } else {
    rows.forEach(({session, speaker}, index) => {
      if (session && speaker) add(session, speaker, `graph-path-${index}`);
    });
  }
  if (!groups.size) return node("p", "No matching results to draw a graph.", "small");

  const figure = node("figure", undefined, "note-graph");
  figure.append(node("figcaption", topic
    ? "Evidence graph · query → session → ranked excerpt"
    : "Relationship graph · speaker label → session → summary"));
  figure.append(node("p", topic ? "Local keyword retrieval, not a Foundry topic graph. Select an excerpt to jump to its evidence."
    : "Speaker labels are scoped to their session. Select a speaker to jump to that path.", "small"));
  const viewport = node("div", undefined, "graph-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "Scrollable graph");
  viewport.setAttribute("role", "region");
  function svg(tag, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }
  const height = 52 + [...groups.values()].reduce((sum, items) => sum + items.length * 38 + 12, 0);
  const graph = svg("svg", {viewBox: `0 0 600 ${height}`, width: 600, height, role: "group",
    "aria-label": topic ? "Query, sessions, and retrieved excerpts" : "Speakers, sessions, and summaries"});
  const edges = svg("g", {"aria-hidden": "true"});
  const vertices = svg("g");
  graph.append(edges, vertices);
  viewport.append(graph);
  figure.append(viewport);
  const xs = [12, 222, 408];
  const widths = [180, 156, 180];
  const headers = topic ? ["Query", "Session", "Evidence"] : ["Speaker label", "Session", "Summary"];
  headers.forEach((heading, i) => {
    const label = svg("text", {x: xs[i] + 8, y: 22, class: "graph-heading"});
    label.textContent = heading;
    vertices.append(label);
  });
  function connect(left, from, to) {
    const start = xs[left] + widths[left], end = xs[left + 1];
    const mid = (start + end) / 2;
    edges.append(svg("path", {d: `M${start} ${from} C${mid} ${from} ${mid} ${to} ${end - 3} ${to}`}));
    edges.append(svg("path", {d: `M${end - 8} ${to - 4} L${end - 3} ${to} L${end - 8} ${to + 4}`}));
  }
  function vertex(column, y, {label, target}) {
    const group = target ? svg("a", {href: `#${target}`, "aria-label": label}) : svg("g");
    const title = svg("title");
    title.textContent = label;
    const width = widths[column], x = xs[column];
    const text = svg("text", {x: x + 8, y: y + 4});
    const limit = column === 1 ? 18 : 21;
    const chars = [...label];
    text.textContent = chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : label;
    group.append(title, svg("rect", {x, y: y - 14, width, height: 28, rx: 6}), text);
    vertices.append(group);
  }
  const queryY = (height + 20) / 2;
  if (topic) vertex(0, queryY, {label: $("question").value.trim()});
  let top = 48;
  for (const [session, items] of groups) {
    const center = top + (items.length - 1) * 19;
    vertex(1, center, {label: session});
    if (topic) connect(0, queryY, center);
    else {
      vertex(2, center, {label: "Summary"});
      connect(1, center, center);
    }
    items.forEach((item, index) => {
      const y = top + index * 38;
      vertex(topic ? 2 : 0, y, item);
      if (topic) connect(1, center, y);
      else connect(0, y, center);
    });
    top += items.length * 38 + 12;
  }
  return figure;
}

function renderEntityGraph({nodes, edges}) {
  const out = node("div");
  if (!nodes.length) {
    out.append(node("p", "No recognized products or relationships were found in the selected excerpts.", "small"));
    return out;
  }
  const headings = ["Person / Organization", "Product", "Product feature"];
  const columns = [["Person", "Organization"], ["Product"], ["ProductFeature"]]
    .map(kinds => kinds.flatMap(kind => nodes.filter(item => item.kind === kind)));
  const height = 68 + Math.max(...columns.map(column => column.length)) * 37;
  const points = new Map();
  function svg(tag, attrs, value) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (value !== undefined) el.textContent = value;
    return el;
  }
  const canvas = svg("svg", {viewBox: `0 0 600 ${height}`, width: 600, height, role: "img",
    "aria-label": "Entity graph. The relationship evidence is listed below."});
  const links = svg("g", {}), vertices = svg("g", {});
  canvas.append(links, vertices);
  columns.forEach((column, i) => {
    const x = 10 + i * 207;
    vertices.append(svg("text", {x, y: 24, class: "graph-heading"}, headings[i]));
    column.forEach((item, j) => {
      const y = 52 + j * 37;
      points.set(item.id, {x, y, item});
      const group = svg("g", {});
      const full = `${item.label}${item.kind === "Person" && item.scope ? ` (${item.scope})` : ""}`;
      const short = [...full].length > 24 ? `${[...full].slice(0, 23).join("")}…` : full;
      group.append(svg("title", {}, `${item.kind}: ${full}`), svg("rect", {x, y: y - 14, width: 157, height: 28, rx: 6,
        class: item.kind === "Organization" ? "graph-organization" : ""}),
        svg("text", {x: x + 7, y: y + 4}, short));
      vertices.append(group);
    });
  });
  const legend = node("p", "Mentions (dotted) · Uses (solid) · Has feature (dashed). Organizations have a blue border.", "small");
  edges.forEach(({source, relation, target}) => {
    const a = points.get(source), b = points.get(target);
    if (!a || !b) return;
    const x = a.x + 157, end = b.x - 3;
    const bend = Math.min(42, (end - x) / 2);
    const attrs = relation === "Mentions" ? {"stroke-dasharray": "2 4"}
      : relation === "Has feature" ? {"stroke-dasharray": "8 4"} : {};
    const path = svg("path", {...attrs, d: `M${x} ${a.y} C${x + bend} ${a.y} ${end - bend} ${b.y} ${end} ${b.y}`});
    path.append(svg("title", {}, `${a.item.label} · ${relation} → ${b.item.label}`));
    links.append(path, svg("path", {d: `M${end - 5} ${b.y - 4} L${end} ${b.y} L${end - 5} ${b.y + 4}`}));
  });
  const figure = node("figure", undefined, "note-graph");
  const viewport = node("div", undefined, "graph-viewport entity-viewport");
  viewport.tabIndex = 0;
  viewport.append(canvas);
  figure.append(node("figcaption", "Product relationships"), legend, viewport);
  out.append(figure);
  if (!edges.length) out.append(node("p", "Products were recognized, but no supported relationships were found.", "small"));
  for (const [i, edge] of edges.entries()) {
    const a = points.get(edge.source)?.item, b = points.get(edge.target)?.item;
    if (!a || !b) continue;
    const row = node("div", undefined, "path");
    const label = a.kind === "Person" && a.scope ? `${a.label} (${a.scope})` : a.label;
    row.append(node("span", `#${i + 1}`, "small"), node("span", label, "node"),
      node("span", `${edge.relation} →`, "edge"), node("span", b.label, "node"));
    const evidence = node("details");
    evidence.append(node("summary", "Relationship evidence"));
    for (const citation of edge.evidence) {
      const item = node("article");
      item.append(node("strong", `${citation.session} / ${citation.kind}`), node("p", citation.text));
      const link = sourceLink(citation);
      if (link) item.append(link);
      evidence.append(item);
    }
    out.append(row, evidence);
  }
  return out;
}

function render(data, status, dataset) {
  const out = $("output");
  if (status) {
    const result = details("Resource details", data);
    result.open = true;
    out.append(result);
    const sync = data.ingestion;
    const last = sync?.lastSynchronizationState;
    feedback(sync
      ? last?.endTime && !sync.currentSynchronizationState
        ? `Last ingestion finished · ${last.itemsUpdatesFailed ?? "unknown"} failed items.`
        : "Ingestion is still running or has not completed."
      : mode === "retriever" ? "Retriever 1 source and knowledge base are available."
        : "Topic source and knowledge base are available.");
    return;
  }
  const rows = Array.isArray(data.value) ? data.value : [];
  const refs = Array.isArray(data.references) ? data.references : [];
  const activity = Array.isArray(data.activity) ? data.activity : [];
  if (data.topicSearch) out.append(node("p", `Azure AI Search · Topic Graph sampling: ${data.topicSearch.mode}`, "small"));
  const localTopics = mode === "topic" && dataset !== "azure";
  if (dataset === "notes" && localTopics) out.append(renderNoteGraph(rows, refs, true));
  if (data.entityGraph) out.append(renderEntityGraph(data.entityGraph));
  if (rows.length || refs.length) {
    const order = dataset === "azure"
      ? "Azure response order. Scores are shown only when supplied; citation IDs are not ranks."
      : localTopics
        ? $("strategy").value === "none"
          ? "Ordered by distinct question words found in each excerpt, highest first. Ties keep source order."
          : "Best-scoring excerpt from each session first, then additional excerpts. Within each group, higher keyword scores come first; ties keep source order."
        : dataset === "notes"
          ? "Session order, then first speaker appearance. No relevance score."
          : "Order of matching relationships in the sample. No relevance score.";
    out.append(node("p", order, "small"));
  }
  const generated = mode === "retriever" && $("strategy").value === "answer";
  if (generated) {
    const text = (data.response ?? []).flatMap(message => message.content ?? [])
      .filter(part => part.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("\n\n").trim();
    const answer = node("article");
    answer.append(node("strong", "Generated answer"), node("p", text || "No answer was returned."));
    out.append(answer);
  }
  if (data.groups) out.append(details("Local groups and theme labels", data.groups));
  if (data.gql) out.append(details("GQL traversal", data.gql));
  if (data.traversal) out.append(details("Local traversal", data.traversal));
  for (const [index, row] of rows.entries()) {
    const steps = "speaker" in row
      ? [row.speaker, "spoke in →", row.session, "has →", row.summary]
      : [row.person, "works for →", row.organization, "uses →", row.product ?? row.technology];
    if (!steps.every(x => typeof x === "string")) continue;
    const path = node("div", undefined, "path");
    path.id = `graph-path-${index}`;
    path.append(node("span", [`#${index + 1}`, ...azureScores(row)].join(" · "), "small"),
      ...steps.map((text, index) => node("span", text, index % 2 ? "edge" : "node")));
    out.append(path);
    if (row.evidence) out.append(details("Path evidence", row.evidence.join("\n\n")));
  }
  for (const [index, ref] of refs.entries()) {
    const source = ref.sourceData ?? {};
    const text = source.content || source.snippet;
    const metrics = localTopics
      ? [`Keyword score ${ref.keywordScore}`,
         ref.rankingPhase === "session-first" ? "Best in session"
           : ref.rankingPhase === "additional" ? "Additional excerpt" : ""]
      : azureScores(ref);
    const card = node("article");
    card.id = `graph-ref-${index}`;
    card.append(node("strong", [`#${index + 1}`, ref.id == null ? "" : `[ref_id:${ref.id}]`,
      source.title || source.session || source.uid || ref.docKey || "Source reference",
      source.kind, source.topic, ...metrics].filter(Boolean).join(" · ")));
    if (typeof text === "string") card.append(node("p", text));
    const link = sourceLink(source, ref);
    if (link) card.append(link);
    out.append(card);
  }
  for (const message of Array.isArray(data.response) ? data.response : []) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!generated && typeof part.text === "string") out.append(details("Extractive response", part.text));
    }
  }
  const hydrated = data["@search.graphProvenanceDocuments"];
  if (hydrated) {
    const evidence = node("details");
    evidence.append(node("summary", "Hydrated graph evidence"));
    for (const [id, source] of Object.entries(hydrated)) {
      if (!source || typeof source !== "object") continue;
      const card = node("article");
      card.append(node("strong", source.uid || id));
      if (typeof source.snippet === "string") card.append(node("p", source.snippet));
      const link = sourceLink(source);
      if (link) card.append(link);
      evidence.append(card);
    }
    out.append(evidence);
  }
  for (const [title, key] of [["Retrieval activity / generated query", "activity"], ["Source references", "references"]]) {
    if (data[key]) out.append(details(title, data[key]));
  }
  out.append(details("Raw response", data));
  const count = data.entityGraph ? `${data.entityGraph.nodes.length} entities · ${data.entityGraph.edges.length} evidence-backed relationships`
    : mode !== "entity" || (!rows.length && refs.length)
    ? `${refs.length} source reference${refs.length === 1 ? "" : "s"}`
    : `${rows.length} relationship path${rows.length === 1 ? "" : "s"}`;
  const graphSearch = activity.some(item => /graphsearch/i.test(JSON.stringify(item.type ?? item.kind ?? "")))
    || refs.some(ref => typeof ref.graphIndexName === "string");
  const isLiveNaturalEntity = dataset === "azure" && mode === "entity" && $("strategy").value === "natural";
  const retriever = activity.find(item => item.type === "modelQueryPlanning" && item.model?.modelName === "microsoft-retriever-1");
  feedback(`${count}.${mode === "retriever" ? retriever
    ? retriever.error ? " Microsoft Retriever 1 reported a planning error." : " Microsoft Retriever 1 planning reported."
    : " Microsoft Retriever 1 planning was not reported; inspect activity."
    : isLiveNaturalEntity ? graphSearch ? " Graph retrieval reported." : " No graph traversal was reported; inspect retrieval activity." : ""}`);
}

function queryInputs() {
  const dataset = $("dataset").value;
  return {
    mode, dataset, strategy: $("strategy").value, question: $("question").value,
    ...(dataset === "notes" ? {noteSources: [...noteSelection]} : {}),
  };
}

let queryPreview;
async function showQueryCode() {
  queryPreview?.abort();
  const preview = new AbortController();
  queryPreview = preview;
  const dialog = $("query-code");
  const status = $("query-code-status");
  const content = $("query-code-content");
  content.hidden = true;
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "Preparing the current query…";
  dialog.showModal();
  try {
    const reply = await fetch("/api/query/preview", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(queryInputs()),
      signal: preview.signal,
    });
    const data = await reply.json();
    if (preview.signal.aborted || !dialog.open) return;
    if (!reply.ok) throw new Error(data.error || `HTTP ${reply.status}`);
    const directTopic = Array.isArray(data.body.vectorQueries);
    const queryComment = directTopic
      ? "Search the vector content index. Its vector field profile points to the companion topic index (TOPIC_INDEX_NAME)."
      : data.body.gql
        ? "Traverse the managed graph index; provenance returns supporting chunks."
        : "Call the knowledge base, which routes retrieval through its configured knowledge sources.";
    const url = new URL(data.url);
    const python = directTopic ? `import json
from lab import request

body = json.loads(${JSON.stringify(JSON.stringify(data.body, null, 2))})
result = request("POST", ${JSON.stringify(url.pathname)}, body,
                 endpoint=${JSON.stringify(url.origin)},
                 api_version=${JSON.stringify(url.searchParams.get("api-version"))})
print(json.dumps(result, indent=2))` : data.python;
    renderCode($("query-code-python"),
      `# ${queryComment}\n# Graph Lab's request helper adds the Microsoft Entra bearer token.\n${python}`, "python");
    renderCode($("query-code-rest"), [
      ...(data.lookup && !directTopic ? [`GET ${data.lookup}`, ""] : []),
      `${data.method} ${data.url}`, "Content-Type: application/json", "",
      JSON.stringify(data.body, null, 2),
    ].join("\n"), "http");
    content.hidden = false;
    status.hidden = true;
  } catch (error) {
    if (preview.signal.aborted || !dialog.open) return;
    status.textContent = error.message;
    status.classList.add("error");
  }
}

async function submit(status) {
  if (busy) return;
  const dataset = $("dataset").value;
  if (!status && dataset === "notes" && (!noteCatalog || !noteSelection.size)) return;
  clear();
  busy = true;
  const controls = [...modes, "dataset", "strategy", "run", "status"].map($);
  controls.forEach(el => { el.disabled = true; });
  sync();
  document.querySelector(".results").setAttribute("aria-busy", "true");
  feedback(status ? "Checking Azure resources…"
    : mode === "retriever" && $("strategy").value === "answer" ? "Retrieving evidence and generating a cited answer…"
    : "Retrieving evidence…");
  const start = performance.now();
  try {
    const reply = await fetch(status ? "/api/status" : "/api/query", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(queryInputs()),
    });
    const data = await reply.json();
    if (!reply.ok) {
      const message = data.error || `HTTP ${reply.status}`;
      let setupHint = "";
      if (message.startsWith("Azure AI Search HTTP 404:")) {
        if (mode === "retriever") {
          setupHint = " Use Set up Retriever resources or provision the demo on a supported service.";
        } else if (mode === "topic" && dataset === "azure") {
          $("topic-setup").open = true;
          setupHint = " Live Topic Graph isn’t provisioned on this endpoint. Follow Set up live Topic Graph.";
        } else if (mode === "entity") {
          setupHint = " Live Entity Graph isn’t ready on this endpoint. Check the managed graph and ingestion status.";
        }
      }
      throw new Error(message + setupHint);
    }
    render(data, status, dataset);
  } catch (error) {
    feedback(error.message, true);
  } finally {
    $("elapsed").textContent = `${((performance.now() - start) / 1000).toFixed(2)} s`;
    busy = false;
    controls.forEach(el => { el.disabled = false; });
    document.querySelector(".results").setAttribute("aria-busy", "false");
    sync();
    syncScopedPlayground();
  }
}

for (const id of modes) $(id).addEventListener("click", () => setMode(id));
$("dataset").addEventListener("change", () => setMode(mode));
$("note-filter").addEventListener("input", renderNoteCatalog);
$("note-list").addEventListener("change", event => {
  const input = event.target;
  if (input.checked) noteSelection.add(input.value);
  else noteSelection.delete(input.value);
  saveNoteSelection();
});
$("note-defaults").addEventListener("click", () => {
  if (!noteCatalog) return;
  noteSelection = new Set(noteCatalog.defaults);
  renderNoteCatalog();
  saveNoteSelection();
});
$("note-clear").addEventListener("click", () => {
  if (!noteCatalog) return;
  noteSelection.clear();
  renderNoteCatalog();
  saveNoteSelection();
});
$("strategy").addEventListener("change", () => { clear(); sync(); syncProcessOverview(); });
$("query").addEventListener("submit", event => { event.preventDefault(); submit(false); });
$("query-code-open").addEventListener("click", showQueryCode);
$("status").addEventListener("click", () => submit(true));

const setupSteps = [
  ["preflight", "Check existing resource group, region and Foundry deployment"],
  ["search", "Create or resume Basic Azure AI Search with a managed identity"],
  ["roles", "Assign Search data roles and access to existing Foundry models"],
  ["retriever", "Create the Retriever 1 semantic content index, knowledge source and base; validate a cited answer"],
  ["storage", "Configure private Blob Storage access and upload the fictional demo text file"],
  ["entity", "Create Entity Graph source, base and managed indexes; verify extraction"],
  ["topic-indexes", "Build and publish Topic Graph content and topic indexes"],
  ["topic-retrieval", "Create Topic Graph knowledge source and base; verify retrieval"],
  ["activate", "Select the verified Search endpoint in Graph Lab"],
];
let latestSetup = {};
let setupInventory;
let inventoryRequest = 0;
let pendingInventoryScope;
const editedSetupFields = new Set();

const processPages = [...document.querySelectorAll("[data-process-page]")];
const setupViews = document.querySelectorAll("[data-setup-view]");
const processHeader = document.querySelector(".process-header");
const processNodes = [...processHeader.querySelectorAll('.process-diagram a[href^="#flow-"]')];
const topicPublishCode = `import json
from os import environ
from pathlib import Path
from suite_deploy import create_index, upload

endpoint = environ["SEARCH_ENDPOINT"].rstrip("/")
graph = environ["TOPIC_INDEX_NAME"]
build = Path(environ["TOPIC_BUILD_DIR"])
manifest = json.loads((build / "run-manifest.json").read_text(encoding="utf-8-sig"))
release = manifest["latestRelease"]
artifacts = build / "releases"
schema = json.loads((artifacts / f"{release}.schema.json").read_text(encoding="utf-8-sig"))
with (artifacts / f"{release}.documents.jsonl").open(encoding="utf-8-sig") as file:
    docs = [json.loads(line) for line in file if line.strip()]
if not docs:
    raise ValueError("The Topic Graph builder produced no records.")

# Publish the companion topic index (TOPIC_INDEX_NAME) before linking the content index.
create_index(endpoint, graph, schema)  # PUT the index schema using Entra.
upload(endpoint, graph, docs)          # POST the builder records in batches.`;
const processDetails = new Map([
  ["resources", ["Deploy or reuse Azure resources", "Graph Lab provisions Entra-only Azure AI Search and reuses the configured Foundry account and models. For Entity Graph only, it also reuses an approved private Blob account and its network security perimeter (NSP).", "#setup-panel", "Open resource setup"]],
  ["identity", ["Establish integration", "Enable the Search managed identity and grant it model access as needed. For the Blob branch, give Search Blob Data Reader and the uploader Blob Data Contributor, and allow the approved network path. The app does not change the Storage firewall.", "#setup-panel", "Open Entra and networking setup"]],
  ["models", ["Prepare Foundry model deployments", "Reuse or deploy an embedding model for vectors and a chat model for entity extraction or answer synthesis. Direct Retriever 1 is hosted by Search; it does not require either deployment.", "#setup-panel", "Open deployment prerequisites"]],
  ["index", ["Create the content index", "If starting from files in Blob Storage, stage the files first, then create the target index. Graph Lab's policy demo creates the index without Blob. It adds a semantic configuration, but neither that configuration nor a vector field is required for direct Retriever 1.", "#index-browser", "Open the full index browser", 'PUT /indexes/policies\n{\n  "name": "policies",\n  "fields": [\n    {"name": "id", "type": "Edm.String", "key": true},\n    {"name": "content", "type": "Edm.String", "searchable": true}\n  ]\n}']],
  ["push", ["Push documents to the content index", "If you staged files in Blob, your application can read and convert them to Search documents before pushing them. Graph Lab's direct ingestion paths don't use Blob or an indexer. Include chunk and vector fields in the records when your schema calls for them.", "#index-browser", "Open the full index browser", 'POST /indexes/policies/docs/index\n{"value":[{"@search.action":"upload","id":"p1","content":"Example policy text"}]}']],
  ["contentkb", ["Optional: create a content knowledge base", "First create a searchIndex knowledge source that references the content index. Then create a knowledge base that references the source. The policy route uses the settings below; direct searches don't use a knowledge base.", null, "", '{\n  "models": [{"kind": "microsoftRetriever1"}],\n  "retrievalReasoningEffort": {"kind": "minimal"},\n  "outputMode": "extractiveData"\n}']],
  ["vectors", ["Add or reuse embedded chunks", "Topic Graph needs a populated vector field. Add the field and backfill embeddings on an existing content index, or build a separate vector content index if your schema or chunking differs. The read-only Python below checks for a stored vector in a known chunk. It needs no topic index or knowledge base.", null, "", `from os import environ
from urllib.parse import quote
from lab import request

endpoint = environ["SEARCH_ENDPOINT"].rstrip("/")
index_name = quote(environ["CONTENT_INDEX_NAME"], safe="")
chunk_id = quote(environ["CHUNK_ID"], safe="")
field = "embedding"

# Check a known chunk in a content index with a retrievable vector field.
chunk = request("GET", f"/indexes/{index_name}/docs/{chunk_id}", endpoint=endpoint)
vector = chunk.get(field)
if not vector:
    raise ValueError(f"{field} is empty or not retrievable")
print(f"{field}: {len(vector)} dimensions")`]],
  ["topics", ["Build and link a companion topic index (TOPIC_INDEX_NAME)", "After the builder runs on the indexed embeddings, publish its result on the same Search service, then link the existing content index and verify the saved link. The write examples do not run from this page.", "#flow-resources", "Check deployed resources in Azure resources", `from os import environ
from lab import object_url, request

endpoint = environ["SEARCH_ENDPOINT"].rstrip("/")
content = environ["CONTENT_INDEX_NAME"]
graph = environ["TOPIC_INDEX_NAME"]
path = object_url("indexes", content)

# Verify that the companion topic index (TOPIC_INDEX_NAME) exists before linking it.
# In this demo, use "note-graph-lab-topic-notes-graph".
request("GET", object_url("indexes", graph), endpoint=endpoint)
definition = request("GET", path, endpoint=endpoint)
definition = {key: value for key, value in definition.items()
              if not key.startswith("@odata.")}
vector_field = next(field for field in definition["fields"]
                    if field["name"] == "embedding")

# Bind the embedding field to a profile targeting the companion topic index (TOPIC_INDEX_NAME).
name = "native-topics"
vector_field["topicGraphProfile"] = name
vector_search = definition["vectorSearch"]
profiles = vector_search.get("topicGraphProfiles") or []
vector_search["topicGraphProfiles"] = [
    profile for profile in profiles if profile["name"] != name
] + [{
    "name": name, "indexName": graph, "defaultKind": "balanced",
    "defaultMinDiversityPoolSize": 1000,
}]

# Save the profile on the content index, not the companion topic index (TOPIC_INDEX_NAME).
request("PUT", path, definition, endpoint=endpoint)`]],
  ["topicquery", ["Run direct Topic Graph vector search", "Query the vector content index, not the companion topic index (TOPIC_INDEX_NAME). Compare topic sampling with it turned off. This is a separate query route from Retriever 1."]],
  ["topickb", ["Optional: create a Topic Graph knowledge base", "The searchIndex knowledge source references the vector content index, not the companion topic index (TOPIC_INDEX_NAME). Select the linked vector field, set topic sampling on the source, and attach that source to the knowledge base.", "#topic-retrieval-demo", "Open Topic Graph code and retrieval examples"]],
  ["blob", ["Upload files to Blob Storage", "For a file-backed content index, stage the files before creating and populating the index. The dotted arrow marks this optional staging path: Blob upload by itself doesn't index the files. In Graph Lab's automated deployment, only Entity Graph uses Blob, and it uploads a fictional file using Entra, not NoteAssistant files.", "#setup-entity", "Open the full Entity Graph setup"]],
  ["ontology", ["Define the ontology", "Decide which entity types and relationships to extract. Supply the ontology in JSON-LD when creating the graph-enabled knowledge source.", "#entity-ontology-definition", "View the ontology, Python, and relationship diagram"]],
  ["source", ["Create the graph-enabled Blob knowledge source", "Point the source at the Blob container and pass the ontology and model configuration. This is the provisioning call; you don't create the graph index or indexer first.", "#entity-retrieval-create-source", "View the source creation code"]],
  ["indexer", ["Why there is an Azure-managed indexer", "Azure creates the indexer behind the Blob knowledge source. It reads files, chunks and embeds text, and runs entity and relationship extraction. Graph Lab does not create it manually; use synchronization status to monitor work and errors.", "#entity-retrieval-status", "Open Entity Graph extraction status"]],
  ["entity", ["Inspect the managed chunk and entity graph indexes", "The managed pipeline writes source chunks to createdResources.index and entities and relationships to createdResources.graphIndex. It doesn't read the content index from branch A.", "#entity-retrieval-source", "Discover the managed index names and schemas"]],
  ["gql", ["Query the entity graph directly with GQL", "After extraction, send a GQL query to the graph index. It can return relationships and supporting source evidence without a knowledge base or Retriever 1.", "#entity-retrieval-gql", "Open the GQL example and result graph"]],
  ["entitykb", ["Query the Entity Graph knowledge base", "Attach the graph-enabled Blob knowledge source to a knowledge base for natural-language graph retrieval. This route is separate from direct GQL and Retriever 1.", "#entity-retrieval-natural", "Open natural-language retrieval and examples"]],
]);
const flowContent = {
  resources: {pages: ["setup-panel"]},
  identity: {pages: ["setup-panel"]},
  models: {pages: ["setup-panel"]},
  index: {pages: ["index-browser"]},
  push: {pages: ["index-browser"]},
  vectors: {pages: []},
  topics: {pages: ["setup-panel"], setup: "topic"},
  topicquery: {pages: ["explore-graphs"], mode: "topic"},
  topickb: {pages: ["topic-retrieval-demo", "setup-panel"], setup: "topic"},
  blob: {pages: ["setup-panel"], setup: "entity"},
  ontology: {pages: ["entity-retrieval-demo"]},
  source: {pages: ["entity-retrieval-demo"]},
  indexer: {pages: ["entity-retrieval-demo"]},
  entity: {pages: ["entity-retrieval-demo"]},
  gql: {pages: ["entity-retrieval-demo"]},
  entitykb: {pages: ["entity-retrieval-demo"]},
};
let setupView = "base";
let activeProcessPage;

function showProcessDetail(key) {
  const [title, description, href, linkLabel, code] = processDetails.get(key);
  $("process-detail-title").textContent = title;
  $("process-detail-description").textContent = description;
  const language = ["vectors", "topics"].includes(key) ? "python" : key === "contentkb" ? "json" : "http";
  renderCode($("process-detail-code"), code || "", language);
  $("process-detail-code").setAttribute("aria-label", key === "topics"
    ? "Python example for linking the content index to the topic index"
    : `${$("process-detail-code").dataset.codeLanguage} example`);
  $("process-detail-code").hidden = !code;
  const topicLink = key === "topics";
  $("process-detail-layout").classList.toggle("show-topic-link", topicLink);
  $("topic-code-headings").hidden = !topicLink;
  $("topic-link-explorer").hidden = !topicLink;
  if (topicLink && !$("topic-publish-code").childElementCount) {
    renderCode($("topic-publish-code"), topicPublishCode, "python");
  }
  const link = $("process-detail-link");
  link.hidden = !href;
  if (href) link.href = href;
  else link.removeAttribute("href");
  link.textContent = linkLabel || "";
  $("entity-graph-overview-link").hidden = !["gql", "entitykb"].includes(key);
}

function syncScopedPlayground() {
  const playground = $("explore-graphs");
  const scopedMode = flowContent[playground.dataset.flowSlice]?.mode;
  if (!scopedMode) return;
  const waiting = busy && scopedMode !== mode;
  $("playground-wait").hidden = !waiting;
  playground.classList.toggle("awaiting-query", waiting);
  if (!waiting && scopedMode !== mode) setMode(scopedMode);
}

function syncProcessOverview() {
  const branchLabels = {topic: "Topic Graph", entity: "Entity Graph", retriever: "Retriever 1"};
  const page = activeProcessPage?.id;
  const tutorialBranch = page === "entity-retrieval-demo" ? "entity" : "topic";
  const setupBranch = page === "topic-console" ? "topic" : setupView;
  const detail = location.hash.slice("#flow-".length);
  const [nodes, label] = page === "process-detail" ? [[detail], processDetails.get(detail)[0]]
    : page === "combined-graph" ? [["combined"], "Topic + Entity Graph"]
    : page === "retriever-playground" ? [["retriever"], "Retriever 1 playground"]
    : page === "index-browser" ? [["index", "topics", "entity"], "Browse indexes"]
    : page === "explore-graphs" ? [[{topic: "topicquery", entity: $("strategy").value === "direct" ? "gql" : "entitykb", retriever: "retriever"}[mode]], `Query playground / ${branchLabels[mode]}`]
    : page === "topic-retrieval-demo" || page === "entity-retrieval-demo"
      ? [tutorialBranch === "entity" ? ["ontology", "source", "entitykb", "gql"] : ["topics", "topickb"], `Graph tutorials / ${branchLabels[tutorialBranch]}`]
      : setupBranch === "base" ? [["resources", "identity", "models"], "Set up resources / Base"]
        : [setupBranch === "topic" ? ["vectors", "topics"] : ["blob", "ontology", "source"], `Set up resources / ${branchLabels[setupBranch]}`];
  for (const item of processNodes) {
    const key = item.getAttribute("href").slice("#flow-".length);
    if (nodes.includes(key)) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  const diagram = processHeader.querySelector(".process-diagram");
  const firstActive = diagram.querySelector("a[aria-current=step]");
  if (firstActive && diagram.scrollWidth > diagram.clientWidth) {
    const nodeBounds = firstActive.getBoundingClientRect();
    const diagramBounds = diagram.getBoundingClientRect();
    if (nodeBounds.left < diagramBounds.left || nodeBounds.right > diagramBounds.right) {
      diagram.scrollLeft += (nodeBounds.left + nodeBounds.right - diagramBounds.left - diagramBounds.right) / 2;
    }
  }
  $("process-location").textContent = `You are here: ${label}`;
}

function updateProcessOffset() {
  document.documentElement.style.setProperty("--process-scroll-offset", `${processHeader.offsetHeight + 8}px`);
}
new ResizeObserver(updateProcessOffset).observe(processHeader);

function syncProcessNav(event) {
  const id = location.hash.slice(1);
  const target = document.getElementById(id === "flow-combined" ? "combined-graph"
    : ["flow-retriever", "flow-managed"].includes(id) ? "retriever-playground" : id);
  const detail = id.startsWith("flow-") && processDetails.has(id.slice(5)) ? id.slice(5) : null;
  const content = flowContent[detail];
  if (detail) showProcessDetail(detail);
  const page = (detail ? $("process-detail") : target?.closest("[data-process-page]"))
    || (/^graph-(ref|path)-\d+$/.test(id) ? $("explore-graphs") : null)
    || (id.startsWith("topic-retrieval-") ? $("topic-retrieval-demo")
      : id.startsWith("entity-retrieval-") ? $("entity-retrieval-demo") : $("setup-panel"));
  const view = content?.setup ?? (id === "setup-topic" ? "topic" : id === "setup-entity" ? "entity" : "base");
  const changed = detail || page !== activeProcessPage || (page.id === "setup-panel" && view !== setupView);
  setupView = view;
  activeProcessPage = page;
  for (const item of processPages) {
    const related = content?.pages.includes(item.id);
    item.hidden = item !== page && !related;
    if (related) item.dataset.flowSlice = detail;
    else delete item.dataset.flowSlice;
  }
  for (const item of setupViews) item.hidden = item.dataset.setupView !== setupView;
  $("setup-code-title").textContent = detail === "topics" ? "Verify the link in Python"
    : detail === "topickb" ? "Set up knowledge-base retrieval in Python" : "Topic Graph Python examples";
  $("setup-code-verification").hidden = detail !== "topics";
  $("setup-code-prerequisites").hidden = detail === "topics";
  $("playground-wait").hidden = true;
  $("explore-graphs").classList.remove("awaiting-query");
  syncScopedPlayground();
  syncProcessOverview();
  if (page.id === "retriever-playground" && !retrieverTargetsLoaded) loadRetrieverTargets();
  updateProcessOffset();
  if (!changed) return;
  if (detail) {
    page.scrollIntoView();
    $("process-detail-title").focus({preventScroll: true});
  } else if (target && page.contains(target) && target !== page) {
    const setupSubpage = page.id === "setup-panel" && view !== "base";
    (setupSubpage ? page : target).scrollIntoView();
    if (event && setupSubpage) target.focus({preventScroll: true});
  } else {
    window.scrollTo(0, 0);
    if (event) {
      const heading = $(page.getAttribute("aria-labelledby"));
      heading.tabIndex = -1;
      heading.focus({preventScroll: true});
    }
  }
}
window.addEventListener("hashchange", syncProcessNav);

const retrieverTargetSelect = $("retriever-target");
const retrieverQuestion = $("retriever-question");
const retrieverStatus = $("retriever-playground-status");
const retrieverRun = $("retriever-playground-run");
const retrieverRefresh = $("retriever-target-refresh");
const retrieverOutput = $("retriever-playground-results");
const retrieverBackingIndexes = {"policy-kb": "policy-index", "topic-kb": "topic-index", "entity-kb": "entity-chunks"};
let retrieverTargetsLoaded = false;
let retrieverTargets = [];
const retrieverExample = target => target?.id.startsWith("policy-")
  ? "What parental leave do Canadian employees receive and how do they request it?"
  : target?.id === "entity-kb" ? "Which organizations use Azure AI Search? Include supporting evidence."
    : target?.id === "entity-graph" ? "What entities are related to OneLake?" : "What was discussed about OneLake?";

function resetRetrieverOutput() {
  retrieverOutput.replaceChildren();
  retrieverOutput.classList.remove("comparison");
}

function updateRetrieverTarget(previousExample) {
  const target = retrieverTargets.find(item => item.id === retrieverTargetSelect.value);
  const baseline = target?.kind === "knowledge base"
    ? retrieverTargets.find(item => item.id === retrieverBackingIndexes[target.id])
    : null;
  $("retriever-target-hint").textContent = target
    ? target.kind === "index"
      ? `Index: ${target.name} · Direct agentic search`
      : `Knowledge base: ${target.name} · Direct comparison index: ${baseline?.name || "Unavailable"} · Minimal KB extraction and Low KB agentic retrieval`
    : "No Retriever 1 target is available.";
  if (target && (!retrieverQuestion.value || retrieverQuestion.value === previousExample)) {
    retrieverQuestion.value = retrieverExample(target);
  }
  retrieverRun.disabled = !target || !!target.unavailable;
  retrieverRun.textContent = target?.kind === "knowledge base" ? "Run three-way comparison" : "Run Retriever 1";
}

async function loadRetrieverTargets() {
  if (retrieverRefresh.disabled) return;
  const previous = retrieverTargetSelect.value;
  retrieverRefresh.disabled = retrieverTargetSelect.disabled = retrieverRun.disabled = true;
  retrieverStatus.classList.remove("error");
  retrieverStatus.textContent = "Reading deployed targets…";
  resetRetrieverOutput();
  const unavailable = $("retriever-unavailable");
  unavailable.hidden = true;
  try {
    const response = await fetch("/api/retriever/targets");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    retrieverTargets = body.targets;
    retrieverTargetSelect.replaceChildren(...["index", "knowledge base"].map(kind => {
      const group = node("optgroup");
      group.label = kind === "index" ? "Search indexes" : "Knowledge bases";
      for (const target of retrieverTargets.filter(item => item.kind === kind)) {
        const name = target.name ? ` — ${target.name}` : "";
        const option = new Option(target.label + name + (target.unavailable ? " (unavailable)" : ""), target.id);
        option.disabled = !!target.unavailable;
        group.append(option);
      }
      return group;
    }));
    const ready = retrieverTargets.filter(target => !target.unavailable);
    retrieverTargetSelect.value = (ready.find(target => target.id === previous)
      || ready.find(target => target.id === "policy-kb" && location.hash === "#flow-managed") || ready[0])?.id || "";
    unavailable.replaceChildren(...retrieverTargets.filter(target => target.unavailable)
      .map(target => node("li", `${target.label}: ${target.unavailable}`)));
    unavailable.hidden = !unavailable.childElementCount;
    retrieverTargetSelect.disabled = !ready.length;
    retrieverStatus.textContent = ready.length ? "Ready to query." : "No targets are ready.";
    retrieverTargetsLoaded = true;
    updateRetrieverTarget();
  } catch (error) {
    retrieverStatus.classList.add("error");
    retrieverStatus.textContent = error.message;
  } finally {
    retrieverRefresh.disabled = false;
  }
}

retrieverRefresh.addEventListener("click", loadRetrieverTargets);
retrieverTargetSelect.addEventListener("change", () => {
  const examples = retrieverTargets.map(retrieverExample);
  updateRetrieverTarget(examples.find(example => example === retrieverQuestion.value));
  resetRetrieverOutput();
  retrieverStatus.classList.remove("error");
  retrieverStatus.textContent = "Ready to query.";
});
async function runRetrieverPanel(title, targetId, question, effort) {
  const target = retrieverTargets.find(item => item.id === targetId);
  const card = node("article", undefined, "topic-demo-result");
  const status = node("p", "Running…", "small");
  status.setAttribute("role", "status");
  const parameters = effort
    ? `reasoning: ${effort} · output: extractiveData · 1 semantic intent · activity: on · runtime limit: 60s`
    : "queryType: agentic · top: 5 · debug: agentic · runtime limit: 60s";
  const planner = node("p", undefined, "small");
  planner.hidden = true;
  const heading = node("h3", title);
  if (!effort) heading.append(" ", node("span", "Retriever 1", "retriever-badge"));
  card.append(heading, node("p", target?.name || target?.label || targetId, "small"),
    node("p", parameters, "small"), planner, status);
  retrieverOutput.append(card);
  const evidence = node("div", undefined, "retriever-evidence");
  function showCode(label, text, language, expanded = false) {
    const details = node("details");
    details.open = expanded;
    const pre = node("pre");
    pre.tabIndex = 0;
    renderCode(pre, text, language);
    details.append(node("summary", label), pre);
    card.append(details);
  }
  try {
    if (!target || target.unavailable) throw new Error(target?.unavailable || "No backing index is configured.");
    const started = performance.now();
    const response = await fetch("/api/retriever/run", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({target: targetId, question, ...(effort ? {reasoningEffort: effort} : {})})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const {request, azure: {status: azureStatus, body}} = data;
    const elapsed = ` · ${((performance.now() - started) / 1000).toFixed(1)}s`;
    showCode("REST request and parameters", `${request.method} ${request.url}\n\n${JSON.stringify(request.body, null, 2)}`, "http");
    showCode("Azure response and diagnostics", JSON.stringify(body, null, 2), "json", true);
    if (azureStatus >= 400) throw new Error(`Azure ${azureStatus}: ${body.error?.message || body.error || "Query failed."}`);
    if (target.kind === "index") {
      const hits = body.value || [];
      const ran = !!body["@search.debug"]?.agentic;
      status.textContent = `${hits.length} search hits · ${ran ? "Agentic diagnostics returned" : "No agentic diagnostics returned"}${elapsed}`;
      for (const hit of hits) {
        const text = hit.content || hit.snippet || [hit.subject_id_display_name,
          hit.predicate, hit.object_id_display_name || hit.object_string].filter(Boolean).join(" → ");
        evidence.append(node("h4", hit.title || hit.id || hit.uid || "Search result"), node("p", text || "See Azure response."));
      }
    } else {
      const references = body.references || [];
      const plans = (body.activity || []).filter(item => item.type === "modelQueryPlanning");
      const planners = [...new Set(plans.map(item => {
        const name = item.model?.modelName || "Model name not reported";
        const kind = name === "microsoft-retriever-1" ? " (Search-hosted retrieval model)" : "";
        return `${name}${kind}${item.error ? " — planning error" : ""}`;
      }))];
      planner.replaceChildren(node("strong", "Query planning model: "),
        planners.length ? planners.join(", ") : "No model planning reported by Azure.");
      planner.hidden = false;
      status.textContent = `${references.length} references${elapsed}`;
      for (const reply of body.response || []) for (const part of reply.content || []) {
        if (typeof part.text === "string") {
          let items;
          try { items = JSON.parse(part.text); } catch { items = null; }
          if (!Array.isArray(items)) evidence.append(node("p", part.text));
          else for (const item of items) {
            evidence.append(node("p", item?.content || item?.text || JSON.stringify(item)));
          }
        }
      }
    }
    if (evidence.childElementCount) {
      evidence.tabIndex = 0;
      card.append(evidence);
    }
    return true;
  } catch (error) {
    status.classList.add("error");
    status.textContent = error.message;
    return false;
  }
}

$("retriever-playground-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (retrieverRun.disabled || !retrieverQuestion.value.trim()) return;
  const target = retrieverTargets.find(item => item.id === retrieverTargetSelect.value);
  const question = retrieverQuestion.value;
  const compare = target.kind === "knowledge base";
  retrieverRun.disabled = retrieverRefresh.disabled = retrieverTargetSelect.disabled = retrieverQuestion.disabled = true;
  resetRetrieverOutput();
  retrieverStatus.classList.remove("error");
  retrieverStatus.textContent = compare ? "Running three queries with the same question…" : "Running direct index search…";
  retrieverOutput.classList.toggle("comparison", compare);
  try {
    const results = compare ? await Promise.all([
      runRetrieverPanel("Direct index", retrieverBackingIndexes[target.id], question),
      runRetrieverPanel("Knowledge base · Extractive", target.id, question, "minimal"),
      runRetrieverPanel("Knowledge base · Agentic", target.id, question, "low"),
    ]) : [await runRetrieverPanel("Direct index", target.id, question)];
    const successful = results.filter(Boolean).length;
    retrieverStatus.textContent = successful === results.length ? "Results ready."
      : `${successful} of ${results.length} queries succeeded. See individual results for details.`;
  } finally {
    retrieverRefresh.disabled = retrieverTargetSelect.disabled = retrieverQuestion.disabled = false;
    updateRetrieverTarget();
  }
});

const graphSetupSteps = {topic: ["topic-indexes", "topic-retrieval"], entity: ["storage", "entity"]};
const isFullSetupInventory = () => setupView !== "base" || $("setup-scope").value === "suite";

function renderSetupChecklist() {
  const selectedSuite = $("setup-scope").value === "suite";
  const suite = isFullSetupInventory();
  const state = latestSetup.suite === suite ? latestSetup : {};
  const inventory = setupInventory?.suite === suite ? setupInventory.checks : {};
  const baseSteps = setupSteps.filter(([id]) => !Object.values(graphSetupSteps).flat().includes(id));
  const deploymentSteps = suite ? setupSteps : baseSteps;
  const active = deploymentSteps.findIndex(([id]) => id === state.phase);
  const steps = setupView === "base" ? deploymentSteps : setupSteps.filter(([id]) => graphSetupSteps[setupView].includes(id));
  const checklistLabel = {base: suite ? "Full-suite deployment" : "Retriever 1 deployment", topic: "Topic Graph", entity: "Entity Graph"};
  $("setup-checklist-title").textContent = `${checklistLabel[setupView]} checklist`;
  $("setup-scope-note").textContent = setupView === "base"
    ? (selectedSuite ? "Shared resources, Retriever 1, Entity Graph, and Topic Graph."
      : "Shared resources and Retriever 1 only. This deployment does not change Storage or graph resources.")
    : "Included in the full-suite deployment. The progress bar shows progress for the whole deployment.";
  $("setup-progress").max = deploymentSteps.length;
  $("setup-progress").value = state.status === "ready" ? deploymentSteps.length : Math.max(0, active);
  $("setup-checklist").replaceChildren(...steps.map(([id, title]) => {
    const index = deploymentSteps.findIndex(([step]) => step === id);
    const detected = inventory?.[id];
    const label = state.status === "ready" || index < active ? "Complete"
      : index === active && state.status === "running" ? "In progress"
      : index === active && state.status === "failed" ? "Failed"
      : state.status === "running" || state.status === "failed" ? "Pending"
      : detected?.status || "Pending";
    const name = id === "search" ? state.resource : id === "storage" && state.container;
    const row = node("li");
    const badge = node("span", label);
    badge.dataset.status = label;
    if (label === "In progress") row.setAttribute("aria-current", "step");
    row.append(node("span", name ? `${title} · ${name}` : title), badge);
    if (detected?.details && state.status !== "running") {
      row.append(node("div", detected.details, "small"));
    }
    return row;
  }));
  $("setup-status").textContent = state.message || "No deployment in progress for this selection.";
  $("setup-status").classList.toggle("error", state.status === "failed");
}

function showSetup(state) {
  clearTimeout(setupTimer);
  const justCompleted = state.status === "ready" && latestSetup.status === "running";
  latestSetup = state;
  setupRunning = state.status === "running";
  if (setupRunning) $("setup-scope").value = state.suite ? "suite" : "retriever";
  for (const id of ["setup-scope", "setup-subscription", "setup-group", "setup-region", "setup-confirm", "setup-run"]) {
    $(id).disabled = setupRunning;
  }
  syncSetupFields();
  renderSetupChecklist();
  if (state.endpoint) {
    if (state.suite) endpoint = state.endpoint;
    retrieverEndpoint = state.endpoint;
  }
  if (setupRunning && !state.starting) {
    setupTimer = setTimeout(refreshSetup, 2500);
  }
  if (justCompleted) refreshSetupInventory();
  sync();
}

function syncSetupFields() {
  const suite = $("setup-scope").value === "suite";
  $("setup-suite-fields").hidden = !suite;
  for (const id of ["setup-storage", "setup-ip"]) {
    $(id).disabled = setupRunning || !suite;
  }
}

async function refreshSetupInventory() {
  const suite = isFullSetupInventory();
  if (pendingInventoryScope === suite) return;
  const id = ++inventoryRequest;
  pendingInventoryScope = suite;
  const feedback = $("setup-inventory-status");
  $("setup-inventory-refresh").disabled = true;
  feedback.classList.remove("error");
  feedback.textContent = "Reading deployed resources from Azure…";
  try {
    const path = suite ? "/api/deploy/inventory" : "/api/retriever/setup/inventory";
    const response = await fetch(path);
    const data = await response.json();
    if (id !== inventoryRequest || suite !== isFullSetupInventory()) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setupInventory = {suite, checks: data.checks};
    if (!setupRunning && suite === ($("setup-scope").value === "suite")) {
      const inputs = {subscription: "setup-subscription", resourceGroup: "setup-group", region: "setup-region",
        storage: "setup-storage"};
      for (const [key, field] of Object.entries(inputs)) {
        if (data.values[key] && !editedSetupFields.has(field)) $(field).value = data.values[key];
      }
    }
    feedback.textContent = `Existing resources on ${new URL(data.endpoint).hostname}. This check does not create resources.`;
    renderSetupChecklist();
  } catch (error) {
    if (id !== inventoryRequest) return;
    feedback.textContent = `Could not check deployed resources: ${error.message}`;
    feedback.classList.add("error");
  } finally {
    if (id === inventoryRequest) {
      pendingInventoryScope = undefined;
      $("setup-inventory-refresh").disabled = false;
    }
  }
}

$("setup-scope").addEventListener("change", () => { syncSetupFields(); renderSetupChecklist(); refreshSetupInventory(); });
window.addEventListener("hashchange", () => {
  if ($("setup-panel").hidden) return;
  renderSetupChecklist();
  const suite = isFullSetupInventory();
  if (setupInventory?.suite !== suite || (pendingInventoryScope !== undefined && pendingInventoryScope !== suite)) {
    refreshSetupInventory();
  }
});
$("setup-inventory-refresh").addEventListener("click", refreshSetupInventory);
$("setup").addEventListener("input", event => editedSetupFields.add(event.target.id));
syncSetupFields();
renderSetupChecklist();

async function setupRequest(options, path = "/api/retriever/setup") {
  const response = await fetch(path, options);
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
  showSetup(state);
}

async function refreshSetup() {
  try {
    await setupRequest();
  } catch (error) {
    $("setup-status").textContent = `Could not check setup: ${error.message}`;
    if (setupRunning) setupTimer = setTimeout(refreshSetup, 2500);
  }
}

$("setup").addEventListener("submit", async event => {
  event.preventDefault();
  if (setupRunning) return;
  const suite = $("setup-scope").value === "suite";
  const body = JSON.stringify({
    subscription: $("setup-subscription").value.trim(),
    resourceGroup: $("setup-group").value.trim(),
    region: $("setup-region").value.trim().toLowerCase(),
    costAccepted: $("setup-confirm").checked,
    ...(suite ? {storage: $("setup-storage").value.trim(), clientIp: $("setup-ip").value.trim()} : {})
  });
  showSetup({status: "running", suite, phase: "preflight", starting: true, message: "Starting Azure setup…"});
  try {
    await setupRequest({method: "POST", headers: {"Content-Type": "application/json"}, body},
      suite ? "/api/deploy" : "/api/retriever/setup");
  } catch (error) {
    showSetup({status: "failed", suite, phase: "preflight", message: error.message});
  }
});

setMode("topic");
renderCode($("topic-setup-command"), $("topic-setup-command").textContent, "shell");
syncProcessNav();
renderSetupChecklist();
fetch("/api/config").then(response => response.ok ? response.json() : {}).then(data => {
  endpoint = data.endpoint || "";
  retrieverEndpoint = data.retrieverEndpoint || "";
  if (!$("setup-subscription").value && !editedSetupFields.has("setup-subscription")) $("setup-subscription").value = data.subscription || "";
  if (!$("setup-storage").value && !editedSetupFields.has("setup-storage")) $("setup-storage").value = data.demoStorage || "";
  sync();
  return refreshSetup();
}).catch(() => { /* Selecting live still reports backend configuration errors. */ });
refreshSetupInventory();
