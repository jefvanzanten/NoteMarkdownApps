import { EditorView, keymap } from "@codemirror/view";
import { history, undo, redo, indentMore, indentLess } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { textVerticalBounds } from "./dragDrop.js";

export const toggleFormatting = (view: EditorView, prefix: string, suffix: string): boolean => {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;

  if (from === to) {
    view.dispatch({
      changes: { from, to, insert: prefix + suffix },
      selection: { anchor: from + prefix.length },
    });
    return true;
  }

  const selectedText = doc.sliceString(from, to);
  const preStart = Math.max(0, from - prefix.length);
  const postEnd = Math.min(doc.length, to + suffix.length);
  const beforeText = doc.sliceString(preStart, from);
  const afterText = doc.sliceString(to, postEnd);

  if (beforeText === prefix && afterText === suffix) {
    view.dispatch({
      changes: [
        { from: preStart, to: from, insert: "" },
        { from: to, to: postEnd, insert: "" },
      ],
      selection: { anchor: preStart, head: preStart + selectedText.length },
    });
    return true;
  }

  if (selectedText.startsWith(prefix) && selectedText.endsWith(suffix)) {
    const inner = selectedText.slice(prefix.length, selectedText.length - suffix.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return true;
  }

  view.dispatch({
    changes: { from, to, insert: prefix + selectedText + suffix },
    selection: { anchor: from + prefix.length, head: from + prefix.length + selectedText.length },
  });
  return true;
};

const edgeAwarePos = (view: EditorView, x: number, y: number) => {
  const { top, bottom } = textVerticalBounds(view);

  const clampedY = y < top
    ? view.coordsAtPos(0)?.top ?? top
    : y > bottom
      ? view.coordsAtPos(view.state.doc.length)?.bottom ?? bottom
      : y;

  return view.posAndSideAtCoords({ x, y: typeof clampedY === "number" ? clampedY : y }, false);
};

const removeRangeAround = (selection: EditorSelection, pos: number) => {
  for (let i = 0; i < selection.ranges.length; i++) {
    const range = selection.ranges[i];
    if (range.from <= pos && range.to >= pos) {
      return EditorSelection.create(
        selection.ranges.slice(0, i).concat(selection.ranges.slice(i + 1)),
        selection.mainIndex === i ? 0 : selection.mainIndex - (selection.mainIndex > i ? 1 : 0),
      );
    }
  }
  return null;
};

export const edgeWhitespaceSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 1) return null;
  const { top, bottom } = textVerticalBounds(view);
  if (event.clientY >= top && event.clientY <= bottom) return null;

  let start = edgeAwarePos(view, event.clientX, event.clientY);
  let startSelection = view.state.selection;

  return {
    update(update) {
      if (update.docChanged) {
        start = { ...start, pos: update.changes.mapPos(start.pos) };
        startSelection = startSelection.map(update.changes);
      }
    },
    get(curEvent, extend, multiple) {
      const current = edgeAwarePos(view, curEvent.clientX, curEvent.clientY);
      let range = EditorSelection.cursor(current.pos, current.assoc);

      if (start.pos !== current.pos && !extend) {
        range = EditorSelection.range(start.pos, current.pos);
      }

      if (extend) {
        return startSelection.replaceRange(startSelection.main.extend(range.from, range.to));
      }

      if (multiple && startSelection.ranges.length > 1) {
        const removed = removeRangeAround(startSelection, current.pos);
        if (removed) return removed;
      }

      if (multiple) return startSelection.addRange(range);
      return EditorSelection.create([range]);
    },
  };
});

export const createKeymap = (getView: () => EditorView | null) =>
  keymap.of([
    { key: "Mod-z", run: () => { const v = getView(); return v ? undo(v) : false; } },
    { key: "Mod-y", run: () => { const v = getView(); return v ? redo(v) : false; } },
    { key: "Shift-Mod-z", run: () => { const v = getView(); return v ? redo(v) : false; } },
    { key: "Tab", run: indentMore },
    { key: "Shift-Tab", run: indentLess },
    { key: "Alt-b", run: (v) => toggleFormatting(v, "**", "**") },
    { key: "Alt-i", run: (v) => toggleFormatting(v, "*", "*") },
    { key: "Alt-u", run: (v) => toggleFormatting(v, "<u>", "</u>") },
    { key: "Alt-s", run: (v) => toggleFormatting(v, "~~", "~~") },
  ]);

export { history };
