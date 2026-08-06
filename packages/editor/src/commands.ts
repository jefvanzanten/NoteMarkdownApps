import { indentLess, indentMore, redo, undo } from "@codemirror/commands";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { toggleFormatting } from "./extensions/keymap";

export type EditorCommandId =
  | "history.undo"
  | "history.redo"
  | "edit.indent"
  | "edit.outdent"
  | "markdown.bold"
  | "markdown.italic"
  | "markdown.strikethrough"
  | "document.save";

export interface EditorCommandContext {
  requestSave?: (view: EditorView) => void;
}

export interface EditorCommand {
  id: EditorCommandId;
  label: string;
  defaultBindings: readonly string[];
  isAvailable: (view: EditorView, context: EditorCommandContext) => boolean;
  run: (view: EditorView, context: EditorCommandContext) => boolean;
}

export type EditorKeybindings = Partial<Record<EditorCommandId, readonly string[]>>;

const alwaysAvailable = (): boolean => true;

export const editorCommands: readonly EditorCommand[] = [
  { id: "history.undo", label: "Undo", defaultBindings: ["Mod-z"], isAvailable: alwaysAvailable, run: undo },
  { id: "history.redo", label: "Redo", defaultBindings: ["Mod-y", "Shift-Mod-z"], isAvailable: alwaysAvailable, run: redo },
  { id: "edit.indent", label: "Indent", defaultBindings: ["Tab"], isAvailable: alwaysAvailable, run: indentMore },
  { id: "edit.outdent", label: "Outdent", defaultBindings: ["Shift-Tab"], isAvailable: alwaysAvailable, run: indentLess },
  {
    id: "markdown.bold",
    label: "Bold",
    defaultBindings: ["Alt-b"],
    isAvailable: alwaysAvailable,
    run: (view) => toggleFormatting(view, "**", "**"),
  },
  {
    id: "markdown.italic",
    label: "Italic",
    defaultBindings: ["Alt-i"],
    isAvailable: alwaysAvailable,
    run: (view) => toggleFormatting(view, "*", "*"),
  },
  {
    id: "markdown.strikethrough",
    label: "Strikethrough",
    defaultBindings: ["Alt-s"],
    isAvailable: alwaysAvailable,
    run: (view) => toggleFormatting(view, "~~", "~~"),
  },
  {
    id: "document.save",
    label: "Save document",
    defaultBindings: ["Mod-s"],
    isAvailable: (_view, context) => context.requestSave !== undefined,
    run: (view, context) => {
      context.requestSave?.(view);
      return context.requestSave !== undefined;
    },
  },
] as const;

/**
 * Finds one registered editor command by stable identity.
 * @param commandId Stable command ID.
 * @returns The matching command, when registered.
 */
export function getEditorCommand(commandId: EditorCommandId): EditorCommand | undefined {
  return editorCommands.find((command) => command.id === commandId);
}

/**
 * Detects keyboard chords assigned to more than one command.
 * @param customBindings Optional per-command keybinding overrides.
 * @returns Conflicting chords and the commands that claim them.
 */
export function findKeybindingConflicts(
  customBindings: EditorKeybindings = {},
): Array<{ binding: string; commandIds: EditorCommandId[] }> {
  const claims = new Map<string, EditorCommandId[]>();
  for (const command of editorCommands) {
    const bindings = customBindings[command.id] ?? command.defaultBindings;
    for (const binding of bindings) {
      const normalized = binding.trim().toLowerCase();
      if (!normalized) continue;
      claims.set(normalized, [...(claims.get(normalized) ?? []), command.id]);
    }
  }
  return Array.from(claims, ([binding, commandIds]) => ({ binding, commandIds }))
    .filter(({ commandIds }) => commandIds.length > 1);
}

/**
 * Builds a CodeMirror extension from the shared command registry.
 * @param customBindings Optional per-command overrides.
 * @param context App callbacks available to shared commands.
 * @returns A CodeMirror keymap extension.
 */
export function createCommandKeymap(
  customBindings: EditorKeybindings = {},
  context: EditorCommandContext = {},
): Extension {
  const bindings: KeyBinding[] = editorCommands.flatMap((command) =>
    (customBindings[command.id] ?? command.defaultBindings).map((key) => ({
      key,
      run: (view: EditorView) => command.isAvailable(view, context) && command.run(view, context),
    })),
  );
  return keymap.of(bindings);
}
