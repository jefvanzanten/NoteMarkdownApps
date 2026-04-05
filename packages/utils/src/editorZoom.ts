export const DEFAULT_EDITOR_FONT_SIZE_PX = 14;
export const MIN_EDITOR_FONT_SIZE_PX = 10;
export const MAX_EDITOR_FONT_SIZE_PX = 24;
export const EDITOR_FONT_SIZE_STEP_PX = 1;

type EditorZoomMap = Record<string, number>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const clampEditorFontSize = (value: number) =>
  clamp(Math.round(value), MIN_EDITOR_FONT_SIZE_PX, MAX_EDITOR_FONT_SIZE_PX);

const readEditorZoomMap = (storageKey: string): EditorZoomMap => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};

    const next: EditorZoomMap = {};
    for (const [tabId, fontSize] of Object.entries(parsed)) {
      if (!tabId) continue;
      if (typeof fontSize !== "number" || Number.isNaN(fontSize)) continue;
      next[tabId] = clampEditorFontSize(fontSize);
    }

    return next;
  } catch {
    return {};
  }
};

const writeEditorZoomMap = (storageKey: string, next: EditorZoomMap) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // ignore storage write failures
  }
};

export const loadEditorFontSize = (storageKey: string, tabId: string) => {
  if (!tabId) return DEFAULT_EDITOR_FONT_SIZE_PX;
  const map = readEditorZoomMap(storageKey);
  return map[tabId] ?? DEFAULT_EDITOR_FONT_SIZE_PX;
};

export const saveEditorFontSize = (storageKey: string, tabId: string, fontSize: number) => {
  if (!tabId) return;
  const map = readEditorZoomMap(storageKey);
  map[tabId] = clampEditorFontSize(fontSize);
  writeEditorZoomMap(storageKey, map);
};

export const removeEditorFontSize = (storageKey: string, tabId: string) => {
  if (!tabId) return;
  const map = readEditorZoomMap(storageKey);
  if (!(tabId in map)) return;
  delete map[tabId];
  writeEditorZoomMap(storageKey, map);
};

export const isZoomInShortcut = (event: KeyboardEvent) =>
  event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+" || event.key === "=";

export const isZoomOutShortcut = (event: KeyboardEvent) =>
  event.code === "Minus" ||
  event.code === "NumpadSubtract" ||
  event.key === "-" ||
  event.key === "_";
