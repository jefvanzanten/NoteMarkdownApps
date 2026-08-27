import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportSyncFailure } from "../sync/workspaceDiagnostics";

interface Props { children: ReactNode }
interface State { error: Error | null }

/** Keeps a render failure from replacing durable drafts with an unrecoverable blank screen. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, _info: ErrorInfo): void { reportSyncFailure(error); }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main role="alert" style={{ maxWidth: 680, margin: "4rem auto", padding: "1.5rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>NoteMarkdown could not render safely</h1>
      <p>Your durable drafts and queued changes were not cleared. Reload the app to restore them from browser storage.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload NoteMarkdown</button>
    </main>;
  }
}
