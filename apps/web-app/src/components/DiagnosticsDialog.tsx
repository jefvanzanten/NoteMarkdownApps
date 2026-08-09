import type { WorkspaceDiagnostic } from "../state/workspaceStore";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MilestonePanels.module.css";

interface DiagnosticsDialogProps {
  locale: Locale;
  diagnostics: WorkspaceDiagnostic[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/**
 * Renders workspace link and asset diagnostics.
 * @param props Diagnostics and navigation callbacks.
 * @returns Accessible diagnostics dialog.
 */
export function DiagnosticsDialog({ locale, diagnostics, onOpen, onClose }: DiagnosticsDialogProps) {
  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <header><h2 id="diagnostics-title">{translate(locale, "diagnostics")}</h2><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
        <section className={styles.diagnosticSection}>
          <h3>{translate(locale, "workspaceDiagnostics")}</h3>
          {diagnostics.length === 0 ? <p className={styles.empty}>{translate(locale, "noDiagnostics")}</p> : <ul className={styles.historyList}>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.documentPath}:${diagnostic.target}:${index}`}><div><strong>{diagnostic.kind === "broken-link" ? translate(locale, "brokenLink") : translate(locale, "missingImage")}</strong><span>{diagnostic.documentPath} → {diagnostic.target}</span></div><button type="button" onClick={() => { onOpen(diagnostic.documentPath); onClose(); }}>{translate(locale, "editor")}</button></li>)}</ul>}
        </section>
      </section>
    </div>
  );
}
