import { useEffect, useState } from "react";
import type { HistoryEntry } from "../storage/browserStorage";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MilestonePanels.module.css";

interface HistoryDialogProps {
  locale: Locale;
  path: string;
  load: (path: string) => Promise<HistoryEntry[]>;
  onRestore: (entry: HistoryEntry) => void;
  onClose: () => void;
}

/**
 * Renders bounded browser-local document recovery history.
 * @param props Active document, history service, and callbacks.
 * @returns Accessible version-history dialog.
 */
export function HistoryDialog({ locale, path, load, onRestore, onClose }: HistoryDialogProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => { void load(path).then(setEntries); }, [load, path]);
  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header><div><h2 id="history-title">{translate(locale, "history")}</h2><small>{path}</small></div><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
        {entries.length === 0 ? <p className={styles.empty}>{translate(locale, "noHistory")}</p> : (
          <ul className={styles.historyList}>{entries.map((entry) => <li key={entry.id}><div><strong>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(entry.updatedAt)}</strong><span>{entry.reason} · {entry.content.length.toLocaleString(locale)} chars</span></div><button type="button" onClick={() => { onRestore(entry); onClose(); }}>{translate(locale, "restoreVersion")}</button></li>)}</ul>
        )}
      </section>
    </div>
  );
}
