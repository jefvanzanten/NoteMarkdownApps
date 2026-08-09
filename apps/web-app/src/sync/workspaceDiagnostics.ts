import type { WorkspaceErrorCode } from "@note/workspace-core";
import type { DriveDiagnostics, DriveRequestKind, DriveRequestResult } from "@note/workspace-drive";

export type WorkspaceMetricName =
  | "workspace_activate_ms"
  | "manifest_load_ms"
  | "remote_reconcile_ms"
  | "drive_metadata_request_count"
  | "drive_content_download_count"
  | "drive_content_download_bytes"
  | "cache_hit_count"
  | "cache_miss_count"
  | "priority_queue_wait_ms"
  | "provider_retry_count"
  | "index_documents_processed";

export interface SyncDiagnosticEvent {
  timestamp: number;
  operation: "drive-request" | "provider-write";
  outcome: "started" | "queued" | "succeeded" | "failed" | "auth-retry";
  requestKind?: DriveRequestKind;
  errorCode?: WorkspaceErrorCode | "cancelled" | "missing-draft" | "unexpected";
  status?: number;
  attempt?: number;
  durationMs?: number;
  retryDelayMs?: number;
}

const SYNC_DIAGNOSTICS_STORAGE_KEY = "notemarkdown:sync-diagnostics:v1";
const MAX_SYNC_DIAGNOSTIC_EVENTS = 200;
const metrics = new Map<WorkspaceMetricName, number>();
let memoryEvents: SyncDiagnosticEvent[] = [];

/**
 * Loads the bounded privacy-safe event log from this browser only.
 * @returns Oldest-first diagnostic events without workspace or document identities.
 */
export function getSyncDiagnosticEvents(): SyncDiagnosticEvent[] {
  if (typeof localStorage === "undefined") return [...memoryEvents];
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_DIAGNOSTICS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as SyncDiagnosticEvent[]).slice(-MAX_SYNC_DIAGNOSTIC_EVENTS) : [];
  } catch {
    return [...memoryEvents];
  }
}

/**
 * Adds one path-free client sync event to a bounded local log.
 * @param event Diagnostic facts containing no provider or document identity.
 * @returns Nothing after best-effort browser persistence.
 */
export function recordSyncDiagnostic(event: Omit<SyncDiagnosticEvent, "timestamp">): void {
  const next = [...getSyncDiagnosticEvents(), { ...event, timestamp: Date.now() }].slice(-MAX_SYNC_DIAGNOSTIC_EVENTS);
  memoryEvents = next;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SYNC_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Diagnostics must never interrupt document writes when browser storage is unavailable.
  }
}

/**
 * Clears this browser's local sync event log.
 * @returns Nothing after best-effort removal.
 */
export function clearSyncDiagnosticEvents(): void {
  memoryEvents = [];
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(SYNC_DIAGNOSTICS_STORAGE_KEY);
  } catch {
    // A blocked localStorage implementation is a valid degraded mode.
  }
}

/**
 * Adds a privacy-safe local diagnostic value.
 * @param name Fixed metric name containing no workspace data.
 * @param value Numeric value to add.
 * @returns Nothing after the local counter changes.
 */
export function recordWorkspaceMetric(name: WorkspaceMetricName, value = 1): void {
  metrics.set(name, (metrics.get(name) ?? 0) + value);
}

/**
 * Returns local aggregate diagnostics without provider identities or paths.
 * @returns Immutable metric snapshot.
 */
export function getWorkspaceMetrics(): Readonly<Record<WorkspaceMetricName, number>> {
  return Object.freeze({
    workspace_activate_ms: metrics.get("workspace_activate_ms") ?? 0,
    manifest_load_ms: metrics.get("manifest_load_ms") ?? 0,
    remote_reconcile_ms: metrics.get("remote_reconcile_ms") ?? 0,
    drive_metadata_request_count: metrics.get("drive_metadata_request_count") ?? 0,
    drive_content_download_count: metrics.get("drive_content_download_count") ?? 0,
    drive_content_download_bytes: metrics.get("drive_content_download_bytes") ?? 0,
    cache_hit_count: metrics.get("cache_hit_count") ?? 0,
    cache_miss_count: metrics.get("cache_miss_count") ?? 0,
    priority_queue_wait_ms: metrics.get("priority_queue_wait_ms") ?? 0,
    provider_retry_count: metrics.get("provider_retry_count") ?? 0,
    index_documents_processed: metrics.get("index_documents_processed") ?? 0,
  });
}

/**
 * Clears local metrics for deterministic tests and diagnostics sessions.
 * @returns Nothing after reset.
 */
export function resetWorkspaceMetrics(): void {
  metrics.clear();
}

/**
 * Persists one completed Drive request result without retaining its URL.
 * @param result Coarse request category, outcome, status, and duration.
 * @returns Nothing after the local event is retained.
 */
function recordDriveRequestResult(result: DriveRequestResult): void {
  if (result.kind !== "mutation" && result.outcome === "succeeded") return;
  recordSyncDiagnostic({
    operation: "drive-request",
    outcome: result.outcome,
    requestKind: result.kind,
    errorCode: result.errorCode,
    status: result.status,
    durationMs: result.durationMs,
  });
}

/**
 * Creates the Drive diagnostics adapter using fixed aggregate categories.
 * @returns Privacy-safe Drive request, result, and byte recorder.
 */
export function createDriveDiagnostics(): DriveDiagnostics {
  return {
    recordRequest: (kind: DriveRequestKind) => {
      if (kind === "metadata" || kind === "list" || kind === "change") recordWorkspaceMetric("drive_metadata_request_count");
      if (kind === "mutation") recordSyncDiagnostic({ operation: "drive-request", outcome: "started", requestKind: kind });
    },
    recordRequestResult: recordDriveRequestResult,
    recordContentDownload: (bytes) => {
      recordWorkspaceMetric("drive_content_download_count");
      recordWorkspaceMetric("drive_content_download_bytes", bytes);
    },
  };
}
