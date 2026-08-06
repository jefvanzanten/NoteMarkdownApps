import type { MarkdownRenderResult, RenderResponse } from "@note/markdown-wasm";

type PendingRender = {
  resolve: (result: MarkdownRenderResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
const pendingRenders = new Map<string, PendingRender>();

/**
 * Builds the stable key used to match worker responses.
 * @param documentId Active document identity.
 * @param generation Monotonic render generation.
 * @returns A worker-request key.
 */
function requestKey(documentId: string, generation: number): string {
  return `${documentId}:${generation}`;
}

/**
 * Lazily creates the one dedicated render worker.
 * @returns The shared renderer worker.
 */
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<RenderResponse>) => {
    const response = event.data;
    const key = requestKey(response.documentId, response.generation);
    const pending = pendingRenders.get(key);
    if (!pending) return;
    pendingRenders.delete(key);
    if (response.type === "error") pending.reject(new Error(response.message));
    else pending.resolve(response.result);
  });
  worker.addEventListener("error", (event) => {
    for (const pending of pendingRenders.values()) pending.reject(new Error(event.message));
    pendingRenders.clear();
  });
  return worker;
}

/**
 * Renders Markdown through Rust/WASM outside the UI thread.
 * @param documentId Active document identity.
 * @param generation Monotonic render generation.
 * @param markdown UTF-8 Markdown source.
 * @returns Safe HTML and extracted preview metadata.
 */
export function renderMarkdown(
  documentId: string,
  generation: number,
  markdown: string,
): Promise<MarkdownRenderResult> {
  return new Promise((resolve, reject) => {
    pendingRenders.set(requestKey(documentId, generation), { resolve, reject });
    getWorker().postMessage({ documentId, generation, markdown });
  });
}
