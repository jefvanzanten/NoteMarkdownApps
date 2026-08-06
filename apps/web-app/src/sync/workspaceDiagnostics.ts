import type { DriveDiagnostics, DriveRequestKind } from "@note/workspace-drive";

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

const metrics = new Map<WorkspaceMetricName, number>();

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
 * Creates the Drive diagnostics adapter using fixed aggregate categories.
 * @returns Privacy-safe Drive request and byte recorder.
 */
export function createDriveDiagnostics(): DriveDiagnostics {
  return {
    recordRequest: (kind: DriveRequestKind) => {
      if (kind === "metadata" || kind === "list" || kind === "change") recordWorkspaceMetric("drive_metadata_request_count");
    },
    recordContentDownload: (bytes) => {
      recordWorkspaceMetric("drive_content_download_count");
      recordWorkspaceMetric("drive_content_download_bytes", bytes);
    },
  };
}
