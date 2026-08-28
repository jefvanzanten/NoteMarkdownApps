import { describe, expect, it } from "vitest";
import type { CachedDocument } from "../storage/browserStorage";
import { moveWorkspaceEntry, movedReferenceCandidates, updateMovedReferences } from "./workspaceStore";

/** Creates one cached Markdown document for move-reference tests. @param path Workspace path. @param content Markdown source. @param entryId Stable test identity. @returns Complete cached document fixture. */
function cachedDocument(path: string, content: string, entryId = path): CachedDocument {
  return {
    workspaceId: "workspace",
    entryId,
    path,
    content,
    format: { hasBom: false, lineEnding: "\n" },
    cachedContentRevision: { id: `revision:${entryId}`, modifiedAt: 1, size: content.length },
    lastAccessedAt: 1,
  };
}

describe("workspace tree updates", () => {
  it("moves a document to the requested directory immediately", () => {
    const entries = [
      { kind: "directory" as const, name: "notes", path: "notes", children: [] },
      { kind: "document" as const, name: "draft.md", path: "draft.md" },
    ];

    expect(moveWorkspaceEntry(entries, "draft.md", "notes/final.md")).toEqual([
      { kind: "directory", name: "notes", path: "notes", children: [{ kind: "document", name: "final.md", path: "notes/final.md" }] },
    ]);
  });

  it("moves a directory together with its descendants", () => {
    const entries = [{
      kind: "directory" as const,
      name: "old",
      path: "old",
      children: [{ kind: "document" as const, name: "note.md", path: "old/note.md" }],
    }];

    expect(moveWorkspaceEntry(entries, "old", "new")).toEqual([{
      kind: "directory",
      name: "new",
      path: "new",
      children: [{ kind: "document", name: "note.md", path: "new/note.md" }],
    }]);
  });
});

describe("workspace move references", () => {
  it("rewrites a relative link to a renamed document", () => {
    expect(updateMovedReferences("[Plan](plan.md)", "index.md", "plan.md", "roadmap.md")).toEqual({
      path: "index.md",
      content: "[Plan](roadmap.md)",
    });
  });

  it("selects only cached documents whose content requires a background write", () => {
    const candidates = movedReferenceCandidates([
      cachedDocument("index.md", "[Plan](planning/untitled.md)", "index"),
      cachedDocument("notes.md", "No links", "notes"),
      cachedDocument("planning/untitled.md", "[Home](../index.md)", "moved"),
    ], "planning/untitled.md", "planning/roadmap.md");

    expect(candidates).toEqual([
      { entryId: "index", originalPath: "index.md", destinationPath: "index.md" },
    ]);
  });
});
