import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MilestonePanels.module.css";

interface UpdatePromptProps {
  locale: Locale;
  onUpdate: () => void;
}

/**
 * Prompts for non-forced service-worker activation after draft durability.
 * @param props Locale and safe update callback.
 * @returns Non-disruptive update status.
 */
export function UpdatePrompt({ locale, onUpdate }: UpdatePromptProps) {
  return <div className={styles.update} role="status"><span>{translate(locale, "updateReady")}</span><button type="button" onClick={onUpdate}>{translate(locale, "updateNow")}</button></div>;
}
