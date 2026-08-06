import { create } from "zustand";
import {
  WorkspaceError,
  resolveWorkspaceTarget,
  type DocumentFormat,
  type TrashResult,
  type WorkspaceEntry,
  type WorkspaceProvider,
  type WorkspaceRevision,
} from "@note/workspace-core";
import { LocalWorkspaceProvider, openLocalWorkspace, reopenLocalWorkspace } from "@note/workspace-local";
import { DriveWorkspaceProvider } from "@note/workspace-drive";
import type { DriveWorkspaceReference } from "@note/api-contracts";
import { getDriveAccessToken } from "../account/apiClient";
import { createDriveMirror } from "../drive/driveMirror";
import {
  deleteDraft,
  loadDraft,
  loadHistory,
  loadLastWorkspace,
  loadSearchDocuments,
  loadSession,
  saveDraft,
  saveHistory,
  saveSearchDocument,
  saveSession,
  saveWorkspace,
  type HistoryEntry,
  type StoredWorkspace,
} from "../storage/browserStorage";
import { indexSearchDocument, removeSearchDocument, replaceSearchDocuments } from "../search/searchClient";

export type DocumentViewMode = "editor" | "preview";
export type DocumentSaveState = "clean" | "dirty-local" | "persisting-local" | "conflicted" | "error-blocking";

export interface OpenDocument {
  path: string;
  content: string;
  format: DocumentFormat;
  revision: WorkspaceRevision;
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
  initialize: () => Promise<void>;
  resumeWorkspace: () => Promise<void>;
  openWorkspace: () => Promise<void>;
  openDriveWorkspace: (reference: DriveWorkspaceReference) => Promise<void>;
  refreshEntries: () => Promise<void>;
  openDocument: (path: string) => Promise<void>;
  closeDocument: (path: string) => void;
  selectPath: (path: string) => void;
  updateDocument: (path: string, content: string, cursor: number) => void;
  setViewMode: (path: string, viewMode: DocumentViewMode) => void;
  saveDocument: (path: string) => Promise<void>;
  createDocument: (path: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  moveEntry: (sourcePath: string, destinationPath: string) => Promise<void>;
  trashEntry: (path: string) => Promise<void>;
  restoreLastTrash: () => Promise<void>;
  insertAssets: (files: File[], assetDirectory?: string) => Promise<void>;
  checkExternalChanges: () => Promise<void>;
  getHistory: (path: string) => Promise<HistoryEntry[]>;
  restoreHistory: (entry: HistoryEntry) => Promise<void>;
  flushDurableDrafts: () => Promise<void>;
  clearError: () => void;
}

const draftTimers = new Map<string, number>();
let sessionTimer: number | null = null;

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
  return error instanceof Error ? error.message : "The workspace operation failed.";
}

/**
 * Persists one current document buffer.
 * @param workspaceId Stable workspace identity.
 * @param document Open document snapshot.
 * @returns Nothing after durable commit.
 */
async function persistDocument(workspaceId: string, document: OpenDocument): Promise<void> {
  await saveDraft({
    workspaceId,
    path: document.path,
    content: document.content,
    format: document.format,
    baseRevision: document.revision,
    cursor: document.cursor,
    updatedAt: Date.now(),
  });
  await saveSearchDocument(workspaceId, document.path, document.content);
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
  await saveHistory({
    workspaceId,
    path: document.path,
    content: document.content,
    format: document.format,
    baseRevision: document.revision,
    cursor: document.cursor,
    updatedAt,
    id: `${workspaceId}:${document.path}:${updatedAt}:${crypto.randomUUID()}`,
    reason,
  });
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
    void saveSession({
      workspaceId: state.provider.id,
      activePath: state.activePath,
      selectedPath: state.selectedPath,
      tabs: state.tabs.map(({ path, cursor, viewMode }) => ({ path, cursor, viewMode })),
      sidebarWidth: 292,
      updatedAt: Date.now(),
    });
  }, 120);
}

/**
 * Schedules local draft durability after editor input.
 * @param get Current Zustand state accessor.
 * @param path Changed document path.
 * @returns Nothing after a short durability timer is installed.
 */
function scheduleDraft(get: () => WorkspaceState, path: string): void {
  const current = draftTimers.get(path);
  if (current) window.clearTimeout(current);
  draftTimers.set(path, window.setTimeout(() => {
    draftTimers.delete(path);
    const state = get();
    const document = state.tabs.find((tab) => tab.path === path);
    if (state.provider && document) void persistDocument(state.provider.id, document);
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
 * Reads and incrementally indexes all Markdown files without long synchronous work.
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
  const paths = flattenEntries(entries).filter((entry) => entry.kind === "document").map((entry) => entry.path);
  const documents: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    try {
      const document = await provider.readDocument(path);
      documents.push({ path, content: document.content });
      indexSearchDocument(path, document.content);
      await saveSearchDocument(provider.id, path, document.content);
    } catch {
      // Files may disappear during an incremental scan; the next scan reconciles them.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  onComplete(documents, calculateDiagnostics(documents, entries));
}

/**
 * Restores an active provider and its durable workspace-scoped session.
 * @param provider Reopened or newly selected provider.
 * @param set Zustand state setter.
 * @param get Zustand state accessor.
 * @returns Nothing after shell restoration starts and indexing is scheduled.
 */
async function activateProvider(
  provider: WorkspaceProvider,
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  get: () => WorkspaceState,
): Promise<void> {
  const entries = await provider.listEntries();
  if (provider instanceof LocalWorkspaceProvider) await saveWorkspace({ id: provider.id, name: provider.name, handle: provider.directoryHandle, lastOpenedAt: Date.now() });
  const cachedSearch = await loadSearchDocuments(provider.id);
  replaceSearchDocuments(cachedSearch);
  const session = await loadSession(provider.id);
  const tabs: OpenDocument[] = [];
  for (const tabState of session?.tabs ?? []) {
    try {
      const providerDocument = await provider.readDocument(tabState.path);
      const draft = await loadDraft(provider.id, tabState.path);
      const hasDraft = draft !== null && draft.content !== providerDocument.content;
      const externallyChanged = hasDraft && draft.baseRevision.id !== providerDocument.revision.id;
      tabs.push({
        ...providerDocument,
        content: hasDraft ? draft.content : providerDocument.content,
        format: draft?.format ?? providerDocument.format,
        revision: draft?.baseRevision ?? providerDocument.revision,
        cursor: draft?.cursor ?? tabState.cursor,
        viewMode: tabState.viewMode,
        saveState: externallyChanged ? "conflicted" : hasDraft ? "dirty-local" : "clean",
      });
    } catch {
      const draft = await loadDraft(provider.id, tabState.path);
      if (draft) tabs.push({ path: draft.path, content: draft.content, format: draft.format, revision: draft.baseRevision, cursor: draft.cursor, viewMode: tabState.viewMode, saveState: "conflicted" });
    }
  }
  const activePath = tabs.some((tab) => tab.path === session?.activePath) ? session?.activePath ?? null : tabs.at(-1)?.path ?? null;
  set({ provider, entries, tabs, activePath, selectedPath: session?.selectedPath ?? activePath, isOpening: false, isIndexing: true, resumableWorkspace: null, error: null, lastTrash: null });
  void indexWorkspace(provider, entries, (_documents, diagnostics) => {
    if (get().provider?.id === provider.id) set({ diagnostics, isIndexing: false });
  });
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

  initialize: async () => {
    if (!("showDirectoryPicker" in window)) return;
    set({ isOpening: true });
    try {
      const stored = await loadLastWorkspace();
      if (!stored) {
        set({ isOpening: false });
        return;
      }
      set({ resumableWorkspace: stored });
      await activateProvider(await reopenLocalWorkspace(stored.handle, stored.id), set, get);
    } catch (error) {
      const permissionError = error instanceof WorkspaceError && error.code === "permission";
      set({ isOpening: false, error: permissionError ? null : errorMessage(error) });
    }
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

  openDriveWorkspace: async (reference) => {
    set({ isOpening: true, error: null });
    try {
      await get().flushDurableDrafts();
      const provider = new DriveWorkspaceProvider({
        workspaceId: reference.id,
        folderId: reference.folderId,
        displayName: reference.displayName,
        tokenProvider: { getAccessToken: () => getDriveAccessToken(reference.connectedAccountId) },
        mirror: createDriveMirror(reference.connectedAccountId, reference.id),
      });
      await activateProvider(provider, set, get);
    } catch (error) {
      set({ isOpening: false, error: errorMessage(error) });
    }
  },

  refreshEntries: async () => {
    const provider = get().provider;
    if (!provider) return;
    try {
      const entries = await provider.listEntries();
      set({ entries, error: null, isIndexing: true });
      void indexWorkspace(provider, entries, (_documents, diagnostics) => {
        if (get().provider?.id === provider.id) set({ diagnostics, isIndexing: false });
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
      const providerDocument = await state.provider.readDocument(path);
      const draft = await loadDraft(state.provider.id, path);
      const hasDraft = draft !== null && draft.content !== providerDocument.content;
      const document: OpenDocument = {
        ...providerDocument,
        content: hasDraft ? draft.content : providerDocument.content,
        format: draft?.format ?? providerDocument.format,
        revision: draft?.baseRevision ?? providerDocument.revision,
        cursor: draft?.cursor ?? 0,
        viewMode: "editor",
        saveState: hasDraft && draft.baseRevision.id !== providerDocument.revision.id ? "conflicted" : hasDraft ? "dirty-local" : "clean",
      };
      set((current) => ({ tabs: [...current.tabs, document], activePath: path, selectedPath: path, error: null }));
      indexSearchDocument(path, document.content);
      scheduleSession(get);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeDocument: (path) => {
    const closingState = get();
    const closingDocument = closingState.tabs.find((tab) => tab.path === path);
    if (closingState.provider && closingDocument && closingDocument.saveState !== "clean") void persistDocument(closingState.provider.id, closingDocument);
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
    set((state) => ({
      tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, content, cursor, saveState: tab.content === content ? tab.saveState : "dirty-local" } : tab),
    }));
    indexSearchDocument(path, content);
    scheduleDraft(get, path);
    scheduleSession(get);
  },

  setViewMode: (path, viewMode) => {
    set((state) => ({ tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, viewMode } : tab) }));
    scheduleSession(get);
  },

  saveDocument: async (path) => {
    const state = get();
    const provider = state.provider;
    const snapshot = state.tabs.find((tab) => tab.path === path);
    if (!provider || !snapshot || snapshot.saveState === "clean" || snapshot.saveState === "persisting-local" || snapshot.saveState === "conflicted") return;
    const timer = draftTimers.get(path);
    if (timer) window.clearTimeout(timer);
    draftTimers.delete(path);
    try {
      await persistDocument(provider.id, snapshot);
      await checkpoint(provider.id, snapshot, "provider-save");
      set((current) => ({ tabs: current.tabs.map((tab) => tab.path === path ? { ...tab, saveState: "persisting-local" } : tab) }));
      const revision = await provider.writeDocument({ path, content: snapshot.content, format: snapshot.format, expectedRevision: snapshot.revision });
      set((current) => ({
        tabs: current.tabs.map((tab) => tab.path === path ? { ...tab, revision, saveState: tab.content === snapshot.content ? "clean" : "dirty-local" } : tab),
        error: null,
      }));
      if (get().tabs.find((tab) => tab.path === path)?.content === snapshot.content) await deleteDraft(provider.id, path);
    } catch (error) {
      const saveState: DocumentSaveState = error instanceof WorkspaceError && error.code === "conflict" ? "conflicted" : "error-blocking";
      set((current) => ({ tabs: current.tabs.map((tab) => tab.path === path ? { ...tab, saveState } : tab), error: errorMessage(error) }));
    }
  },

  createDocument: async (path) => {
    const provider = get().provider;
    if (!provider) return;
    try {
      const document = await provider.createDocument(path, "# Untitled\n");
      await get().refreshEntries();
      set((state) => ({ tabs: [...state.tabs, { ...document, cursor: document.content.length, viewMode: "editor", saveState: "clean" }], activePath: document.path, selectedPath: document.path, error: null }));
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
      for (const document of originals) await checkpoint(provider.id, { ...document, cursor: 0, viewMode: "editor", saveState: "clean" }, "provider-save");
      await provider.move(sourcePath, destinationPath);
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
    if (!state.provider) return;
    for (const tab of state.tabs) {
      try {
        const external = await state.provider.readDocument(tab.path);
        if (external.revision.id === tab.revision.id) continue;
        if (tab.saveState === "clean") {
          await checkpoint(state.provider.id, tab, "external-change");
          set((current) => ({ tabs: current.tabs.map((item) => item.path === tab.path ? { ...external, cursor: Math.min(item.cursor, external.content.length), viewMode: item.viewMode, saveState: "clean" } : item) }));
          indexSearchDocument(tab.path, external.content);
        } else {
          await persistDocument(state.provider.id, tab);
          set((current) => ({ tabs: current.tabs.map((item) => item.path === tab.path ? { ...item, saveState: "conflicted" } : item), error: `${tab.path} changed outside NoteMarkdown. Your local draft was preserved.` }));
        }
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "not-found") {
          await persistDocument(state.provider.id, tab);
          set((current) => ({ tabs: current.tabs.map((item) => item.path === tab.path ? { ...item, saveState: "conflicted" } : item), error: `${tab.path} was removed outside NoteMarkdown. Your local draft was preserved.` }));
        }
      }
    }
  },

  getHistory: async (path) => {
    const provider = get().provider;
    return provider ? loadHistory(provider.id, path) : [];
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
