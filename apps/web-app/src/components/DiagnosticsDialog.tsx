import { useMemo, useState, useSyncExternalStore } from "react";
import type { WorkspaceDiagnostic } from "../state/workspaceStore";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import {
  clearActivityJournal,
  exportActivityJournal,
  getActivityRecordingSnapshot,
  getActivityServerSnapshot,
  getActivitySnapshot,
  isActivityJournalAvailable,
  setActivityRecording,
  subscribeActivityJournal,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityLevel,
} from "../diagnostics/activityJournal";
import styles from "./MilestonePanels.module.css";

interface DiagnosticsDialogProps {
  locale: Locale;
  diagnostics: WorkspaceDiagnostic[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** Formats event details as compact readable JSON. @param event Activity event. @returns Metadata summary without empty braces. */
function eventDetails(event: ActivityEvent): string {
  const details = { ...event.details, ...(event.correlationId ? { correlationId: event.correlationId } : {}) };
  return Object.keys(details).length > 0 ? JSON.stringify(details) : "";
}

/** Downloads the complete retained activity bundle as JSON. @returns Nothing after the temporary download link is activated. */
async function downloadActivityJournal(): Promise<void> {
  const blob = new Blob([await exportActivityJournal()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `notemarkdown-activity-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Renders the persistent development activity viewer. @param locale Active UI locale. @returns Filterable local activity panel. */
function ActivityJournal({ locale }: { locale: Locale }) {
  const events = useSyncExternalStore(subscribeActivityJournal, getActivitySnapshot, getActivityServerSnapshot);
  const recording = useSyncExternalStore(subscribeActivityJournal, getActivityRecordingSnapshot, getActivityRecordingSnapshot);
  const [category, setCategory] = useState<ActivityCategory | "all">("all");
  const [level, setLevel] = useState<ActivityLevel | "all">("all");
  const [query, setQuery] = useState("");
  const visibleEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...events].reverse().filter((event) => {
      if (category !== "all" && event.category !== category) return false;
      if (level !== "all" && event.level !== level) return false;
      if (!normalizedQuery) return true;
      return `${event.event} ${event.category} ${eventDetails(event)}`.toLowerCase().includes(normalizedQuery);
    });
  }, [category, events, level, query]);

  /** Copies the complete retained JSON bundle to the clipboard. @returns Nothing after the clipboard request completes. */
  const copyJournal = async (): Promise<void> => { await navigator.clipboard.writeText(await exportActivityJournal()); };

  return (
    <section className={`${styles.diagnosticSection} ${styles.activityPanel}`}>
      <div className={styles.diagnosticHeading}>
        <div><h3>{translate(locale, "activityLog")}</h3><small>{translate(locale, "activityLogPrivacy")}</small></div>
        <div className={styles.diagnosticActions}>
          <button type="button" onClick={() => setActivityRecording(!recording)} disabled={!isActivityJournalAvailable()}>{translate(locale, recording ? "stopRecording" : "startRecording")}</button>
          <button type="button" onClick={() => void copyJournal()} disabled={events.length === 0}>{translate(locale, "copyLog")}</button>
          <button type="button" onClick={() => void downloadActivityJournal()} disabled={events.length === 0}>{translate(locale, "exportLog")}</button>
          <button type="button" onClick={() => void clearActivityJournal()} disabled={events.length === 0}>{translate(locale, "clearLog")}</button>
        </div>
      </div>
      <div className={styles.activityFilters}>
        <select value={category} onChange={(event) => setCategory(event.target.value as ActivityCategory | "all")} aria-label={translate(locale, "activityCategory")}>
          <option value="all">{translate(locale, "allActivities")}</option>
          <option value="application">Application</option>
          <option value="workspace">Workspace</option>
          <option value="document">Document</option>
          <option value="storage">Storage</option>
          <option value="sync">Sync</option>
          <option value="api">API</option>
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value as ActivityLevel | "all")} aria-label={translate(locale, "activityLevel")}>
          <option value="all">{translate(locale, "allLevels")}</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={translate(locale, "filterActivity")} aria-label={translate(locale, "filterActivity")} />
        <span>{visibleEvents.length} / {events.length}</span>
      </div>
      {visibleEvents.length === 0 ? <p className={styles.empty}>{translate(locale, "noActivity")}</p> : (
        <ol className={styles.diagnosticLog}>
          {visibleEvents.map((event) => (
            <li key={event.id} data-level={event.level}>
              <div><strong>{event.event}</strong><span>{event.category} · {event.level}</span></div>
              <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString(locale)}</time>
              {eventDetails(event) ? <code>{eventDetails(event)}</code> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Renders workspace link diagnostics and the local development activity journal. @param props Diagnostics and navigation callbacks. @returns Accessible diagnostics dialog. */
export function DiagnosticsDialog({ locale, diagnostics, onOpen, onClose }: DiagnosticsDialogProps) {
  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <header><h2 id="diagnostics-title">{translate(locale, "diagnostics")}</h2><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
        <section className={styles.diagnosticSection}>
          <h3>{translate(locale, "workspaceDiagnostics")}</h3>
          {diagnostics.length === 0 ? <p className={styles.empty}>{translate(locale, "noDiagnostics")}</p> : <ul className={styles.historyList}>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.documentPath}:${diagnostic.target}:${index}`}><div><strong>{diagnostic.kind === "broken-link" ? translate(locale, "brokenLink") : translate(locale, "missingImage")}</strong><span>{diagnostic.documentPath} → {diagnostic.target}</span></div><button type="button" onClick={() => { onOpen(diagnostic.documentPath); onClose(); }}>{translate(locale, "editor")}</button></li>)}</ul>}
        </section>
        <ActivityJournal locale={locale} />
      </section>
    </div>
  );
}
