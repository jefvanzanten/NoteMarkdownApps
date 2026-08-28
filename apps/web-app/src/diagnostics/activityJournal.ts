import {
  aggregateHourlyActivity,
  classifyActivity,
  createHourlyMetrics,
  type HourlyActivityMetrics,
} from "./activityPolicy";

export type ActivityCategory = "application" | "api" | "document" | "storage" | "sync" | "workspace";
export type ActivityLevel = "debug" | "info" | "warning" | "error";
export type ActivityDetails = Record<string, boolean | number | string | null | undefined>;

export interface ActivityEvent {
  id: string;
  sequence: number;
  timestamp: number;
  sessionId: string;
  tabId: string;
  category: ActivityCategory;
  level: ActivityLevel;
  event: string;
  correlationId?: string;
  details: Record<string, boolean | number | string | null>;
}

interface ActivityJournalOptions {
  enabled: boolean;
  buildMode: string;
}

interface PersistedHourlyMetrics extends HourlyActivityMetrics {
  id: string;
  tabId: string;
}

interface MetricChannelMessage {
  type: "metric";
  timestamp: number;
  event: string;
  details: ActivityDetails;
  tabId: string;
}

type ActivityChannelMessage = ActivityEvent | MetricChannelMessage;
type TruncationReason = "age" | "count" | "size";

/** Identifies an aggregate metric broadcast. @param message Cross-tab activity message. @returns Whether the message carries a metric increment. */
function isMetricChannelMessage(message: ActivityChannelMessage): message is MetricChannelMessage {
  return "type" in message && message.type === "metric";
}

const DATABASE_NAME = "notemarkdown-activity-journal";
const DATABASE_VERSION = 2;
const EVENT_STORE = "events";
const HOURLY_STORE = "hourlyMetrics";
const MAX_RECENT_EVENTS = 400;
const MAX_PROTECTED_EVENTS = 100;
const MAX_PERSISTED_EVENTS = MAX_RECENT_EVENTS + MAX_PROTECTED_EVENTS;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_HOURLY_BUCKETS = 24;
const MAX_DETAIL_STRING_LENGTH = 2_000;
const MAX_EXPORT_BYTES = 512 * 1_024;
const ACTIVITY_CHANNEL = "notemarkdown:activity-journal:v2";
const EMPTY_EVENTS: readonly ActivityEvent[] = Object.freeze([]);
const EMPTY_METRICS: readonly HourlyActivityMetrics[] = Object.freeze([]);
let options: ActivityJournalOptions = { enabled: false, buildMode: "unknown" };
let sequence = 0;
let events: readonly ActivityEvent[] = EMPTY_EVENTS;
let hourlyMetrics: readonly HourlyActivityMetrics[] = EMPTY_METRICS;
let databasePromise: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
let retentionTimer: number | null = null;
const localHourlyMetrics = new Map<number, PersistedHourlyMetrics>();
const truncationReasons = new Set<TruncationReason>();
const listeners = new Set<() => void>();

/** Reads or creates one browser-tab identifier without exposing provider identity. @returns Stable identifier for the lifetime of the browser tab. */
function tabIdentifier(): string {
  try {
    const existing = sessionStorage.getItem("notemarkdown:activity-tab-id");
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem("notemarkdown:activity-tab-id", created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const tabId = tabIdentifier();
const sessionId = crypto.randomUUID();

/** Opens the isolated diagnostic database and resets version-one diagnostics during upgrade. @returns Open IndexedDB database. */
function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      if (database.objectStoreNames.contains(EVENT_STORE)) transaction?.objectStore(EVENT_STORE).clear();
      else {
        const store = database.createObjectStore(EVENT_STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      }
      if (!database.objectStoreNames.contains(HOURLY_STORE)) {
        const store = database.createObjectStore(HOURLY_STORE, { keyPath: "id" });
        store.createIndex("hourStart", "hourStart");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The activity journal database could not be opened."));
  });
  return databasePromise;
}

/** Orders journal events deterministically, including events created in the same millisecond. @param left First event. @param right Second event. @returns Sort order. */
function compareEvents(left: ActivityEvent, right: ActivityEvent): number {
  return left.timestamp - right.timestamp || (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id);
}

/** Returns the UTC-aligned start timestamp for an activity hour. @param timestamp Epoch timestamp. @returns Hour start epoch timestamp. */
function hourStart(timestamp: number): number {
  const hourMs = 60 * 60 * 1_000;
  return Math.floor(timestamp / hourMs) * hourMs;
}

/** Returns whether an event receives protected warning/error retention. @param event Activity event. @returns Whether severity is warning or error. */
function isProtectedEvent(event: ActivityEvent): boolean {
  return event.level === "warning" || event.level === "error";
}

/** Applies the rolling age, recent-event, and protected-event retention policy. @param source Oldest-first or unordered events. @param now Current epoch timestamp. @returns Oldest-first retained events. */
function retainEvents(source: readonly ActivityEvent[], now = Date.now()): ActivityEvent[] {
  const cutoff = now - MAX_EVENT_AGE_MS;
  const sorted = [...source].sort(compareEvents);
  const ageEligible = sorted.filter((event) => event.timestamp >= cutoff);
  if (ageEligible.length < sorted.length) truncationReasons.add("age");
  if (ageEligible.length <= MAX_RECENT_EVENTS) return ageEligible;
  const recent = ageEligible.slice(-MAX_RECENT_EVENTS);
  const olderProtected = ageEligible.slice(0, -MAX_RECENT_EVENTS).filter(isProtectedEvent).slice(-MAX_PROTECTED_EVENTS);
  if (olderProtected.length + recent.length < ageEligible.length) truncationReasons.add("count");
  return [...olderProtected, ...recent].sort(compareEvents);
}

/** Publishes a new immutable activity snapshot to UI subscribers. @param nextEvents Candidate event list. @returns Nothing after listeners run. */
function publishEvents(nextEvents: readonly ActivityEvent[]): void {
  events = Object.freeze(retainEvents(nextEvents));
  for (const listener of listeners) listener();
}

/** Publishes bounded immutable hourly metrics to UI subscribers. @param nextMetrics Candidate metrics. @returns Nothing after listeners run. */
function publishHourlyMetrics(nextMetrics: readonly HourlyActivityMetrics[]): void {
  hourlyMetrics = Object.freeze([...nextMetrics].sort((left, right) => left.hourStart - right.hourStart).slice(-MAX_HOURLY_BUCKETS));
  for (const listener of listeners) listener();
}

/** Limits diagnostic strings so one malformed metadata field cannot dominate an export. @param value Original scalar value. @returns Bounded JSON-safe scalar value. */
function sanitizeDetailValue(value: boolean | number | string | null): boolean | number | string | null {
  return typeof value === "string" ? value.slice(0, MAX_DETAIL_STRING_LENGTH) : value;
}

/** Removes undefined detail properties and bounds strings. @param details Optional caller details. @returns Sanitized scalar detail map. */
function sanitizeDetails(details: ActivityDetails = {}): ActivityEvent["details"] {
  return Object.fromEntries(Object.entries(details)
    .filter((entry): entry is [string, boolean | number | string | null] => entry[1] !== undefined)
    .map(([key, value]) => [key.slice(0, 100), sanitizeDetailValue(value)]));
}

/** Loads all records from one IndexedDB store. @param database Open journal database. @param storeName Store to read. @returns Stored records. */
async function loadStoreRecords<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/** Replaces stored events with the retained rolling snapshot when pruning is needed. @param database Open journal database. @returns Retained persisted events. */
async function trimPersistedEvents(database: IDBDatabase): Promise<ActivityEvent[]> {
  const stored = await loadStoreRecords<ActivityEvent>(database, EVENT_STORE);
  const retained = retainEvents(stored);
  const retainedIds = new Set(retained.map((event) => event.id));
  const removed = stored.filter((event) => !retainedIds.has(event.id));
  if (removed.length === 0) return retained;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    for (const event of removed) store.delete(event.id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return retained;
}

/** Persists one event and immediately enforces bounded retention. @param activity Complete local activity event. @returns Nothing after the best-effort transaction. */
async function persistEvent(activity: ActivityEvent): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(EVENT_STORE, "readwrite");
      transaction.objectStore(EVENT_STORE).put(activity);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    await trimPersistedEvents(database);
  } catch {
    // Diagnostics must never interrupt application work or recursively log storage failure.
  }
}

/** Merges tab-scoped metric records into at most 24 hourly buckets. @param records Persisted tab/hour records. @returns Combined oldest-first metrics. */
function mergeHourlyRecords(records: readonly PersistedHourlyMetrics[]): HourlyActivityMetrics[] {
  const minimumHour = hourStart(Date.now()) - (MAX_HOURLY_BUCKETS - 1) * 60 * 60 * 1_000;
  const merged = new Map<number, HourlyActivityMetrics>();
  for (const record of records.filter((metric) => metric.hourStart >= minimumHour)) {
    const current = merged.get(record.hourStart) ?? createHourlyMetrics(record.hourStart);
    for (const key of Object.keys(current) as Array<keyof HourlyActivityMetrics>) {
      if (key !== "hourStart") current[key] += record[key];
    }
    merged.set(record.hourStart, current);
  }
  return [...merged.values()].sort((left, right) => left.hourStart - right.hourStart).slice(-MAX_HOURLY_BUCKETS);
}

/** Persists one tab-scoped hourly metric record and removes expired hour records. @param record Updated local record. @returns Nothing after best-effort persistence. */
async function persistHourlyMetrics(record: PersistedHourlyMetrics): Promise<void> {
  try {
    const database = await openDatabase();
    const minimumHour = hourStart(Date.now()) - (MAX_HOURLY_BUCKETS - 1) * 60 * 60 * 1_000;
    const stored = await loadStoreRecords<PersistedHourlyMetrics>(database, HOURLY_STORE);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HOURLY_STORE, "readwrite");
      const store = transaction.objectStore(HOURLY_STORE);
      store.put(record);
      for (const expired of stored.filter((metric) => metric.hourStart < minimumHour)) store.delete(expired.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Aggregate diagnostics remain available in memory when IndexedDB is unavailable.
  }
}

/** Applies one aggregate metric event locally and optionally persists and broadcasts it. @param event Aggregated activity name. @param details Sanitized scalar metadata. @param timestamp Event timestamp. @param publishToPeers Whether to persist and broadcast this tab's increment. @returns Nothing after snapshots update. */
function recordHourlyActivity(event: string, details: ActivityDetails, timestamp: number, publishToPeers: boolean): void {
  const bucketStart = hourStart(timestamp);
  const currentCombined = hourlyMetrics.find((metric) => metric.hourStart === bucketStart) ?? createHourlyMetrics(bucketStart);
  const updatedCombined = aggregateHourlyActivity(currentCombined, event, details);
  publishHourlyMetrics([...hourlyMetrics.filter((metric) => metric.hourStart !== bucketStart), updatedCombined]);
  if (!publishToPeers) return;
  const local = localHourlyMetrics.get(bucketStart) ?? { ...createHourlyMetrics(bucketStart), id: `${bucketStart}:${tabId}`, tabId };
  const updatedLocal = { ...aggregateHourlyActivity(local, event, details), id: local.id, tabId };
  localHourlyMetrics.set(bucketStart, updatedLocal);
  channel?.postMessage({ type: "metric", event, details, timestamp, tabId } satisfies MetricChannelMessage);
  if (typeof indexedDB !== "undefined") void persistHourlyMetrics(updatedLocal);
}

/** Loads retained events and metrics into live snapshots. @returns Nothing after initialization. */
async function loadPersistedDiagnostics(): Promise<void> {
  try {
    const database = await openDatabase();
    const [loadedEvents, metricRecords] = await Promise.all([
      trimPersistedEvents(database),
      loadStoreRecords<PersistedHourlyMetrics>(database, HOURLY_STORE),
    ]);
    sequence = Math.max(sequence, ...loadedEvents.map((event) => event.sequence ?? 0));
    for (const record of metricRecords.filter((metric) => metric.tabId === tabId)) localHourlyMetrics.set(record.hourStart, record);
    const currentIds = new Set(events.map((event) => event.id));
    publishEvents([...loadedEvents.filter((event) => !currentIds.has(event.id)), ...events]);
    publishHourlyMetrics(mergeHourlyRecords(metricRecords));
  } catch {
    // The journal remains available in memory when IndexedDB is unavailable.
  }
}

/** Applies time-based retention to live and persisted diagnostics. @returns Nothing after best-effort pruning. */
function pruneExpiredDiagnostics(): void {
  publishEvents(events);
  publishHourlyMetrics(hourlyMetrics.filter((metric) => metric.hourStart >= hourStart(Date.now()) - (MAX_HOURLY_BUCKETS - 1) * 60 * 60 * 1_000));
  if (typeof indexedDB === "undefined") return;
  void openDatabase().then(trimPersistedEvents).catch(() => {
    // Scheduled diagnostic retention must never interrupt application work.
  });
}

/** Configures continuous recording and initializes local diagnostics. @param nextOptions Feature flag and build label. @returns Nothing after initialization starts. */
export function configureActivityJournal(nextOptions: ActivityJournalOptions): void {
  options = nextOptions;
  if (!options.enabled) {
    if (retentionTimer !== null && typeof window !== "undefined") window.clearInterval(retentionTimer);
    retentionTimer = null;
    return;
  }
  if (typeof indexedDB === "undefined") return;
  if (typeof BroadcastChannel !== "undefined" && !channel) {
    channel = new BroadcastChannel(ACTIVITY_CHANNEL);
    channel.addEventListener("message", (message: MessageEvent<ActivityChannelMessage>) => {
      const activity = message.data;
      if (!activity || activity.tabId === tabId) return;
      if (isMetricChannelMessage(activity)) {
        recordHourlyActivity(activity.event, activity.details, activity.timestamp, false);
        return;
      }
      if (events.some((event) => event.id === activity.id)) return;
      sequence = Math.max(sequence, activity.sequence ?? 0);
      publishEvents([...events, activity]);
    });
  }
  if (typeof window !== "undefined" && retentionTimer === null) retentionTimer = window.setInterval(pruneExpiredDiagnostics, 60 * 60 * 1_000);
  void loadPersistedDiagnostics();
  recordActivity("application", "application.started", { buildMode: options.buildMode, online: navigator.onLine });
}

/** Appends one approved event to live and persistent storage. @param category Stable subsystem category. @param event Stable dotted event name. @param details Sanitized scalar metadata. @param level Event severity. @param correlationId Optional operation identifier. @returns Created immutable event. */
function appendActivity(category: ActivityCategory, event: string, details: ActivityDetails, level: ActivityLevel, correlationId?: string): ActivityEvent {
  const activity: ActivityEvent = {
    id: crypto.randomUUID(),
    sequence: sequence += 1,
    timestamp: Date.now(),
    sessionId,
    tabId,
    category,
    level,
    event: event.slice(0, 200),
    correlationId: correlationId?.slice(0, 200),
    details: sanitizeDetails(details),
  };
  publishEvents([...events, activity]);
  channel?.postMessage(activity);
  if (typeof indexedDB !== "undefined") void persistEvent(activity);
  return activity;
}

/** Records one content-free or explicitly local diagnostic event. @param category Stable subsystem category. @param event Stable dotted event name. @param details Scalar metadata; callers must never provide note content or credentials. @param level Event severity. @param correlationId Optional operation correlation identifier. @returns Created event, or null when disabled, dropped, or aggregated. */
export function recordActivity(category: ActivityCategory, event: string, details: ActivityDetails = {}, level: ActivityLevel = "info", correlationId?: string): ActivityEvent | null {
  if (!options.enabled) return null;
  const sanitized = sanitizeDetails(details);
  const policy = classifyActivity(event, sanitized, level);
  if (policy === "drop") return null;
  if (policy === "aggregate") {
    recordHourlyActivity(event, sanitized, Date.now(), true);
    return null;
  }
  return appendActivity(category, event, sanitized, level, correlationId);
}

/** Returns the stable event snapshot used by React. @returns Oldest-first retained activity events. */
export function getActivitySnapshot(): readonly ActivityEvent[] {
  return events;
}

/** Returns the stable hourly metric snapshot used by React. @returns Oldest-first metric buckets. */
export function getHourlyMetricsSnapshot(): readonly HourlyActivityMetrics[] {
  return hourlyMetrics;
}

/** Returns empty server-rendering events. @returns Empty immutable event list. */
export function getActivityServerSnapshot(): readonly ActivityEvent[] {
  return EMPTY_EVENTS;
}

/** Returns empty server-rendering metrics. @returns Empty immutable metric list. */
export function getHourlyMetricsServerSnapshot(): readonly HourlyActivityMetrics[] {
  return EMPTY_METRICS;
}

/** Subscribes a viewer to journal changes. @param listener Snapshot invalidation callback. @returns Unsubscribe callback. */
export function subscribeActivityJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clears persisted events, hourly metrics, and live diagnostics. @returns Nothing after the local database transaction completes. */
export async function clearActivityJournal(): Promise<void> {
  localHourlyMetrics.clear();
  truncationReasons.clear();
  publishEvents(EMPTY_EVENTS);
  publishHourlyMetrics(EMPTY_METRICS);
  if (typeof indexedDB === "undefined") return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([EVENT_STORE, HOURLY_STORE], "readwrite");
      transaction.objectStore(EVENT_STORE).clear();
      transaction.objectStore(HOURLY_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Clearing in-memory diagnostics remains useful when persistence is unavailable.
  }
}

/** Loads the complete retained persistent journal for export. @returns Oldest-first retained events. */
async function loadExportEvents(): Promise<ActivityEvent[]> {
  if (!options.enabled || typeof indexedDB === "undefined") return [...events];
  try {
    const database = await openDatabase();
    const persisted = await trimPersistedEvents(database);
    const persistedIds = new Set(persisted.map((event) => event.id));
    return retainEvents([...persisted, ...events.filter((event) => !persistedIds.has(event.id))]);
  } catch {
    return [...events];
  }
}

/** Loads and combines retained persisted hour buckets for export. @returns Oldest-first hourly metrics. */
async function loadExportMetrics(): Promise<HourlyActivityMetrics[]> {
  if (!options.enabled || typeof indexedDB === "undefined") return [...hourlyMetrics];
  try {
    const database = await openDatabase();
    return mergeHourlyRecords(await loadStoreRecords<PersistedHourlyMetrics>(database, HOURLY_STORE));
  } catch {
    return [...hourlyMetrics];
  }
}

/** Creates one serializable export bundle. @param exportEvents Retained event list. @param metrics Hourly aggregate metrics. @param reasons Active truncation reasons. @returns Diagnostic export object. */
function createExportBundle(exportEvents: ActivityEvent[], metrics: HourlyActivityMetrics[], reasons: Set<TruncationReason>): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    buildMode: options.buildMode,
    browser: navigator.userAgent.slice(0, MAX_DETAIL_STRING_LENGTH),
    online: navigator.onLine,
    recording: options.enabled,
    retention: { maxAgeHours: 24, maxEvents: MAX_PERSISTED_EVENTS, maxExportBytes: MAX_EXPORT_BYTES },
    eventCount: exportEvents.length,
    rangeStart: exportEvents[0] ? new Date(exportEvents[0].timestamp).toISOString() : null,
    rangeEnd: exportEvents.at(-1) ? new Date(exportEvents.at(-1)!.timestamp).toISOString() : null,
    truncated: reasons.size > 0,
    truncatedReasons: [...reasons],
    hourlyMetrics: metrics,
    events: exportEvents,
  };
}

/** Returns the formatted byte size of one export bundle. @param bundle Serializable export object. @returns UTF-8 byte count. */
function exportByteLength(bundle: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(bundle, null, 2)).byteLength;
}

/** Builds a shareable bounded JSON diagnostic bundle without note content or credentials. @returns Formatted diagnostic JSON. */
export async function exportActivityJournal(): Promise<string> {
  const exportEvents = await loadExportEvents();
  const metrics = await loadExportMetrics();
  const reasons = new Set(truncationReasons);
  if (exportEvents.length >= MAX_PERSISTED_EVENTS) reasons.add("count");
  let bundle = createExportBundle(exportEvents, metrics, reasons);
  while (exportEvents.length > 0 && exportByteLength(bundle) > MAX_EXPORT_BYTES) {
    reasons.add("size");
    const normalIndex = exportEvents.findIndex((event) => !isProtectedEvent(event));
    exportEvents.splice(normalIndex >= 0 ? normalIndex : 0, 1);
    bundle = createExportBundle(exportEvents, metrics, reasons);
  }
  return JSON.stringify(bundle, null, 2);
}

/** Installs browser lifecycle and global failure activity capture once. @returns Cleanup callback for tests or an embedding host. */
export function installActivityJournalHandlers(): () => void {
  const recordOnline = (): void => { recordActivity("application", navigator.onLine ? "network.online" : "network.offline"); };
  const recordFocus = (): void => { recordActivity("application", "window.focused", {}, "debug"); };
  const recordBlur = (): void => { recordActivity("application", "window.blurred", {}, "debug"); };
  const recordVisibility = (): void => { recordActivity("application", "document.visibility-changed", { visibility: document.visibilityState }, "debug"); };
  const recordError = (event: ErrorEvent): void => { recordActivity("application", "error.unhandled", { name: event.error instanceof Error ? event.error.name : "Error" }, "error"); };
  const recordRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    recordActivity("application", "promise.unhandled-rejection", { name: reason instanceof Error ? reason.name : typeof reason }, "error");
  };
  window.addEventListener("online", recordOnline);
  window.addEventListener("offline", recordOnline);
  window.addEventListener("focus", recordFocus);
  window.addEventListener("blur", recordBlur);
  window.addEventListener("error", recordError);
  window.addEventListener("unhandledrejection", recordRejection);
  document.addEventListener("visibilitychange", recordVisibility);
  return () => {
    window.removeEventListener("online", recordOnline);
    window.removeEventListener("offline", recordOnline);
    window.removeEventListener("focus", recordFocus);
    window.removeEventListener("blur", recordBlur);
    window.removeEventListener("error", recordError);
    window.removeEventListener("unhandledrejection", recordRejection);
    document.removeEventListener("visibilitychange", recordVisibility);
  };
}
