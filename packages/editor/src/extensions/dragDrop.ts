import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

export const editorSidePaddingPx = 16;

export type ParsedChecklistLine = {
  indent: string;
  bullet: string;
  checked: boolean;
  text: string;
};

export type ParsedBulletListLine = {
  indent: string;
  bullet: string;
  text: string;
};

export type ChecklistItem = {
  lineNumber: number;
  lineFrom: number;
  handleFrom: number;
  checkboxFrom: number;
  checked: boolean;
  groupId: number;
};

export type BulletListItem = {
  lineNumber: number;
  lineFrom: number;
  handleFrom: number;
  bulletFrom: number;
  bullet: string;
  groupId: number;
};

type TaskDragState = {
  sourceLineFrom: number;
  sourceGroupId: number;
  startX: number;
  startY: number;
  hasMoved: boolean;
  targetLineFrom: number | null;
  placeAfter: boolean;
};

const checklistPattern = /^(\s*)([-*+] )\[([ xX])\]/;
const bulletListPattern = /^(\s*)([-*+] )(?!\[)/;
export const horizontalRulePattern = /^\s*---+\s*$/;

export const parseChecklistLine = (lineText: string): ParsedChecklistLine | null => {
  const match = lineText.match(checklistPattern);
  if (!match) return null;
  return {
    indent: match[1],
    bullet: match[2],
    checked: match[3].toLowerCase() === "x",
    text: lineText.slice(match[0].length),
  };
};

export const parseBulletListLine = (lineText: string): ParsedBulletListLine | null => {
  const match = lineText.match(bulletListPattern);
  if (!match) return null;
  return {
    indent: match[1],
    bullet: match[2],
    text: lineText.slice(match[0].length),
  };
};

export const collectChecklistItems = (state: EditorState): ChecklistItem[] => {
  const items: ChecklistItem[] = [];
  let groupId = -1;
  let previousWasChecklist = false;

  for (let ln = 1; ln <= state.doc.lines; ln++) {
    const line = state.doc.line(ln);
    const parsed = parseChecklistLine(line.text);
    if (!parsed) { previousWasChecklist = false; continue; }
    if (!previousWasChecklist) groupId += 1;
    previousWasChecklist = true;

    const handleFrom = line.from + parsed.indent.length;
    const checkboxFrom = handleFrom + parsed.bullet.length;
    items.push({ lineNumber: ln, lineFrom: line.from, handleFrom, checkboxFrom, checked: parsed.checked, groupId });
  }
  return items;
};

export const collectBulletListItems = (state: EditorState): BulletListItem[] => {
  const items: BulletListItem[] = [];
  let groupId = -1;
  let previousWasBulletList = false;

  for (let ln = 1; ln <= state.doc.lines; ln++) {
    const line = state.doc.line(ln);
    const parsed = parseBulletListLine(line.text);
    if (!parsed) { previousWasBulletList = false; continue; }
    if (!previousWasBulletList) groupId += 1;
    previousWasBulletList = true;

    const handleFrom = line.from + parsed.indent.length;
    items.push({ lineNumber: ln, lineFrom: line.from, handleFrom, bulletFrom: handleFrom, bullet: parsed.bullet, groupId });
  }
  return items;
};

const collectDocLines = (state: EditorState): string[] => {
  const lines: string[] = [];
  for (let ln = 1; ln <= state.doc.lines; ln++) {
    lines.push(state.doc.line(ln).text);
  }
  return lines;
};

const lineStartAtIndex = (lines: string[], index: number): number => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += lines[i].length + 1;
  return pos;
};

const lineCenterY = (view: EditorView, pos: number): number => {
  const coords = view.coordsAtPos(pos);
  if (coords) return (coords.top + coords.bottom) / 2;
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  return scrollerRect.top + scrollerRect.height / 2;
};

export const textVerticalBounds = (view: EditorView) => {
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const first = view.coordsAtPos(0);
  const last = view.coordsAtPos(view.state.doc.length);
  if (!first || !last) return { top: scrollerRect.top, bottom: scrollerRect.bottom };
  return { top: Math.max(scrollerRect.top, first.top), bottom: Math.min(scrollerRect.bottom, last.bottom) };
};

export const moveTaskLine = (
  view: EditorView,
  sourceLineFrom: number,
  targetLineFrom: number,
  placeAfter: boolean,
): void => {
  const checklistItems = collectChecklistItems(view.state);
  const bulletListItems = collectBulletListItems(view.state);
  const sourceItem =
    checklistItems.find((i) => i.lineFrom === sourceLineFrom) ||
    bulletListItems.find((i) => i.lineFrom === sourceLineFrom);
  if (!sourceItem) return;

  const sourceLineNumber = sourceItem.lineNumber;
  const targetLineNumber = view.state.doc.lineAt(targetLineFrom).number;
  if (sourceLineNumber === targetLineNumber) return;

  const lines = collectDocLines(view.state);
  const [movedLine] = lines.splice(sourceLineNumber - 1, 1);
  if (movedLine === undefined) return;

  let insertIndex = targetLineNumber - 1;
  if (sourceLineNumber < targetLineNumber) insertIndex -= 1;
  if (placeAfter) insertIndex += 1;
  insertIndex = Math.max(0, Math.min(insertIndex, lines.length));
  lines.splice(insertIndex, 0, movedLine);

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: lines.join("\n") },
    selection: { anchor: lineStartAtIndex(lines, insertIndex) },
    scrollIntoView: true,
  });
  view.focus();
};

// Drag state (module-level, one drag at a time)
let taskDragState: TaskDragState | null = null;
let removeTaskDragListeners: (() => void) | null = null;
let taskDragGhostEl: HTMLDivElement | null = null;
let taskDropIndicatorEl: HTMLDivElement | null = null;

const clearTaskDragListeners = () => {
  if (!removeTaskDragListeners) return;
  removeTaskDragListeners();
  removeTaskDragListeners = null;
};

const removeTaskDragGhost = () => {
  taskDragGhostEl?.remove();
  taskDragGhostEl = null;
};

const removeTaskDropIndicator = () => {
  taskDropIndicatorEl?.remove();
  taskDropIndicatorEl = null;
};

const updateTaskDragGhostPosition = (x: number, y: number) => {
  if (!taskDragGhostEl) return;
  taskDragGhostEl.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
};

const showTaskDragGhost = (view: EditorView, sourceLineFrom: number) => {
  removeTaskDragGhost();
  const line = view.state.doc.lineAt(sourceLineFrom);
  const checklistParsed = parseChecklistLine(line.text);
  const bulletListParsed = parseBulletListLine(line.text);
  if (!checklistParsed && !bulletListParsed) return;

  const ghost = document.createElement("div");
  ghost.className = "cm-task-drag-ghost";

  if (checklistParsed) {
    const bullet = document.createElement("span");
    bullet.className = "cm-task-drag-bullet";
    bullet.textContent = checklistParsed.bullet.trim();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "cm-checkbox";
    checkbox.checked = checklistParsed.checked;
    checkbox.disabled = true;

    const text = document.createElement("span");
    text.className = "cm-task-drag-text";
    text.textContent = checklistParsed.text || " ";

    ghost.append(bullet, checkbox, text);
  } else if (bulletListParsed) {
    const bullet = document.createElement("span");
    bullet.className = "cm-task-drag-bullet";
    bullet.textContent = bulletListParsed.bullet.trim();

    const text = document.createElement("span");
    text.className = "cm-task-drag-text";
    text.textContent = bulletListParsed.text || " ";

    ghost.append(bullet, text);
  }

  document.body.append(ghost);
  taskDragGhostEl = ghost;
};

const showTaskDropIndicator = (view: EditorView, targetLineFrom: number, placeAfter: boolean) => {
  if (!taskDropIndicatorEl) {
    const indicator = document.createElement("div");
    indicator.className = "cm-task-drop-indicator";
    document.body.append(indicator);
    taskDropIndicatorEl = indicator;
  }

  const line = view.state.doc.lineAt(targetLineFrom);
  const block = view.lineBlockAt(line.from);
  const y = view.documentTop + (placeAfter ? block.bottom : block.top);
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const left = Math.round(scrollerRect.left + editorSidePaddingPx);
  const width = Math.max(36, Math.round(scrollerRect.width - editorSidePaddingPx * 2));

  taskDropIndicatorEl.style.transform = `translate(${left}px, ${Math.round(y - 1)}px)`;
  taskDropIndicatorEl.style.width = `${width}px`;
  taskDropIndicatorEl.style.display = "block";
};

const hideTaskDropIndicator = () => {
  if (taskDropIndicatorEl) taskDropIndicatorEl.style.display = "none";
};

export const stopTaskDrag = () => {
  taskDragState = null;
  clearTaskDragListeners();
  removeTaskDragGhost();
  removeTaskDropIndicator();
  document.body.classList.remove("cm-task-reordering");
};

const taskDropTargetAtCoords = (view: EditorView, x: number, y: number) => {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos === null) return null;
  const line = view.state.doc.lineAt(pos);
  const placeAfter = y > lineCenterY(view, line.from);
  return { targetLineFrom: line.from, placeAfter };
};

export const startTaskDrag = (view: EditorView, event: PointerEvent, sourceLineFrom: number) => {
  if (event.button !== 0) return;

  const checklistItem = collectChecklistItems(view.state).find((i) => i.lineFrom === sourceLineFrom);
  const bulletListItem = collectBulletListItems(view.state).find((i) => i.lineFrom === sourceLineFrom);
  const sourceItem = checklistItem || bulletListItem;
  if (!sourceItem) return;

  event.preventDefault();
  event.stopPropagation();

  stopTaskDrag();
  taskDragState = {
    sourceLineFrom,
    sourceGroupId: sourceItem.groupId,
    startX: event.clientX,
    startY: event.clientY,
    hasMoved: false,
    targetLineFrom: null,
    placeAfter: false,
  };

  document.body.classList.add("cm-task-reordering");
  showTaskDragGhost(view, sourceLineFrom);
  updateTaskDragGhostPosition(event.clientX, event.clientY);

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (!taskDragState) return;
    updateTaskDragGhostPosition(moveEvent.clientX, moveEvent.clientY);

    const movedX = Math.abs(moveEvent.clientX - taskDragState.startX);
    const movedY = Math.abs(moveEvent.clientY - taskDragState.startY);
    if (!taskDragState.hasMoved && (movedX > 3 || movedY > 3)) taskDragState.hasMoved = true;

    const target = taskDropTargetAtCoords(view, moveEvent.clientX, moveEvent.clientY);
    if (!target) {
      taskDragState.targetLineFrom = null;
      hideTaskDropIndicator();
      return;
    }
    taskDragState.targetLineFrom = target.targetLineFrom;
    taskDragState.placeAfter = target.placeAfter;
    showTaskDropIndicator(view, target.targetLineFrom, target.placeAfter);
  };

  const onPointerEnd = (endEvent: PointerEvent) => {
    if (endEvent.type === "pointerup") endEvent.preventDefault();
    const drag = taskDragState;
    stopTaskDrag();
    if (!drag || !drag.hasMoved || drag.targetLineFrom === null) {
      view.focus();
      return;
    }
    moveTaskLine(view, drag.sourceLineFrom, drag.targetLineFrom, drag.placeAfter);
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);

  removeTaskDragListeners = () => {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerEnd, true);
    window.removeEventListener("pointercancel", onPointerEnd, true);
  };
};
