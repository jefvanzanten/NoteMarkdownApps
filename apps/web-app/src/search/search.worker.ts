import { searchCorpus, type SearchableDocument } from "./searchEngine";

const documents = new Map<string, string>();

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as
    | { type: "replace"; id: number; documents: SearchableDocument[] }
    | { type: "upsert"; id: number; document: SearchableDocument }
    | { type: "remove"; id: number; path: string }
    | { type: "query"; id: number; query: string };
  if (message.type === "replace") {
    documents.clear();
    for (const document of message.documents) documents.set(document.path, document.content);
    self.postMessage({ type: "ack", id: message.id });
    return;
  }
  if (message.type === "upsert") {
    documents.set(message.document.path, message.document.content);
    self.postMessage({ type: "ack", id: message.id });
    return;
  }
  if (message.type === "remove") {
    documents.delete(message.path);
    self.postMessage({ type: "ack", id: message.id });
    return;
  }
  const corpus = Array.from(documents, ([path, content]) => ({ path, content }));
  self.postMessage({ type: "results", id: message.id, results: searchCorpus(corpus, message.query) });
});
