import { describe, expect, it } from "vitest";
import { availableMarkdownPath, classifyWorkspaceEntry, ensureMarkdownPath, joinWorkspacePath, normalizeWorkspacePath, resolveWorkspaceTarget } from "./path";

describe("workspace paths", () => {
  it("normalizes separators", () => {
    expect(normalizeWorkspacePath("/notes\\today.md/")).toBe("notes/today.md");
    expect(joinWorkspacePath("notes", "nested/today.md")).toBe("notes/nested/today.md");
  });

  it("rejects traversal", () => {
    expect(() => normalizeWorkspacePath("notes/../secret.md")).toThrow();
    expect(resolveWorkspaceTarget("notes/today.md", "../../secret.md")).toBeNull();
    expect(resolveWorkspaceTarget("notes/today.md", "%E0%A4%A")).toBeNull();
  });

  it("resolves relative content paths", () => {
    expect(resolveWorkspaceTarget("notes/daily/today.md", "../assets/photo.png#x")).toBe("notes/assets/photo.png");
  });

  it("adds the Markdown extension to created document paths", () => {
    expect(ensureMarkdownPath("notes/meeting")).toBe("notes/meeting.md");
    expect(ensureMarkdownPath("notes/meeting.txt")).toBe("notes/meeting.txt.md");
    expect(ensureMarkdownPath("notes/MEETING.MD")).toBe("notes/MEETING.md");
  });

  it("finds a collision-free Markdown path in the requested directory", () => {
    const entries = [
      { kind: "directory" as const, name: "notes", path: "notes", children: [
        { kind: "document" as const, name: "untitled.md", path: "notes/untitled.md" },
        { kind: "document" as const, name: "untitled-2.md", path: "notes/untitled-2.md" },
      ] },
    ];
    expect(availableMarkdownPath(entries, "notes")).toBe("notes/untitled-3.md");
    expect(availableMarkdownPath(entries)).toBe("untitled.md");
  });

  it("only classifies supported content", () => {
    expect(classifyWorkspaceEntry("note.md", false)).toBe("document");
    expect(classifyWorkspaceEntry("photo.avif", false)).toBe("image");
    expect(classifyWorkspaceEntry("script.js", false)).toBeNull();
    expect(classifyWorkspaceEntry(".git", true)).toBeNull();
  });
});
