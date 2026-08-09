import { WorkspaceError } from "@note/workspace-core";
import { CancelledWorkError, retryDelay } from "@note/sync-core";
import { ApiRequestError } from "../account/apiClient";

/**
 * Converts Drive-token API failures into precise workspace categories and recovery guidance.
 * @param error Unknown token acquisition failure.
 * @returns Provider-facing error retaining the original typed API cause.
 */
export function driveTokenFailure(error: unknown): WorkspaceError {
  if (error instanceof ApiRequestError) {
    const reference = error.requestId ? ` Diagnostic reference: ${error.requestId}.` : "";
    if (error.status === 401) {
      return new WorkspaceError("permission", `Your NoteMarkdown session expired or was revoked. Sign in again before Google Drive can synchronize. Your draft remains stored locally.${reference}`, { cause: error });
    }
    if (error.status === 404 || error.code === "not-found") {
      return new WorkspaceError("permission", `The connected Google account for this saved workspace is no longer available. Reconnect Google Drive before retrying; local drafts remain stored locally.${reference}`, { cause: error });
    }
    if (error.status === 409 || error.code === "reauthorization-required") {
      return new WorkspaceError("permission", `Google Drive authorization must be renewed. Reconnect Google Drive before retrying; your draft remains stored locally.${reference}`, { cause: error });
    }
    return new WorkspaceError("temporary", `The NoteMarkdown API could not refresh Google Drive access (HTTP ${error.status}, ${error.code}). Local changes remain stored and provider work will retry.${reference}`, { cause: error });
  }
  return new WorkspaceError("temporary", "The NoteMarkdown API could not refresh Google Drive access. Local changes remain stored and provider work will retry.", { cause: error });
}

/**
 * Calculates a bounded write retry without retrying permanent permission failures.
 * @param error Provider, API, or coordination failure.
 * @param attempt Number of previous failed attempts.
 * @returns Retry delay, or null for blocking and exhausted failures.
 */
export function providerWriteRetryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof CancelledWorkError) return retryDelay(attempt);
  if (!(error instanceof WorkspaceError)) return null;
  if (error.code === "permission") {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof ApiRequestError && cause.status === 401 ? retryDelay(attempt) : null;
  }
  if (error.code !== "offline" && error.code !== "quota" && error.code !== "temporary") return null;
  return retryDelay(attempt, { retryAfterMs: error.retryAfterMs });
}
