import { WorkspaceError, type WorkspaceErrorCode } from "./types";

export type WorkspaceFailureCategory =
  | "session-expired"
  | "reauthorization-required"
  | "offline"
  | "rate-limited"
  | "provider-temporary"
  | "provider-quota"
  | "permission"
  | "not-found"
  | "revision-conflict"
  | "path-collision"
  | "cursor-invalid"
  | "unsupported"
  | "cancelled"
  | "fatal";

export type WorkspaceFailureSource = "metadata-api" | "google-drive" | "local-provider" | "browser-storage" | "coordination" | "application";
export type WorkspaceFailureBlock = "operation" | "document" | "workspace" | "account";
export type WorkspaceRecoveryAction = "retry" | "sign-in" | "reconnect" | "resolve-conflict" | "resolve-collision" | "request-permission" | "free-space" | "none";

/** Machine-readable failure policy kept separate from localized user-facing copy. */
export interface WorkspaceFailure {
  category: WorkspaceFailureCategory;
  source: WorkspaceFailureSource;
  retryable: boolean;
  retryAfterMs?: number;
  blocks: WorkspaceFailureBlock;
  preservesDraft: boolean;
  recoveryAction: WorkspaceRecoveryAction;
  requestId?: string;
}

const defaults: Record<WorkspaceErrorCode, Omit<WorkspaceFailure, "source" | "retryAfterMs">> = {
  conflict: { category: "revision-conflict", retryable: false, blocks: "document", preservesDraft: true, recoveryAction: "resolve-conflict" },
  permission: { category: "permission", retryable: false, blocks: "workspace", preservesDraft: true, recoveryAction: "request-permission" },
  "not-found": { category: "not-found", retryable: false, blocks: "document", preservesDraft: true, recoveryAction: "none" },
  collision: { category: "path-collision", retryable: false, blocks: "document", preservesDraft: true, recoveryAction: "resolve-collision" },
  unsupported: { category: "unsupported", retryable: false, blocks: "operation", preservesDraft: true, recoveryAction: "none" },
  quota: { category: "provider-quota", retryable: true, blocks: "operation", preservesDraft: true, recoveryAction: "retry" },
  offline: { category: "offline", retryable: true, blocks: "operation", preservesDraft: true, recoveryAction: "retry" },
  "cursor-invalid": { category: "cursor-invalid", retryable: true, blocks: "operation", preservesDraft: true, recoveryAction: "retry" },
  ambiguous: { category: "fatal", retryable: false, blocks: "workspace", preservesDraft: true, recoveryAction: "none" },
  temporary: { category: "provider-temporary", retryable: true, blocks: "operation", preservesDraft: true, recoveryAction: "retry" },
  fatal: { category: "fatal", retryable: false, blocks: "workspace", preservesDraft: true, recoveryAction: "none" },
};

/**
 * Converts a provider error into explicit retry, blocking, and recovery policy.
 * @param error Provider, storage, coordination, or application failure.
 * @param source Subsystem that produced the failure.
 * @param override Optional policy facts that are more specific than the workspace error code.
 * @returns Machine-readable failure and recovery policy.
 */
export function classifyWorkspaceError(
  error: unknown,
  source: WorkspaceFailureSource,
  override: Partial<WorkspaceFailure> = {},
): WorkspaceFailure {
  const base = error instanceof WorkspaceError ? defaults[error.code] : defaults.fatal;
  return {
    ...base,
    source,
    ...(error instanceof WorkspaceError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...override,
  };
}
