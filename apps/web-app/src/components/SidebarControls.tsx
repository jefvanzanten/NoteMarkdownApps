import { useRef, useState } from "react";
import type { DriveWorkspaceReference } from "@note/api-contracts";
import { loadRepositoryWorkspaces, type RepositoryWorkspaceReference } from "../storage/browserStorage";
import { translate, type Locale } from "../i18n";
import styles from "./SidebarControls.module.css";

interface SidebarControlsProps {
  locale: Locale;
  providerId: string;
  providerName: string;
  providerStatus: string;
  driveWorkspaces: DriveWorkspaceReference[];
  diagnosticsCount: number;
  recoveryCount: number;
  onOpenLocal: (workspace: RepositoryWorkspaceReference) => void;
  onOpenDrive: (workspace: DriveWorkspaceReference) => void;
  onBrowse: () => void;
  onManageDrive: () => void;
  onSettings: () => void;
  onDiagnostics: () => void;
  onRecovery: () => void;
  onToggleLocale: () => void;
}

/**
 * Renders workspace switching and secondary application actions at the bottom of the sidebar.
 * @param props Active workspace details, available Drive workspaces, and action callbacks.
 * @returns Sidebar footer controls with upward-opening menus.
 */
export function SidebarControls(props: SidebarControlsProps) {
  const workspaceMenu = useRef<HTMLDetailsElement>(null);
  const settingsMenu = useRef<HTMLDetailsElement>(null);
  const [localWorkspaces, setLocalWorkspaces] = useState<RepositoryWorkspaceReference[]>([]);
  const [isLoading, setLoading] = useState(false);

  /** Closes both footer menus after an action is selected. @returns Nothing. */
  const closeMenus = (): void => {
    if (workspaceMenu.current) workspaceMenu.current.open = false;
    if (settingsMenu.current) settingsMenu.current.open = false;
  };

  /** Loads recent local workspaces when the workspace menu opens. @returns Nothing after loading starts. */
  const loadLocalWorkspaces = (): void => {
    if (!workspaceMenu.current?.open) return;
    if (settingsMenu.current) settingsMenu.current.open = false;
    setLoading(true);
    void loadRepositoryWorkspaces()
      .then((workspaces) => setLocalWorkspaces(workspaces.filter((workspace) => workspace.providerType === "local" && Boolean(workspace.handle))))
      .finally(() => setLoading(false));
  };

  /** Opens one local workspace and closes the menu. @param workspace Stored local workspace. @returns Nothing. */
  const openLocal = (workspace: RepositoryWorkspaceReference): void => {
    closeMenus();
    props.onOpenLocal(workspace);
  };

  /** Opens one Drive workspace and closes the menu. @param workspace Linked Drive workspace. @returns Nothing. */
  const openDrive = (workspace: DriveWorkspaceReference): void => {
    closeMenus();
    props.onOpenDrive(workspace);
  };

  /** Runs a menu action after closing both menus. @param action Selected application action. @returns Nothing. */
  const runAction = (action: () => void): void => {
    closeMenus();
    action();
  };

  return (
    <div className={styles.controls}>
      <details ref={workspaceMenu} className={styles.workspaceControl} onToggle={loadLocalWorkspaces}>
        <summary title={props.providerStatus}>
          <span className={styles.statusDot} aria-hidden="true">●</span>
          <span>{props.providerName}</span>
          <span aria-hidden="true">⌃</span>
        </summary>
        <div className={styles.menu}>
          <strong>{translate(props.locale, "switchWorkspace")}</strong>
          {localWorkspaces.map((workspace) => (
            <button type="button" key={workspace.id} disabled={workspace.id === props.providerId} onClick={() => openLocal(workspace)}>
              <span>{workspace.name}</span><small>{translate(props.locale, "localWorkspace")}</small>
            </button>
          ))}
          {props.driveWorkspaces.map((workspace) => (
            <button type="button" key={workspace.id} disabled={`drive:${workspace.id}` === props.providerId} onClick={() => openDrive(workspace)}>
              <span>{workspace.displayName}</span><small>Google Drive</small>
            </button>
          ))}
          {isLoading ? <small className={styles.loading}>{translate(props.locale, "loadingWorkspaces")}</small> : null}
          <div className={styles.menuSeparator} />
          <button type="button" onClick={() => runAction(props.onBrowse)}>{translate(props.locale, "browseWorkspace")}</button>
          <button type="button" onClick={() => runAction(props.onManageDrive)}>{translate(props.locale, "manageDriveWorkspaces")}</button>
        </div>
      </details>

      <details ref={settingsMenu} className={styles.settingsControl} onToggle={() => {
        if (settingsMenu.current?.open && workspaceMenu.current) workspaceMenu.current.open = false;
      }}>
        <summary aria-label={translate(props.locale, "settings")} title={translate(props.locale, "settings")}>⚙</summary>
        <div className={`${styles.menu} ${styles.settingsMenu}`}>
          <button type="button" onClick={() => runAction(props.onSettings)}>{translate(props.locale, "settings")}</button>
          <button type="button" onClick={() => runAction(props.onDiagnostics)}>
            <span>{translate(props.locale, "diagnostics")}</span>{props.diagnosticsCount ? <small>{props.diagnosticsCount}</small> : null}
          </button>
          <button type="button" onClick={() => runAction(props.onRecovery)}>
            <span>{translate(props.locale, "recovery")}</span>{props.recoveryCount ? <small>{props.recoveryCount}</small> : null}
          </button>
          <button type="button" onClick={() => runAction(props.onToggleLocale)}>
            <span>{translate(props.locale, "currentLanguage")}</span><small>{translate(props.locale, "language")}</small>
          </button>
        </div>
      </details>
    </div>
  );
}
