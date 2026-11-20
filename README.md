# NoteAssistant Graph Lab

A loopback web demo for the Foundry IQ Knowledge Graph public preview. Run `python -B lab.py serve`, then open `http://127.0.0.1:8765`. Python 3.10+ suffices for local mode. NoteAssistant's own checkout is unchanged.

- **Topic graph:** Compare native Azure AI Search vector queries with Balanced, Diverse, and Off. Balanced uses the content field's stored topic profile; Off is the vector baseline without topic sampling. Results link to original local NoteAssistant files when the index includes `session_id` and `source_kind`.
- **Entity graph:** Native extraction uses the configured **Person**, **Organization**, **Product**, and **Product Feature** ontology. Run natural language retrieval or a direct `Person → Organization → Product` GQL traversal.

All query modes use Foundry IQ with no local graph, ranking, or answer fallback. Results keep Azure's response order and show scores and HTTPS evidence links when Azure supplies them. The optional CLI note export prepares text from `.json/transcript.json` and `.json/live-recap.json`; it neither builds graphs nor uploads files.

Click **ⓘ** next to the query button in Explore to see the Python call and Azure AI Search REST request for the current mode, strategy, and question. Graph Lab uses the live knowledge source definition to resolve its demo index for Topic Graph and direct Entity Graph. The displayed Topic Graph query targets the resolved content index directly and does not need a knowledge source or knowledge base. Opening the preview does not execute the query or display credentials.

## Live Azure setup

Select **Azure resources** in the diagram for shared prerequisites, deployment controls, and the checklist. Choose the full suite to see deployment steps for both graphs and Retriever 1. **Build + link topic index** links back to Azure resources for deployment checks and keeps the publishing and linking code, verification example, and live playground on the topic page. **Upload files to Blob** shows Entity Graph storage and ingestion details.

The **Base** setup map separates resource and model prerequisites from three independent paths. The actual full-suite run goes **Retriever 1 → Entity Graph → Topic Graph** after shared Search setup. Retriever 1 and Topic Graph push documents to their respective content indexes without an indexer; Topic Graph then builds from the stored vectors and links the companion topic index (`TOPIC_INDEX_NAME` in the examples). Only Entity Graph stages files in Blob Storage: the full-suite deployer uploads `graph-lab-fictional.txt` with Entra before creating the graph-enabled source with its ontology. Azure manages the indexer and both output indexes (chunks and graph); it doesn't use an existing content index. The deployment does not upload NoteAssistant files.

Knowledge bases reference knowledge sources and are needed for managed retrieval, not for direct index queries. Microsoft Retriever 1 is a Search-hosted retrieval model, not a model deployed into Foundry. Direct search can return stored Entity Graph records as search hits, but it does not traverse the graph or run Topic Graph vector sampling. The setup checklist and Azure activity report what actually ran.

Choose **Topic KB (optional)** for the Microsoft Learn knowledge-base examples: stored settings, a Diverse override, and disabled sampling. Each has editable fields and a matching Python SDK example on the left, and extractive evidence, status, and raw Azure JSON on the right. **Execute** sends the equivalent Entra-authenticated knowledge-base REST request without changing the saved source settings. **Topic vector query** opens the playground for direct vector search against the content index.

The Entity Graph nodes show editable Python examples for creating a graph-enabled Blob source, inspecting the managed indexes, verifying extraction, and attaching the source to a knowledge base. Run natural-language knowledge-base retrieval or a direct GQL traversal with Azure results beside the code. Creation examples are previews only; executable cards do not modify resources. Defaults use the demo's organization-to-product data, not the Seattle corpus in Microsoft Learn.

The **Ontology definition** card shows the local `RELATIONS` and `ontology()` Python code and generated JSON-LD on the left, with the concepts and relationships diagram on the right. On narrow screens the diagram stacks below the code. Use **Discover the managed indexes** to inspect the ontology returned by the deployed source instead.

Entity Graph query examples offer a **Graph** result view with directed, labeled links for simple GQL paths that return both endpoint names. It shows a subset of the returned relationships, not the entire index; links are grouped by returned names and types. **Matches** shows the row cards, including IDs when returned, and supporting excerpts. Expand **Match 1 JSON** (or any other match) to inspect that full row, including nested fields and provenance when returned. Use **Text** / **Answer** for the response text. **Azure response JSON** is available in every view.

For the full indexed graph, open **Chunk + entity graph indexes** and choose **Load full graph**. The interactive canvas uses [Cytoscape.js](https://js.cytoscape.org/) with a force-directed layout, pan, zoom, and draggable nodes. Select a node (or use the entity dropdown) to highlight its relationships, or click an arrow to open its raw records. The view reads all pages of the live managed graph index through the read-only Index Browser API. Arrows with matching endpoint IDs, types, and predicates are grouped without dropping records. It does not run a GQL query or infer edges. The pinned JavaScript bundle and MIT license are in `vendor`; there is no CDN dependency.

The Topic Graph knowledge-base examples and the Entity Graph natural-language example offer **Output mode → Synthesized answer**. This sends `outputMode: "answerSynthesis"` for that request only, uses the model configured on the knowledge base, and leaves retrieval settings unchanged. Azure model token charges apply. See **Azure retrieval activity** for `modelAnswerSynthesis` and, on Entity Graph queries that traverse the graph, `graphSearch`. Topic sampling applies to vector retrieval; `searchIndex` activity alone does not establish that it ran. Citations and references are returned by Azure; inspect **Azure response JSON** for the reference details. Embedded JSON in extractive results is expanded for readability; choose **Show original escaped JSON** to see it as returned. Direct vector and GQL queries do not synthesize answers.

Click a walkthrough or example heading to open its Microsoft Learn reference in a new tab.

Select **Create content index** and choose **Load indexes** to see the indexes on the active Search service (and the Retriever service if configured separately). Select an index to page through its documents or search. On the Entity Graph relationship index, choose **Search source chunks instead** to search transcript and recap text. Use `"id": "value"` or `"uid": "value"` with the selected index's key field for an exact match. Expand a row to inspect the returned JSON; vector embeddings and non-retrievable fields are excluded. This view uses your existing Entra sign-in and does not change any Azure resources.

**Add or reuse embeddings** shows a read-only check for an existing chunk vector. **Build + link topic index** then shows Python that assigns `topicGraphProfile`, registers the named profile in `vectorSearch.topicGraphProfiles`, and saves the content schema with a `PUT`. Set `SEARCH_ENDPOINT`, `CONTENT_INDEX_NAME`, and `TOPIC_INDEX_NAME` before running that example from the Graph Lab folder. The separate verification example reads the saved link without modifying it. Knowledge-source and knowledge-base creation examples appear under **Topic KB (optional)**, after the linking step, and each includes its own client and inputs.

**Build + link topic index** shows the examples in execution order: publish the companion topic index (`TOPIC_INDEX_NAME`) and upload the builder's JSONL records, update the existing content index to link it, then verify the saved link. The publishing example reads `TOPIC_BUILD_DIR` and is not executed by the UI. Microsoft Learn's **Set up requests** starts at verification: it assumes both indexes are populated and already linked. Knowledge-base setup comes afterward and is optional.

On the right, **Load live linkage** verifies the content field's profile and matches the live topic records to the builder release. The interactive [Cytoscape.js](https://js.cytoscape.org/) canvas shows all topics and chunks, with pan, zoom, draggable nodes, and a topic picker to focus on a subtree. Click a chunk or use the chunk picker to read its live, non-vector JSON. Chunk membership comes from the original builder artifacts, not vector similarity or direct edges stored in Azure. The existing demo uses `official-iq-plugin/notes-build` next to `graph-lab`; set `GRAPH_TOPIC_BUILD_DIR` to use another matching build folder. Retain the builder folder when publishing if you want to inspect membership later. The source ZIP does not include these artifacts.

The graph labels stored parent-to-child arrows with the Search predicate `HasSubTopic`. Select an arrow to inspect its subject, predicate, and object. Chunk membership links are dashed and unlabeled because they are not stored topic edges.

**Topic + Entity Graph** opens from the flowchart node fed by both graph indexes. The read-only Cytoscape.js overlay follows each indexed entity's `chunk_id` to its managed source snippet and looks for a shared contiguous passage (at least 12 whitespace-delimited tokens and 80 characters after whitespace normalization) in the verified Topic Graph member chunks. A topic circle includes the entity only if that passage names it. Shared entities sit once in the intersection of translucent circles when the memberships can be represented accurately; more complex patterns use explicitly labeled separate circles. Click a node to inspect its evidence or drag it within its region. Unmatched entities stay unshaded. Circles use direct chunk membership, not parent rollups. Azure stores the entity arrows, not the overlay or its topic-to-entity memberships.

The **Topic Graph API console** loads editable variables from the active knowledge source and the content vector's linked topic profile. It shows the exact REST payload, the equivalent Graph Lab Python call, and a linked Python SDK reference. The console runs the Learn guide's index and source reads, test source/base creation, and stored/Diverse/Off knowledge-base retrieval. It also exposes the direct vector-search API used by Explore. Read the status and JSON from Azure to compare the paths; a successful knowledge-base response alone doesn't demonstrate that topic sampling changed the results. PUT tests require confirmation and fresh `-api-test` names; they cannot overwrite existing resources. Delete any test knowledge base before deleting its test source.

The demo reads the Search endpoint, Foundry project endpoint, and chat deployment from `C:\git\xaml-markdown-editor-1\src\MarkdownEditor.App\appsettings.json`. Set `$env:GRAPH_AZURE_CONFIG` to load a different copy, or `$env:GRAPH_SEARCH_ENDPOINT` to override only the Search endpoint. Set the same environment variables for provisioning and serving, and restart the server after changing settings. The demo keeps its own graph resource names; it does not overwrite the Markdown Editor's index, source, or knowledge base. NoteAssistant's `App.config` still supplies the Entra tenant and local corpus settings; override the paths with `$env:NOTEASSISTANT_CONFIG` and `$env:NOTEASSISTANT_NOTES`.

```powershell
az login --tenant <AzureTenantID-from-App.config>
```

The server uses your Azure CLI **Microsoft Entra** identity in the configured tenant. It does not read API keys, use an app secret, or send tokens to the browser. Enable Search RBAC; the caller needs **Search Index Data Reader** for queries and **Search Service Contributor** for setup and definition/status inspection. Give the Search managed identity **Storage Blob Data Reader** on the source storage account and **Cognitive Services OpenAI User** on the deployment resource. A publisher that uploads notes also needs **Storage Blob Data Contributor**; creating/publishing Search indexes may need **Search Index Data Contributor** in addition to Search Service Contributor. Use a private, dedicated demo corpus and approved endpoints. Do not expose this personal loopback app on the network.

### Deploy all three demos from the UI

The sticky Mermaid flowchart is the main navigation. It shows Blob staging before content-index creation when starting from files (dotted arrow), and a direct push path with no Blob prerequisite. Graph Lab's automated push paths do not use Blob. Selecting a node shows the related setup, index browser, tutorial cards, or query tools alongside its explanation. The diagram highlights the current step, not deployment progress; the checklist reports what actually ran.

The diagram is rendered from `process.mmd` at build time, with no Mermaid runtime or CDN. To regenerate it, run `mmdc -i process.mmd -o process.svg` with Mermaid CLI 11.12.0, then `python embed_process.py process.svg`.

**Retriever 1** is a single query playground in the flowchart. Solid arrows into it show direct index search; dotted arrows show retrieval through the Content KB, Topic KB, or Entity Graph KB. **Topic vector query** still opens direct vector search, and the Entity Graph nodes still show their GQL or knowledge-base examples.

The diagram legend identifies the regular content index route in blue, Topic Graph in purple, Entity Graph in amber, and shared setup in gray. The selected node keeps its route color and gains a brighter outline.

Code examples show syntax colors and a language or format label. Python examples include comments where they clarify how indexes, sources, or query options fit together. REST and JSON payloads stay comment-free so their request bodies can be copied as valid JSON.

The checklist automatically inspects the active Search environment. Choose **Check deployed resources** to refresh the read-only inventory. The form prefills the detected subscription, resource group, and region, plus the configured Blob account, without overwriting edits. Enter your current public IPv4 yourself for a full deployment. Inventory checks confirm resource presence and selected settings, not all effective role assignments or end-to-end retrieval.

1. Install the official [Foundry IQ Topic Graph build tool](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-install-foundry-iq-skills) and set `GRAPH_TOPICGRAPH_EXE` to its executable before launching Graph Lab. The session installation also recognizes the verified adjacent Windows ARM64 executable.
2. In **Set up resources**, enter an existing resource group, an eligible Search region (for example `northeurope`), your current public IPv4, and the resource ID of an approved StorageV2 Blob account. Pre-fill the latter with `GRAPH_DEMO_STORAGE_ID` if desired. The account must have a dedicated NSP profile, allow the uploader's Entra traffic, have native Blob soft delete on and versioning off, and have HNS, shared keys and anonymous access off. A shared NSP profile is rejected rather than broadening access to other accounts.
3. Review the charges and role assignments, then select **Set up Azure resources**. The app creates an Entra-only Basic Search service with Standard Knowledge Retrieval and a private staging container. It reuses the configured Foundry account and models, adds only the new Search endpoint's IPv4 `/32` to the Storage NSP profile, and does not change the Storage firewall. Your Azure CLI identity needs rights to create Search and the container, update the dedicated NSP profile, and assign roles on Search, Storage and the Foundry account. This includes granting Search account-level Blob read access.

The suite deploys fictional documents only. The app switches all three tabs to the new endpoint after it observes a cited Retriever answer, a native GQL result with evidence, and native Topic Graph vector results. It saves the selected endpoint locally in `.graph-suite-endpoint`; remove that file and refresh to restore the previous target. The **Retriever 1 only** option remains available. A failed deployment can leave billable resources; retry with the same subscription, group, region and Storage ID to reuse them. To clean up, remove the new Search service, its role assignments on the reused accounts, and the deployment-owned Blob container and named NSP rule; do not delete the reused Storage account, NSP or Foundry resource.

```powershell
# Optional: stage reviewable text files. Nothing is uploaded by this step.
python lab.py export C:\temp\graph-lab-fixtures
# Use --dataset notes only if those excerpts are approved for the demo.
```

**Topic graph:** Use the [Foundry IQ skills plugin](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-install-foundry-iq-skills) to build the content and centroid indexes from the staged text. Use `text-embedding-3-large` for the embeddings and for the content index's query vectorizer. Publish the topic profile on the content vector field. Instruct the plugin to prepare indexes only, then attach those indexes to this demo's source and knowledge base:

```powershell
python lab.py provision topic --content-index <prepared-content-index> --confirm
```

Pass `--content` and `--vector` if the fields are not named `content` and `embedding`. Provisioning checks the profile binding and uses create-only requests for demo resources.

**Entity graph:** Use a private Azure Blob container on a non-HNS account with **native blob soft delete enabled and versioning disabled**. Entra roles alone don't provide network access: use an approved Storage NSP rule for Search's exact public IP instead of editing the Storage firewall. After review, upload only the approved export with `az storage blob upload-batch --auth-mode login`. Do not point the command or knowledge source at your full OneDrive corpus. Then provision:

```powershell
python lab.py provision entity --storage-id <storage-account-resource-id> --container <container> --confirm
```

The entity graph uses `gpt-5.6-sol` from the Markdown Editor settings and defaults to `text-embedding-3-large` for embeddings. Use `--embedding` to select a different deployment explicitly. The entity source creates its own managed graph asynchronously. In the UI choose **Foundry IQ · live (Entra)** and check **Azure status**. Wait for synchronization to finish without failed items, then run both retrieval modes. Use **Retrieval activity / generated query** to distinguish graph execution from ordinary search, and **Hydrated graph evidence** to trace direct GQL rows back to chunks.

Run live with `python -B lab.py serve`. The default demo prefix is `note-graph-lab`; use `GRAPH_PREFIX` to isolate separate runs. Cleanup requires deleting only the demo knowledge bases, sources and any topic indexes or staging blobs you created. A Foundry agent is unnecessary here: the Search API returns native graph retrieval, source references, and diagnostics directly.

## Microsoft Retriever 1

The **Retriever 1** playground uses [Microsoft Retriever 1](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-use-microsoft-retriever). Select a deployed Search index for direct `queryType: agentic` search or a knowledge base configured with `microsoftRetriever1` for Minimal, extractive retrieval. The dropdown shows deployed resource names alongside the friendly labels. For a knowledge base, the hint below the dropdown identifies the index used for the direct comparison. A knowledge base without the model appears disabled; the playground does not alter it or fall back to another model. The exact REST request and Azure diagnostics are available alongside the results. The legacy query playground (`#explore-graphs`) still supports policy answer synthesis using the configured Foundry chat deployment.

Selecting an index runs one direct query. Selecting a knowledge base compares three queries with the same question: direct Retriever 1 search of the backing index, KB extraction with Minimal reasoning (which can use Retriever 1 planning), and KB agentic retrieval with Low reasoning (external model planning). Both KB runs request `extractiveData` so synthesis does not confound the comparison. Each card opens its Azure response and diagnostics by default; the REST request remains expandable. The Entity Graph KB comparison uses the managed content chunk index for the direct baseline.

The direct index card has a **Retriever 1** badge in its heading. The KB cards show the **Query planning model** reported by Azure for that run, not just the configured model. Minimal can use the Search-hosted `microsoft-retriever-1`; Low uses the configured external planning model. Neither KB card requests answer synthesis.

New full-suite deployments configure the Topic KB and Entity Graph KB with both `microsoftRetriever1` and the Foundry chat model. Resuming a full-suite deployment adds Retriever 1 to either older KB if it still references the expected source, preserving its other settings. The Entity Graph KB keeps Low reasoning as its default. Direct searches of the managed entity indexes still return records without traversing relationships.

The demo requires a Search service in a [supported environment](https://learn.microsoft.com/en-us/azure/search/search-region-support) with the **Standard Knowledge Retrieval** plan (not the same as the Search SKU). The Search managed identity also needs **Cognitive Services User** access on the configured Foundry resource for synthesis.

In **Set up resources**, choose **Retriever 1 only**, enter an existing resource group and deployment region, and approve charges. **Set up Azure resources** creates a dedicated Basic Search service with Standard Knowledge Retrieval and API keys disabled. It reuses the configured Foundry deployment, grants the required roles, indexes fictional policies, and selects the new Search endpoint for Retriever 1 only after a live answer succeeds. The existing graph endpoint is unchanged.

Use an Azure CLI user identity that can create Search services in the target group and assign roles on both the new Search service and the configured Foundry resource. A failed setup may leave billable resources; the UI reports the service name. Retrying the same subscription, group, and region resumes that demo. To stop charges, remove the dedicated Search service and its managed identity's role assignment from the Foundry resource. Do not delete a shared resource group.

If you already have an eligible Search service, the original CLI command can provision just the index, source, and knowledge base:

```powershell
python -B lab.py provision retriever --confirm
```

This creates a dedicated semantic content index, knowledge source, and knowledge base. It uploads only two fictional HR policies, never NoteAssistant data. The command does not change the service plan or grant permissions. Delete only the demo's `-retriever-kb`, `-retriever-ks`, and `-retriever-idx` resources, in that order, to clean up.
