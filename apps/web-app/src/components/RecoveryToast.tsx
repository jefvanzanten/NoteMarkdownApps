import { useEffect } from "react";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./RecoveryToast.module.css";

interface RecoveryToastProps {
  locale: Locale;
  onRestore: () => void;
  onDismiss: () => void;
}

const DISMISS_DELAY_MS = 6000;

/**
 * Offers immediate recovery after a provider trash operation.
 * @param props Locale, restore callback, and automatic dismissal callback.
 * @returns Recovery status toast.
 */
export function RecoveryToast({ locale, onRestore, onDismiss }: RecoveryToastProps) {
  useEffect(() => {
    const timeoutId = window.setTimeout(onDismiss, DISMISS_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [onDismiss]);

  return (
    <div className={styles.toast} role="status">
      <span>{translate(locale, "deleted")}</span>
      <button type="button" onClick={onRestore}>{translate(locale, "undoDelete")}</button>
    </div>
  );
}
