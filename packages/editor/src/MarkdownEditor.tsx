import { useMarkdownEditor } from "./hooks/useMarkdownEditor";

export interface MarkdownEditorProps {
  content: string;
  sessionId: string;
  onChange: (sessionId: string, value: string, cursor: number) => void;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const { containerRef } = useMarkdownEditor(props);
  return <div ref={containerRef} style={{ height: "100%" }} />;
}
