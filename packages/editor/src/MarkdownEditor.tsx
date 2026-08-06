import type { EditorKeybindings } from "./commands";
import { useMarkdownEditor } from "./hooks/useMarkdownEditor";

export interface MarkdownEditorProps {
  content: string;
  sessionId: string;
  onChange: (sessionId: string, value: string, cursor: number) => void;
  onSave?: (sessionId: string, value: string, cursor: number) => void;
  keybindings?: EditorKeybindings;
  spellCheck?: boolean;
  readOnly?: boolean;
  initialCursor?: number;
}

/**
 * Renders the shared CodeMirror Markdown editor.
 * @param props Document session, callbacks, and editor preferences.
 * @returns The CodeMirror host element.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const { containerRef } = useMarkdownEditor(props);
  return <div ref={containerRef} style={{ height: "100%" }} />;
}
