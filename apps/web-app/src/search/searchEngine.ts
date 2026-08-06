export interface SearchableDocument {
  path: string;
  content: string;
}

export interface LocalSearchResult {
  path: string;
  snippet: string;
  score: number;
}

/**
 * Parses unquoted words and exact quoted phrases from a local query.
 * @param query User-entered query.
 * @returns Normalized terms that must all match.
 */
export function parseSearchQuery(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLocaleLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Creates a compact contextual snippet around the first match.
 * @param content Original Markdown content.
 * @param term First normalized search term.
 * @returns A one-line result excerpt.
 */
function createSnippet(content: string, term: string): string {
  const normalized = content.toLocaleLowerCase();
  const index = Math.max(0, normalized.indexOf(term));
  const start = Math.max(0, index - 55);
  const end = Math.min(content.length, index + term.length + 95);
  const excerpt = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < content.length ? "…" : ""}`;
}

/**
 * Searches a local corpus using case-insensitive AND semantics.
 * @param documents Searchable Markdown documents.
 * @param query Query containing words and optional exact phrases.
 * @returns Ranked, bounded contextual results.
 */
export function searchCorpus(documents: Iterable<SearchableDocument>, query: string): LocalSearchResult[] {
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return [];
  const results: LocalSearchResult[] = [];
  for (const { path, content } of documents) {
    const haystack = `${path}\n${content}`.toLocaleLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    const pathMatches = terms.filter((term) => path.toLocaleLowerCase().includes(term)).length;
    results.push({ path, snippet: createSnippet(content, terms[0]), score: pathMatches * 100 - content.toLocaleLowerCase().indexOf(terms[0]) });
  }
  return results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, 500);
}
