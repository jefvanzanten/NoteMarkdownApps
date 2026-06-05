import { useEffect, useRef } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine } from "@codemirror/view";
import { syntaxHighlighting, LanguageDescription } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { mdHighlight } from "../extensions/highlight.js";
import { editorTheme, injectGlobalDragStyles } from "../extensions/theme.js";
import { mdPlugin } from "../extensions/plugin.js";
import { createKeymap, edgeWhitespaceSelection, history } from "../extensions/keymap.js";
import { stopTaskDrag } from "../extensions/dragDrop.js";

export interface UseMarkdownEditorOptions {
  content: string;
  sessionId: string;
  onChange: (sessionId: string, value: string, cursor: number) => void;
}

function buildExtensions(getView: () => EditorView | null, queueChange: (v: string, c: number) => void): Extension[] {
  return [
    history(),
    markdown({
      codeLanguages: [
        LanguageDescription.of({
          name: "TypeScript",
          alias: ["ts", "typescript"],
          load: () => Promise.resolve(javascript({ typescript: true })),
        }),
        LanguageDescription.of({
          name: "JavaScript",
          alias: ["js", "javascript"],
          load: () => Promise.resolve(javascript()),
        }),
      ],
    }),
    syntaxHighlighting(mdHighlight),
    mdPlugin,
    edgeWhitespaceSelection,
    editorTheme,
    createKeymap(getView),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;
      queueChange(update.state.doc.toString(), update.state.selection.main.head);
    }),
  ];
}

export function useMarkdownEditor({ content, sessionId, onChange }: UseMarkdownEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorStates = useRef(new Map<string, EditorState>());
  const pendingChangeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string>(sessionId);
  const extensionsRef = useRef<Extension[] | null>(null);

  // Stable refs so closures always read current values
  const sessionIdRef = useRef(sessionId);
  const onChangeRef = useRef(onChange);
  sessionIdRef.current = sessionId;
  onChangeRef.current = onChange;

  // Mount: create the EditorView once
  useEffect(() => {
    if (!containerRef.current) return;

    injectGlobalDragStyles();

    const queueChange = (value: string, cursor: number) => {
      if (pendingChangeTimeout.current) clearTimeout(pendingChangeTimeout.current);
      const capturedId = sessionIdRef.current;
      pendingChangeTimeout.current = setTimeout(() => {
        pendingChangeTimeout.current = null;
        onChangeRef.current(capturedId, value, cursor);
      }, 300);
    };

    const extensions = buildExtensions(() => viewRef.current, queueChange);
    extensionsRef.current = extensions;

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    editorStates.current.set(sessionId, view.state);
    prevSessionIdRef.current = sessionId;

    return () => {
      if (pendingChangeTimeout.current) clearTimeout(pendingChangeTimeout.current);
      stopTaskDrag();
      view.destroy();
      viewRef.current = null;
    };
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session switch: save old state, restore or create new state
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !extensionsRef.current) return;
    if (sessionId === prevSessionIdRef.current) return;

    // Save current state for the previous session
    editorStates.current.set(prevSessionIdRef.current, view.state);
    prevSessionIdRef.current = sessionId;

    const savedState = editorStates.current.get(sessionId);
    if (savedState) {
      view.setState(savedState);
    } else {
      // New session: fresh state with same extensions
      const newState = EditorState.create({ doc: content, extensions: extensionsRef.current });
      view.setState(newState);
      editorStates.current.set(sessionId, newState);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Content change from outside (same session, e.g. file reloaded externally)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sessionId !== prevSessionIdRef.current) return; // session switch handled separately
    if (content === view.state.doc.toString()) return;

    const sel = view.state.selection.main.head;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: Math.min(sel, content.length) },
      annotations: Transaction.addToHistory.of(false),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  return { containerRef };
}
