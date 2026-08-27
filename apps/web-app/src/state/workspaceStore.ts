import { create } from "zustand";
import {
  WorkspaceError,
  ensureMarkdownPath,
  resolveWorkspaceTarget,
  type DocumentFormat,
  type TrashResult,
  type WorkspaceEntry,
  type WorkspaceMetadataFingerprint,
  type WorkspaceProvider,
  type WorkspaceRevision,
} from "@note/workspace-core";
import { LocalWorkspaceProvider, openLocalWorkspace, reopenLocalWorkspace } from "@note/workspace-local";
import { DriveWorkspaceProvider, type DriveAccessTokenProvider } from "@note/workspace-drive";
import { CancelledWorkError, PriorityScheduler, retryDelay, type WorkPriority } from "@note/sync-core";
import type { DriveWorkspaceReference } from "@note/api-contracts";
import { ApiRequestError, getDriveAccessToken, invalidateDriveAccessToken } from "../account/apiClient";
import { recordActivity } from "../diagnostics/activityJournal";
import {
  acknowledgeIndexRevision,
  commitCachedDocument,
  commitDocumentAndAcknowledgeWrite,
  commitWorkspaceChangePage,
  cleanupRebuildableCache,
  createManifestEntries,
  deleteConflict,
  deleteDraft,
  deletePendingWrite,
  deleteRecoveryItem,
  deleteRepositoryDraft,
  loadCachedDocument,
  loadCachedDocuments,
  loadConflicts,
  loadDraft,
  loadHistory,
  loadLastRepositoryWorkspace,
  loadLastWorkspace,
  loadPendingWrites,
  loadRecoveryItems,
  loadRepositoryDraft,
  loadRepositoryHistory,
  loadRepositorySession,
  loadSearchDocuments,
  loadSession,
  loadWorkspaceManifest,
  loadWorkspaceSyncState,
  importLegacyDriveMirror,
  inspectStoragePressure,
  manifestToWorkspaceEntries,
  migrateLegacyWorkspace,
  moveRepositoryEntry,
  PENDING_WRITE_FORMAT_VERSION,
  registerRepositoryWorkspace,
  saveConflict,
  savePendingWrite,
  saveRecoveryItem,
  saveRepositoryDraft,
  saveRepositoryHistory,
  saveRepositorySession,
  saveWorkspace,
  saveWorkspaceManifest,
  updatePendingWrite,
  updatePendingWriteIfCurrent,
  type CachedDocument,
  type DocumentConflict,
  type HistoryEntry,
  type PendingDocumentWrite,
  type RecoveryItem,
  type RepositoryDraft,
  type RepositoryWorkspaceReference,
  type StoredWorkspace,
  type WorkspaceManifest,
} from "../storage/browserStorage";
import { indexSearchDocument, removeSearchDocument, replaceSearchDocuments } from "../search/searchClient";
import { acquireDocumentEditingLease, acquireWorkspaceLeadership, takeOverDocumentEditingLease, type EditingLeaseHandle, type LeadershipHandle } from "../sync/browserCoordination";
import { discoverDriveChanges, compareManifests, setInitialDriveCursor, withProviderRetry, type ProviderDiscoveryResult } from "../sync/driveChangeDiscovery";
import { pendingWriteResumeDecision } from "../sync/pendingWritePolicy";
import { documentFormatsMatch, processPendingWrite } from "../sync/pendingWriteProcessor";
import { KeyedSerialTaskQueue } from "../sync/keyedSerialTaskQueue";
import { threeWayMerge } from "../sync/threeWayMerge";
import { driveTokenFailure, providerWriteRetryDelay } from "../sync/providerFailurePolicy";
import {
  createDriveDiagnostics,
  recordSyncDiagnostic,
  recordWorkspaceMetric,
  reportSlowSyncOperation,
  reportSyncFailure,
  type SyncDiagnosticErrorCode,
} from "../sync/workspaceDiagnostics";

export type DocumentViewMode = "editor" | "preview";
export type DocumentSaveState = "checking" | "clean" | "dirty-local" | "dirty-durable" | "persisting-local" | "queued" | "conflicted" | "destroyed" | "error-blocking";

export interface OpenDocument {
  entryId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  revision: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  editingState: "owned" | "read-only";
  cursor: number;
  viewMode: DocumentViewMode;
  saveState: DocumentSaveState;
}

export interface WorkspaceDiagnostic {
  documentPath: string;
  target: string;
  kind: "broken-link" | "missing-image";
}

interface WorkspaceState {
  provider: WorkspaceProvider | null;
  entries: WorkspaceEntry[];
  tabs: OpenDocument[];
  activePath: string | null;
  selectedPath: string | null;
  isOpening: boolean;
  isIndexing: boolean;
  resumableWorkspace: StoredWorkspace | null;
  error: string | null;
  lastTrash: TrashResult | null;
  diagnostics: WorkspaceDiagnostic[];
  conflicts: DocumentConflict[];
  recoveryItems: RecoveryItem[];
  initialize: () => Promise<void>;
  resumeWorkspace: () => Promise<void>;
  openWorkspace: () => Promise<void>;
  openRecentWorkspace: (reference: RepositoryWorkspaceReference) => Promise<void>;
  openDriveWorkspace: (reference: DriveWorkspaceReference) => Promise<void>;
  refreshEntries: () => Promise<void>;
  openDocument: (path: string) => Promise<void>;
  closeDocument: (path: string) => void;
  selectPath: (path: string) => void;
  updateDocument: (path: string, content: string, cursor: number) => void;
  setViewMode: (path: string, viewMode: DocumentViewMode) => void;
  requestEditingTakeover: (path: string) => Promise<void>;
  saveDocument: (path: string) => Promise<void>;
  createDocument: (path: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  moveEntry: (sourcePath: string, destinationPath: string) => Promise<void>;
  trashEntry: (path: string) => Promise<void>;
  restoreLastTrash: () => Promise<void>;
  restoreRecoveryItem: (id: string, destinationPath: string) => Promise<void>;
  removeRecoveryItem: (id: string) => Promise<void>;
  resolveConflict: (id: string, content: string | null) => Promise<void>;
  insertAssets: (files: File[], assetDirectory?: string) => Promise<void>;
  checkExternalChanges: () => Promise<void>;
  getHistory: (path: string) => Promise<HistoryEntry[]>;
  restoreHistory: (entry: HistoryEntry) => Promise<void>;
  flushDurableDrafts: () => Promise<void>;
  clearError: () => void;
}

const draftTimers = new Map<string, number>();
const lastMetadataChecks = new Map<string, number>();
const draftPersistenceQueue = new KeyedSerialTaskQueue();
const providerWriteQueue = new KeyedSerialTaskQueue();
const persistedDrafts = new Map<string, RepositoryDraft>();
const editorOwnerToken = crypto.randomUUID();
const editingLeases = new Map<string, EditingLeaseHandle>();
const warmWorkspaceCacheEnabled = import.meta.env.VITE_WARM_WORKSPACE_CACHE !== "false";
const scheduler = new PriorityScheduler({
  concurrency: 3,
  onQueueWait: (milliseconds) => recordWorkspaceMetric("priority_queue_wait_ms", milliseconds),
});
let sessionTimer: number | null = null;
let workspaceInitialization: Promise<void> | null = null;
let workspaceGeneration = 0;
let leadership: LeadershipHandle | null = null;
let editingChannel: BroadcastChannel | null = null;

/**
 * Requests persistent browser storage once after durable workspace use is established.
 * @returns Nothing; refusal remains a valid degraded durability mode.
 */
function requestDurableStorageOnce(): void {
  const key = "notemarkdown:persistence-requested:v1";
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "true");
  void inspectStoragePressure();
}

/**
 * Flattens hierarchical provider entries.
 * @param entries Workspace tree.
 * @returns All entries in deterministic tree order.
 */
function flattenEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.flatMap((entry) => [entry, ...(entry.children ? flattenEntries(entry.children) : [])]);
}

/**
 * Replaces a path prefix for an entry and any descendants.
 * @param path Existing document path.
 * @param sourcePath Moved source path.
 * @param destinationPath New source path.
 * @returns Updated document path.
 */
function replacePathPrefix(path: string, sourcePath: string, destinationPath: string): string {
  if (path === sourcePath) return destinationPath;
  return path.startsWith(`${sourcePath}/`) ? `${destinationPath}${path.slice(sourcePath.length)}` : path;
}

/**
 * Converts unknown domain failures into UI-safe diagnostics.
 * @param error Unknown operation failure.
 * @returns A concise diagnostic message.
 */
function errorMessage(error: unknown): string {
  reportSyncFailure(error);
  return error instanceof Error ? error.message : "The workspace operation failed.";
}

/**
 * Reduces an unknown write failure to a path-free diagnostic category.
 * @param error Unknown provider or coordination failure.
 * @returns Stable local diagnostic category.
 */
function diagnosticErrorCode(error: unknown): SyncDiagnosticErrorCode {
  if (error instanceof WorkspaceError) return error.code;
  if (error instanceof CancelledWorkError) return "cancelled";
  return "unexpected";
}

/**
 * Checks whether an asynchronous operation still belongs to the active workspace generation.
 * @param providerId Provider identity captured when the operation started.
 * @param generation Workspace generation captured when the operation started.
 * @param get Current Zustand state accessor.
 * @returns Whether late work may affect active UI state or start a provider mutation.
 */
function isCurrentWorkspaceOperation(providerId: string, generation: number, get: () => WorkspaceState): boolean {
  return get().provider?.id === providerId && generation === workspaceGeneration;
}

/**
 * Creates a Drive token source that preserves API session failures as actionable provider errors.
 * @param connectedAccountId User-scoped connected-account identity.
 * @returns Token provider with explicit session, authorization, and API failure categories.
 */
function createDriveTokenProvider(connectedAccountId: string): DriveAccessTokenProvider {
  return {
    getAccessToken: async () => {
      const startedAt = Date.now();
      recordSyncDiagnostic({ operation: "token-request", outcome: "started" });
      try {
        const token = await getDriveAccessToken(connectedAccountId);
        recordSyncDiagnostic({ operation: "token-request", outcome: "succeeded", durationMs: Date.now() - startedAt });
        return token;
      } catch (error) {
        recordSyncDiagnostic({
          operation: "token-request",
          outcome: "failed",
          durationMs: Date.now() - startedAt,
          errorCode: error instanceof ApiRequestError ? error.code : diagnosticErrorCode(error),
          status: error instanceof ApiRequestError ? error.status : undefined,
        });
        throw driveTokenFailure(error);
      }
    },
    invalidateAccessToken: () => invalidateDriveAccessToken(connectedAccountId),
  };
}

/**
 * Persists one current document buffer.
 * @param workspaceId Stable workspace identity.
 * @param document Open document snapshot.
 * @returns Versioned durable repository draft.
 */
async function persistDocument(workspaceId: string, document: OpenDocument): Promise<RepositoryDraft> {
  const key = documentOperationKey(workspaceId, document.entryId);
  return draftPersistenceQueue.run(key, async () => {
    const persisted = persistedDrafts.get(key);
    if (
      persisted?.content === document.content
      && persisted.cursor === document.cursor
      && persisted.format.hasBom === document.format.hasBom
      && persisted.format.lineEnding === document.format.lineEnding
      && persisted.baseRevision.id === document.revision.id
    ) return persisted;
    const durableDraft = await saveRepositoryDraft({
      localRevision: crypto.randomUUID(),
      workspaceId,
      entryId: document.entryId,
      path: document.path,
      content: document.content,
      format: document.format,
      baseRevision: document.revision,
      cursor: document.cursor,
      updatedAt: Date.now(),
    });
    persistedDrafts.set(key, durableDraft);
    recordActivity("storage", "draft.persisted", { workspaceId, entryId: document.entryId, path: document.path, contentLength: document.content.length });
    return durableDraft;
  });
}

/**
 * Creates the stable key used to coordinate local and provider work for one document.
 * @param workspaceId Stable workspace identity.
 * @param entryId Stable provider entry identity.
 * @returns Workspace-scoped document operation key.
 */
function documentOperationKey(workspaceId: string, entryId: string): string {
  return `${workspaceId}:${entryId}`;
}

/**
 * Three-way merges source-format changes without silently choosing overlapping intent.
 * @param base Last confirmed provider format.
 * @param local Current local format.
 * @param remote Newly observed provider format.
 * @returns Merged format, or null when both sides changed differently.
 */
function mergeDocumentFormat(base: DocumentFormat, local: DocumentFormat, remote: DocumentFormat): DocumentFormat | null {
  if (documentFormatsMatch(local, remote)) return local;
  if (documentFormatsMatch(local, base)) return remote;
  if (documentFormatsMatch(remote, base)) return local;
  return null;
}

/**
 * Creates a retained history checkpoint from an open document.
 * @param workspaceId Stable workspace identity.
 * @param document Open document snapshot.
 * @param reason Checkpoint cause.
 * @returns Nothing after retention cleanup.
 */
async function checkpoint(
  workspaceId: string,
  document: OpenDocument,
  reason: HistoryEntry["reason"],
): Promise<void> {
  const updatedAt = Date.now();
  await saveRepositoryHistory({
    workspaceId,
    entryId: document.entryId,
    path: document.path,
    content: document.content,
    format: document.format,
    baseRevision: document.revision,
    cursor: document.cursor,
    updatedAt,
    id: `${workspaceId}:${document.entryId}:${updatedAt}:${crypto.randomUUID()}`,
    reason,
  });
  recordActivity("storage", "history.checkpoint-created", { workspaceId, entryId: document.entryId, path: document.path, reason, contentLength: document.content.length });
}

/**
 * Schedules workspace-scoped tab and layout persistence.
 * @param get Current Zustand state accessor.
 * @returns Nothing after a debounce timer is installed.
 */
function scheduleSession(get: () => WorkspaceState): void {
  if (sessionTimer !== null) window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => {
    sessionTimer = null;
    const state = get();
    if (!state.provider) return;
    const active = state.tabs.find((tab) => tab.path === state.activePath);
    const selected = flattenEntries(state.entries).find((entry) => entry.path === state.selectedPath);
    void saveRepositorySession({
      workspaceId: state.provider.id,
      activeEntryId: active?.entryId ?? null,
      selectedEntryId: selected?.entryId ?? null,
      tabs: state.tabs.map(({ entryId, path, cursor, viewMode }) => ({ entryId, path, cursor, viewMode })),
      updatedAt: Date.now(),
    });
  }, 120);
}

/**
 * Schedules local draft durability after editor input.
 * @param get Current Zustand state accessor.
 * @param set Zustand state updater.
 * @param path Changed document path.
 * @returns Nothing after a short durability timer is installed.
 */
function scheduleDraft(
  get: () => WorkspaceState,
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  path: string,
): void {
  const current = draftTimers.get(path);
  if (current) window.clearTimeout(current);
  draftTimers.set(path, window.setTimeout(() => {
    draftTimers.delete(path);
    const state = get();
    const document = state.tabs.find((tab) => tab.path === path);
    if (!state.provider || !document) return;
    void persistDocument(state.provider.id, document).then(() => {
      set((latest) => ({
        tabs: latest.tabs.map((tab) => tab.entryId === document.entryId
          && tab.content === document.content
          && tab.cursor === document.cursor
          && tab.revision.id === document.revision.id
          && tab.saveState === "dirty-local"
          ? { ...tab, saveState: "dirty-durable" }
          : tab),
      }));
    }).catch((error) => set({ error: errorMessage(error) }));
  }, 90));
}

/**
 * Calculates relative-link diagnostics from a complete local scan.
 * @param documents Scanned Markdown sources.
 * @param entries Current workspace entries.
 * @returns Missing document and image targets.
 */
function calculateDiagnostics(
  documents: Array<{ path: string; content: string }>,
  entries: WorkspaceEntry[],
): WorkspaceDiagnostic[] {
  const available = new Set(flattenEntries(entries).map((entry) => entry.path));
  const diagnostics: WorkspaceDiagnostic[] = [];
  const pattern = /(!?)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  for (const document of documents) {
    for (const match of document.content.matchAll(pattern)) {
      const authored = match[2];
      if (/^(?:[a-z]+:|#)/i.test(authored)) continue;
      const withoutAnchor = authored.split("#", 1)[0];
      if (!withoutAnchor) continue;
      const target = resolveWorkspaceTarget(document.path, withoutAnchor);
      if (target && !available.has(target)) {
        diagnostics.push({ documentPath: document.path, target: authored, kind: match[1] ? "missing-image" : "broken-link" });
      }
    }
  }
  return diagnostics;
}

/**
 * Converts a provider document into an atomic central cache record.
 * @param workspaceId Stable workspace identity.
 * @param entryId Stable provider entry identity.
 * @param document Provider document snapshot.
 * @returns Central cached-document record.
 */
function cachedDocumentFromProvider(
  workspaceId: string,
  entryId: string,
  document: Pick<OpenDocument, "path" | "content" | "format" | "revision" | "metadataFingerprint">,
): CachedDocument {
  return {
    workspaceId,
    entryId,
    path: document.path,
    content: document.content,
    format: document.format,
    cachedContentRevision: document.revision,
    metadataFingerprint: document.metadataFingerprint,
    lastAccessedAt: Date.now(),
  };
}

/**
 * Loads a central draft and falls back to the previous schema during migration.
 * @param workspaceId Stable workspace identity.
 * @param entryId Stable provider entry identity.
 * @param path Current provider path.
 * @returns Durable draft facts or null.
 */
async function loadCompatibleDraft(workspaceId: string, entryId: string, path: string) {
  const repositoryDraft = await loadRepositoryDraft(workspaceId, entryId);
  if (repositoryDraft) {
    recordActivity("storage", "draft.found", { workspaceId, entryId, path, contentLength: repositoryDraft.content.length }, "debug");
    return repositoryDraft;
  }
  const legacyDraft = await loadDraft(workspaceId, path);
  if (!legacyDraft) {
    recordActivity("storage", "draft.missing", { workspaceId, entryId, path }, "debug");
    return null;
  }
  const migrated = { ...legacyDraft, entryId };
  await saveRepositoryDraft(migrated);
  await deleteDraft(workspaceId, path);
  recordActivity("storage", "draft.migrated", { workspaceId, entryId, path, contentLength: migrated.content.length });
  return migrated;
}

/**
 * Reads and incrementally indexes Markdown files using revision-matched cache hits.
 * @param provider Active workspace provider.
 * @param entries Current provider tree.
 * @param onComplete Receives documents and diagnostics after scanning.
 * @returns Nothing after the background scan completes.
 */
async function indexWorkspace(
  provider: WorkspaceProvider,
  entries: WorkspaceEntry[],
  onComplete: (documents: Array<{ path: string; content: string }>, diagnostics: WorkspaceDiagnostic[]) => void,
): Promise<void> {
  const cached = new Map((await loadCachedDocuments(provider.id)).map((document) => [document.entryId, document]));
  const documents: Array<{ path: string; content: string }> = [];
  for (const entry of flattenEntries(entries).filter((item) => item.kind === "document" && item.state !== "path-collision")) {
    try {
      const entryId = entry.entryId ?? entry.path;
      const cachedDocument = cached.get(entryId);
      const unchanged = cachedDocument !== undefined && (
        entry.revision?.id === cachedDocument.cachedContentRevision.id
        || (entry.revision === undefined && entry.metadataFingerprint?.id === cachedDocument.metadataFingerprint?.id)
      );
      if (unchanged && cachedDocument) {
        documents.push({ path: entry.path, content: cachedDocument.content });
        indexSearchDocument(entry.path, cachedDocument.content);
        recordWorkspaceMetric("cache_hit_count");
        recordActivity("storage", "document-cache.hit", { workspaceId: provider.id, entryId, path: entry.path, contentLength: cachedDocument.content.length }, "debug");
      } else {
        recordWorkspaceMetric("cache_miss_count");
        recordActivity("storage", "document-cache.miss", { workspaceId: provider.id, entryId, path: entry.path }, "debug");
        const document = await provider.readDocument(entry.path);
        const record = cachedDocumentFromProvider(provider.id, entryId, document);
        await commitCachedDocument(record);
        documents.push({ path: document.path, content: document.content });
        await indexSearchDocument(document.path, document.content);
        await acknowledgeIndexRevision(provider.id, entryId, document.revision.id);
        recordWorkspaceMetric("index_documents_processed");
      }
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "not-found") throw error;
      // Entries may disappear during a scan; authoritative reconciliation handles removal.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  onComplete(documents, calculateDiagnostics(documents, entries));
}

/**
 * Tests whether provider metadata still represents cached document bytes.
 * @param document Cached or open document.
 * @param revision Newly observed strong provider revision.
 * @param fingerprint Newly observed weak metadata fingerprint.
 * @returns Whether content download can be skipped.
 */
function metadataMatches(
  document: Pick<OpenDocument, "revision" | "metadataFingerprint"> | CachedDocument,
  revision?: WorkspaceRevision,
  fingerprint?: WorkspaceMetadataFingerprint,
): boolean {
  const cachedRevision = "cachedContentRevision" in document ? document.cachedContentRevision : document.revision;
  const cachedFingerprint = document.metadataFingerprint;
  return revision ? revision.id === cachedRevision.id : fingerprint?.id !== undefined && fingerprint.id === cachedFingerprint?.id;
}

/**
 * Restores tabs entirely from protected repository records.
 * @param workspaceId Stable workspace identity.
 * @param entries Warm manifest entries.
 * @returns Open documents and restored active/selected paths.
 */
async function restoreWarmSession(workspaceId: string, entries: WorkspaceEntry[]): Promise<{
  tabs: OpenDocument[];
  activePath: string | null;
  selectedPath: string | null;
}> {
  const repositorySession = await loadRepositorySession(workspaceId);
  const legacySession = repositorySession ? null : await loadSession(workspaceId);
  const sessionTabs = repositorySession?.tabs ?? (legacySession?.tabs ?? []).map((tab) => ({ ...tab, entryId: tab.path }));
  const entryById = new Map(flattenEntries(entries).map((entry) => [entry.entryId ?? entry.path, entry]));
  const tabs: OpenDocument[] = [];
  for (const tabState of sessionTabs) {
    const entry = entryById.get(tabState.entryId) ?? flattenEntries(entries).find((item) => item.path === tabState.path);
    const entryId = entry?.entryId ?? tabState.entryId ?? tabState.path;
    const cached = await loadCachedDocument(workspaceId, entryId);
    const draft = await loadCompatibleDraft(workspaceId, entryId, entry?.path ?? tabState.path);
    if (!cached && !draft) continue;
    const source = draft ?? cached!;
    const lease = await acquireDocumentEditingLease(workspaceId, entryId, editorOwnerToken);
    if (lease) editingLeases.set(`${workspaceId}:${entryId}`, lease);
    tabs.push({
      entryId,
      path: entry?.path ?? source.path,
      content: source.content,
      format: source.format,
      revision: draft?.baseRevision ?? cached!.cachedContentRevision,
      metadataFingerprint: cached?.metadataFingerprint,
      editingState: lease ? "owned" : "read-only",
      cursor: draft?.cursor ?? tabState.cursor,
      viewMode: tabState.viewMode,
      saveState: draft ? "dirty-local" : "checking",
    });
  }
  const activeEntryId = repositorySession?.activeEntryId;
  const activePath = tabs.find((tab) => tab.entryId === activeEntryId)?.path
    ?? (legacySession?.activePath && tabs.some((tab) => tab.path === legacySession.activePath) ? legacySession.activePath : tabs.at(-1)?.path ?? null);
  const selectedEntryId = repositorySession?.selectedEntryId;
  const selectedPath = entryById.get(selectedEntryId ?? "")?.path ?? legacySession?.selectedPath ?? activePath;
  return { tabs, activePath, selectedPath };
}

/**
 * Applies one metadata-first check to an open document.
 * @param provider Active provider.
 * @param document Open document snapshot.
 * @param priority Scheduler priority.
 * @param generation Active workspace generation.
 * @param set Zustand setter.
 * @param get Zustand accessor.
 * @returns Nothing after unchanged, update, conflict, move, or deletion handling.
 */
async function reconcileOpenDocument(
  provider: WorkspaceProvider,
  document: OpenDocument,
  priority: WorkPriority,
  generation: number,
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  get: () => WorkspaceState,
): Promise<void> {
  if (!provider.getEntryMetadata || providerWriteQueue.has(documentOperationKey(provider.id, document.entryId))) return;
  await scheduler.enqueue({
    key: `metadata:${document.entryId}`,
    workspaceId: provider.id,
    generation,
    priority,
    run: async (token) => {
      token.throwIfCancelled();
      recordSyncDiagnostic({ operation: "document-reconciliation", outcome: "started" });
      try {
        const metadata = await provider.getEntryMetadata!({ entryId: document.entryId, path: document.path });
        token.throwIfCancelled();
        if (metadata.state === "removed") throw new WorkspaceError("not-found", `${document.path} was removed.`);
        if (metadata.state === "path-collision") {
          reportSyncFailure(new WorkspaceError("ambiguous", "A duplicate provider path blocked reconciliation."));
          set((state) => ({ tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...tab, saveState: "error-blocking" } : tab), error: `${document.path} has a duplicate provider path.` }));
          return;
        }
        if (metadata.path !== document.path) {
          await moveRepositoryEntry(provider.id, document.entryId, metadata.path);
          set((state) => ({
            tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...tab, path: metadata.path } : tab),
            activePath: state.activePath === document.path ? metadata.path : state.activePath,
            selectedPath: state.selectedPath === document.path ? metadata.path : state.selectedPath,
          }));
        }
        if (metadataMatches(document, metadata.revision, metadata.metadataFingerprint)) {
          recordWorkspaceMetric("cache_hit_count");
          set((state) => ({ tabs: state.tabs.map((tab) => tab.entryId === document.entryId && tab.saveState === "checking" ? { ...tab, saveState: "clean", metadataFingerprint: metadata.metadataFingerprint } : tab) }));
          recordSyncDiagnostic({ operation: "document-reconciliation", outcome: "succeeded" });
          return;
        }
        recordWorkspaceMetric("cache_miss_count");
        const remote = await provider.readDocument(metadata.path);
        token.throwIfCancelled();
        const current = get().tabs.find((tab) => tab.entryId === document.entryId);
        if (!current) return;
        if (current.saveState === "clean" || current.saveState === "checking") {
          await checkpoint(provider.id, current, "external-change");
          await commitCachedDocument(cachedDocumentFromProvider(provider.id, document.entryId, remote));
          await indexSearchDocument(remote.path, remote.content);
          await acknowledgeIndexRevision(provider.id, document.entryId, remote.revision.id);
          set((state) => ({ tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...remote, entryId: document.entryId, editingState: tab.editingState, cursor: Math.min(tab.cursor, remote.content.length), viewMode: tab.viewMode, saveState: "clean" } : tab) }));
          recordSyncDiagnostic({ operation: "document-reconciliation", outcome: "succeeded" });
          return;
        }
        await persistDocument(provider.id, current);
        const base = await loadCachedDocument(provider.id, document.entryId);
        const mergedContent = base ? threeWayMerge(base.content, current.content, remote.content) : { kind: "conflict" as const };
        const mergedFormat = base ? mergeDocumentFormat(base.format, current.format, remote.format) : null;
        if (mergedContent.kind !== "conflict" && mergedFormat) {
          await checkpoint(provider.id, current, "external-change");
          await commitCachedDocument(cachedDocumentFromProvider(provider.id, document.entryId, remote));
          await acknowledgeIndexRevision(provider.id, document.entryId, remote.revision.id);
          const matchesRemote = mergedContent.content === remote.content && documentFormatsMatch(mergedFormat, remote.format);
          const mergedDocument: OpenDocument = {
            ...current,
            path: remote.path,
            content: mergedContent.content,
            format: mergedFormat,
            revision: remote.revision,
            metadataFingerprint: remote.metadataFingerprint,
            cursor: Math.min(current.cursor, mergedContent.content.length),
            saveState: matchesRemote ? "clean" : "dirty-local",
          };
          if (matchesRemote) {
            await deleteRepositoryDraft(provider.id, document.entryId);
            await deleteDraft(provider.id, current.path);
          } else {
            await persistDocument(provider.id, mergedDocument);
          }
          await indexSearchDocument(mergedDocument.path, mergedDocument.content);
          set((state) => ({
            tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...mergedDocument, editingState: tab.editingState, viewMode: tab.viewMode } : tab),
            error: null,
          }));
          recordSyncDiagnostic({ operation: "document-reconciliation", outcome: "succeeded", itemCount: 1 });
          if (!matchesRemote) void get().saveDocument(mergedDocument.path);
          return;
        }
        const conflict: DocumentConflict = {
          id: `${provider.id}:${document.entryId}`,
          workspaceId: provider.id,
          entryId: document.entryId,
          path: metadata.path,
          baseContent: base?.content,
          localContent: current.content,
          remoteContent: remote.content,
          baseRevision: current.revision,
          remoteRevision: remote.revision,
          createdAt: Date.now(),
        };
        await saveConflict(conflict);
        recordSyncDiagnostic({ operation: "document-reconciliation", outcome: "failed", errorCode: "conflict" });
        reportSyncFailure(new WorkspaceError("conflict", "An external document change conflicted with a local draft."));
        set((state) => ({ conflicts: [conflict, ...state.conflicts.filter((item) => item.id !== conflict.id)], tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...tab, saveState: "conflicted" } : tab), error: `${metadata.path} changed outside NoteMarkdown. Your local draft was preserved.` }));
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "not-found") throw error;
        const current = get().tabs.find((tab) => tab.entryId === document.entryId);
        if (!current) return;
        let recoveryItem: RecoveryItem | null = null;
        if (current.saveState !== "clean" && current.saveState !== "checking") {
          await persistDocument(provider.id, current);
          recoveryItem = {
            id: crypto.randomUUID(),
            workspaceId: provider.id,
            formerEntryId: current.entryId,
            formerPath: current.path,
            content: current.content,
            format: current.format,
            baseRevision: current.revision,
            reason: "provider-removed",
            createdAt: Date.now(),
          };
          await saveRecoveryItem(recoveryItem);
        }
        const removalMessage = `${current.path} was removed outside NoteMarkdown.${current.saveState === "clean" || current.saveState === "checking" ? "" : " Your local draft is available in recovery."}`;
        set((state) => ({
          tabs: state.tabs.map((tab) => tab.entryId === document.entryId ? { ...tab, saveState: "destroyed" } : tab),
          recoveryItems: recoveryItem ? [recoveryItem, ...state.recoveryItems] : state.recoveryItems,
          error: removalMessage,
        }));
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.entryId !== document.entryId);
          return { tabs, activePath: state.activePath === current.path ? tabs.at(-1)?.path ?? null : state.activePath };
        });
        removeSearchDocument(current.path);
      }
    },
  });
}

/**
 * Reconciles open documents before a bounded general manifest pass.
 * @param provider Active provider.
 * @param generation Fenced workspace generation.
 * @param set Zustand setter.
 * @param get Zustand accessor.
 * @returns Nothing after current priority work is scheduled and committed.
 */
async function reconcileProvider(
  provider: WorkspaceProvider,
  generation: number,
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  get: () => WorkspaceState,
): Promise<void> {
  const startedAt = performance.now();
  recordSyncDiagnostic({ operation: "reconciliation", outcome: "started" });
  const pendingWrites = await loadPendingWrites(provider.id);
  recordSyncDiagnostic({ operation: "pending-write", outcome: pendingWrites.length > 0 ? "queued" : "skipped", itemCount: pendingWrites.length });
  const resumableWrites: PendingDocumentWrite[] = [];
  for (const pending of pendingWrites) {
    const decision = pendingWriteResumeDecision(pending);
    if (decision.action === "process") {
      resumableWrites.push(decision.pending);
      continue;
    }
    if (decision.action === "block-stale") {
      await updatePendingWrite({ ...pending, state: "blocked", retryAt: undefined });
      recordSyncDiagnostic({ operation: "pending-write", outcome: "failed", attempt: pending.attempt, errorCode: `stale-${decision.reason}` });
      reportSyncFailure(Object.assign(new Error("Stale pending write blocked"), { name: "StalePendingWriteError", code: decision.reason }));
      set((current) => ({
        tabs: current.tabs.map((tab) => tab.entryId === pending.entryId ? { ...tab, saveState: "error-blocking" } : tab),
        error: "An outdated queued Drive write was blocked instead of being sent. The local draft was preserved; save it again to create a fresh write.",
      }));
    }
  }
  for (const pending of resumableWrites) {
    await scheduler.enqueue({
      key: `pending:${pending.id}`,
      workspaceId: provider.id,
      generation,
      priority: 3,
      run: async (token) => {
        token.throwIfCancelled();
        const result = await providerWriteQueue.run(
          documentOperationKey(provider.id, pending.entryId),
          () => processPendingWrite(provider, pending, async () => Boolean(leadership?.isLeader && await leadership.isCurrent())),
        );
        if (!isCurrentWorkspaceOperation(provider.id, generation, get)) return;
        const resolvedConflicts = result.saveState === "conflicted" ? await loadConflicts(provider.id) : null;
        set((current) => ({
          conflicts: resolvedConflicts ?? current.conflicts,
          tabs: current.tabs.map((tab) => {
            if (tab.entryId !== result.entryId) return tab;
            if (result.saveState === "clean" && result.revision) return { ...tab, revision: result.revision, saveState: tab.content === result.content ? "clean" : "dirty-local" };
            return { ...tab, saveState: result.saveState };
          }),
        }));
      },
    });
  }

  const reconciledState = get();
  const active = reconciledState.tabs.find((tab) => tab.path === reconciledState.activePath);
  if (active) await reconcileOpenDocument(provider, active, 1, generation, set, get);
  for (const tab of reconciledState.tabs.filter((item) => item.entryId !== active?.entryId)) await reconcileOpenDocument(provider, tab, 2, generation, set, get);

  const discovery = await scheduler.enqueue({
    key: provider.listChanges ? "drive-changes" : "manifest-scan",
    workspaceId: provider.id,
    generation,
    priority: 4,
    run: async (token) => {
      token.throwIfCancelled();
      if (provider.getChangesStartCursor && provider.listChanges) return discoverDriveChanges(provider, generation);
      const previous = await loadWorkspaceManifest(provider.id);
      const entries = await provider.listEntries();
      token.throwIfCancelled();
      const manifest: WorkspaceManifest = {
        workspaceId: provider.id,
        entries: createManifestEntries(provider.id, entries),
        generation: Math.max(previous?.generation ?? 0, generation) + 1,
        updatedAt: Date.now(),
      };
      const difference = compareManifests(previous, manifest);
      await saveWorkspaceManifest(manifest);
      return { entries, ...difference, fullScan: true } satisfies ProviderDiscoveryResult;
    },
  });
  if (get().provider?.id !== provider.id || generation !== workspaceGeneration) return;
  const committedManifest = await loadWorkspaceManifest(provider.id);
  leadership?.broadcastGeneration(committedManifest?.generation ?? generation);
  for (const path of discovery.removedPaths) void removeSearchDocument(path);
  for (const move of discovery.moves) {
    void removeSearchDocument(move.previousPath);
    const movedDocument = await loadCachedDocument(provider.id, move.entryId);
    if (movedDocument) void indexSearchDocument(move.nextPath, movedDocument.content);
  }
  set((current) => ({
    entries: discovery.entries,
    tabs: current.tabs.map((tab) => {
      const move = discovery.moves.find((item) => item.entryId === tab.entryId);
      return move ? { ...tab, path: move.nextPath } : tab;
    }),
    activePath: discovery.moves.find((move) => move.previousPath === current.activePath)?.nextPath ?? current.activePath,
    selectedPath: discovery.moves.find((move) => move.previousPath === current.selectedPath)?.nextPath ?? current.selectedPath,
  }));

  const cached = new Map((await loadCachedDocuments(provider.id)).map((document) => [document.entryId, document]));
  const allRemoteDocuments = flattenEntries(discovery.entries).filter((entry) => entry.kind === "document" && entry.state !== "path-collision");
  const remoteDocuments = discovery.fullScan
    ? allRemoteDocuments
    : allRemoteDocuments.filter((entry) => {
      const entryId = entry.entryId ?? entry.path;
      const cachedDocument = cached.get(entryId);
      return discovery.changedEntryIds.has(entryId)
        || !cachedDocument
        || !metadataMatches(cachedDocument, entry.revision, entry.metadataFingerprint);
    });
  const liveDocumentById = new Map(allRemoteDocuments.map((entry) => [entry.entryId ?? entry.path, entry]));
  const derivedDocuments: Array<{ path: string; content: string }> = Array.from(cached.entries())
    .filter(([entryId]) => liveDocumentById.has(entryId))
    .map(([entryId, document]) => ({ path: liveDocumentById.get(entryId)?.path ?? document.path, content: document.content }));
  const contentTasks: Array<Promise<unknown>> = [];
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const deferBackgroundContent = connection?.saveData === true || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g";
  for (const entry of remoteDocuments) {
    const entryId = entry.entryId ?? entry.path;
    const openDocument = get().tabs.find((tab) => tab.entryId === entryId);
    if (openDocument && openDocument.saveState !== "clean" && openDocument.saveState !== "checking") continue;
    const local = cached.get(entryId);
    if (local && metadataMatches(local, entry.revision, entry.metadataFingerprint)) continue;
    if (deferBackgroundContent) continue;
    contentTasks.push(scheduler.enqueue({
      key: `content:${entryId}:${entry.revision?.id ?? entry.metadataFingerprint?.id ?? "unknown"}`,
      workspaceId: provider.id,
      generation,
      priority: 5,
      run: async (token) => {
        token.throwIfCancelled();
        const document = await provider.readDocument(entry.path);
        token.throwIfCancelled();
        await commitCachedDocument(cachedDocumentFromProvider(provider.id, entryId, document));
        await indexSearchDocument(document.path, document.content);
        await acknowledgeIndexRevision(provider.id, entryId, document.revision.id);
        recordWorkspaceMetric("index_documents_processed");
        return document;
      },
    }).catch((error) => {
      if (!(error instanceof CancelledWorkError)) set({ error: errorMessage(error) });
    }));
  }
  set({ diagnostics: calculateDiagnostics(derivedDocuments, discovery.entries), isIndexing: contentTasks.length > 0 });
  await Promise.all(contentTasks);
  if (!deferBackgroundContent && get().provider?.id === provider.id && generation === workspaceGeneration) {
    const completeDocuments = (await loadCachedDocuments(provider.id))
      .filter((document) => liveDocumentById.has(document.entryId))
      .map((document) => ({ ...document, path: liveDocumentById.get(document.entryId)?.path ?? document.path }));
    set({ diagnostics: calculateDiagnostics(completeDocuments, discovery.entries), isIndexing: false });
    await cleanupRebuildableCache(provider.id, new Set(get().tabs.map((tab) => tab.entryId)));
  }
  const durationMs = performance.now() - startedAt;
  recordWorkspaceMetric("remote_reconcile_ms", durationMs);
  recordSyncDiagnostic({ operation: "reconciliation", outcome: "succeeded", durationMs, itemCount: discovery.entries.length });
  reportSlowSyncOperation("reconciliation", durationMs);
}

/**
 * Restores a provider from the central repository before optional provider I/O.
 * @param provider Reopened or newly selected provider.
 * @param set Zustand state setter.
 * @param get Zustand state accessor.
 * @param reference Optional registered provider lookup envelope.
 * @returns Nothing after warm render and leader reconciliation start.
 */
async function activateProvider(
  provider: WorkspaceProvider,
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  get: () => WorkspaceState,
  reference?: Omit<RepositoryWorkspaceReference, "salt">,
): Promise<void> {
  const startedAt = performance.now();
  recordSyncDiagnostic({ operation: "workspace-activation", outcome: "started" });
  workspaceGeneration += 1;
  const generation = workspaceGeneration;
  scheduler.cancelOlderGenerations(provider.id, generation);
  await leadership?.release();
  leadership = null;
  await Promise.all(Array.from(editingLeases.values(), (lease) => lease.release()));
  editingLeases.clear();
  editingChannel?.close();
  editingChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`notemarkdown:editing:${provider.id}`);
  editingChannel?.addEventListener("message", (event: MessageEvent<{ entryId?: string; ownerToken?: string }>) => {
    if (!event.data.entryId || event.data.ownerToken === editorOwnerToken) return;
    const current = get().tabs.find((tab) => tab.entryId === event.data.entryId);
    if (current && current.editingState === "owned") void persistDocument(provider.id, current);
    const leaseKey = `${provider.id}:${event.data.entryId}`;
    void editingLeases.get(leaseKey)?.release();
    editingLeases.delete(leaseKey);
    set((state) => ({ tabs: state.tabs.map((tab) => tab.entryId === event.data.entryId ? { ...tab, editingState: "read-only" } : tab) }));
  });

  if (provider instanceof LocalWorkspaceProvider) {
    await saveWorkspace({ id: provider.id, name: provider.name, handle: provider.directoryHandle, lastOpenedAt: Date.now() });
    await registerRepositoryWorkspace(reference ?? { id: provider.id, name: provider.name, providerType: "local", handle: provider.directoryHandle, lastOpenedAt: Date.now() });
  } else if (reference) {
    await registerRepositoryWorkspace(reference);
  }

  const manifestStartedAt = performance.now();
  const warmManifest = warmWorkspaceCacheEnabled ? await loadWorkspaceManifest(provider.id) : null;
  const manifestDurationMs = performance.now() - manifestStartedAt;
  recordWorkspaceMetric("manifest_load_ms", manifestDurationMs);
  recordActivity("storage", warmManifest ? "manifest-cache.hit" : "manifest-cache.miss", { workspaceId: provider.id, durationMs: manifestDurationMs, entryCount: warmManifest?.entries.length ?? 0 }, "debug");
  let entries = warmManifest ? manifestToWorkspaceEntries(warmManifest.entries) : [];

  if (!warmManifest) {
    if (provider.getChangesStartCursor && provider.listChanges) setInitialDriveCursor(provider.id, await withProviderRetry(() => provider.getChangesStartCursor!()));
    entries = await withProviderRetry(() => provider.listEntries());
    await saveWorkspaceManifest({ workspaceId: provider.id, entries: createManifestEntries(provider.id, entries), generation, updatedAt: Date.now() });
  }
  provider.primeEntries?.(entries);

  const identityByPath = new Map(flattenEntries(entries).map((entry) => [entry.path, entry.entryId ?? entry.path]));
  await migrateLegacyWorkspace(provider.id, identityByPath);
  if (provider instanceof DriveWorkspaceProvider) {
    const migratedSession = await loadRepositorySession(provider.id);
    const entriesById = new Map(flattenEntries(entries).map((entry) => [entry.entryId ?? entry.path, entry]));
    for (const tab of migratedSession?.tabs ?? []) {
      const entry = entriesById.get(tab.entryId);
      if (entry?.revision && !await loadCachedDocument(provider.id, tab.entryId)) {
        await importLegacyDriveMirror(provider.id, tab.entryId, entry.path, entry.revision);
      }
    }
  }
  const cachedDocuments = await loadCachedDocuments(provider.id);
  const [recoveryItems, conflicts] = await Promise.all([loadRecoveryItems(provider.id), loadConflicts(provider.id)]);
  const legacySearch = cachedDocuments.length === 0 ? await loadSearchDocuments(provider.id) : [];
  replaceSearchDocuments(cachedDocuments.length > 0 ? cachedDocuments.map(({ path, content }) => ({ path, content })) : legacySearch);
  const restored = await restoreWarmSession(provider.id, entries);
  recordActivity("storage", "session.restored", { workspaceId: provider.id, tabCount: restored.tabs.length, warmManifest: Boolean(warmManifest) });
  if (!warmManifest && restored.tabs.length === 0) {
    const repositorySession = await loadRepositorySession(provider.id);
    const legacySession = repositorySession ? null : await loadSession(provider.id);
    const sessionTabs = repositorySession?.tabs ?? (legacySession?.tabs ?? []).map((tab) => ({ ...tab, entryId: tab.path }));
    for (const tabState of sessionTabs) {
      try {
        const providerDocument = await provider.readDocument(tabState.path);
        const entryId = providerDocument.entryId ?? tabState.entryId;
        await commitCachedDocument(cachedDocumentFromProvider(provider.id, entryId, providerDocument));
        const draft = await loadCompatibleDraft(provider.id, entryId, providerDocument.path);
        const lease = await acquireDocumentEditingLease(provider.id, entryId, editorOwnerToken);
        if (lease) editingLeases.set(`${provider.id}:${entryId}`, lease);
        restored.tabs.push({
          ...providerDocument,
          entryId,
          editingState: lease ? "owned" : "read-only",
          content: draft?.content ?? providerDocument.content,
          format: draft?.format ?? providerDocument.format,
          revision: draft?.baseRevision ?? providerDocument.revision,
          cursor: draft?.cursor ?? tabState.cursor,
          viewMode: tabState.viewMode,
          saveState: draft ? "dirty-local" : "clean",
        });
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "not-found") throw error;
        // A cold fallback may skip tabs that disappeared before activation.
      }
    }
    restored.activePath = restored.tabs.find((tab) => tab.entryId === repositorySession?.activeEntryId)?.path
      ?? (legacySession?.activePath && restored.tabs.some((tab) => tab.path === legacySession.activePath) ? legacySession.activePath : restored.tabs.at(-1)?.path ?? null);
    restored.selectedPath = legacySession?.selectedPath ?? restored.activePath;
  }
  set({
    provider,
    entries,
    tabs: restored.tabs,
    activePath: restored.activePath,
    selectedPath: restored.selectedPath,
    isOpening: false,
    isIndexing: true,
    resumableWorkspace: null,
    error: null,
    lastTrash: null,
    diagnostics: calculateDiagnostics(cachedDocuments, entries),
    conflicts,
    recoveryItems,
  });
  const activationDurationMs = performance.now() - startedAt;
  recordWorkspaceMetric("workspace_activate_ms", activationDurationMs);
  recordSyncDiagnostic({ operation: "workspace-activation", outcome: "succeeded", durationMs: activationDurationMs, itemCount: entries.length });
  reportSlowSyncOperation("workspace-activation", activationDurationMs);
  requestDurableStorageOnce();

  recordSyncDiagnostic({ operation: "leadership", outcome: "started" });
  leadership = await acquireWorkspaceLeadership(provider.id, (committedGeneration) => {
    if (committedGeneration < generation || get().provider?.id !== provider.id) return;
    void Promise.all([loadWorkspaceManifest(provider.id), loadCachedDocuments(provider.id)]).then(([nextManifest, documents]) => {
      if (!nextManifest || get().provider?.id !== provider.id) return;
      const nextEntries = manifestToWorkspaceEntries(nextManifest.entries);
      const documentsByEntryId = new Map(documents.map((document) => [document.entryId, document]));
      replaceSearchDocuments(documents.map(({ path, content }) => ({ path, content })));
      set((current) => ({
        entries: nextEntries,
        tabs: current.tabs.map((tab) => {
          const cached = documentsByEntryId.get(tab.entryId);
          if (!cached || cached.content !== tab.content || (tab.saveState !== "queued" && tab.saveState !== "persisting-local" && tab.saveState !== "error-blocking")) return tab;
          return { ...tab, revision: cached.cachedContentRevision, metadataFingerprint: cached.metadataFingerprint, saveState: "clean" };
        }),
        diagnostics: calculateDiagnostics(documents, nextEntries),
        isIndexing: false,
      }));
    });
  }, () => {
    if (leadership?.isLeader && get().provider?.id === provider.id) {
      void reconcileProvider(provider, generation, set, get);
    }
  });
  recordSyncDiagnostic({ operation: "leadership", outcome: leadership?.isLeader ? "succeeded" : "skipped" });
  if (leadership?.isLeader && generation === workspaceGeneration) {
    void reconcileProvider(provider, generation, set, get).catch((error) => {
      if (!(error instanceof CancelledWorkError) && get().provider?.id === provider.id) set({ error: errorMessage(error), isIndexing: false });
    });
  } else {
    set({ isIndexing: false });
  }
}

/**
 * Computes a relative workspace path from one document to a target.
 * @param documentPath New source document path.
 * @param targetPath Absolute workspace-relative target path.
 * @returns Portable relative path.
 */
function relativeTarget(documentPath: string, targetPath: string): string {
  const from = documentPath.split("/").slice(0, -1);
  const to = targetPath.split("/");
  while (from[0] && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || (targetPath.split("/").at(-1) ?? targetPath);
}

/**
 * Updates relative Markdown references affected by moving a path or containing document.
 * @param content Original Markdown source.
 * @param documentPath Original source path.
 * @param sourcePath Moved path prefix.
 * @param destinationPath Replacement path prefix.
 * @returns Updated source and its post-move path.
 */
function updateMovedReferences(
  content: string,
  documentPath: string,
  sourcePath: string,
  destinationPath: string,
): { path: string; content: string } {
  const nextDocumentPath = replacePathPrefix(documentPath, sourcePath, destinationPath);
  const pattern = /(!?\[[^\]]*\]\()([^\s)]+)((?:\s+"[^"]*")?\))/g;
  const updated = content.replace(pattern, (whole, prefix: string, authored: string, suffix: string) => {
    if (/^(?:[a-z]+:|#)/i.test(authored)) return whole;
    const [pathPart, anchor] = authored.split(/(?=#)/, 2);
    const target = resolveWorkspaceTarget(documentPath, pathPart);
    if (!target) return whole;
    const nextTarget = replacePathPrefix(target, sourcePath, destinationPath);
    if (nextTarget === target && nextDocumentPath === documentPath) return whole;
    return `${prefix}${relativeTarget(nextDocumentPath, nextTarget)}${anchor ?? ""}${suffix}`;
  });
  return { path: nextDocumentPath, content: updated };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  provider: null,
  entries: [],
  tabs: [],
  activePath: null,
  selectedPath: null,
  isOpening: false,
  isIndexing: false,
  resumableWorkspace: null,
  error: null,
  lastTrash: null,
  diagnostics: [],
  conflicts: [],
  recoveryItems: [],

  initialize: () => {
    if (workspaceInitialization) return workspaceInitialization;
    workspaceInitialization = (async () => {
      set({ isOpening: true });
      try {
        const repositoryWorkspace = await loadLastRepositoryWorkspace();
        if (repositoryWorkspace?.providerType === "drive" && repositoryWorkspace.providerWorkspaceId && repositoryWorkspace.folderId && repositoryWorkspace.connectedAccountId) {
          const provider = new DriveWorkspaceProvider({
            workspaceId: repositoryWorkspace.providerWorkspaceId,
            folderId: repositoryWorkspace.folderId,
            displayName: repositoryWorkspace.name,
            tokenProvider: createDriveTokenProvider(repositoryWorkspace.connectedAccountId),
            diagnostics: createDriveDiagnostics(),
          });
          await activateProvider(provider, set, get, { ...repositoryWorkspace, lastOpenedAt: Date.now() });
          return;
        }
        if (!("showDirectoryPicker" in window)) {
          set({ isOpening: false });
          return;
        }
        const stored = await loadLastWorkspace();
        if (!stored) {
          set({ isOpening: false });
          return;
        }
        set({ resumableWorkspace: stored });
        await activateProvider(await reopenLocalWorkspace(stored.handle, stored.id), set, get);
      } catch (error) {
        const permissionError = error instanceof WorkspaceError && error.code === "permission";
        reportSyncFailure(error);
        set({ isOpening: false, error: permissionError ? null : errorMessage(error) });
      }
    })().finally(() => { workspaceInitialization = null; });
    return workspaceInitialization;
  },

  /**
   * Requests renewed browser permission and restores the retained workspace session.
   * @returns Nothing after restoration completes or permission is rejected.
   */
  resumeWorkspace: async () => {
    const stored = get().resumableWorkspace;
    if (!stored) return;
    set({ isOpening: true, error: null });
    try {
      await activateProvider(await reopenLocalWorkspace(stored.handle, stored.id, true), set, get);
    } catch (error) {
      set({ isOpening: false, error: errorMessage(error) });
    }
  },

  openWorkspace: async () => {
    set({ isOpening: true, error: null });
    try {
      const nextProvider = await openLocalWorkspace();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
      await get().flushDurableDrafts();
      await activateProvider(nextProvider, set, get);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set({ isOpening: false });
        return;
      }
      set({ isOpening: false, error: errorMessage(error) });
    }
  },

  /**
   * Reopens a previously registered local workspace from the sidebar switcher.
   * @param reference Stored local workspace reference.
   * @returns Nothing after activation completes or permission is rejected.
   */
  openRecentWorkspace: async (reference) => {
    if (reference.providerType !== "local" || !reference.handle || reference.id === get().provider?.id) return;
    set({ isOpening: true, error: null });
    try {
      await get().flushDurableDrafts();
      const nextProvider = await reopenLocalWorkspace(reference.handle, reference.id, true);
      await activateProvider(nextProvider, set, get, { ...reference, lastOpenedAt: Date.now() });
    } catch (error) {
      set({ isOpening: false, error: errorMessage(error) });
    }
  },

  openDriveWorkspace: async (reference) => {
    set({ isOpening: true, error: null });
    try {
      await get().flushDurableDrafts();
      const provider = new DriveWorkspaceProvider({
        workspaceId: reference.id,
        folderId: reference.folderId,
        displayName: reference.displayName,
        tokenProvider: createDriveTokenProvider(reference.connectedAccountId),
        diagnostics: createDriveDiagnostics(),
      });
      await activateProvider(provider, set, get, {
        id: provider.id,
        name: provider.name,
        providerType: "drive",
        connectedAccountId: reference.connectedAccountId,
        providerWorkspaceId: reference.id,
        folderId: reference.folderId,
        lastOpenedAt: Date.now(),
      });
    } catch (error) {
      set({ isOpening: false, error: errorMessage(error) });
    }
  },

  refreshEntries: async () => {
    const provider = get().provider;
    if (!provider) return;
    try {
      const previous = await loadWorkspaceManifest(provider.id);
      const entries = await provider.listEntries();
      provider.primeEntries?.(entries);
      const manifest: WorkspaceManifest = {
        workspaceId: provider.id,
        entries: createManifestEntries(provider.id, entries),
        generation: Math.max(previous?.generation ?? 0, workspaceGeneration) + 1,
        updatedAt: Date.now(),
      };
      const difference = compareManifests(previous, manifest);
      const syncState = await loadWorkspaceSyncState(provider.id);
      if (provider.listChanges) {
        await commitWorkspaceChangePage(manifest, {
          workspaceId: provider.id,
          providerType: "drive",
          driveChangeToken: syncState?.driveChangeToken,
          lastFullScanAt: Date.now(),
          lastReconciledAt: syncState?.lastReconciledAt,
        }, difference.moves);
      } else {
        await saveWorkspaceManifest(manifest);
      }
      for (const path of difference.removedPaths) void removeSearchDocument(path);
      set({ entries, error: null, isIndexing: true });
      void indexWorkspace(provider, entries, (_documents, diagnostics) => {
        if (get().provider?.id === provider.id) set({ diagnostics, isIndexing: false });
      }).catch((error) => {
        if (get().provider?.id === provider.id) set({ error: errorMessage(error), isIndexing: false });
        else reportSyncFailure(error);
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  openDocument: async (path) => {
    const state = get();
    const existing = state.tabs.find((tab) => tab.path === path);
    if (existing) {
      set({ activePath: path, selectedPath: path });
      scheduleSession(get);
      return;
    }
    if (!state.provider) return;
    try {
      const entry = flattenEntries(state.entries).find((item) => item.path === path);
      const entryId = entry?.entryId ?? path;
      const cached = warmWorkspaceCacheEnabled ? await loadCachedDocument(state.provider.id, entryId) : null;
      const providerDocument = cached
        ? {
          path: cached.path,
          content: cached.content,
          format: cached.format,
          revision: cached.cachedContentRevision,
          entryId,
          metadataFingerprint: cached.metadataFingerprint,
        }
        : await state.provider.readDocument(path);
      if (!cached) await commitCachedDocument(cachedDocumentFromProvider(state.provider.id, providerDocument.entryId ?? entryId, providerDocument));
      const draft = await loadCompatibleDraft(state.provider.id, providerDocument.entryId ?? entryId, path);
      const hasDraft = draft !== null && draft.content !== providerDocument.content;
      const stableEntryId = providerDocument.entryId ?? entryId;
      const lease = await acquireDocumentEditingLease(state.provider.id, stableEntryId, editorOwnerToken);
      if (lease) editingLeases.set(`${state.provider.id}:${stableEntryId}`, lease);
      const document: OpenDocument = {
        ...providerDocument,
        entryId: stableEntryId,
        editingState: lease ? "owned" : "read-only",
        content: hasDraft ? draft.content : providerDocument.content,
        format: draft?.format ?? providerDocument.format,
        revision: draft?.baseRevision ?? providerDocument.revision,
        cursor: draft?.cursor ?? 0,
        viewMode: "editor",
        saveState: hasDraft ? "dirty-local" : cached ? "checking" : "clean",
      };
      set((current) => ({ tabs: [...current.tabs, document], activePath: document.path, selectedPath: document.path, error: null }));
      indexSearchDocument(document.path, document.content);
      scheduleSession(get);
      void reconcileOpenDocument(state.provider, document, 1, workspaceGeneration, set, get).catch((error) => set({ error: errorMessage(error) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeDocument: (path) => {
    const closingState = get();
    const closingDocument = closingState.tabs.find((tab) => tab.path === path);
    if (closingState.provider && closingDocument) {
      if (closingDocument.saveState !== "clean") void persistDocument(closingState.provider.id, closingDocument);
      const leaseKey = `${closingState.provider.id}:${closingDocument.entryId}`;
      const lease = editingLeases.get(leaseKey);
      if (lease) void lease.release();
      editingLeases.delete(leaseKey);
    }
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      const tabs = state.tabs.filter((tab) => tab.path !== path);
      const nextIndex = Math.min(Math.max(index - 1, 0), tabs.length - 1);
      return { tabs, activePath: state.activePath === path ? tabs[nextIndex]?.path ?? null : state.activePath };
    });
    scheduleSession(get);
  },

  selectPath: (path) => {
    set({ selectedPath: path });
    scheduleSession(get);
  },

  updateDocument: (path, content, cursor) => {
    if (get().tabs.find((tab) => tab.path === path)?.editingState === "read-only") return;
    set((state) => ({
      tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, content, cursor, saveState: tab.content === content ? tab.saveState : "dirty-local" } : tab),
    }));
    indexSearchDocument(path, content);
    scheduleDraft(get, set, path);
    scheduleSession(get);
  },

  setViewMode: (path, viewMode) => {
    set((state) => ({ tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, viewMode } : tab) }));
    scheduleSession(get);
  },

  /**
   * Explicitly takes over a document editing lease after local state is durable.
   * @param path Open document path.
   * @returns Nothing after fencing and follower notification.
   */
  requestEditingTakeover: async (path) => {
    const state = get();
    const tab = state.tabs.find((document) => document.path === path);
    if (!state.provider || !tab || tab.editingState === "owned") return;
    await persistDocument(state.provider.id, tab);
    const lease = await takeOverDocumentEditingLease(state.provider.id, tab.entryId, editorOwnerToken);
    editingLeases.set(`${state.provider.id}:${tab.entryId}`, lease);
    editingChannel?.postMessage({ entryId: tab.entryId, ownerToken: editorOwnerToken, fencingToken: lease.fencingToken });
    set((current) => ({ tabs: current.tabs.map((document) => document.entryId === tab.entryId ? { ...document, editingState: "owned" } : document) }));
  },

  saveDocument: async (path) => {
    const initialState = get();
    const initialProvider = initialState.provider;
    const initialDocument = initialState.tabs.find((tab) => tab.path === path);
    if (!initialProvider || !initialDocument) return;
    await providerWriteQueue.run(documentOperationKey(initialProvider.id, initialDocument.entryId), async () => {
      const state = get();
      const provider = state.provider;
      const operationGeneration = workspaceGeneration;
      const snapshot = state.tabs.find((tab) => tab.entryId === initialDocument.entryId);
      if (!provider || provider.id !== initialProvider.id || !snapshot || snapshot.editingState === "read-only" || snapshot.saveState === "clean" || snapshot.saveState === "checking" || snapshot.saveState === "persisting-local" || snapshot.saveState === "conflicted") return;
      const timer = draftTimers.get(snapshot.path);
    if (timer) window.clearTimeout(timer);
      draftTimers.delete(snapshot.path);
      set((current) => ({ tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, saveState: "persisting-local" } : tab) }));
    const pendingCreatedAt = Date.now();
    const pendingWrite: PendingDocumentWrite = {
      id: `document:${snapshot.entryId}`,
      workspaceId: provider.id,
      entryId: snapshot.entryId,
      targetPath: snapshot.path,
      expectedBaseRevision: snapshot.revision,
      draftRevision: crypto.randomUUID(),
      content: snapshot.content,
      format: snapshot.format,
      state: "pending",
      attempt: 0,
      formatVersion: PENDING_WRITE_FORMAT_VERSION,
      createdAt: pendingCreatedAt,
      updatedAt: pendingCreatedAt,
    };
    try {
      const existingPending = (await loadPendingWrites(provider.id)).find((item) => item.id === pendingWrite.id);
      if (existingPending?.state === "retryable") pendingWrite.attempt = existingPending.attempt;
      const durableDraft = await persistDocument(provider.id, snapshot);
      pendingWrite.draftRevision = durableDraft.localRevision ?? pendingWrite.draftRevision;
      pendingWrite.content = durableDraft.content;
      pendingWrite.format = durableDraft.format;
      await savePendingWrite(pendingWrite);
      recordSyncDiagnostic({ operation: "provider-write", outcome: "queued", attempt: pendingWrite.attempt });
      if (leadership && !leadership.isLeader) {
        leadership.requestSync();
        set((current) => ({ tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, saveState: "queued" } : tab) }));
        return;
      }
      await checkpoint(provider.id, snapshot, "provider-save");
      const writeStartedAt = Date.now();
      recordSyncDiagnostic({ operation: "provider-write", outcome: "started", attempt: pendingWrite.attempt + 1 });
      let alreadyAppliedRevision: WorkspaceRevision | null = null;
      if (provider.getEntryMetadata) {
        const metadata = await provider.getEntryMetadata({ entryId: snapshot.entryId, path: snapshot.path });
        if (metadata.state === "removed") throw new WorkspaceError("not-found", `${snapshot.path} was removed.`);
        const revisionChanged = metadata.revision
          ? metadata.revision.id !== snapshot.revision.id
          : Boolean(snapshot.metadataFingerprint && metadata.metadataFingerprint?.id !== snapshot.metadataFingerprint.id);
        if (revisionChanged) {
          const remote = await provider.readDocument(metadata.path);
          if (remote.content === snapshot.content && documentFormatsMatch(remote.format, snapshot.format)) {
            alreadyAppliedRevision = remote.revision;
            recordSyncDiagnostic({ operation: "provider-write", outcome: "skipped", attempt: pendingWrite.attempt + 1 });
          } else {
            throw new WorkspaceError("conflict", `${snapshot.path} changed before save.`);
          }
        }
      }
      if (!isCurrentWorkspaceOperation(provider.id, operationGeneration, get)) throw new CancelledWorkError();
      if (leadership && !await leadership.isCurrent()) throw new CancelledWorkError();
      if (!alreadyAppliedRevision && !await updatePendingWriteIfCurrent({ ...pendingWrite, state: "in-flight" })) {
        leadership?.requestSync();
        set((current) => ({ tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, saveState: "queued" } : tab) }));
        return;
      }
      const revision = alreadyAppliedRevision
        ?? await provider.writeDocument({ path: snapshot.path, content: snapshot.content, format: snapshot.format, expectedRevision: snapshot.revision });
      const cachedDocument = cachedDocumentFromProvider(provider.id, snapshot.entryId, { ...snapshot, revision });
      const acknowledged = await commitDocumentAndAcknowledgeWrite(cachedDocument, pendingWrite);
      recordSyncDiagnostic({ operation: "provider-write", outcome: "succeeded", attempt: pendingWrite.attempt + 1, durationMs: Date.now() - writeStartedAt });
      if (!acknowledged) {
        const successor = (await loadPendingWrites(provider.id)).find((item) => item.id === pendingWrite.id && item.draftRevision !== pendingWrite.draftRevision);
        if (successor) await updatePendingWriteIfCurrent({ ...successor, expectedBaseRevision: revision, state: "pending", retryAt: undefined });
      }
      const latestDraft = await loadRepositoryDraft(provider.id, snapshot.entryId);
      if (acknowledged && latestDraft?.content === snapshot.content && latestDraft.baseRevision.id === snapshot.revision.id) {
        await deleteRepositoryDraft(provider.id, snapshot.entryId);
        await deleteDraft(provider.id, snapshot.path);
      } else if (latestDraft && latestDraft.baseRevision.id === snapshot.revision.id) {
        const rebasedDraft = await saveRepositoryDraft({ ...latestDraft, baseRevision: revision, updatedAt: Date.now() });
        persistedDrafts.set(documentOperationKey(provider.id, snapshot.entryId), rebasedDraft);
      }
      if (isCurrentWorkspaceOperation(provider.id, operationGeneration, get)) {
        set((current) => ({
          tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, revision, saveState: tab.content === snapshot.content ? "clean" : "dirty-local" } : tab),
          error: null,
        }));
      }
    } catch (error) {
      const conflicted = error instanceof WorkspaceError && (error.code === "conflict" || error.code === "not-found");
      const retryDelayMs = conflicted ? null : providerWriteRetryDelay(error, pendingWrite.attempt);
      let savedConflict: DocumentConflict | null = null;
      if (error instanceof WorkspaceError && error.code === "conflict") {
        try {
          const remote = await provider.readDocument(snapshot.path);
          const base = await loadCachedDocument(provider.id, snapshot.entryId);
          savedConflict = {
            id: `${provider.id}:${snapshot.entryId}`,
            workspaceId: provider.id,
            entryId: snapshot.entryId,
            path: snapshot.path,
            baseContent: base?.content,
            localContent: snapshot.content,
            remoteContent: remote.content,
            baseRevision: snapshot.revision,
            remoteRevision: remote.revision,
            createdAt: Date.now(),
          };
          await saveConflict(savedConflict);
        } catch (conflictReadError) {
          reportSyncFailure(conflictReadError);
          // The pending write remains conflicted even when remote conflict bytes cannot be fetched yet.
        }
      }
      if (error instanceof WorkspaceError && error.code === "not-found") {
        const recoveryItem: RecoveryItem = {
          id: crypto.randomUUID(),
          workspaceId: provider.id,
          formerEntryId: snapshot.entryId,
          formerPath: snapshot.path,
          content: snapshot.content,
          format: snapshot.format,
          baseRevision: snapshot.revision,
          reason: "provider-removed",
          createdAt: Date.now(),
        };
        await saveRecoveryItem(recoveryItem);
        set((current) => ({ recoveryItems: [recoveryItem, ...current.recoveryItems] }));
      }
      const updated = await updatePendingWriteIfCurrent({ ...pendingWrite, state: conflicted ? "conflicted" : retryDelayMs === null ? "blocked" : "retryable", attempt: pendingWrite.attempt + 1, retryAt: retryDelayMs === null ? undefined : Date.now() + retryDelayMs });
      if (!updated) {
        leadership?.requestSync();
        set((current) => ({ tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, saveState: "queued" } : tab) }));
        return;
      }
      recordSyncDiagnostic({ operation: "provider-write", outcome: "failed", attempt: pendingWrite.attempt + 1, errorCode: diagnosticErrorCode(error), retryDelayMs: retryDelayMs ?? undefined });
      const saveState: DocumentSaveState = conflicted ? "conflicted" : retryDelayMs === null ? "error-blocking" : "queued";
      if (isCurrentWorkspaceOperation(provider.id, operationGeneration, get)) {
        set((current) => ({ conflicts: savedConflict ? [savedConflict, ...current.conflicts.filter((item) => item.id !== savedConflict.id)] : current.conflicts, tabs: current.tabs.map((tab) => tab.entryId === snapshot.entryId ? { ...tab, saveState } : tab), error: errorMessage(error) }));
      } else {
        reportSyncFailure(error);
      }
      }
    });
  },

  createDocument: async (path) => {
    const provider = get().provider;
    if (!provider) return;
    try {
      const document = await provider.createDocument(ensureMarkdownPath(path), "# Untitled\n");
      const entryId = document.entryId ?? document.path;
      await commitCachedDocument(cachedDocumentFromProvider(provider.id, entryId, document));
      await get().refreshEntries();
      const lease = await acquireDocumentEditingLease(provider.id, entryId, editorOwnerToken);
      if (lease) editingLeases.set(`${provider.id}:${entryId}`, lease);
      set((state) => ({ tabs: [...state.tabs, { ...document, entryId, editingState: lease ? "owned" : "read-only", cursor: document.content.length, viewMode: "editor", saveState: "clean" }], activePath: document.path, selectedPath: document.path, error: null }));
      indexSearchDocument(document.path, document.content);
      scheduleSession(get);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  createDirectory: async (path) => {
    const provider = get().provider;
    if (!provider) return;
    try {
      await provider.createDirectory(path);
      await get().refreshEntries();
      set({ selectedPath: path, error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  moveEntry: async (sourcePath, destinationPath) => {
    const provider = get().provider;
    if (!provider) return;
    try {
      const documentPaths = flattenEntries(get().entries).filter((entry) => entry.kind === "document").map((entry) => entry.path);
      const originals = await Promise.all(documentPaths.map((path) => provider.readDocument(path)));
      const updates = originals.map((document) => ({ document, ...updateMovedReferences(document.content, document.path, sourcePath, destinationPath) }));
      const affected = updates.filter((update) => update.content !== update.document.content);
      if (affected.length > 1 && !window.confirm(`${affected.length} Markdown files contain references that will be updated. Continue?`)) return;
      for (const document of originals) await checkpoint(provider.id, { ...document, entryId: document.entryId ?? document.path, editingState: "owned", cursor: 0, viewMode: "editor", saveState: "clean" }, "provider-save");
      await provider.move(sourcePath, destinationPath);
      for (const tab of get().tabs.filter((item) => item.path === sourcePath || item.path.startsWith(`${sourcePath}/`))) {
        await moveRepositoryEntry(provider.id, tab.entryId, replacePathPrefix(tab.path, sourcePath, destinationPath));
      }
      const writtenRevisions = new Map<string, WorkspaceRevision>();
      for (const update of affected) {
        const revision = await provider.writeDocument({ path: update.path, content: update.content, format: update.document.format, expectedRevision: update.document.revision });
        writtenRevisions.set(update.path, revision);
        indexSearchDocument(update.path, update.content);
      }
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          const updated = updateMovedReferences(tab.content, tab.path, sourcePath, destinationPath);
          return { ...tab, ...updated, revision: writtenRevisions.get(updated.path) ?? tab.revision };
        }),
        activePath: state.activePath ? replacePathPrefix(state.activePath, sourcePath, destinationPath) : null,
        selectedPath: destinationPath,
        error: null,
      }));
      removeSearchDocument(sourcePath);
      await get().refreshEntries();
      scheduleSession(get);
    } catch (error) {
      set({ error: `Move transaction stopped safely: ${errorMessage(error)} Recovery snapshots were retained.` });
      await get().refreshEntries();
    }
  },

  trashEntry: async (path) => {
    const provider = get().provider;
    if (!provider) return;
    try {
      await get().flushDurableDrafts();
      const lastTrash = await provider.trash(path);
      removeSearchDocument(path);
      set((state) => {
        const tabs = state.tabs.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`));
        return {
          lastTrash,
          tabs,
          activePath: state.activePath && (state.activePath === path || state.activePath.startsWith(`${path}/`)) ? tabs.at(-1)?.path ?? null : state.activePath,
          selectedPath: null,
          error: null,
        };
      });
      await get().refreshEntries();
      scheduleSession(get);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  restoreLastTrash: async () => {
    const { provider, lastTrash } = get();
    if (!provider || !lastTrash) return;
    try {
      await provider.restore(lastTrash.token);
      set({ lastTrash: null, selectedPath: lastTrash.originalPath, error: null });
      await get().refreshEntries();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  /**
   * Restores provider-removed content as a new provider document.
   * @param id Persistent recovery identity.
   * @param destinationPath Explicit collision-safe destination path.
   * @returns Nothing after provider and repository commits.
   */
  restoreRecoveryItem: async (id, destinationPath) => {
    const state = get();
    const item = state.recoveryItems.find((record) => record.id === id);
    if (!state.provider || !item) return;
    try {
      const document = await state.provider.createDocument(ensureMarkdownPath(destinationPath), item.content);
      const entryId = document.entryId ?? document.path;
      await commitCachedDocument(cachedDocumentFromProvider(state.provider.id, entryId, document));
      await deleteRecoveryItem(state.provider.id, id);
      set((current) => ({ recoveryItems: current.recoveryItems.filter((record) => record.id !== id), error: null }));
      await get().refreshEntries();
      await get().openDocument(document.path);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  /**
   * Explicitly removes one persistent recovery item.
   * @param id Recovery identity confirmed by the user.
   * @returns Nothing after durable deletion.
   */
  removeRecoveryItem: async (id) => {
    const provider = get().provider;
    if (!provider) return;
    await deleteRecoveryItem(provider.id, id);
    set((state) => ({ recoveryItems: state.recoveryItems.filter((record) => record.id !== id) }));
  },

  /**
   * Resolves one durable conflict against a freshly verified provider revision.
   * @param id Conflict identity.
   * @param content Explicit local/merged content, or null to keep the remote document.
   * @returns Nothing after the chosen result becomes durable or a newer remote revision is retained.
   */
  resolveConflict: async (id, content) => {
    const state = get();
    const provider = state.provider;
    const conflict = state.conflicts.find((item) => item.id === id);
    const current = conflict ? state.tabs.find((tab) => tab.entryId === conflict.entryId) : null;
    if (!provider || !conflict || !current) return;
    try {
      const remote = await provider.readDocument(conflict.path);
      if (remote.revision.id !== conflict.remoteRevision.id) {
        const refreshed = { ...conflict, remoteContent: remote.content, remoteRevision: remote.revision, createdAt: Date.now() };
        await saveConflict(refreshed);
        set((workspace) => ({
          conflicts: workspace.conflicts.map((item) => item.id === id ? refreshed : item),
          error: `${conflict.path} changed again. Review the newest remote version before resolving the conflict.`,
        }));
        return;
      }
      await checkpoint(provider.id, current, "external-change");
      if (content === null) {
        await commitCachedDocument(cachedDocumentFromProvider(provider.id, conflict.entryId, remote));
        await deleteRepositoryDraft(provider.id, conflict.entryId);
        await deleteDraft(provider.id, conflict.path);
        await deletePendingWrite(provider.id, `document:${conflict.entryId}`);
        await deleteConflict(provider.id, id);
        await indexSearchDocument(remote.path, remote.content);
        set((workspace) => ({
          conflicts: workspace.conflicts.filter((item) => item.id !== id),
          tabs: workspace.tabs.map((tab) => tab.entryId === conflict.entryId ? { ...remote, entryId: conflict.entryId, editingState: tab.editingState, cursor: Math.min(tab.cursor, remote.content.length), viewMode: tab.viewMode, saveState: "clean" } : tab),
          error: null,
        }));
        return;
      }
      await commitCachedDocument(cachedDocumentFromProvider(provider.id, conflict.entryId, remote));
      const resolved: OpenDocument = { ...current, path: remote.path, content, revision: remote.revision, metadataFingerprint: remote.metadataFingerprint, cursor: Math.min(current.cursor, content.length), saveState: "dirty-local" };
      await persistDocument(provider.id, resolved);
      await deletePendingWrite(provider.id, `document:${conflict.entryId}`);
      await deleteConflict(provider.id, id);
      await indexSearchDocument(resolved.path, resolved.content);
      set((workspace) => ({
        conflicts: workspace.conflicts.filter((item) => item.id !== id),
        tabs: workspace.tabs.map((tab) => tab.entryId === conflict.entryId ? resolved : tab),
        error: null,
      }));
      await get().saveDocument(resolved.path);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  insertAssets: async (files, assetDirectory = "assets") => {
    const state = get();
    const provider = state.provider;
    const active = state.tabs.find((tab) => tab.path === state.activePath);
    if (!provider || !active) return;
    const supported = files.filter((file) => /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/i.test(file.type));
    if (supported.length === 0) return;
    try {
      let content = active.content;
      let cursor = active.cursor;
      const reservedPaths = new Set(flattenEntries(get().entries).map((entry) => entry.path));
      for (const file of supported) {
        const extension = file.name.match(/\.(png|jpe?g|gif|webp|avif|svg)$/i)?.[0].toLowerCase() ?? ".png";
        const base = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "image";
        let assetPath = `${assetDirectory}/${base}${extension}`;
        let attempt = 1;
        while (reservedPaths.has(assetPath)) assetPath = `${assetDirectory}/${base}-${attempt++}${extension}`;
        await provider.writeBinary(assetPath, file);
        reservedPaths.add(assetPath);
        const link = `![${base}](${relativeTarget(active.path, assetPath)})`;
        content = `${content.slice(0, cursor)}${link}${content.slice(cursor)}`;
        cursor += link.length;
      }
      get().updateDocument(active.path, content, cursor);
      await get().refreshEntries();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  checkExternalChanges: async () => {
    const state = get();
    if (!state.provider || !leadership?.isLeader || document.visibilityState !== "visible" || !navigator.onLine) return;
    const now = Date.now();
    const active = state.tabs.find((tab) => tab.path === state.activePath);
    if (active && now - (lastMetadataChecks.get(active.entryId) ?? 0) >= 30_000) {
      lastMetadataChecks.set(active.entryId, now);
      await reconcileOpenDocument(state.provider, active, 1, workspaceGeneration, set, get);
    }
    for (const tab of state.tabs.filter((item) => item.entryId !== active?.entryId && now - (lastMetadataChecks.get(item.entryId) ?? 0) >= 60_000)) {
      lastMetadataChecks.set(tab.entryId, now);
      await reconcileOpenDocument(state.provider, tab, 2, workspaceGeneration, set, get);
    }
    const pendingWrites = await loadPendingWrites(state.provider.id);
    for (const pending of pendingWrites) {
      const decision = pendingWriteResumeDecision(pending);
      if (decision.action !== "process" || (pending.state !== "retryable" && pending.state !== "in-flight")) continue;
      const tab = get().tabs.find((item) => item.entryId === pending.entryId);
      if (tab) await get().saveDocument(tab.path);
    }
  },

  getHistory: async (path) => {
    const state = get();
    if (!state.provider) return [];
    const entryId = state.tabs.find((tab) => tab.path === path)?.entryId ?? path;
    const repositoryHistory = await loadRepositoryHistory(state.provider.id, entryId);
    if (repositoryHistory.length > 0) return repositoryHistory.map(({ entryId: _entryId, ...entry }) => entry);
    return loadHistory(state.provider.id, path);
  },

  restoreHistory: async (entry) => {
    const active = get().tabs.find((tab) => tab.path === entry.path);
    const provider = get().provider;
    if (!active || !provider) return;
    await checkpoint(provider.id, active, "restore");
    get().updateDocument(entry.path, entry.content, Math.min(entry.cursor, entry.content.length));
  },

  flushDurableDrafts: async () => {
    const state = get();
    if (!state.provider) return;
    for (const timer of draftTimers.values()) window.clearTimeout(timer);
    draftTimers.clear();
    await Promise.all(state.tabs.filter((tab) => tab.saveState !== "clean").map((tab) => persistDocument(state.provider!.id, tab)));
  },

  clearError: () => set({ error: null }),
}));
