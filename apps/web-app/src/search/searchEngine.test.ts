import { describe, expect, it } from "vitest";
import { parseSearchQuery, searchCorpus } from "./searchEngine";

describe("local full-text search", () => {
  it("parses words and exact quoted phrases", () => {
    expect(parseSearchQuery('Roadmap "safe update"')).toEqual(["roadmap", "safe update"]);
  });

  it("matches names and content case-insensitively with AND semantics", () => {
    const documents = [
      { path: "notes/Roadmap.md", content: "A SAFE UPDATE retains every draft." },
      { path: "notes/other.md", content: "A safe update without the requested file name." },
    ];
    expect(searchCorpus(documents, 'roadmap "safe update"').map(({ path }) => path)).toEqual(["notes/Roadmap.md"]);
  });

  it("returns a contextual snippet", () => {
    const [result] = searchCorpus([{ path: "note.md", content: `${"before ".repeat(20)}needle after` }], "needle");
    expect(result.snippet).toContain("needle");
    expect(result.snippet.startsWith("…")).toBe(true);
  });
});
