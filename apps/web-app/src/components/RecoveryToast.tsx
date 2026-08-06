import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./RecoveryToast.module.css";

interface RecoveryToastProps {
  locale: Locale;
  onRestore: () => void;
}

/**
 * Offers immediate recovery after a provider trash operation.
 * @param props Locale and restore callback.
 * @returns Recovery status toast.
 */
export function RecoveryToast({ locale, onRestore }: RecoveryToastProps) {
  return (
    <div className={styles.toast} role="status">
      <span>{translate(locale, "deleted")}</span>
      <button type="button" onClick={onRestore}>{translate(locale, "undoDelete")}</button>
    </div>
  );
}
