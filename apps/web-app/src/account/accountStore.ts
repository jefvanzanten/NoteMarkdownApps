import { create } from "zustand";
import type { DriveWorkspaceReference, Me } from "@note/api-contracts";
import { appPath, clearAccessTokens, deleteAccount, disconnectAccount, loadDriveWorkspaces, loadMe, logout } from "./apiClient";
import { loadPendingWrites, lockDriveRepositories } from "@note/browser-storage";
import { useWorkspaceStore } from "../state/workspaceStore";

interface AccountState {
  me: Me | null; workspaces: DriveWorkspaceReference[]; isLoading: boolean; error: string | null;
  initialize: () => Promise<void>; refreshWorkspaces: () => Promise<void>; signIn: () => void; logout: () => Promise<void>; disconnect: (id: string) => Promise<void>; deleteAccount: () => Promise<void>;
}

/** Converts an unknown account failure into safe UI text. @param error Unknown failure. @returns Visible message. */
function message(error: unknown): string { return error instanceof Error ? error.message : "The account operation failed."; }

/**
 * Requires confirmation before encryption keys are locked with unsynchronized work.
 * @returns Whether logout or disconnect may continue.
 */
async function confirmRepositoryLock(): Promise<boolean> {
  const workspace = useWorkspaceStore.getState();
  if (!workspace.provider?.id.startsWith("drive:")) return true;
  const hasDirtyTab = workspace.tabs.some((tab) => tab.saveState !== "clean" && tab.saveState !== "checking");
  const pendingWrites = await loadPendingWrites(workspace.provider.id);
  const hasPendingWrite = pendingWrites.some((pending) => pending.state !== "applied");
  return !hasDirtyTab && !hasPendingWrite
    || window.confirm("Unsynchronized Drive work will remain encrypted and locked on this device after logout. Continue?");
}

export const useAccountStore = create<AccountState>((set, get) => ({
  me: null, workspaces: [], isLoading: true, error: null,
  initialize: async () => { const me = await loadMe(); if (!me) { set({ me: null, workspaces: [], isLoading: false }); return; } try { set({ me, workspaces: await loadDriveWorkspaces(), isLoading: false, error: null }); } catch (error) { set({ me, isLoading: false, error: message(error) }); } },
  refreshWorkspaces: async () => { try { set({ workspaces: await loadDriveWorkspaces(), error: null }); } catch (error) { set({ error: message(error) }); } },
  signIn: () => { window.location.assign(`${appPath("/api/v1/auth/google/start")}?returnTo=${encodeURIComponent(window.location.pathname)}`); },
  logout: async () => { try { if (!await confirmRepositoryLock()) return; await logout(); clearAccessTokens(); await lockDriveRepositories(); set({ me: null, workspaces: [], error: null }); } catch (error) { set({ error: message(error) }); } },
  disconnect: async (id) => { try { if (!await confirmRepositoryLock()) return; await disconnectAccount(id); clearAccessTokens(); await lockDriveRepositories(); await get().initialize(); } catch (error) { set({ error: message(error) }); } },
  deleteAccount: async () => { try { if (!await confirmRepositoryLock()) return; await deleteAccount(); clearAccessTokens(); await lockDriveRepositories(); set({ me: null, workspaces: [], error: null }); } catch (error) { set({ error: message(error) }); } },
}));
