import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./ErrorBanner.module.css";

interface ErrorBannerProps {
  message: string;
  locale: Locale;
  onClose: () => void;
}

/**
 * Announces a blocking workspace error without hiding document state.
 * @param props Diagnostic message, locale, and dismissal callback.
 * @returns Dismissible error banner.
 */
export function ErrorBanner({ message, locale, onClose }: ErrorBannerProps) {
  return (
    <div className={styles.banner} role="alert">
      <strong>{translate(locale, "workspaceProblem")}</strong>
      <span><b>{translate(locale, "failureReason")}</b> {message}</span>
      <button type="button" onClick={onClose} aria-label={translate(locale, "close")}>×</button>
    </div>
  );
}
