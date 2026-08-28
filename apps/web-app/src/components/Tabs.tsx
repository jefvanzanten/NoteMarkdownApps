import { useState } from "react";
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
  const [isMobileDropdownOpen, setMobileDropdownOpen] = useState(false);
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const hasMultipleTabs = tabs.length > 1;
  const mobileTabContent = (
    <>
      {activeTab ? <span className={styles.status} data-state={activeTab.saveState} aria-hidden="true" /> : null}
      <span className={styles.dropdownLabel}>{activeTab ? basename(activeTab.path) : tabs.length > 0 ? translate(locale, "noDocument") : ""}</span>
    </>
  );

  return (
    <>
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

      <div className={styles.mobileTabs}>
        <button
          type="button"
          className={styles.mobileCreateTab}
          onClick={onCreate}
          title={translate(locale, "newNote")}
          aria-label={translate(locale, "newNote")}
        >+</button>
        <div className={`${styles.mobileTab} ${tabs.length === 0 ? styles.mobileTabEmpty : ""}`}>
          <div
            className={`${styles.mobileSelector} ${tabs.length === 0 ? styles.emptyTab : ""}`}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMobileDropdownOpen(false);
            }}
          >
            <div className={styles.mobileSelectorControl}>
              {hasMultipleTabs ? (
                <button
                  type="button"
                  className={styles.dropdownButton}
                  onClick={() => setMobileDropdownOpen((isOpen) => !isOpen)}
                  aria-haspopup="listbox"
                  aria-expanded={isMobileDropdownOpen}
                >
                  {mobileTabContent}
                </button>
              ) : (
                <div className={`${styles.dropdownButton} ${styles.singleTab}`}>{mobileTabContent}</div>
              )}
              {activeTab ? (
                <button
                  type="button"
                  className={styles.mobileClose}
                  onClick={() => {
                    setMobileDropdownOpen(false);
                    onClose(activeTab.path);
                  }}
                  aria-label={`${translate(locale, "close")} ${basename(activeTab.path)}`}
                >×</button>
              ) : null}
              {hasMultipleTabs ? (
                <button
                  type="button"
                  className={styles.dropdownToggle}
                  onClick={() => setMobileDropdownOpen((isOpen) => !isOpen)}
                  aria-haspopup="listbox"
                  aria-expanded={isMobileDropdownOpen}
                  aria-label={translate(locale, "files")}
                >
                  <span className={styles.chevron} aria-hidden="true">⌄</span>
                </button>
              ) : null}
            </div>
            {hasMultipleTabs && isMobileDropdownOpen ? (
              <div className={styles.dropdownMenu} role="listbox" aria-label={translate(locale, "files")}>
                {tabs.map((tab) => (
                  <button
                    key={tab.path}
                    type="button"
                    role="option"
                    aria-selected={tab.path === activePath}
                    className={tab.path === activePath ? styles.dropdownOptionActive : ""}
                    onClick={() => {
                      onActivate(tab.path);
                      setMobileDropdownOpen(false);
                    }}
                    title={tab.path}
                  >
                    <span className={styles.status} data-state={tab.saveState} aria-hidden="true" />
                    <span>{basename(tab.path)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
