import { describe, expect, it } from "vitest";
import { classifyWorkspaceEntry, joinWorkspacePath, normalizeWorkspacePath, resolveWorkspaceTarget } from "./path";

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

  it("only classifies supported content", () => {
    expect(classifyWorkspaceEntry("note.md", false)).toBe("document");
    expect(classifyWorkspaceEntry("photo.avif", false)).toBe("image");
    expect(classifyWorkspaceEntry("script.js", false)).toBeNull();
    expect(classifyWorkspaceEntry(".git", true)).toBeNull();
  });
});
