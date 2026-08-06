import { useState } from "react";
import type { DriveWorkspaceReference } from "@note/api-contracts";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import { useAccountStore } from "../account/accountStore";
import { getDriveAccessToken, linkDriveWorkspace } from "../account/apiClient";
import { createDriveFolder, pickDriveFolder } from "../drive/googlePicker";
import styles from "./MilestonePanels.module.css";

interface DriveDialogProps { locale: Locale; onOpen: (workspace: DriveWorkspaceReference) => void; onClose: () => void }

/** Renders account controls and explicitly linked Drive folder selection. @param props Locale and workspace callbacks. @returns Accessible Drive dialog. */
export function DriveDialog({ locale, onOpen, onClose }: DriveDialogProps) {
  const me = useAccountStore((state) => state.me); const workspaces = useAccountStore((state) => state.workspaces); const signIn = useAccountStore((state) => state.signIn); const refresh = useAccountStore((state) => state.refreshWorkspaces); const logout = useAccountStore((state) => state.logout); const disconnect = useAccountStore((state) => state.disconnect); const removeAccount = useAccountStore((state) => state.deleteAccount);
  const [error, setError] = useState<string | null>(null); const account = me?.connectedAccounts[0];

  /** Selects an existing Drive folder and stores only its opaque ID and display name in the API. @returns Nothing after linking. */
  const selectFolder = async (): Promise<void> => { if (!account) return; try { const folder = await pickDriveFolder(await getDriveAccessToken(account.id)); if (!folder) return; await linkDriveWorkspace({ connectedAccountId: account.id, folderId: folder.id, displayName: folder.name }); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Drive selection failed."); } };
  /** Creates a Drive folder directly from the browser and links its metadata. @returns Nothing after linking. */
  const createFolder = async (): Promise<void> => { if (!account) return; const name = window.prompt(translate(locale, "driveFolderName"), "NoteMarkdown")?.trim(); if (!name) return; try { const folder = await createDriveFolder(await getDriveAccessToken(account.id), name); await linkDriveWorkspace({ connectedAccountId: account.id, folderId: folder.id, displayName: folder.name }); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Drive folder creation failed."); } };

  return <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="drive-title"><header><div><h2 id="drive-title">Google Drive</h2>{me ? <small>{me.user.displayName} · {me.user.email}</small> : null}</div><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
    {!me ? <><p>{translate(locale, "driveSignInBody")}</p><button className={styles.primaryAction} type="button" onClick={signIn}>{translate(locale, "signInGoogle")}</button></> : <>
      <div className={styles.driveActions}><button type="button" onClick={() => void selectFolder()}>{translate(locale, "selectDriveFolder")}</button><button type="button" onClick={() => void createFolder()}>{translate(locale, "createDriveFolder")}</button></div>
      <ul className={styles.workspaceList}>{workspaces.map((workspace) => <li key={workspace.id}><div><strong>{workspace.displayName}</strong><small>Google Drive</small></div><button type="button" onClick={() => onOpen(workspace)}>{translate(locale, "open")}</button></li>)}</ul>
      {!workspaces.length ? <p>{translate(locale, "noDriveWorkspaces")}</p> : null}
      <div className={styles.dangerActions}><button type="button" onClick={() => void logout()}>{translate(locale, "logout")}</button><button type="button" onClick={() => account && window.confirm(translate(locale, "confirmDisconnect")) && void disconnect(account.id)}>{translate(locale, "disconnectGoogle")}</button><button type="button" onClick={() => window.confirm(translate(locale, "confirmDeleteAccount")) && void removeAccount()}>{translate(locale, "deleteAccount")}</button></div>
    </>}{error ? <p role="alert">{error}</p> : null}</section></div>;
}
