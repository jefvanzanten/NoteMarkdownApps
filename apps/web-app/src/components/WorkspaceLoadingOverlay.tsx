import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./WorkspaceLoadingOverlay.module.css";

interface WorkspaceLoadingOverlayProps {
  locale: Locale;
}

/**
 * Blocks workspace interaction while a selected folder is being scanned and restored.
 * @param props Active interface locale.
 * @returns An accessible loading overlay with indeterminate progress.
 */
export function WorkspaceLoadingOverlay({ locale }: WorkspaceLoadingOverlayProps) {
  return (
    <div className={styles.backdrop} role="status" aria-live="polite" aria-busy="true">
      <section className={styles.panel}>
        <div className={styles.heading}>
          <span className={styles.mark} aria-hidden="true">N</span>
          <div>
            <strong>{translate(locale, "loadingWorkspace")}</strong>
            <p>{translate(locale, "loadingWorkspaceDetail")}</p>
          </div>
        </div>
        <div className={styles.progressTrack} aria-hidden="true">
          <div className={styles.progressBar} />
        </div>
        <span className={styles.waitMessage}>{translate(locale, "loadingWorkspaceWait")}</span>
      </section>
    </div>
  );
}
