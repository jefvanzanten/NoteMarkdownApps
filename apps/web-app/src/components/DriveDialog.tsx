import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DriveWorkspaceReference } from "@note/api-contracts";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import {
  accountQueryKeys,
  signInToGoogle,
  useDeleteAccountMutation,
  useDisconnectAccountMutation,
  useDriveWorkspacesQuery,
  useLogoutMutation,
  useMeQuery,
} from "../account/queries";
import { getDriveAccessToken, linkDriveWorkspace } from "../account/apiClient";
import { createDriveFolder, pickDriveFolder } from "../drive/googlePicker";
import styles from "./MilestonePanels.module.css";

interface DriveDialogProps { locale: Locale; onOpen: (workspace: DriveWorkspaceReference) => void; onClose: () => void }
const message = (error: unknown): string | null => error instanceof Error ? error.message : error ? "The account operation failed." : null;

/** Renders account controls and explicitly linked Drive folder selection. */
export function DriveDialog({ locale, onOpen, onClose }: DriveDialogProps) {
  const queryClient = useQueryClient();
  const meQuery = useMeQuery();
  const me = meQuery.data ?? null;
  const workspacesQuery = useDriveWorkspacesQuery(Boolean(me));
  const logout = useLogoutMutation();
  const disconnect = useDisconnectAccountMutation();
  const removeAccount = useDeleteAccountMutation();
  const [localError, setLocalError] = useState<string | null>(null);
  const account = me?.connectedAccounts[0];
  const workspaces = workspacesQuery.data ?? [];
  const error = localError ?? message(meQuery.error) ?? message(workspacesQuery.error) ?? message(logout.error) ?? message(disconnect.error) ?? message(removeAccount.error);

  /** Selects an existing Drive folder and stores only its opaque ID and display name in the API. */
  const selectFolder = async (): Promise<void> => {
    if (!account) return;
    try {
      setLocalError(null);
      const folder = await pickDriveFolder(await getDriveAccessToken(account.id));
      if (!folder) return;
      await linkDriveWorkspace({ connectedAccountId: account.id, folderId: folder.id, displayName: folder.name });
      await queryClient.invalidateQueries({ queryKey: accountQueryKeys.driveWorkspaces });
    } catch (failure) { setLocalError(message(failure)); }
  };

  /** Creates a Drive folder directly from the browser and links its metadata. */
  const createFolder = async (): Promise<void> => {
    if (!account) return;
    const name = window.prompt(translate(locale, "driveFolderName"), "NoteMarkdown")?.trim();
    if (!name) return;
    try {
      setLocalError(null);
      const folder = await createDriveFolder(await getDriveAccessToken(account.id), name);
      await linkDriveWorkspace({ connectedAccountId: account.id, folderId: folder.id, displayName: folder.name });
      await queryClient.invalidateQueries({ queryKey: accountQueryKeys.driveWorkspaces });
    } catch (failure) { setLocalError(message(failure)); }
  };

  return <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`${styles.dialog} ${styles.wide}`} role="dialog" aria-modal="true" aria-labelledby="drive-title"><header><div><h2 id="drive-title">Google Drive</h2>{me ? <small>{me.user.displayName} · {me.user.email}</small> : null}</div><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
    {!me ? <><p>{translate(locale, "driveSignInBody")}</p><button className={styles.primaryAction} type="button" onClick={signInToGoogle}>{translate(locale, "signInGoogle")}</button></> : account?.status === "reauthorization-required" ? <><p role="alert">{translate(locale, "driveReconnectBody")}</p><button className={styles.primaryAction} type="button" onClick={signInToGoogle}>{translate(locale, "reconnectGoogle")}</button>
      <div className={styles.dangerActions}><button type="button" onClick={() => logout.mutate()}>{translate(locale, "logout")}</button><button type="button" onClick={() => account && window.confirm(translate(locale, "confirmDisconnect")) && disconnect.mutate(account.id)}>{translate(locale, "disconnectGoogle")}</button><button type="button" onClick={() => window.confirm(translate(locale, "confirmDeleteAccount")) && removeAccount.mutate()}>{translate(locale, "deleteAccount")}</button></div></> : <>
      <div className={styles.driveActions}><button type="button" onClick={() => void selectFolder()}>{translate(locale, "selectDriveFolder")}</button><button type="button" onClick={() => void createFolder()}>{translate(locale, "createDriveFolder")}</button></div>
      <ul className={styles.workspaceList}>{workspaces.map((workspace) => <li key={workspace.id}><div><strong>{workspace.displayName}</strong><small>Google Drive</small></div><button type="button" onClick={() => onOpen(workspace)}>{translate(locale, "open")}</button></li>)}</ul>
      {!workspacesQuery.isLoading && !workspaces.length ? <p>{translate(locale, "noDriveWorkspaces")}</p> : null}
      <div className={styles.dangerActions}><button type="button" onClick={() => logout.mutate()}>{translate(locale, "logout")}</button><button type="button" onClick={() => account && window.confirm(translate(locale, "confirmDisconnect")) && disconnect.mutate(account.id)}>{translate(locale, "disconnectGoogle")}</button><button type="button" onClick={() => window.confirm(translate(locale, "confirmDeleteAccount")) && removeAccount.mutate()}>{translate(locale, "deleteAccount")}</button></div>
    </>}{error ? <p role="alert">{error}</p> : null}</section></div>;
}
