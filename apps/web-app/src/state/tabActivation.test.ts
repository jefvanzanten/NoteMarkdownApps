import { describe, expect, it, vi } from "vitest";
import type { OpenDocument } from "./workspaceStore";
import { useWorkspaceStore } from "./workspaceStore";

/** Creates an open-document fixture. @param path Document path. @returns Complete clean tab snapshot. */
function openDocument(path: string): OpenDocument {
  return {
    entryId: path,
    path,
    content: "",
    format: { hasBom: false, lineEnding: "\n" },
    revision: { id: `revision:${path}`, modifiedAt: 1, size: 0 },
    editingState: "owned",
    cursor: 0,
    viewMode: "editor",
    saveState: "clean",
  };
}

describe("tab activation", () => {
  it("does not change file-browser selection", () => {
    vi.stubGlobal("window", { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    const original = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      tabs: [openDocument("first.md"), openDocument("second.md")],
      activePath: "first.md",
      selectedPath: "folder/selected.md",
    });

    useWorkspaceStore.getState().activateDocument("second.md");

    expect(useWorkspaceStore.getState()).toMatchObject({
      activePath: "second.md",
      selectedPath: "folder/selected.md",
    });
    useWorkspaceStore.setState({ tabs: original.tabs, activePath: original.activePath, selectedPath: original.selectedPath });
    vi.unstubAllGlobals();
  });
});
