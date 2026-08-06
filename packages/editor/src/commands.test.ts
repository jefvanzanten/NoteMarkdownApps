import { describe, expect, it } from "vitest";
import { editorCommands, findKeybindingConflicts, getEditorCommand } from "./commands";

describe("editor command registry", () => {
  it("exposes stable unique command identities", () => {
    const ids = editorCommands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getEditorCommand("document.save")?.defaultBindings).toContain("Mod-s");
  });

  it("detects custom keybinding collisions", () => {
    const conflicts = findKeybindingConflicts({
      "markdown.bold": ["Mod-k"],
      "markdown.italic": ["mod-K"],
    });
    expect(conflicts).toEqual([{
      binding: "mod-k",
      commandIds: ["markdown.bold", "markdown.italic"],
    }]);
  });

  it("allows a command binding to be disabled", () => {
    expect(findKeybindingConflicts({ "markdown.bold": [] })).toEqual([]);
  });
});
