import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./Welcome.module.css";

interface WelcomeProps {
  locale: Locale;
  isOpening: boolean;
  isSupported: boolean;
  isBrave: boolean;
  onOpen: () => void;
  onDrive: () => void;
}

/**
 * Presents the account-free real-directory entry journey.
 * @param props Locale, capability state, progress, and picker callback.
 * @returns The local workspace welcome screen.
 */
export function Welcome({ locale, isOpening, isSupported, isBrave, onOpen, onDrive }: WelcomeProps) {
  return (
    <main className={styles.welcome}>
      <div className={styles.ambient} aria-hidden="true" />
      <section className={styles.card}>
        <div className={styles.mark} aria-hidden="true">N</div>
        <p className={styles.eyebrow}>NoteMarkdown / local-first</p>
        <h1>{translate(locale, "unsupportedTitle")}</h1>
        <p className={styles.lead}>{translate(locale, "unsupportedBody")}</p>
        <button type="button" className={styles.openButton} onClick={onOpen} disabled={!isSupported || isOpening}>
          <span aria-hidden="true">↗</span>
          {translate(locale, "openDirectory")}
        </button>
        <button type="button" className={styles.driveButton} onClick={onDrive}>{translate(locale, "openDrive")}</button>
        {!isSupported ? <p className={styles.unsupported} role="status">{translate(locale, isBrave ? "braveEnable" : "unsupported")}</p> : null}
        <p className={styles.privacy}><span aria-hidden="true">●</span>{translate(locale, "privacy")}</p>
      </section>
    </main>
  );
}
