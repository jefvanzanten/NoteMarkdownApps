import { useState } from "react";
import type { WorkspaceDiagnostic } from "../state/workspaceStore";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import { clearSyncDiagnosticEvents, getSyncDiagnosticEvents, type SyncDiagnosticEvent } from "../sync/workspaceDiagnostics";
import styles from "./MilestonePanels.module.css";

interface DiagnosticsDialogProps {
  locale: Locale;
  diagnostics: WorkspaceDiagnostic[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/**
 * Formats one path-free sync event for local inspection.
 * @param event Recorded client event.
 * @returns Compact single-line event details.
 */
function formatSyncEvent(event: SyncDiagnosticEvent): string {
  return [
    event.operation,
    event.requestKind,
    event.outcome,
    event.status === undefined ? undefined : `HTTP ${event.status}`,
    event.errorCode,
    event.attempt === undefined ? undefined : `attempt ${event.attempt}`,
    event.durationMs === undefined ? undefined : `${event.durationMs} ms`,
    event.retryDelayMs === undefined ? undefined : `retry ${event.retryDelayMs} ms`,
  ].filter(Boolean).join(" · ");
}

/**
 * Renders workspace links and browser-local privacy-safe sync diagnostics.
 * @param props Diagnostics and navigation callbacks.
 * @returns Accessible diagnostics dialog.
 */
export function DiagnosticsDialog({ locale, diagnostics, onOpen, onClose }: DiagnosticsDialogProps) {
  const [syncEvents, setSyncEvents] = useState(() => getSyncDiagnosticEvents().slice().reverse());

  /** Copies the path-free local sync log as JSON. @returns Nothing after the clipboard request. */
  const copySyncLog = async (): Promise<void> => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(JSON.stringify(syncEvents.slice().reverse(), null, 2));
  };

  /** Clears the browser-local sync log and visible event list. @returns Nothing. */
  const clearSyncLog = (): void => {
    clearSyncDiagnosticEvents();
    setSyncEvents([]);
  };

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <header><h2 id="diagnostics-title">{translate(locale, "diagnostics")}</h2><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
        <section className={styles.diagnosticSection}>
          <h3>{translate(locale, "workspaceDiagnostics")}</h3>
          {diagnostics.length === 0 ? <p className={styles.empty}>{translate(locale, "noDiagnostics")}</p> : <ul className={styles.historyList}>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.documentPath}:${diagnostic.target}:${index}`}><div><strong>{diagnostic.kind === "broken-link" ? translate(locale, "brokenLink") : translate(locale, "missingImage")}</strong><span>{diagnostic.documentPath} → {diagnostic.target}</span></div><button type="button" onClick={() => { onOpen(diagnostic.documentPath); onClose(); }}>{translate(locale, "editor")}</button></li>)}</ul>}
        </section>
        <section className={styles.diagnosticSection}>
          <div className={styles.diagnosticHeading}>
            <div><h3>{translate(locale, "syncLog")}</h3><small>{translate(locale, "syncLogPrivacy")}</small></div>
            <div className={styles.diagnosticActions}>
              <button type="button" onClick={() => void copySyncLog()} disabled={syncEvents.length === 0}>{translate(locale, "copyLog")}</button>
              <button type="button" onClick={clearSyncLog} disabled={syncEvents.length === 0}>{translate(locale, "clearLog")}</button>
            </div>
          </div>
          {syncEvents.length === 0 ? <p className={styles.empty}>{translate(locale, "noSyncLog")}</p> : <ol className={styles.diagnosticLog}>{syncEvents.map((event, index) => <li key={`${event.timestamp}:${index}`}><time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString(locale)}</time><code>{formatSyncEvent(event)}</code></li>)}</ol>}
        </section>
      </section>
    </div>
  );
}
