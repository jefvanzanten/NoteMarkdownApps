import { create } from "zustand";
import type { DriveWorkspaceReference, Me } from "@note/api-contracts";
import { clearAccessTokens, deleteAccount, disconnectAccount, loadDriveWorkspaces, loadMe, logout } from "./apiClient";
import { lockAllDriveMirrors } from "../drive/driveMirror";

interface AccountState {
  me: Me | null; workspaces: DriveWorkspaceReference[]; isLoading: boolean; error: string | null;
  initialize: () => Promise<void>; refreshWorkspaces: () => Promise<void>; signIn: () => void; logout: () => Promise<void>; disconnect: (id: string) => Promise<void>; deleteAccount: () => Promise<void>;
}

/** Converts an unknown account failure into safe UI text. @param error Unknown failure. @returns Visible message. */
function message(error: unknown): string { return error instanceof Error ? error.message : "The account operation failed."; }

export const useAccountStore = create<AccountState>((set, get) => ({
  me: null, workspaces: [], isLoading: true, error: null,
  initialize: async () => { const me = await loadMe(); if (!me) { set({ me: null, workspaces: [], isLoading: false }); return; } try { set({ me, workspaces: await loadDriveWorkspaces(), isLoading: false, error: null }); } catch (error) { set({ me, isLoading: false, error: message(error) }); } },
  refreshWorkspaces: async () => { try { set({ workspaces: await loadDriveWorkspaces(), error: null }); } catch (error) { set({ error: message(error) }); } },
  signIn: () => { window.location.assign(`/api/v1/auth/google/start?returnTo=${encodeURIComponent(window.location.pathname)}`); },
  logout: async () => { try { await logout(); clearAccessTokens(); await lockAllDriveMirrors(); set({ me: null, workspaces: [], error: null }); } catch (error) { set({ error: message(error) }); } },
  disconnect: async (id) => { try { await disconnectAccount(id); clearAccessTokens(); await lockAllDriveMirrors(); await get().initialize(); } catch (error) { set({ error: message(error) }); } },
  deleteAccount: async () => { try { await deleteAccount(); clearAccessTokens(); await lockAllDriveMirrors(); set({ me: null, workspaces: [], error: null }); } catch (error) { set({ error: message(error) }); } },
}));
