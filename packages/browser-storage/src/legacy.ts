import type { DocumentFormat, WorkspaceRevision } from "@note/workspace-core";

const DATABASE_NAME = "notemarkdown-local-first";
const DATABASE_VERSION = 5;
const MAX_HISTORY_ENTRIES = 120;

export interface DurableDraft {
  workspaceId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  baseRevision: WorkspaceRevision;
  cursor: number;
  updatedAt: number;
}

export interface HistoryEntry extends DurableDraft {
  id: string;
  reason: "autosave" | "provider-save" | "external-change" | "restore";
}

export interface SessionDocument {
  path: string;
  cursor: number;
  viewMode: "editor" | "preview";
}

export interface WorkspaceSession {
  workspaceId: string;
  activePath: string | null;
  selectedPath: string | null;
  tabs: SessionDocument[];
  sidebarWidth: number;
  updatedAt: number;
}

export interface StoredWorkspace {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpenedAt: number;
}

/**
 * Opens the versioned browser database and applies forward-only migrations.
 * @returns The ready IndexedDB database.
 */
export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("workspaces")) database.createObjectStore("workspaces", { keyPath: "id" });
      if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: ["workspaceId", "path"] });
      if (!database.objectStoreNames.contains("history")) {
        const history = database.createObjectStore("history", { keyPath: "id" });
        history.createIndex("by-document", ["workspaceId", "path", "updatedAt"]);
      }
      if (!database.objectStoreNames.contains("sessions")) database.createObjectStore("sessions", { keyPath: "workspaceId" });
      if (!database.objectStoreNames.contains("searchDocuments")) database.createObjectStore("searchDocuments", { keyPath: ["workspaceId", "path"] });
      if (!database.objectStoreNames.contains("driveKeys")) database.createObjectStore("driveKeys", { keyPath: "connectedAccountId" });
      if (!database.objectStoreNames.contains("driveMirror")) database.createObjectStore("driveMirror", { keyPath: ["workspaceId", "path"] });
      if (!database.objectStoreNames.contains("repositoryWorkspaces")) database.createObjectStore("repositoryWorkspaces", { keyPath: "id" });
      if (!database.objectStoreNames.contains("workspaceManifests")) database.createObjectStore("workspaceManifests", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("cachedDocuments")) database.createObjectStore("cachedDocuments", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("repositoryDrafts")) database.createObjectStore("repositoryDrafts", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("pendingWrites")) database.createObjectStore("pendingWrites", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("pendingWorkspaceMutations")) database.createObjectStore("pendingWorkspaceMutations", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("conflicts")) database.createObjectStore("conflicts", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("repositoryHistory")) database.createObjectStore("repositoryHistory", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("recoveryItems")) database.createObjectStore("recoveryItems", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("repositorySessions")) database.createObjectStore("repositorySessions", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("workspaceSyncStates")) database.createObjectStore("workspaceSyncStates", { keyPath: ["workspaceId", "recordKey"] });
      if (!database.objectStoreNames.contains("migrationStates")) database.createObjectStore("migrationStates", { keyPath: "workspaceId" });
      if (!database.objectStoreNames.contains("quarantine")) database.createObjectStore("quarantine", { keyPath: "id" });
      if (!database.objectStoreNames.contains("coordinationLeases")) database.createObjectStore("coordinationLeases", { keyPath: "resource" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage could not be opened."));
    request.onblocked = () => reject(new Error("Browser storage migration is blocked by another tab."));
  });
}

/**
 * Resolves an IndexedDB request as a promise.
 * @param request Browser database request.
 * @returns The request result.
 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage operation failed."));
  });
}

/**
 * Runs a callback in one browser database transaction.
 * @param stores Object stores included in the transaction.
 * @param mode Read or write transaction mode.
 * @param operation Work performed before transaction completion.
 * @returns The callback result after the transaction commits.
 */
async function transact<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(stores, mode);
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage transaction was aborted."));
  });
  try {
    const result = await operation(transaction);
    await completed;
    return result;
  } finally {
    database.close();
  }
}

/**
 * Persists a workspace handle for Brave/Chromium session reopening.
 * @param workspace Workspace identity and structured-cloneable directory handle.
 * @returns Nothing after commit.
 */
export async function saveWorkspace(workspace: StoredWorkspace): Promise<void> {
  await transact("workspaces", "readwrite", (transaction) => {
    transaction.objectStore("workspaces").put(workspace);
  });
}

/**
 * Loads the most recently used workspace reference.
 * @returns The last workspace or null when none exists.
 */
export async function loadLastWorkspace(): Promise<StoredWorkspace | null> {
  return transact("workspaces", "readonly", async (transaction) => {
    const all = await requestResult(transaction.objectStore("workspaces").getAll()) as StoredWorkspace[];
    return all.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)[0] ?? null;
  });
}

/**
 * Persists the latest editor buffer before provider I/O.
 * @param draft Durable document buffer.
 * @returns Nothing after commit.
 */
export async function saveDraft(draft: DurableDraft): Promise<void> {
  await transact("drafts", "readwrite", (transaction) => {
    transaction.objectStore("drafts").put(draft);
  });
}

/**
 * Loads a locally durable document buffer.
 * @param workspaceId Stable workspace identity.
 * @param path Workspace-relative document path.
 * @returns The retained draft or null.
 */
export async function loadDraft(workspaceId: string, path: string): Promise<DurableDraft | null> {
  return transact("drafts", "readonly", async (transaction) => {
    return await requestResult(transaction.objectStore("drafts").get([workspaceId, path])) as DurableDraft | undefined ?? null;
  });
}

/**
 * Removes a draft after provider durability is confirmed and content still matches.
 * @param workspaceId Stable workspace identity.
 * @param path Workspace-relative document path.
 * @returns Nothing after commit.
 */
export async function deleteDraft(workspaceId: string, path: string): Promise<void> {
  await transact("drafts", "readwrite", (transaction) => transaction.objectStore("drafts").delete([workspaceId, path]));
}

/**
 * Saves one bounded recovery snapshot and deterministically thins old history.
 * @param entry History snapshot to retain.
 * @returns Nothing after retention cleanup.
 */
export async function saveHistory(entry: HistoryEntry): Promise<void> {
  await transact("history", "readwrite", async (transaction) => {
    const store = transaction.objectStore("history");
    store.put(entry);
    const range = IDBKeyRange.bound([entry.workspaceId, entry.path, 0], [entry.workspaceId, entry.path, Number.MAX_SAFE_INTEGER]);
    const records = await requestResult(store.index("by-document").getAll(range)) as HistoryEntry[];
    const newest = records.sort((left, right) => right.updatedAt - left.updatedAt);
    const retainedBuckets = new Set<string>();
    const retained = new Set(newest.slice(0, 30).map((record) => record.id));
    for (const record of newest.slice(30)) {
      const age = Date.now() - record.updatedAt;
      const bucket = age < 7 * 86_400_000
        ? `hour:${Math.floor(record.updatedAt / 3_600_000)}`
        : `day:${Math.floor(record.updatedAt / 86_400_000)}`;
      if (!retainedBuckets.has(bucket) && retained.size < MAX_HISTORY_ENTRIES) {
        retainedBuckets.add(bucket);
        retained.add(record.id);
      }
    }
    for (const record of newest) if (!retained.has(record.id)) store.delete(record.id);
  });
}

/**
 * Lists newest-first recovery snapshots for one document.
 * @param workspaceId Stable workspace identity.
 * @param path Workspace-relative document path.
 * @returns Bounded version history.
 */
export async function loadHistory(workspaceId: string, path: string): Promise<HistoryEntry[]> {
  return transact("history", "readonly", async (transaction) => {
    const range = IDBKeyRange.bound([workspaceId, path, 0], [workspaceId, path, Number.MAX_SAFE_INTEGER]);
    const records = await requestResult(transaction.objectStore("history").index("by-document").getAll(range)) as HistoryEntry[];
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  });
}

/**
 * Persists workspace-scoped tabs and layout state.
 * @param session Session snapshot.
 * @returns Nothing after commit.
 */
export async function saveSession(session: WorkspaceSession): Promise<void> {
  await transact("sessions", "readwrite", (transaction) => transaction.objectStore("sessions").put(session));
}

/**
 * Loads workspace-scoped tabs and layout state.
 * @param workspaceId Stable workspace identity.
 * @returns Prior session or null.
 */
export async function loadSession(workspaceId: string): Promise<WorkspaceSession | null> {
  return transact("sessions", "readonly", async (transaction) => {
    return await requestResult(transaction.objectStore("sessions").get(workspaceId)) as WorkspaceSession | undefined ?? null;
  });
}

/**
 * Stores local search source data so a warm index can be rebuilt offline.
 * @param workspaceId Stable workspace identity.
 * @param path Document path.
 * @param content Markdown content.
 * @returns Nothing after commit.
 */
export async function saveSearchDocument(workspaceId: string, path: string, content: string): Promise<void> {
  await transact("searchDocuments", "readwrite", (transaction) => {
    transaction.objectStore("searchDocuments").put({ workspaceId, path, content, updatedAt: Date.now() });
  });
}

/**
 * Loads all persisted search sources for a workspace.
 * @param workspaceId Stable workspace identity.
 * @returns Cached document paths and contents.
 */
export async function loadSearchDocuments(workspaceId: string): Promise<Array<{ path: string; content: string }>> {
  return transact("searchDocuments", "readonly", async (transaction) => {
    const all = await requestResult(transaction.objectStore("searchDocuments").getAll()) as Array<{ workspaceId: string; path: string; content: string }>;
    return all.filter((record) => record.workspaceId === workspaceId).map(({ path, content }) => ({ path, content }));
  });
}

/**
 * Reports browser-local durability capabilities without treating storage as a workspace provider.
 * @returns IndexedDB and OPFS availability flags.
 */
export function storageCapabilities(): { indexedDb: boolean; opfs: boolean } {
  return { indexedDb: "indexedDB" in window, opfs: typeof navigator.storage?.getDirectory === "function" };
}
