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

const DATABASE_NAME = "notemarkdown-activity-journal";
const DATABASE_VERSION = 1;
const EVENT_STORE = "events";
const MAX_PERSISTED_EVENTS = 10_000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_VISIBLE_EVENTS = 1_000;
const ACTIVITY_CHANNEL = "notemarkdown:activity-journal:v1";
const EMPTY_EVENTS: readonly ActivityEvent[] = Object.freeze([]);
let options: ActivityJournalOptions = { enabled: false, buildMode: "unknown" };
let recording = false;
let sequence = 0;
let events: readonly ActivityEvent[] = EMPTY_EVENTS;
let databasePromise: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
let writeCount = 0;
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

/** Opens the isolated diagnostic database and creates its time index when needed. @returns Open IndexedDB database. */
function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(EVENT_STORE, { keyPath: "id" });
      store.createIndex("timestamp", "timestamp");
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

/** Publishes a new immutable activity snapshot to UI subscribers. @param nextEvents Oldest-first bounded event list. @returns Nothing after listeners run. */
function publish(nextEvents: readonly ActivityEvent[]): void {
  events = Object.freeze([...nextEvents].sort(compareEvents).slice(-MAX_VISIBLE_EVENTS));
  for (const listener of listeners) listener();
}

/** Removes undefined detail properties so persisted events remain JSON-safe. @param details Optional caller details. @returns Sanitized scalar detail map. */
function sanitizeDetails(details: ActivityDetails = {}): ActivityEvent["details"] {
  return Object.fromEntries(Object.entries(details).filter((entry): entry is [string, boolean | number | string | null] => entry[1] !== undefined));
}

/** Persists one event and periodically applies bounded retention. @param activity Complete local activity event. @returns Nothing after the best-effort transaction. */
async function persistEvent(activity: ActivityEvent): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(EVENT_STORE, "readwrite");
      transaction.objectStore(EVENT_STORE).put(activity);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    writeCount += 1;
    if (writeCount % 100 === 0) await trimPersistedEvents(database);
  } catch {
    // Diagnostics must never interrupt application work or recursively log their own storage failure.
  }
}

/** Deletes persisted events older than seven days or above the count bound. @param database Open journal database. @returns Nothing after retention completes. */
async function trimPersistedEvents(database: IDBDatabase): Promise<void> {
  const records = await new Promise<Array<{ key: IDBValidKey; timestamp: number }>>((resolve, reject) => {
    const result: Array<{ key: IDBValidKey; timestamp: number }> = [];
    const transaction = database.transaction(EVENT_STORE, "readonly");
    const request = transaction.objectStore(EVENT_STORE).index("timestamp").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(result);
        return;
      }
      result.push({ key: cursor.primaryKey, timestamp: Number(cursor.key) });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const cutoff = Date.now() - MAX_EVENT_AGE_MS;
  const retained = records.filter((record) => record.timestamp >= cutoff);
  const keysToDelete = new Set<IDBValidKey>(records.filter((record) => record.timestamp < cutoff).map((record) => record.key));
  for (const record of retained.slice(0, Math.max(0, retained.length - MAX_PERSISTED_EVENTS))) keysToDelete.add(record.key);
  if (keysToDelete.size === 0) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    for (const key of keysToDelete) store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Loads the newest persisted events into the live viewer. @returns Nothing after the external-store snapshot is initialized. */
async function loadPersistedEvents(): Promise<void> {
  try {
    const database = await openDatabase();
    await trimPersistedEvents(database);
    const loaded = await new Promise<ActivityEvent[]>((resolve, reject) => {
      const result: ActivityEvent[] = [];
      const transaction = database.transaction(EVENT_STORE, "readonly");
      const request = transaction.objectStore(EVENT_STORE).index("timestamp").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= MAX_VISIBLE_EVENTS) {
          resolve(result.reverse());
          return;
        }
        result.push(cursor.value as ActivityEvent);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    sequence = Math.max(sequence, ...loaded.map((event) => event.sequence ?? 0));
    const currentIds = new Set(events.map((event) => event.id));
    publish([...loaded.filter((event) => !currentIds.has(event.id)), ...events]);
  } catch {
    // The journal remains available in memory when IndexedDB is unavailable.
  }
}

/** Configures and initializes the local development activity journal. @param nextOptions Feature flag and build label. @returns Nothing after initialization starts. */
export function configureActivityJournal(nextOptions: ActivityJournalOptions): void {
  options = nextOptions;
  recording = options.enabled;
  if (!options.enabled || typeof indexedDB === "undefined") return;
  if (typeof BroadcastChannel !== "undefined" && !channel) {
    channel = new BroadcastChannel(ACTIVITY_CHANNEL);
    channel.addEventListener("message", (message: MessageEvent<ActivityEvent>) => {
      if (!message.data || message.data.tabId === tabId || events.some((event) => event.id === message.data.id)) return;
      sequence = Math.max(sequence, message.data.sequence ?? 0);
      publish([...events, message.data]);
    });
  }
  void loadPersistedEvents();
  recordActivity("application", "application.started", { buildMode: options.buildMode, online: navigator.onLine });
}

/** Records one content-free or explicitly local diagnostic event. @param category Stable subsystem category. @param event Stable dotted event name. @param details Scalar metadata; callers must never provide note content or credentials. @param level Event severity. @param correlationId Optional operation/request correlation identifier. @returns Created event, or null when recording is disabled. */
export function recordActivity(category: ActivityCategory, event: string, details: ActivityDetails = {}, level: ActivityLevel = "info", correlationId?: string): ActivityEvent | null {
  if (!recording) return null;
  const activity: ActivityEvent = {
    id: crypto.randomUUID(),
    sequence: sequence += 1,
    timestamp: Date.now(),
    sessionId,
    tabId,
    category,
    level,
    event,
    correlationId,
    details: sanitizeDetails(details),
  };
  publish([...events, activity]);
  channel?.postMessage(activity);
  if (typeof indexedDB !== "undefined") void persistEvent(activity);
  return activity;
}

/** Returns the stable external-store snapshot used by React. @returns Oldest-first recent activity events. */
export function getActivitySnapshot(): readonly ActivityEvent[] {
  return events;
}

/** Returns whether activity recording is available in this build. @returns Configured journal availability. */
export function isActivityJournalAvailable(): boolean {
  return options.enabled;
}

/** Returns whether local activity recording is currently active. @returns Current recording state. */
export function getActivityRecordingSnapshot(): boolean {
  return recording;
}

/** Starts or stops local recording while retaining already captured events. @param nextRecording Requested recording state. @returns Effective recording state. */
export function setActivityRecording(nextRecording: boolean): boolean {
  if (!options.enabled || recording === nextRecording) return recording;
  if (nextRecording) {
    recording = true;
    recordActivity("application", "activity-recording.started");
  } else {
    recordActivity("application", "activity-recording.stopped");
    recording = false;
  }
  publish(events);
  return recording;
}

/** Returns an empty server-rendering snapshot. @returns Empty immutable event list. */
export function getActivityServerSnapshot(): readonly ActivityEvent[] {
  return EMPTY_EVENTS;
}

/** Subscribes a viewer to journal changes. @param listener Snapshot invalidation callback. @returns Unsubscribe callback. */
export function subscribeActivityJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clears persisted and live activity history. @returns Nothing after the local database transaction completes. */
export async function clearActivityJournal(): Promise<void> {
  publish(EMPTY_EVENTS);
  if (!options.enabled || typeof indexedDB === "undefined") return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(EVENT_STORE, "readwrite");
      transaction.objectStore(EVENT_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Clearing the in-memory view remains useful when persistence is unavailable.
  }
}

/** Loads the retained persistent journal for export without changing the bounded live view. @returns Oldest-first retained events. */
async function loadExportEvents(): Promise<ActivityEvent[]> {
  if (!options.enabled || typeof indexedDB === "undefined") return [...events];
  try {
    const database = await openDatabase();
    await trimPersistedEvents(database);
    const persisted = await new Promise<ActivityEvent[]>((resolve, reject) => {
      const result: ActivityEvent[] = [];
      const transaction = database.transaction(EVENT_STORE, "readonly");
      const request = transaction.objectStore(EVENT_STORE).index("timestamp").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= MAX_PERSISTED_EVENTS) {
          resolve(result.reverse());
          return;
        }
        result.push(cursor.value as ActivityEvent);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    const persistedIds = new Set(persisted.map((event) => event.id));
    return [...persisted, ...events.filter((event) => !persistedIds.has(event.id))].sort(compareEvents).slice(-MAX_PERSISTED_EVENTS);
  } catch {
    return [...events];
  }
}

/** Builds a shareable JSON diagnostic bundle without note content or credentials. @returns Formatted diagnostic JSON with the complete retained event window. */
export async function exportActivityJournal(): Promise<string> {
  const exportEvents = await loadExportEvents();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    buildMode: options.buildMode,
    browser: navigator.userAgent,
    online: navigator.onLine,
    recording,
    eventCount: exportEvents.length,
    rangeStart: exportEvents[0] ? new Date(exportEvents[0].timestamp).toISOString() : null,
    rangeEnd: exportEvents.at(-1) ? new Date(exportEvents.at(-1)!.timestamp).toISOString() : null,
    truncated: exportEvents.length >= MAX_PERSISTED_EVENTS,
    events: exportEvents,
  }, null, 2);
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
