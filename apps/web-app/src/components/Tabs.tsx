import type { OpenDocument } from "../state/workspaceStore";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./Tabs.module.css";

interface TabsProps {
  tabs: OpenDocument[];
  activePath: string | null;
  locale: Locale;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onCreate: () => void;
}

/**
 * Returns the final provider path segment for compact tab labels.
 * @param path Workspace-relative document path.
 * @returns File name shown in the tab.
 */
function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/**
 * Renders scrollable document tabs without nested interactive controls.
 * @param props Open tabs, active identity, locale, and tab callbacks.
 * @returns Accessible document tab strip.
 */
export function Tabs({ tabs, activePath, locale, onActivate, onClose, onCreate }: TabsProps) {
  return (
    <div className={styles.tabs} role="tablist" aria-label={translate(locale, "files")}>
      <button
        type="button"
        role="tab"
        aria-selected="false"
        className={styles.createTab}
        onClick={onCreate}
        title={translate(locale, "newNote")}
        aria-label={translate(locale, "newNote")}
      >+</button>
      {tabs.map((tab) => (
        <div key={tab.path} className={`${styles.tabGroup} ${tab.path === activePath ? styles.active : ""}`}>
          <button
            type="button"
            role="tab"
            aria-selected={tab.path === activePath}
            className={styles.tab}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            <span className={styles.status} data-state={tab.saveState} aria-hidden="true" />
            <span>{basename(tab.path)}</span>
          </button>
          <button
            type="button"
            className={styles.close}
            onClick={() => onClose(tab.path)}
            aria-label={`${translate(locale, "close")} ${basename(tab.path)}`}
          >×</button>
        </div>
      ))}
    </div>
  );
}
