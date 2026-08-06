export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
}

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, (results: SearchResult[]) => void>();
const pendingMutations = new Map<number, () => void>();

/**
 * Returns the singleton incremental search worker.
 * @returns Worker that owns all searchable Markdown content.
 */
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<{ type: string; id: number; results?: SearchResult[] }>) => {
    if (event.data.type === "results") {
      pending.get(event.data.id)?.(event.data.results ?? []);
      pending.delete(event.data.id);
      return;
    }
    if (event.data.type === "ack") {
      pendingMutations.get(event.data.id)?.();
      pendingMutations.delete(event.data.id);
    }
  });
  return worker;
}

/**
 * Replaces the complete in-memory search corpus.
 * @param documents Workspace Markdown sources.
 * @returns Promise resolved after the worker acknowledges replacement.
 */
export function replaceSearchDocuments(documents: Array<{ path: string; content: string }>): Promise<void> {
  return mutateSearchWorker({ type: "replace", documents });
}

/**
 * Incrementally adds or replaces one searchable document.
 * @param path Workspace-relative document path.
 * @param content Current Markdown content.
 * @returns Promise resolved after the worker acknowledges indexing.
 */
export function indexSearchDocument(path: string, content: string): Promise<void> {
  return mutateSearchWorker({ type: "upsert", document: { path, content } });
}

/**
 * Removes a path from normal search results.
 * @param path Deleted or trashed document path.
 * @returns Promise resolved after the worker acknowledges removal.
 */
export function removeSearchDocument(path: string): Promise<void> {
  return mutateSearchWorker({ type: "remove", path });
}

/**
 * Applies a worker mutation and resolves only after worker acknowledgement.
 * @param message Mutation payload without request identity.
 * @returns Promise resolved after the search corpus changes.
 */
function mutateSearchWorker(message: Record<string, unknown>): Promise<void> {
  const id = ++requestId;
  return new Promise((resolve) => {
    pendingMutations.set(id, resolve);
    getWorker().postMessage({ ...message, id });
  });
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
