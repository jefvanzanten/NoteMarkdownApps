export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
}

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, (results: SearchResult[]) => void>();

/**
 * Returns the singleton incremental search worker.
 * @returns Worker that owns all searchable Markdown content.
 */
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<{ type: string; id: number; results: SearchResult[] }>) => {
    if (event.data.type !== "results") return;
    pending.get(event.data.id)?.(event.data.results);
    pending.delete(event.data.id);
  });
  return worker;
}

/**
 * Replaces the complete in-memory search corpus.
 * @param documents Workspace Markdown sources.
 * @returns Nothing after the worker message is queued.
 */
export function replaceSearchDocuments(documents: Array<{ path: string; content: string }>): void {
  getWorker().postMessage({ type: "replace", documents });
}

/**
 * Incrementally adds or replaces one searchable document.
 * @param path Workspace-relative document path.
 * @param content Current Markdown content.
 * @returns Nothing after the worker message is queued.
 */
export function indexSearchDocument(path: string, content: string): void {
  getWorker().postMessage({ type: "upsert", document: { path, content } });
}

/**
 * Removes a path from normal search results.
 * @param path Deleted or trashed document path.
 * @returns Nothing after the worker message is queued.
 */
export function removeSearchDocument(path: string): void {
  getWorker().postMessage({ type: "remove", path });
}

/**
 * Runs a local full-text query outside the UI thread.
 * @param query Case-insensitive query with optional exact phrases.
 * @returns Ranked matching paths and contextual snippets.
 */
export function searchDocuments(query: string): Promise<SearchResult[]> {
  const id = ++requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ type: "query", id, query });
  });
}
