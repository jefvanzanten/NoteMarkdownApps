import type { ClientDiagnosticEvent, ClientDiagnosticReport } from "@note/api-contracts";
import type { WorkspaceErrorCode } from "@note/workspace-core";
import type { DriveDiagnostics, DriveRequestKind, DriveRequestResult } from "@note/workspace-drive";
import { recordActivity } from "../diagnostics/activityJournal";

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

export type SyncDiagnosticEvent = ClientDiagnosticEvent;
export type SyncDiagnosticErrorCode = WorkspaceErrorCode | "cancelled" | "missing-draft" | "unexpected";

export interface DiagnosticPageState {
  providerType: "drive" | "local" | "none";
  isOpening: boolean;
  isIndexing: boolean;
  entryCount: number;
  tabCount: number;
  saveStates: Record<string, number>;
}

interface SyncDiagnosticsOptions {
  enabled: boolean;
  slowOperationMs: number;
  buildMode: string;
  getPageState: () => DiagnosticPageState;
}

const MAX_SYNC_DIAGNOSTIC_EVENTS = 300;
const LEGACY_SYNC_DIAGNOSTICS_STORAGE_KEY = "notemarkdown:sync-diagnostics:v1";
const MAX_DIAGNOSTIC_REPORT_BYTES = 60 * 1_024;
const metrics = new Map<WorkspaceMetricName, number>();
let memoryEvents: SyncDiagnosticEvent[] = [];
let options: SyncDiagnosticsOptions = {
  enabled: false,
  slowOperationMs: 30_000,
  buildMode: "unknown",
  getPageState: () => ({ providerType: "none", isOpening: false, isIndexing: false, entryCount: 0, tabCount: 0, saveStates: {} }),
};
const reportedErrors = new WeakSet<object>();
let globalHandlersInstalled = false;

/**
 * Configures temporary error-triggered sync diagnostics for this browser process.
 * @param nextOptions Feature flag, slow threshold, build mode, and safe state reader.
 * @returns Nothing after replacing runtime options.
 */
export function configureSyncDiagnostics(nextOptions: SyncDiagnosticsOptions): void {
  options = nextOptions;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_SYNC_DIAGNOSTICS_STORAGE_KEY);
  } catch {
    // Legacy client-log cleanup is best effort when browser storage is blocked.
  }
}

/**
 * Returns the bounded in-memory event timeline.
 * @returns Oldest-first diagnostic events without workspace or document identities.
 */
export function getSyncDiagnosticEvents(): SyncDiagnosticEvent[] {
  return [...memoryEvents];
}

/**
 * Adds one path-free event to the temporary in-memory timeline and the classified activity journal.
 * @param event Diagnostic facts containing no provider or document identity.
 * @returns Nothing after bounded retention.
 */
export function recordSyncDiagnostic(event: Omit<SyncDiagnosticEvent, "timestamp">): void {
  recordActivity("sync", `sync.${event.operation}.${event.outcome}`, {
    attempt: event.attempt,
    durationMs: event.durationMs,
    errorCode: event.errorCode,
    itemCount: event.itemCount,
    requestBytes: event.requestBytes,
    requestKind: event.requestKind,
    responseBytes: event.responseBytes,
    retryDelayMs: event.retryDelayMs,
    status: event.status,
  }, event.outcome === "failed" ? "error" : event.outcome === "retrying" || event.outcome === "slow" ? "warning" : "info", event.operationId);
  if (!options.enabled) return;
  memoryEvents = [...memoryEvents, { ...event, timestamp: Date.now() }].slice(-MAX_SYNC_DIAGNOSTIC_EVENTS);
}

/**
 * Clears this browser process's temporary sync timeline.
 * @returns Nothing after reset.
 */
export function clearSyncDiagnosticEvents(): void {
  memoryEvents = [];
}

/**
 * Adds a privacy-safe local diagnostic value.
 * @param name Fixed metric name containing no workspace data.
 * @param value Numeric value to add.
 * @returns Nothing after the local counter changes.
 */
export function recordWorkspaceMetric(name: WorkspaceMetricName, value = 1): void {
  if (!options.enabled) return;
  metrics.set(name, (metrics.get(name) ?? 0) + value);
}

/**
 * Returns aggregate diagnostics without provider identities or paths.
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
 * Clears aggregate metrics for deterministic tests and diagnostic sessions.
 * @returns Nothing after reset.
 */
export function resetWorkspaceMetrics(): void {
  metrics.clear();
}

/**
 * Reduces a browser stack to code locations without the potentially sensitive message line.
 * @param error Original unknown failure.
 * @returns Bounded and origin-free stack frames.
 */
function safeStackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  const origin = typeof location === "undefined" ? "" : location.origin;
  return error.stack.split("\n").slice(1)
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 20)
    .map((line) => line.replaceAll(origin, "").replace(/[?#][^\s)]*/g, "").slice(0, 300));
}

/**
 * Collects only error class names from the cause chain.
 * @param error Original failure.
 * @returns Bounded cause names without messages or payloads.
 */
function safeCauseNames(error: unknown): string[] {
  const names: string[] = [];
  let current = error;
  while (current instanceof Error && names.length < 8) {
    const cause = (current as Error & { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    names.push(cause.name.slice(0, 100));
    current = cause;
  }
  return names;
}

/**
 * Normalizes an unknown failure into content-free technical facts.
 * @param error Original application or provider failure.
 * @returns Error class, stable codes, status, and safe code frames.
 */
function normalizeFailure(error: unknown): ClientDiagnosticReport["failure"] {
  const technical = error instanceof Error ? error as Error & { code?: unknown; status?: unknown } : null;
  const code = typeof technical?.code === "string" ? technical.code.slice(0, 100) : undefined;
  const status = typeof technical?.status === "number" && technical.status >= 0 && technical.status <= 599 ? Math.trunc(technical.status) : undefined;
  return {
    name: technical?.name.slice(0, 100) ?? "UnknownFailure",
    code: technical?.name === "ApiRequestError" ? undefined : code,
    apiCode: technical?.name === "ApiRequestError" ? code : undefined,
    status,
    stackFrames: safeStackFrames(error),
    causeNames: safeCauseNames(error),
  };
}

/**
 * Converts browser visibility into the report contract.
 * @returns Stable visibility category.
 */
function visibilityState(): ClientDiagnosticReport["pageState"]["visibility"] {
  if (typeof document === "undefined") return "unknown";
  if (document.visibilityState === "visible" || document.visibilityState === "hidden" || document.visibilityState === "prerender") return document.visibilityState;
  return "unknown";
}

/**
 * Uploads one bounded report directly to the temporary API sink.
 * @param report Content-free client diagnostic report.
 * @returns Nothing after best-effort delivery.
 */
async function uploadReport(report: ClientDiagnosticReport): Promise<void> {
  try {
    await fetch(`${import.meta.env.BASE_URL}api/v1/diagnostics/client-errors`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // Temporary diagnostics cannot safely block or recursively report application work.
  }
}

/**
 * Sends the current in-memory timeline after an application failure.
 * @param error Original failure; raw messages and application data are not included.
 * @param trigger Report trigger category.
 * @returns Nothing; delivery is asynchronous and best effort.
 */
export function reportSyncFailure(error: unknown, trigger: ClientDiagnosticReport["trigger"] = "workspace-error"): void {
  const failure = normalizeFailure(error);
  recordActivity("sync", "sync.failure-reported", {
    trigger,
    name: failure.name,
    code: failure.code,
    apiCode: failure.apiCode,
    status: failure.status,
  }, "error");
  if (!options.enabled) return;
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  const now = Date.now();
  const pageState = options.getPageState();
  const report: ClientDiagnosticReport = {
    reportId: crypto.randomUUID(),
    createdAt: now,
    trigger,
    buildMode: options.buildMode.slice(0, 40),
    pageState: {
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      visibility: visibilityState(),
      ...pageState,
    },
    failure: normalizeFailure(error),
    metrics: getWorkspaceMetrics(),
    events: getSyncDiagnosticEvents(),
  };
  while (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_DIAGNOSTIC_REPORT_BYTES && report.events.length > 0) {
    report.events = report.events.slice(Math.max(1, Math.ceil(report.events.length / 10)));
  }
  void uploadReport(report);
}

/**
 * Records and reports an operation that exceeded the temporary debugging threshold.
 * @param operation Safe state-machine operation category.
 * @param durationMs Measured operation duration.
 * @returns Whether the operation crossed the configured threshold.
 */
export function reportSlowSyncOperation(operation: SyncDiagnosticEvent["operation"], durationMs: number): boolean {
  if (!options.enabled || durationMs < options.slowOperationMs) return false;
  recordSyncDiagnostic({ operation, outcome: "slow", durationMs });
  const error = Object.assign(new Error("Slow sync operation"), { name: "SlowSyncOperation", code: operation });
  reportSyncFailure(error, "slow-operation");
  return true;
}

/**
 * Installs one-time global browser failure capture for errors outside workspace catch paths.
 * @returns Nothing after listeners are installed or confirmed present.
 */
export function installGlobalDiagnosticHandlers(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => reportSyncFailure(event.error ?? new Error("Unhandled browser error"), "unhandled-error"));
  window.addEventListener("unhandledrejection", (event) => reportSyncFailure(event.reason, "unhandled-rejection"));
}

/**
 * Records one completed Drive request result without retaining its URL.
 * @param result Coarse request category, outcome, status, and duration.
 * @returns Nothing after the event and optional slow report are recorded.
 */
function recordDriveRequestResult(result: DriveRequestResult): void {
  recordSyncDiagnostic({
    operation: "drive-request",
    outcome: result.outcome,
    operationId: result.operationId,
    requestKind: result.kind,
    errorCode: result.errorCode,
    status: result.status,
    durationMs: result.durationMs,
    requestBytes: result.requestBytes,
    responseBytes: result.responseBytes,
  });
  reportSlowSyncOperation("drive-request", result.durationMs);
}

/**
 * Creates the Drive diagnostics adapter using fixed aggregate categories.
 * @returns Privacy-safe Drive request, result, and byte recorder.
 */
export function createDriveDiagnostics(): DriveDiagnostics {
  return {
    recordRequest: (kind: DriveRequestKind) => {
      const operationId = crypto.randomUUID();
      if (kind === "metadata" || kind === "list" || kind === "change") recordWorkspaceMetric("drive_metadata_request_count");
      recordSyncDiagnostic({ operation: "drive-request", outcome: "started", operationId, requestKind: kind });
      return operationId;
    },
    recordRequestResult: recordDriveRequestResult,
    recordContentDownload: (bytes) => {
      recordWorkspaceMetric("drive_content_download_count");
      recordWorkspaceMetric("drive_content_download_bytes", bytes);
    },
  };
}
