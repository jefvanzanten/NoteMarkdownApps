import { useState } from "react";
import type { DocumentConflict } from "@note/browser-storage";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./ConflictDialog.module.css";

interface ConflictDialogProps {
  locale: Locale;
  conflicts: DocumentConflict[];
  onResolve: (id: string, content: string | null) => void;
  onClose: () => void;
}

/** Renders one conflict's explicit remote, local, and manual resolution controls. @param props Conflict facts and resolution callback. @returns Conflict editor. */
function ConflictEditor({ conflict, locale, onResolve }: { conflict: DocumentConflict; locale: Locale; onResolve: ConflictDialogProps["onResolve"] }) {
  const [mergedContent, setMergedContent] = useState(conflict.localContent);
  return (
    <li>
      <strong>{conflict.path}</strong>
      <label>
        <span>{translate(locale, "conflictBase")}</span>
        <textarea readOnly value={conflict.baseContent ?? ""} rows={5} />
      </label>
      <label>
        <span>{translate(locale, "conflictRemote")}</span>
        <textarea readOnly value={conflict.remoteContent} rows={7} />
      </label>
      <label>
        <span>{translate(locale, "conflictResolution")}</span>
        <textarea value={mergedContent} onChange={(event) => setMergedContent(event.target.value)} rows={9} />
      </label>
      <div>
        <button type="button" onClick={() => onResolve(conflict.id, null)}>{translate(locale, "keepRemote")}</button>
        <button type="button" onClick={() => onResolve(conflict.id, conflict.localContent)}>{translate(locale, "keepLocal")}</button>
        <button type="button" onClick={() => onResolve(conflict.id, mergedContent)}>{translate(locale, "saveMerge")}</button>
      </div>
    </li>
  );
}

/**
 * Renders durable document conflicts without discarding either side.
 * @param props Conflict records, locale, resolution callback, and close callback.
 * @returns Accessible conflict-resolution dialog.
 */
export function ConflictDialog({ locale, conflicts, onResolve, onClose }: ConflictDialogProps) {
  return (
    <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="conflicts-title">
        <header>
          <h2 id="conflicts-title">{translate(locale, "resolveConflicts")}</h2>
          <button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button>
        </header>
        {conflicts.length === 0 ? <p>{translate(locale, "noConflicts")}</p> : (
          <ul>{conflicts.map((conflict) => <ConflictEditor key={`${conflict.id}:${conflict.remoteRevision.id}`} conflict={conflict} locale={locale} onResolve={onResolve} />)}</ul>
        )}
      </section>
    </div>
  );
}
