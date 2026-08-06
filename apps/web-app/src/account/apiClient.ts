import type { CreateWorkspace, DriveWorkspaceReference, Me, PreferenceValue } from "@note/api-contracts";

interface ApiFailure { error?: { code?: string; message?: string } }

/** Performs one same-origin metadata API request with stable error handling. @param path Versioned API path. @param init Fetch options. @returns Validated-by-server JSON payload. */
async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) { const failure = await response.json().catch(() => ({})) as ApiFailure; throw new Error(failure.error?.message ?? `API request failed (${response.status}).`); }
  return response.json() as Promise<T>;
}

/** Loads the current account or returns null while anonymous. @returns Account identity or null. */
export async function loadMe(): Promise<Me | null> { try { return await apiRequest<Me>("/api/v1/me"); } catch { return null; } }
/** Loads linked Drive folder references. @returns Current user's references. */
export async function loadDriveWorkspaces(): Promise<DriveWorkspaceReference[]> { return (await apiRequest<{ workspaces: DriveWorkspaceReference[] }>("/api/v1/drive/workspaces")).workspaces; }
/** Persists one selected Drive folder reference. @param value Connected account and folder metadata. @returns Created reference. */
export async function linkDriveWorkspace(value: CreateWorkspace): Promise<DriveWorkspaceReference> { return apiRequest("/api/v1/drive/workspaces", { method: "POST", body: JSON.stringify(value) }); }
/** Removes one folder reference without deleting Drive files. @param id Reference ID. @returns Nothing. */
export async function unlinkDriveWorkspace(id: string): Promise<void> { await apiRequest(`/api/v1/drive/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }); }
/** Revokes the current server session. @returns Nothing. */
export async function logout(): Promise<void> { await apiRequest("/api/v1/session/logout", { method: "POST" }); }
/** Disconnects one Google grant and its linked references. @param id Connected account ID. @returns Nothing. */
export async function disconnectAccount(id: string): Promise<void> { await apiRequest(`/api/v1/connected-accounts/${encodeURIComponent(id)}`, { method: "DELETE" }); }
/** Deletes only NoteMarkdown account metadata. @returns Nothing. */
export async function deleteAccount(): Promise<void> { await apiRequest("/api/v1/account", { method: "DELETE" }); }
/** Loads synchronized preferences when present. @returns Server preference or null. */
export async function loadPreferences(): Promise<PreferenceValue | null> { try { return (await apiRequest<{ preferences: PreferenceValue }>("/api/v1/preferences")).preferences; } catch { return null; } }
/** Replaces synchronized global preferences. @param preferences Complete preference snapshot. @returns Nothing. */
export async function putPreferences(preferences: PreferenceValue): Promise<void> { await apiRequest("/api/v1/preferences", { method: "PUT", body: JSON.stringify({ preferences }) }); }

const accessTokens = new Map<string, { accessToken: string; expiresAt: number }>();
/** Obtains a memory-only short-lived Drive token. @param connectedAccountId User-scoped account ID. @returns Access token. */
export async function getDriveAccessToken(connectedAccountId: string): Promise<string> { const cached = accessTokens.get(connectedAccountId); if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken; const token = await apiRequest<{ accessToken: string; expiresAt: number }>("/api/v1/drive/token", { method: "POST", body: JSON.stringify({ connectedAccountId }) }); accessTokens.set(connectedAccountId, token); return token.accessToken; }
/** Removes all in-memory provider credentials on explicit logout. @returns Nothing. */
export function clearAccessTokens(): void { accessTokens.clear(); }
