import {
  DriveTokenSchema,
  DriveWorkspaceSchema,
  EmptySchema,
  MeSchema,
  PreferenceSchema,
  WorkspaceListSchema,
  type CreateWorkspace,
  type DriveWorkspaceReference,
  type Me,
  type PreferenceValue,
} from "@note/api-contracts";
import { parseRetryAfter } from "@note/sync-core";
import { recordActivity } from "../diagnostics/activityJournal";

interface ApiFailure { error?: { code?: string; message?: string } }
interface RuntimeSchema<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }

const API_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
  /**
   * Creates a typed metadata-API failure for provider/session classification.
   * @param message Safe server or fallback failure message.
   * @param status HTTP response status, or zero for transport failures.
   * @param code Stable API failure code.
   * @param requestId Optional server-log correlation identifier.
   * @param retryAfterMs Optional server retry guidance.
   * @returns Typed API request error.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiRequestError";
  }
}

/** Prefixes an application path with the configured public base path. @param path Root-relative application path. @returns Public path below the deployment base. */
export function appPath(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}

/** Creates one timeout signal while preserving caller cancellation. */
function requestSignal(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Redacts dynamic API identifiers while retaining a useful route category. @param path Requested API path. @returns Path safe for the local activity export. */
function diagnosticApiPath(path: string): string {
  return path.split("?", 1)[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
}

/** Performs one same-origin metadata request with bounded transport and runtime response validation. @param path API route. @param schema Runtime response contract. @param init Optional fetch configuration. @returns Validated response payload. */
async function apiRequest<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}): Promise<T> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const method = init.method ?? "GET";
  const diagnosticPath = diagnosticApiPath(path);
  recordActivity("api", "api.request.started", { method, path: diagnosticPath }, "info", correlationId);
  let response: Response;
  try {
    response = await fetch(appPath(path), {
      credentials: "include",
      ...init,
      signal: requestSignal(init.signal),
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), "x-correlation-id": correlationId, ...init.headers },
    });
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    const aborted = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    const code = aborted ? "timeout" : "network-error";
    recordActivity("api", "api.request.failed", { method, path: diagnosticPath, code, durationMs: Date.now() - startedAt }, "error", correlationId);
    throw new ApiRequestError(
      aborted ? "The NoteMarkdown API request timed out." : "The NoteMarkdown API could not be reached.",
      0,
      code,
      undefined,
      undefined,
      { cause: error },
    );
  }

  const serverRequestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as ApiFailure;
    const code = failure.error?.code ?? "unknown";
    const reference = serverRequestId ? ` Reference: ${serverRequestId}.` : "";
    const message = failure.error?.message ?? `API request failed (${response.status}, ${code}).`;
    recordActivity("api", "api.request.failed", { method, path: diagnosticPath, status: response.status, code, serverRequestId, durationMs: Date.now() - startedAt }, "error", correlationId);
    throw new ApiRequestError(`${message}${reference}`, response.status, code, serverRequestId, parseRetryAfter(response.headers.get("retry-after")));
  }

  const payload = await response.json().catch((cause: unknown) => {
    recordActivity("api", "api.response.invalid-json", { method, path: diagnosticPath, status: response.status, serverRequestId, durationMs: Date.now() - startedAt }, "error", correlationId);
    throw new ApiRequestError("The NoteMarkdown API returned invalid JSON.", response.status, "invalid-response", serverRequestId, undefined, { cause });
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    recordActivity("api", "api.response.invalid-contract", { method, path: diagnosticPath, status: response.status, serverRequestId, durationMs: Date.now() - startedAt }, "error", correlationId);
    throw new ApiRequestError("The NoteMarkdown API returned an invalid response.", response.status, "invalid-response", serverRequestId);
  }
  recordActivity("api", "api.request.succeeded", { method, path: diagnosticPath, status: response.status, serverRequestId, durationMs: Date.now() - startedAt }, "info", correlationId);
  return parsed.data;
}

/** Loads the current account or returns null only for an anonymous/expired session. */
export async function loadMe(): Promise<Me | null> {
  try { return await apiRequest("/api/v1/me", MeSchema); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

/** Loads linked Drive folder references. */
export async function loadDriveWorkspaces(): Promise<DriveWorkspaceReference[]> {
  return (await apiRequest("/api/v1/drive/workspaces", WorkspaceListSchema)).workspaces;
}

/** Persists one selected Drive folder reference. */
export async function linkDriveWorkspace(value: CreateWorkspace): Promise<DriveWorkspaceReference> {
  return apiRequest("/api/v1/drive/workspaces", DriveWorkspaceSchema, { method: "POST", body: JSON.stringify(value) });
}

/** Removes one folder reference without deleting Drive files. */
export async function unlinkDriveWorkspace(id: string): Promise<void> {
  await apiRequest(`/api/v1/drive/workspaces/${encodeURIComponent(id)}`, EmptySchema, { method: "DELETE" });
}

/** Revokes the current server session. */
export async function logout(): Promise<void> { await apiRequest("/api/v1/session/logout", EmptySchema, { method: "POST" }); }
/** Disconnects one Google grant and its linked references. */
export async function disconnectAccount(id: string): Promise<void> { await apiRequest(`/api/v1/connected-accounts/${encodeURIComponent(id)}`, EmptySchema, { method: "DELETE" }); }
/** Deletes only NoteMarkdown account metadata. */
export async function deleteAccount(): Promise<void> { await apiRequest("/api/v1/account", EmptySchema, { method: "DELETE" }); }

/** Loads synchronized preferences, treating only the documented 404 as absence. */
export async function loadPreferences(): Promise<PreferenceValue | null> {
  try { return (await apiRequest("/api/v1/preferences", PreferenceSchema)).preferences; }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** Replaces synchronized global preferences. */
export async function putPreferences(preferences: PreferenceValue): Promise<void> {
  await apiRequest("/api/v1/preferences", PreferenceSchema, { method: "PUT", body: JSON.stringify({ preferences }) });
}

const accessTokens = new Map<string, { accessToken: string; expiresAt: number }>();
/** Obtains a memory-only short-lived Drive token. */
export async function getDriveAccessToken(connectedAccountId: string): Promise<string> {
  const cached = accessTokens.get(connectedAccountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const token = await apiRequest("/api/v1/drive/token", DriveTokenSchema, { method: "POST", body: JSON.stringify({ connectedAccountId }) });
  accessTokens.set(connectedAccountId, token);
  return token.accessToken;
}

/** Invalidates one cached Drive credential after Google rejects it. */
export function invalidateDriveAccessToken(connectedAccountId: string): void { accessTokens.delete(connectedAccountId); }
/** Removes all in-memory provider credentials on explicit logout. */
export function clearAccessTokens(): void { accessTokens.clear(); }
