import type { ActivityDetails, ActivityLevel } from "./activityJournal";

export type ActivityRetentionPolicy = "aggregate" | "drop" | "retain";

export interface HourlyActivityMetrics {
  hourStart: number;
  apiSuccessCount: number;
  apiDurationMs: number;
  tokenSuccessCount: number;
  tokenDurationMs: number;
  driveReadCount: number;
  driveReadDurationMs: number;
  driveReadBytes: number;
  cacheHitCount: number;
  cacheMissCount: number;
  reconciliationCount: number;
  reconciliationDurationMs: number;
}

const NETWORK_SLOW_MS = 5_000;
const RECONCILIATION_SLOW_MS = 30_000;

/**
 * Central retention registry for exact activity names. Dynamic sync event families are
 * classified by classifyActivity so newly observed names still have a safe fallback.
 */
export const ACTIVITY_EVENT_POLICIES = Object.freeze({
  "api.request.failed": "retain",
  "api.request.started": "drop",
  "api.request.succeeded": "aggregate",
  "api.response.invalid-contract": "retain",
  "api.response.invalid-json": "retain",
  "application.started": "retain",
  "document.activated": "drop",
  "document.closed": "retain",
  "document.deactivated": "drop",
  "document.editing-state-changed": "retain",
  "document.edit-started": "retain",
  "document.opened": "retain",
  "document.path-changed": "retain",
  "document.save-state-changed": "retain",
  "document.view-mode-changed": "drop",
  "document.visibility-changed": "drop",
  "document-cache.hit": "aggregate",
  "document-cache.miss": "aggregate",
  "draft.found": "drop",
  "draft.migrated": "retain",
  "draft.missing": "drop",
  "draft.persisted": "drop",
  "error.unhandled": "retain",
  "history.checkpoint-created": "drop",
  "manifest-cache.hit": "aggregate",
  "manifest-cache.miss": "aggregate",
  "network.offline": "retain",
  "network.online": "retain",
  "promise.unhandled-rejection": "retain",
  "session.restored": "retain",
  "sync.document-reconciliation.started": "drop",
  "sync.document-reconciliation.succeeded": "aggregate",
  "sync.failure-reported": "retain",
  "sync.reconciliation.started": "drop",
  "sync.reconciliation.succeeded": "aggregate",
  "sync.token-request.started": "drop",
  "sync.token-request.succeeded": "aggregate",
  "window.blurred": "drop",
  "window.focused": "drop",
  "workspace.activated": "retain",
  "workspace.closed": "retain",
  "workspace.entries-changed": "drop",
  "workspace.error": "retain",
  "workspace.error-cleared": "drop",
  "workspace.move.failed": "retain",
  "workspace.move.provider-succeeded": "retain",
  "workspace.move.started": "retain",
  "workspace.move-reference-update.completed": "retain",
  "workspace.move-reference-update.document-failed": "retain",
  "workspace.move-reference-update.started": "retain",
} satisfies Record<string, ActivityRetentionPolicy>);

/** Creates a zeroed metric bucket for one UTC-aligned hour. @param hourStart Start timestamp of the hour. @returns Empty hourly metrics. */
export function createHourlyMetrics(hourStart: number): HourlyActivityMetrics {
  return {
    hourStart,
    apiSuccessCount: 0,
    apiDurationMs: 0,
    tokenSuccessCount: 0,
    tokenDurationMs: 0,
    driveReadCount: 0,
    driveReadDurationMs: 0,
    driveReadBytes: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    reconciliationCount: 0,
    reconciliationDurationMs: 0,
  };
}

/** Reads a finite numeric event detail with a zero fallback. @param details Scalar activity metadata. @param key Detail key. @returns Finite numeric value. */
function numericDetail(details: ActivityDetails, key: string): number {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Determines whether a successful operation exceeded its individual retention threshold. @param event Stable activity name. @param details Scalar event metadata. @returns Whether this successful event is unusually slow. */
function isSlowSuccess(event: string, details: ActivityDetails): boolean {
  const durationMs = numericDetail(details, "durationMs");
  if (event === "api.request.succeeded" || event === "sync.token-request.succeeded" || event === "sync.drive-request.succeeded") {
    return durationMs >= NETWORK_SLOW_MS;
  }
  return (event === "sync.reconciliation.succeeded" || event === "sync.document-reconciliation.succeeded")
    && durationMs >= RECONCILIATION_SLOW_MS;
}

/**
 * Classifies one event using severity, the exact registry, and bounded dynamic sync families.
 * Unknown names are retained so missing registry entries never silently remove diagnostics.
 * @param event Stable dotted event name.
 * @param details Scalar event metadata.
 * @param level Event severity.
 * @returns Retention treatment for the event.
 */
export function classifyActivity(event: string, details: ActivityDetails, level: ActivityLevel): ActivityRetentionPolicy {
  if (level === "error" || level === "warning") return "retain";
  if (isSlowSuccess(event, details)) return "retain";
  if (event === "sync.drive-request.started") return details.requestKind === "mutation" ? "retain" : "drop";
  if (event === "sync.drive-request.succeeded") return details.requestKind === "mutation" ? "retain" : "aggregate";
  const registered = ACTIVITY_EVENT_POLICIES[event as keyof typeof ACTIVITY_EVENT_POLICIES];
  if (registered) return registered;
  return "retain";
}

/**
 * Adds one aggregate event to an hourly metric bucket.
 * @param metrics Current immutable-style hour bucket.
 * @param event Aggregated activity name.
 * @param details Scalar event metadata.
 * @returns Updated hour bucket.
 */
export function aggregateHourlyActivity(metrics: HourlyActivityMetrics, event: string, details: ActivityDetails): HourlyActivityMetrics {
  const next = { ...metrics };
  const durationMs = numericDetail(details, "durationMs");
  if (event === "api.request.succeeded") {
    next.apiSuccessCount += 1;
    next.apiDurationMs += durationMs;
  } else if (event === "sync.token-request.succeeded") {
    next.tokenSuccessCount += 1;
    next.tokenDurationMs += durationMs;
  } else if (event === "sync.drive-request.succeeded") {
    next.driveReadCount += 1;
    next.driveReadDurationMs += durationMs;
    next.driveReadBytes += numericDetail(details, "responseBytes");
  } else if (event.endsWith("cache.hit")) {
    next.cacheHitCount += 1;
  } else if (event.endsWith("cache.miss")) {
    next.cacheMissCount += 1;
  } else if (event === "sync.reconciliation.succeeded" || event === "sync.document-reconciliation.succeeded") {
    next.reconciliationCount += 1;
    next.reconciliationDurationMs += durationMs;
  }
  return next;
}
