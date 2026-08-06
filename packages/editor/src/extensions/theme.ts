import { EditorView } from "@codemirror/view";

export const editorTheme = EditorView.baseTheme({
  "&": {
    height: "100%",
    fontFamily: '"Fira Code", Consolas, monospace',
    fontSize: "14px",
    color: "var(--color-text, #e2e8f0)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    minHeight: "100%",
    minWidth: "100%",
    boxSizing: "border-box",
    padding: "16px 0",
    caretColor: "var(--color-text, #e2e8f0)",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-scroller": {
    padding: "0",
    lineHeight: "1.6",
  },
  ".cm-cursor": {
    borderLeft: "2px solid var(--color-text, #e2e8f0)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent, #38bdf8) 28%, transparent) !important",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--color-hover, rgba(148, 163, 184, 0.08))",
    borderRadius: "6px",
    transition: "background-color 120ms ease",
  },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "var(--color-selected, rgba(56, 189, 248, 0.12))",
  },

  // Heading sizes
  ".cm-line.md-h1": {
    fontSize: "1.8em",
    fontWeight: "700",
    lineHeight: "1.4",
  },
  ".cm-line.md-h2": {
    fontSize: "1.5em",
    fontWeight: "700",
    lineHeight: "1.4",
  },
  ".cm-line.md-h3": {
    fontSize: "1.3em",
    fontWeight: "700",
    lineHeight: "1.4",
  },
  ".cm-line.md-h4": {
    fontSize: "1.1em",
    fontWeight: "700",
  },
  ".cm-line.md-h5": {
    fontSize: "1em",
    fontWeight: "700",
  },
  ".cm-line.md-h6": {
    fontSize: "1em",
    fontWeight: "600",
    color: "#94a3b8",
  },

  // Horizontal rule
  ".cm-line.md-hr": {
    position: "relative",
    color: "transparent",
    width: "100%",
    boxSizing: "border-box",
  },
  ".cm-line.md-hr::before": {
    content: '""',
    position: "absolute",
    left: "0",
    right: "0",
    top: "50%",
    borderTop: "1px solid #334155",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },

  // Markdown inline styles
  ".md-mark": { color: "currentcolor" },
  ".md-strong": { fontWeight: "900", color: "var(--color-text, #f1f5f9)" },
  ".md-em": { fontStyle: "italic" },
  ".md-strike": { textDecoration: "line-through", color: "var(--color-text-muted, #94a3b8)" },
  ".md-code": {
    fontFamily: '"Fira Code", Consolas, monospace',
    color: "var(--color-syntax-keyword, #f472b6)",
    background: "var(--color-code, #1e293b)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  ".cm-line.md-codeblock-line, .cm-line.md-codeblock-fence": {
    background: "var(--color-code, #0f172a)",
  },
  ".cm-line.md-codeblock-fence": {
    color: "var(--color-text-dim, #64748b)",
  },
  "&.cm-focused .cm-line.md-codeblock-fence.cm-activeLine, &.cm-focused .cm-line.md-codeblock-line.cm-activeLine": {
    background: "var(--color-selected, #132033)",
  },
  ".md-link": { color: "var(--color-accent-strong, #7dd3fc)", textDecoration: "underline" },
  ".md-url": { color: "var(--color-text-dim, #64748b)" },

  // Drag-drop UI
  ".cm-task-handle": {
    width: "12px",
    height: "14px",
    border: "0",
    padding: "0",
    marginRight: "4px",
    background: "transparent",
    color: "#64748b",
    cursor: "grab",
    display: "inline-block",
    verticalAlign: "middle",
    position: "relative",
  },
  ".cm-task-handle:hover": { color: "#94a3b8" },
  ".cm-task-handle:active": { cursor: "grabbing" },
  ".cm-checkbox": {
    cursor: "pointer",
    width: "14px",
    height: "14px",
    verticalAlign: "middle",
    marginRight: "0",
    accentColor: "#0284c7",
  },
  ".cm-bullet-container": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0",
  },
  ".cm-bullet-text": {
    color: "#94a3b8",
    fontWeight: "700",
    marginRight: "4px",
  },
});

export const globalDragStyles = `
body.cm-task-reordering { cursor: grabbing; }

.cm-task-drag-ghost {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(72vw, 680px);
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: rgba(15, 23, 42, 0.94);
  color: #e2e8f0;
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.45);
  opacity: 0.95;
  font-family: "Fira Code", Consolas, monospace;
  font-size: 14px;
  line-height: 1.35;
  white-space: nowrap;
}
.cm-task-drag-bullet { color: #94a3b8; font-weight: 700; flex: 0 0 auto; }
.cm-task-drag-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.cm-task-drag-ghost .cm-checkbox { margin: 0; pointer-events: none; opacity: 1; }

.cm-task-drop-indicator {
  position: fixed;
  top: 0;
  left: 0;
  height: 2px;
  border-radius: 999px;
  pointer-events: none;
  z-index: 999;
  background: #38bdf8;
  box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.25);
}

.cm-task-handle::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 2px;
  width: 2px;
  height: 2px;
  border-radius: 999px;
  background: currentcolor;
  box-shadow: 0 4px 0 currentcolor, 0 8px 0 currentcolor,
              4px 0 0 currentcolor, 4px 4px 0 currentcolor, 4px 8px 0 currentcolor;
}
`;

export function injectGlobalDragStyles(): void {
  if (document.getElementById("note-editor-drag-styles")) return;
  const style = document.createElement("style");
  style.id = "note-editor-drag-styles";
  style.textContent = globalDragStyles;
  document.head.appendChild(style);
}
