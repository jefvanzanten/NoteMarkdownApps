import type { RecoveryItem } from "@note/browser-storage";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./RecoveryDialog.module.css";

interface RecoveryDialogProps {
  locale: Locale;
  items: RecoveryItem[];
  onRestore: (id: string, destinationPath: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/**
 * Renders persistent provider-removal recovery actions.
 * @param props Recovery records and explicit restore/delete callbacks.
 * @returns Accessible modal recovery view.
 */
export function RecoveryDialog({ locale, items, onRestore, onDelete, onClose }: RecoveryDialogProps) {
  return (
    <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <header>
          <h2 id="recovery-title">{translate(locale, "recovery")}</h2>
          <button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button>
        </header>
        {items.length === 0 ? <p>{translate(locale, "noRecoveryItems")}</p> : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <span>{item.formerPath}</span>
                <div>
                  <button type="button" onClick={() => {
                    const destination = window.prompt(translate(locale, "recoveryPath"), item.formerPath)?.trim();
                    if (destination) onRestore(item.id, destination);
                  }}>{translate(locale, "restoreRecovery")}</button>
                  <button type="button" onClick={() => {
                    if (window.confirm(translate(locale, "confirmDeleteRecovery"))) onDelete(item.id);
                  }}>{translate(locale, "deleteRecovery")}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
