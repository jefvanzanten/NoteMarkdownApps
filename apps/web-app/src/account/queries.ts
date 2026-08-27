import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loadPendingWrites, lockDriveRepositories } from "@note/browser-storage";
import type { PreferenceValue } from "@note/api-contracts";
import { useWorkspaceStore } from "../state/workspaceStore";
import {
  ApiRequestError,
  appPath,
  clearAccessTokens,
  deleteAccount as deleteAccountRequest,
  disconnectAccount as disconnectAccountRequest,
  loadDriveWorkspaces,
  loadMe,
  loadPreferences,
  logout as logoutRequest,
  putPreferences,
} from "./apiClient";

export const accountQueryKeys = {
  me: ["account", "me"] as const,
  driveWorkspaces: ["account", "drive-workspaces"] as const,
  preferences: ["account", "preferences"] as const,
};

/**
 * Retries only bounded transport, throttling, and server failures.
 * @param failureCount Number of consecutive query failures.
 * @param error Latest query failure.
 * @returns Whether React Query may retry the request.
 */
function retryServerQuery(failureCount: number, error: Error): boolean {
  if (failureCount >= 2) return false;
  return error instanceof ApiRequestError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

/**
 * Returns current account metadata; null represents a documented anonymous session.
 * @returns Current-account query result.
 */
export function useMeQuery() {
  return useQuery({ queryKey: accountQueryKeys.me, queryFn: loadMe, staleTime: 60_000, retry: retryServerQuery });
}

/**
 * Returns linked Drive references only while authenticated.
 * @param enabled Whether an authenticated account is available.
 * @returns Linked-Drive-workspace query result.
 */
export function useDriveWorkspacesQuery(enabled: boolean) {
  return useQuery({ queryKey: accountQueryKeys.driveWorkspaces, queryFn: loadDriveWorkspaces, enabled, staleTime: 30_000, retry: retryServerQuery });
}

/**
 * Returns the synchronized preference snapshot while authenticated.
 * @param enabled Whether an authenticated account is available.
 * @returns Preference query result.
 */
export function usePreferencesQuery(enabled: boolean) {
  return useQuery({ queryKey: accountQueryKeys.preferences, queryFn: loadPreferences, enabled, staleTime: 60_000, retry: retryServerQuery });
}

/**
 * Persists preferences explicitly; mutations are never automatically replayed.
 * @returns Preference mutation result.
 */
export function usePutPreferencesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putPreferences,
    retry: false,
    onSuccess: (_result, preferences: PreferenceValue) => queryClient.setQueryData(accountQueryKeys.preferences, preferences),
  });
}

/**
 * Requires confirmation before encryption keys are locked with unsynchronized work.
 * @returns Whether the account operation may lock repository keys.
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

/**
 * Clears all account-owned query state after credentials and repository keys are removed.
 * @param queryClient Account query cache to clear.
 * @returns Nothing after credentials, keys, and cached account data are removed.
 */
async function clearAccountState(queryClient: QueryClient): Promise<void> {
  clearAccessTokens();
  await lockDriveRepositories();
  queryClient.setQueryData(accountQueryKeys.me, null);
  queryClient.setQueryData(accountQueryKeys.driveWorkspaces, []);
  queryClient.removeQueries({ queryKey: accountQueryKeys.preferences });
}

/** Starts the Google sign-in redirect for the current application path. @returns Nothing after navigation starts. */
export function signInToGoogle(): void {
  window.location.assign(`${appPath("/api/v1/auth/google/start")}?returnTo=${encodeURIComponent(window.location.pathname)}`);
}

/** Creates the guarded account logout mutation. @returns Logout mutation result. */
export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: async () => { if (!await confirmRepositoryLock()) return false; await logoutRequest(); await clearAccountState(queryClient); return true; }, retry: false });
}

/** Creates the guarded Google-account disconnection mutation. @returns Account-disconnection mutation result. */
export function useDisconnectAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!await confirmRepositoryLock()) return false;
      await disconnectAccountRequest(id);
      clearAccessTokens();
      await lockDriveRepositories();
      queryClient.setQueryData(accountQueryKeys.driveWorkspaces, []);
      queryClient.removeQueries({ queryKey: accountQueryKeys.preferences });
      await queryClient.invalidateQueries({ queryKey: accountQueryKeys.me });
      return true;
    },
    retry: false,
  });
}

/** Creates the guarded NoteMarkdown-account deletion mutation. @returns Account-deletion mutation result. */
export function useDeleteAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: async () => { if (!await confirmRepositoryLock()) return false; await deleteAccountRequest(); await clearAccountState(queryClient); return true; }, retry: false });
}
