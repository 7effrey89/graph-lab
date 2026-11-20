const get = id => document.getElementById(`index-browser-${id}`);
let page = 0;
let appliedSearch = "";
let hasNext = false;

async function request(action, params = {}) {
  const response = await fetch("/api/index-browser", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({action, ...params}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function status(message, error = false) {
  get("status").textContent = message;
  get("status").classList.toggle("error", error);
}

function clear() {
  get("results").replaceChildren();
  get("pages").hidden = true;
  get("chunk-index").hidden = true;
  page = 0;
  hasNext = false;
}

function options(element, items) {
  element.replaceChildren(...items.map(([id, label]) => new Option(label, id)));
}

async function renderPage(target, term) {
  status("Reading documents from Azure…");
  const {documents, count, keyField, exactField, chunkFields, relationshipIndex, start, hasNext: next} = await request("documents", {
    service: get("service").value, index: get("index").value, search: term, page: target,
  });
  const results = documents.map((doc, index) => {
    const row = document.createElement("details");
    const label = document.createElement("summary");
    const hint = doc.title || doc.subject || doc.name || doc.metadata_storage_name;
    const key = doc[keyField];
    label.textContent = `${start + index + 1}. ${hint || key || "Document"}`;
    const content = document.createElement("pre");
    renderCode(content, JSON.stringify(doc, null, 2), "json");
    row.append(label, content);
    if (term && term !== "*" && index === 0) row.open = true;
    return row;
  });
  get("results").replaceChildren(...results);
  page = target;
  appliedSearch = term;
  hasNext = next;
  const range = `Showing ${(start + 1).toLocaleString()}–${(start + documents.length).toLocaleString()}`;
  const total = count == null ? "" : ` · ${count.toLocaleString()} matching documents`;
  const scope = exactField ? ` · Exact match on ${exactField}` : term && term !== "*" ? ` · Keywords: ${term}` : "";
  status((results.length ? `${range}${total}` : "No matching documents.") + scope);
  const keyHint = keyField ? ` Paste "${keyField}": "value" for an exact lookup.` : "";
  get("scope").textContent = (relationshipIndex
    ? "This index searches relationship records, not transcript text."
    : chunkFields.length ? `Keywords search the chunk text (${chunkFields.join(", ")}).`
      : "Keywords search indexed fields.") + keyHint;
  const index = get("index").value;
  const chunkIndex = index.replace(/-graph-index$/, "-index");
  get("chunk-index").hidden = !relationshipIndex || chunkIndex === index
    || ![...get("index").options].some(option => option.value === chunkIndex);
  get("pages").hidden = !page && !hasNext;
}

async function loadIndexes() {
  clear();
  get("term").value = "";
  options(get("index"), []);
  status("Loading Azure Search indexes…");
  const {indexes} = await request("indexes", {service: get("service").value});
  options(get("index"), indexes.map(name => [name, name]));
  if (!indexes.length) {
    status("No indexes found on this service.");
    return;
  }
  await renderPage(0, "");
}

async function run(action) {
  const controls = ["load", "service", "index", "term", "search", "chunk-index", "prev", "next"];
  for (const id of controls) get(id).disabled = true;
  try {
    await action();
  } catch (error) {
    status(error.message, true);
  } finally {
    for (const id of controls) get(id).disabled = false;
    get("index").disabled = get("search").disabled = !get("index").options.length;
    get("prev").disabled = page === 0;
    get("next").disabled = !hasNext;
  }
}

get("load").addEventListener("click", () => run(async () => {
  clear();
  get("form").hidden = true;
  status("Reading configured Search services…");
  const {services} = await request("services");
  const current = get("service").value;
  options(get("service"), services.map(({id, endpoint}) => [id, new URL(endpoint).hostname]));
  if (services.some(({id}) => id === current)) get("service").value = current;
  get("form").hidden = false;
  get("load").textContent = "Refresh indexes";
  await loadIndexes();
}));
get("service").addEventListener("change", () => run(loadIndexes));
get("index").addEventListener("change", () => run(async () => {
  clear();
  get("term").value = "";
  await renderPage(0, "");
}));
get("chunk-index").addEventListener("click", () => run(async () => {
  const term = get("term").value.trim();
  get("index").value = get("index").value.replace(/-graph-index$/, "-index");
  clear();
  get("term").value = /^(?:"\w+"|\w+)\s*:/.test(term) ? "" : term;
  await renderPage(0, get("term").value);
}));
get("term").addEventListener("input", () => {
  if (get("term").value.trim() !== appliedSearch) status("Search text changed. Press Enter or click Search documents to apply it.");
  else status("Press Enter or click Search documents to refresh the results.");
});
get("form").addEventListener("submit", event => {
  event.preventDefault();
  run(async () => {
    clear();
    await renderPage(0, get("term").value.trim());
  });
});
get("prev").addEventListener("click", () => run(() => renderPage(page - 1, appliedSearch)));
get("next").addEventListener("click", () => run(() => renderPage(page + 1, appliedSearch)));
