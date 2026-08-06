import type {
  DocumentFormat,
  WorkspaceEntry,
  WorkspaceMetadataFingerprint,
  WorkspaceRevision,
  WorkspaceDocument,
} from "@note/workspace-core";
import { openDatabase } from "./legacy";

export type RepositoryProviderType = "local" | "drive";

export interface RepositoryWorkspaceReference {
  id: string;
  name: string;
  providerType: RepositoryProviderType;
  connectedAccountId?: string;
  providerWorkspaceId?: string;
  folderId?: string;
  handle?: FileSystemDirectoryHandle;
  salt: string;
  lastOpenedAt: number;
}

export interface ManifestEntry {
  workspaceId: string;
  entryId: string;
  path: string;
  kind: "directory" | "document" | "image";
  parentEntryId?: string;
  observedProviderRevision?: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  state: "live" | "possibly-removed" | "removed" | "path-collision";
  updatedAt: number;
}

export interface WorkspaceManifest {
  workspaceId: string;
  entries: ManifestEntry[];
  generation: number;
  updatedAt: number;
}

export interface CachedDocument {
  workspaceId: string;
  entryId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  cachedContentRevision: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  indexRevision?: string;
  diagnosticsGeneration?: string;
  lastAccessedAt: number;
}

export interface RepositoryDraft {
  workspaceId: string;
  entryId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  baseRevision: WorkspaceRevision;
  cursor: number;
  updatedAt: number;
}

export interface RepositoryHistoryEntry extends RepositoryDraft {
  id: string;
  reason: "autosave" | "provider-save" | "external-change" | "restore";
}

export interface PendingDocumentWrite {
  id: string;
  workspaceId: string;
  entryId: string;
  targetPath: string;
  expectedBaseRevision: WorkspaceRevision;
  draftRevision: string;
  state: "pending" | "in-flight" | "retryable" | "conflicted" | "applied";
  attempt: number;
  retryAt?: number;
}

export interface DocumentConflict {
  id: string;
  workspaceId: string;
  entryId: string;
  path: string;
  baseContent?: string;
  localContent: string;
  remoteContent: string;
  baseRevision: WorkspaceRevision;
  remoteRevision: WorkspaceRevision;
  createdAt: number;
}

export interface RecoveryItem {
  id: string;
  workspaceId: string;
  formerEntryId: string;
  formerPath: string;
  content: string;
  format: DocumentFormat;
  baseRevision: WorkspaceRevision;
  reason: "provider-removed";
  createdAt: number;
}

export interface WorkspaceSyncState {
  workspaceId: string;
  providerType: RepositoryProviderType;
  driveChangeToken?: string;
  lastFullScanAt?: number;
  lastReconciledAt?: number;
}

export interface RepositorySession {
  workspaceId: string;
  activeEntryId: string | null;
  selectedEntryId: string | null;
  tabs: Array<{ entryId: string; path: string; cursor: number; viewMode: "editor" | "preview" }>;
  updatedAt: number;
}

export interface RepositoryPathMove {
  entryId: string;
  previousPath: string;
  nextPath: string;
}

export interface StoragePressure {
  persisted: boolean;
  usage?: number;
  quota?: number;
}

interface KeyRecord {
  connectedAccountId: string;
  key: CryptoKey;
}

interface ProtectedRecord {
  workspaceId: string;
  recordKey?: string;
  encrypted: boolean;
  nonce?: ArrayBuffer;
  ciphertext?: ArrayBuffer;
  payload?: unknown;
}

interface MigrationState {
  workspaceId: string;
  version: number;
  completedSteps: string[];
  updatedAt: number;
}

interface QuarantineRecord {
  id: string;
  workspaceId: string;
  storeName: string;
  recordKey: string;
  reason: "decrypt" | "shape" | "migration";
  createdAt: number;
}

const listeners = new Set<(workspaceId: string, generation: number) => void>();

/**
 * Resolves one IndexedDB request.
 * @param request Browser database request.
 * @returns Request result.
 */
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage operation failed."));
  });
}

/**
 * Waits for a browser transaction to commit.
 * @param transaction IndexedDB transaction.
 * @returns Nothing after durable completion.
 */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage transaction was aborted."));
  });
}

/**
 * Converts random bytes to a compact opaque salt.
 * @returns Browser-generated workspace salt.
 */
function createSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Produces an opaque record lookup key without exposing provider identity.
 * @param salt Workspace-specific random salt.
 * @param identity Sensitive stable identity.
 * @returns Hex SHA-256 lookup key.
 */
async function opaqueKey(salt: string, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${identity}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Loads one repository workspace envelope.
 * @param workspaceId Stable app workspace identity.
 * @returns Workspace envelope or null.
 */
export async function loadRepositoryWorkspace(workspaceId: string): Promise<RepositoryWorkspaceReference | null> {
  const database = await openDatabase();
  try {
    return await result(database.transaction("repositoryWorkspaces").objectStore("repositoryWorkspaces").get(workspaceId)) as RepositoryWorkspaceReference | undefined ?? null;
  } finally {
    database.close();
  }
}

/**
 * Loads the most recently opened repository workspace.
 * @returns Last workspace envelope or null.
 */
export async function loadLastRepositoryWorkspace(): Promise<RepositoryWorkspaceReference | null> {
  const database = await openDatabase();
  try {
    const records = await result(database.transaction("repositoryWorkspaces").objectStore("repositoryWorkspaces").getAll()) as RepositoryWorkspaceReference[];
    return records.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)[0] ?? null;
  } finally {
    database.close();
  }
}

/**
 * Registers or updates a minimum unencrypted workspace lookup envelope.
 * @param reference Provider lookup information; sensitive Drive paths remain in protected records.
 * @returns Stored envelope with stable random salt.
 */
export async function registerRepositoryWorkspace(
  reference: Omit<RepositoryWorkspaceReference, "salt"> & { salt?: string },
): Promise<RepositoryWorkspaceReference> {
  const current = await loadRepositoryWorkspace(reference.id);
  const stored: RepositoryWorkspaceReference = {
    ...reference,
    name: reference.providerType === "drive" ? "Drive workspace" : reference.name,
    salt: current?.salt ?? reference.salt ?? createSalt(),
  };
  const database = await openDatabase();
  try {
    const transaction = database.transaction("repositoryWorkspaces", "readwrite");
    transaction.objectStore("repositoryWorkspaces").put(stored);
    await completed(transaction);
  } finally {
    database.close();
  }
  return stored;
}

/**
 * Loads or creates a non-extractable account encryption key.
 * @param connectedAccountId Connected account identity.
 * @param create Whether a missing key may be created.
 * @returns Active AES-GCM key or null while explicitly locked.
 */
async function accountKey(connectedAccountId: string, create: boolean): Promise<CryptoKey | null> {
  const database = await openDatabase();
  try {
    const existing = await result(database.transaction("driveKeys").objectStore("driveKeys").get(connectedAccountId)) as KeyRecord | undefined;
    if (existing) return existing.key;
  } finally {
    database.close();
  }
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const writeDatabase = await openDatabase();
  try {
    const transaction = writeDatabase.transaction("driveKeys", "readwrite");
    transaction.objectStore("driveKeys").put({ connectedAccountId, key } satisfies KeyRecord);
    await completed(transaction);
  } finally {
    writeDatabase.close();
  }
  return key;
}

/**
 * Encodes local data plainly or Drive data as authenticated ciphertext.
 * @param envelope Workspace protection envelope.
 * @param storeName Destination store name.
 * @param recordKey Opaque record identity.
 * @param payload Sensitive repository payload.
 * @returns IndexedDB-safe protected record.
 */
async function protect<T>(
  envelope: RepositoryWorkspaceReference,
  storeName: string,
  recordKey: string,
  payload: T,
): Promise<ProtectedRecord> {
  if (envelope.providerType === "local") return { workspaceId: envelope.id, recordKey, encrypted: false, payload };
  if (!envelope.connectedAccountId) throw new Error("Drive repository encryption account is unavailable.");
  const key = await accountKey(envelope.connectedAccountId, true);
  if (!key) throw new Error("Drive repository is locked.");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`${storeName}:${envelope.id}:${recordKey}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { workspaceId: envelope.id, recordKey, encrypted: true, nonce: nonce.buffer as ArrayBuffer, ciphertext };
}

/**
 * Isolates a corrupt record without exposing its payload.
 * @param workspaceId Workspace owning the record.
 * @param storeName Source store.
 * @param recordKey Opaque lookup key.
 * @param reason Stable corruption category.
 * @returns Nothing after quarantine metadata commits.
 */
async function quarantine(workspaceId: string, storeName: string, recordKey: string, reason: QuarantineRecord["reason"]): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("quarantine", "readwrite");
    transaction.objectStore("quarantine").put({
      id: `${workspaceId}:${storeName}:${recordKey}:${crypto.randomUUID()}`,
      workspaceId,
      storeName,
      recordKey,
      reason,
      createdAt: Date.now(),
    } satisfies QuarantineRecord);
    await completed(transaction);
  } finally {
    database.close();
  }
}

/**
 * Decodes one protected repository record.
 * @param envelope Workspace protection envelope.
 * @param storeName Source store name.
 * @param recordKey Opaque record identity.
 * @param record Stored envelope.
 * @returns Decoded payload or null when locked/corrupt.
 */
async function unprotect<T>(
  envelope: RepositoryWorkspaceReference,
  storeName: string,
  recordKey: string,
  record: ProtectedRecord | undefined,
): Promise<T | null> {
  if (!record) return null;
  if (!record.encrypted) return record.payload as T;
  if (!envelope.connectedAccountId || !record.nonce || !record.ciphertext) {
    await quarantine(envelope.id, storeName, recordKey, "shape");
    return null;
  }
  const key = await accountKey(envelope.connectedAccountId, false);
  if (!key) return null;
  try {
    const additionalData = new TextEncoder().encode(`${storeName}:${envelope.id}:${recordKey}`);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.nonce, additionalData }, key, record.ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    await quarantine(envelope.id, storeName, recordKey, "decrypt");
    return null;
  }
}

/**
 * Stores one protected record.
 * @param storeName Repository store.
 * @param workspaceId Workspace identity.
 * @param sensitiveIdentity Stable sensitive identity used only before hashing.
 * @param payload Record payload.
 * @returns Opaque record key.
 */
async function putProtected<T>(storeName: string, workspaceId: string, sensitiveIdentity: string, payload: T): Promise<string> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) throw new Error(`Repository workspace ${workspaceId} is not registered.`);
  const recordKey = await opaqueKey(envelope.salt, sensitiveIdentity);
  const record = await protect(envelope, storeName, recordKey, payload);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    await completed(transaction);
  } finally {
    database.close();
  }
  return recordKey;
}

/**
 * Loads one protected record by sensitive identity.
 * @param storeName Repository store.
 * @param workspaceId Workspace identity.
 * @param sensitiveIdentity Stable identity hashed before lookup.
 * @returns Decoded payload or null.
 */
async function getProtected<T>(storeName: string, workspaceId: string, sensitiveIdentity: string): Promise<T | null> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) return null;
  const recordKey = await opaqueKey(envelope.salt, sensitiveIdentity);
  const database = await openDatabase();
  let record: ProtectedRecord | undefined;
  try {
    record = await result(database.transaction(storeName).objectStore(storeName).get([workspaceId, recordKey])) as ProtectedRecord | undefined;
  } finally {
    database.close();
  }
  return unprotect<T>(envelope, storeName, recordKey, record);
}

/**
 * Loads all protected records belonging to a workspace.
 * @param storeName Repository store.
 * @param workspaceId Workspace identity.
 * @returns Independently decoded records; corrupt records are skipped.
 */
async function getAllProtected<T>(storeName: string, workspaceId: string): Promise<T[]> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) return [];
  const database = await openDatabase();
  let records: ProtectedRecord[];
  try {
    records = (await result(database.transaction(storeName).objectStore(storeName).getAll()) as ProtectedRecord[])
      .filter((record) => record.workspaceId === workspaceId);
  } finally {
    database.close();
  }
  const decoded: T[] = [];
  for (const record of records) {
    const value = await unprotect<T>(envelope, storeName, record.recordKey ?? "", record);
    if (value !== null) decoded.push(value);
  }
  return decoded;
}

/**
 * Maps provider entries into durable manifest facts.
 * @param workspaceId Workspace identity.
 * @param entries Hierarchical provider entries.
 * @param updatedAt Observation timestamp.
 * @returns Flat manifest records retaining stable IDs.
 */
export function createManifestEntries(workspaceId: string, entries: WorkspaceEntry[], updatedAt = Date.now()): ManifestEntry[] {
  return entries.flatMap((entry) => {
    const record: ManifestEntry = {
      workspaceId,
      entryId: entry.entryId ?? entry.path,
      path: entry.path,
      kind: entry.kind,
      parentEntryId: entry.parentEntryId,
      observedProviderRevision: entry.revision,
      metadataFingerprint: entry.metadataFingerprint,
      state: entry.state ?? "live",
      updatedAt,
    };
    return [record, ...createManifestEntries(workspaceId, entry.children ?? [], updatedAt)];
  });
}

/**
 * Reconstructs a hierarchical workspace tree from flat manifest records.
 * @param records Flat manifest records.
 * @returns Deterministically nested entries.
 */
export function manifestToWorkspaceEntries(records: ManifestEntry[]): WorkspaceEntry[] {
  const byParent = new Map<string | undefined, ManifestEntry[]>();
  const knownIds = new Set(records.map((record) => record.entryId));
  for (const record of records.filter((item) => item.state !== "removed")) {
    const parent = record.parentEntryId && knownIds.has(record.parentEntryId) ? record.parentEntryId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), record]);
  }
  const build = (parent?: string): WorkspaceEntry[] => (byParent.get(parent) ?? [])
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((record) => ({
      kind: record.kind,
      name: record.path.split("/").at(-1) ?? record.path,
      path: record.path,
      entryId: record.entryId,
      parentEntryId: record.parentEntryId,
      revision: record.observedProviderRevision,
      metadataFingerprint: record.metadataFingerprint,
      state: record.state,
      children: record.kind === "directory" ? build(record.entryId) : undefined,
    }));
  return build();
}

/**
 * Commits a complete observed manifest without changing cached content revisions.
 * @param manifest Manifest generation and observed provider facts.
 * @returns Nothing after durable commit.
 */
export async function saveWorkspaceManifest(manifest: WorkspaceManifest): Promise<void> {
  await putProtected("workspaceManifests", manifest.workspaceId, "manifest", manifest);
  for (const listener of listeners) listener(manifest.workspaceId, manifest.generation);
}

/**
 * Loads the last durable workspace manifest.
 * @param workspaceId Workspace identity.
 * @returns Manifest or null when absent, locked, or corrupt.
 */
export async function loadWorkspaceManifest(workspaceId: string): Promise<WorkspaceManifest | null> {
  return getProtected("workspaceManifests", workspaceId, "manifest");
}

/**
 * Atomically commits content with its exact cached provider revision.
 * @param document Cached document record.
 * @returns Nothing after content and revision commit together.
 */
export async function commitCachedDocument(document: CachedDocument): Promise<void> {
  await putProtected("cachedDocuments", document.workspaceId, document.entryId, document);
}

/**
 * Advances an index revision only after matching content is already durable.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @param cachedContentRevision Revision acknowledged by the index worker.
 * @returns Whether the matching durable record advanced.
 */
export async function acknowledgeIndexRevision(
  workspaceId: string,
  entryId: string,
  cachedContentRevision: string,
): Promise<boolean> {
  const document = await loadCachedDocument(workspaceId, entryId);
  if (!document || document.cachedContentRevision.id !== cachedContentRevision) return false;
  await commitCachedDocument({ ...document, indexRevision: cachedContentRevision });
  return true;
}

/**
 * Loads one cached document by stable entry identity.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @returns Cached document or null.
 */
export async function loadCachedDocument(workspaceId: string, entryId: string): Promise<CachedDocument | null> {
  return getProtected("cachedDocuments", workspaceId, entryId);
}

/**
 * Loads all independently valid cached documents for warm search/index restoration.
 * @param workspaceId Workspace identity.
 * @returns Cached documents, excluding isolated corruption.
 */
export async function loadCachedDocuments(workspaceId: string): Promise<CachedDocument[]> {
  return getAllProtected("cachedDocuments", workspaceId);
}

/**
 * Persists an encrypted or permission-gated repository draft.
 * @param draft Durable editor buffer.
 * @returns Nothing after local durability.
 */
export async function saveRepositoryDraft(draft: RepositoryDraft): Promise<void> {
  await putProtected("repositoryDrafts", draft.workspaceId, draft.entryId, draft);
}

/**
 * Loads a repository draft by stable entry identity.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @returns Draft or null.
 */
export async function loadRepositoryDraft(workspaceId: string, entryId: string): Promise<RepositoryDraft | null> {
  return getProtected("repositoryDrafts", workspaceId, entryId);
}

/**
 * Deletes a protected record by sensitive identity.
 * @param storeName Repository store.
 * @param workspaceId Workspace identity.
 * @param sensitiveIdentity Stable identity hashed before deletion.
 * @returns Nothing after deletion.
 */
async function deleteProtected(storeName: string, workspaceId: string, sensitiveIdentity: string): Promise<void> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) return;
  const recordKey = await opaqueKey(envelope.salt, sensitiveIdentity);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete([workspaceId, recordKey]);
    await completed(transaction);
  } finally {
    database.close();
  }
}

/**
 * Removes a draft after provider durability is confirmed.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @returns Nothing after commit.
 */
export async function deleteRepositoryDraft(workspaceId: string, entryId: string): Promise<void> {
  await deleteProtected("repositoryDrafts", workspaceId, entryId);
}

/**
 * Persists a protected history checkpoint.
 * @param entry Durable document history entry.
 * @returns Nothing after commit.
 */
export async function saveRepositoryHistory(entry: RepositoryHistoryEntry): Promise<void> {
  await putProtected("repositoryHistory", entry.workspaceId, entry.id, entry);
  const records = (await getAllProtected<RepositoryHistoryEntry>("repositoryHistory", entry.workspaceId))
    .filter((record) => record.entryId === entry.entryId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const obsolete of records.slice(120)) await deleteProtected("repositoryHistory", entry.workspaceId, obsolete.id);
}

/**
 * Loads newest-first protected history for one stable entry.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @returns Bounded matching history.
 */
export async function loadRepositoryHistory(workspaceId: string, entryId: string): Promise<RepositoryHistoryEntry[]> {
  const records = await getAllProtected<RepositoryHistoryEntry>("repositoryHistory", workspaceId);
  return records.filter((entry) => entry.entryId === entryId).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 120);
}

/**
 * Persists an idempotent pending write before provider mutation starts.
 * @param pendingWrite Durable outbox item.
 * @returns Nothing after commit.
 */
export async function savePendingWrite(pendingWrite: PendingDocumentWrite): Promise<void> {
  await putProtected("pendingWrites", pendingWrite.workspaceId, pendingWrite.id, pendingWrite);
}

/**
 * Lists non-rebuildable pending writes for one workspace.
 * @param workspaceId Workspace identity.
 * @returns Durable outbox items.
 */
export async function loadPendingWrites(workspaceId: string): Promise<PendingDocumentWrite[]> {
  return getAllProtected("pendingWrites", workspaceId);
}

/**
 * Updates one pending-write state without acknowledging unknown mutations.
 * @param pendingWrite Updated durable outbox item.
 * @returns Nothing after commit.
 */
export async function updatePendingWrite(pendingWrite: PendingDocumentWrite): Promise<void> {
  await savePendingWrite(pendingWrite);
}

/**
 * Atomically commits provider-confirmed content and marks its pending write applied.
 * @param document Cached provider-confirmed document.
 * @param pendingWrite Matching pending write.
 * @returns Nothing after both protected records commit.
 */
export async function commitDocumentAndAcknowledgeWrite(
  document: CachedDocument,
  pendingWrite: PendingDocumentWrite,
): Promise<void> {
  const envelope = await loadRepositoryWorkspace(document.workspaceId);
  if (!envelope) throw new Error("Repository workspace is unavailable.");
  const documentKey = await opaqueKey(envelope.salt, document.entryId);
  const pendingKey = await opaqueKey(envelope.salt, pendingWrite.id);
  const documentRecord = await protect(envelope, "cachedDocuments", documentKey, document);
  const appliedRecord = await protect(envelope, "pendingWrites", pendingKey, { ...pendingWrite, state: "applied" });
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["cachedDocuments", "pendingWrites"], "readwrite");
    transaction.objectStore("cachedDocuments").put(documentRecord);
    transaction.objectStore("pendingWrites").put(appliedRecord);
    await completed(transaction);
  } finally {
    database.close();
  }
}

/**
 * Persists all three conflict inputs for later merge UI.
 * @param conflict Durable conflict record.
 * @returns Nothing after commit.
 */
export async function saveConflict(conflict: DocumentConflict): Promise<void> {
  await putProtected("conflicts", conflict.workspaceId, conflict.id, conflict);
}

/**
 * Lists durable conflicts for one workspace.
 * @param workspaceId Workspace identity.
 * @returns Conflict records.
 */
export async function loadConflicts(workspaceId: string): Promise<DocumentConflict[]> {
  return getAllProtected("conflicts", workspaceId);
}

/**
 * Persists a destroyed dirty draft before its tab can close.
 * @param item Provider-removal recovery record.
 * @returns Nothing after durable commit.
 */
export async function saveRecoveryItem(item: RecoveryItem): Promise<void> {
  await putProtected("recoveryItems", item.workspaceId, item.id, item);
}

/**
 * Lists persistent provider-removal recovery items.
 * @param workspaceId Workspace identity.
 * @returns Recovery items ordered newest first.
 */
export async function loadRecoveryItems(workspaceId: string): Promise<RecoveryItem[]> {
  const records = await getAllProtected<RecoveryItem>("recoveryItems", workspaceId);
  return records.sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * Explicitly removes one recovery item after restore or confirmed deletion.
 * @param workspaceId Workspace identity.
 * @param id Recovery identity.
 * @returns Nothing after commit.
 */
export async function deleteRecoveryItem(workspaceId: string, id: string): Promise<void> {
  await deleteProtected("recoveryItems", workspaceId, id);
}

/**
 * Atomically updates path-derived repository state for a stable entry move.
 * @param workspaceId Workspace identity.
 * @param entryId Stable provider entry identity.
 * @param destinationPath Newly observed path.
 * @returns Nothing after manifest, cache, draft, session, and pending targets commit together.
 */
export async function moveRepositoryEntry(workspaceId: string, entryId: string, destinationPath: string): Promise<void> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) return;
  const manifest = await loadWorkspaceManifest(workspaceId);
  const document = await loadCachedDocument(workspaceId, entryId);
  const draft = await loadRepositoryDraft(workspaceId, entryId);
  const session = await loadRepositorySession(workspaceId);
  const pendingWrites = (await loadPendingWrites(workspaceId)).filter((pending) => pending.entryId === entryId && pending.state !== "applied");
  const records: Array<{ storeName: string; value: ProtectedRecord }> = [];

  if (manifest) {
    const recordKey = await opaqueKey(envelope.salt, "manifest");
    const next = { ...manifest, entries: manifest.entries.map((entry) => entry.entryId === entryId ? { ...entry, path: destinationPath, updatedAt: Date.now() } : entry) };
    records.push({ storeName: "workspaceManifests", value: await protect(envelope, "workspaceManifests", recordKey, next) });
  }
  if (document) {
    const recordKey = await opaqueKey(envelope.salt, entryId);
    records.push({ storeName: "cachedDocuments", value: await protect(envelope, "cachedDocuments", recordKey, { ...document, path: destinationPath }) });
  }
  if (draft) {
    const recordKey = await opaqueKey(envelope.salt, entryId);
    records.push({ storeName: "repositoryDrafts", value: await protect(envelope, "repositoryDrafts", recordKey, { ...draft, path: destinationPath }) });
  }
  if (session) {
    const recordKey = await opaqueKey(envelope.salt, "session");
    const next = { ...session, tabs: session.tabs.map((tab) => tab.entryId === entryId ? { ...tab, path: destinationPath } : tab) };
    records.push({ storeName: "repositorySessions", value: await protect(envelope, "repositorySessions", recordKey, next) });
  }
  for (const pending of pendingWrites) {
    const recordKey = await opaqueKey(envelope.salt, pending.id);
    records.push({ storeName: "pendingWrites", value: await protect(envelope, "pendingWrites", recordKey, { ...pending, targetPath: destinationPath }) });
  }
  if (records.length === 0) return;
  const storeNames = Array.from(new Set(records.map((record) => record.storeName)));
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeNames, "readwrite");
    for (const record of records) transaction.objectStore(record.storeName).put(record.value);
    await completed(transaction);
  } finally {
    database.close();
  }
}

/**
 * Persists a protected workspace session.
 * @param session Stable-ID based tab and selection state.
 * @returns Nothing after commit.
 */
export async function saveRepositorySession(session: RepositorySession): Promise<void> {
  await putProtected("repositorySessions", session.workspaceId, "session", session);
}

/**
 * Loads a protected workspace session.
 * @param workspaceId Workspace identity.
 * @returns Session or null.
 */
export async function loadRepositorySession(workspaceId: string): Promise<RepositorySession | null> {
  return getProtected("repositorySessions", workspaceId, "session");
}

/**
 * Persists provider sync cursor and reconciliation timestamps.
 * @param state Workspace sync state.
 * @returns Nothing after commit.
 */
export async function saveWorkspaceSyncState(state: WorkspaceSyncState): Promise<void> {
  await putProtected("workspaceSyncStates", state.workspaceId, "sync-state", state);
}

/**
 * Atomically commits one applied provider-change page, cursor, and path-derived records.
 * @param manifest Complete manifest after applying the page.
 * @param state Sync cursor that follows exactly that page.
 * @param moves Stable-ID path moves discovered in the page.
 * @returns Nothing after all protected records commit in one transaction.
 */
export async function commitWorkspaceChangePage(
  manifest: WorkspaceManifest,
  state: WorkspaceSyncState,
  moves: readonly RepositoryPathMove[],
): Promise<void> {
  const envelope = await loadRepositoryWorkspace(manifest.workspaceId);
  if (!envelope) throw new Error("Repository workspace is unavailable.");
  const moveByEntryId = new Map(moves.map((move) => [move.entryId, move]));
  const records: Array<{ storeName: string; value: ProtectedRecord }> = [];
  const manifestKey = await opaqueKey(envelope.salt, "manifest");
  const syncKey = await opaqueKey(envelope.salt, "sync-state");
  records.push({ storeName: "workspaceManifests", value: await protect(envelope, "workspaceManifests", manifestKey, manifest) });
  records.push({ storeName: "workspaceSyncStates", value: await protect(envelope, "workspaceSyncStates", syncKey, state) });

  const [documents, drafts, pendingWrites, session] = await Promise.all([
    loadCachedDocuments(manifest.workspaceId),
    getAllProtected<RepositoryDraft>("repositoryDrafts", manifest.workspaceId),
    loadPendingWrites(manifest.workspaceId),
    loadRepositorySession(manifest.workspaceId),
  ]);
  for (const document of documents) {
    const move = moveByEntryId.get(document.entryId);
    if (!move) continue;
    const recordKey = await opaqueKey(envelope.salt, document.entryId);
    records.push({ storeName: "cachedDocuments", value: await protect(envelope, "cachedDocuments", recordKey, { ...document, path: move.nextPath }) });
  }
  for (const draft of drafts) {
    const move = moveByEntryId.get(draft.entryId);
    if (!move) continue;
    const recordKey = await opaqueKey(envelope.salt, draft.entryId);
    records.push({ storeName: "repositoryDrafts", value: await protect(envelope, "repositoryDrafts", recordKey, { ...draft, path: move.nextPath }) });
  }
  for (const pending of pendingWrites) {
    const move = moveByEntryId.get(pending.entryId);
    if (!move || pending.state === "applied") continue;
    const recordKey = await opaqueKey(envelope.salt, pending.id);
    records.push({ storeName: "pendingWrites", value: await protect(envelope, "pendingWrites", recordKey, { ...pending, targetPath: move.nextPath }) });
  }
  if (session && moves.length > 0) {
    const recordKey = await opaqueKey(envelope.salt, "session");
    const nextSession = {
      ...session,
      tabs: session.tabs.map((tab) => {
        const move = moveByEntryId.get(tab.entryId);
        return move ? { ...tab, path: move.nextPath } : tab;
      }),
    };
    records.push({ storeName: "repositorySessions", value: await protect(envelope, "repositorySessions", recordKey, nextSession) });
  }

  const storeNames = Array.from(new Set(records.map((record) => record.storeName)));
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeNames, "readwrite");
    for (const record of records) transaction.objectStore(record.storeName).put(record.value);
    await completed(transaction);
  } finally {
    database.close();
  }
  for (const listener of listeners) listener(manifest.workspaceId, manifest.generation);
}

/**
 * Loads provider sync state.
 * @param workspaceId Workspace identity.
 * @returns Sync state or null.
 */
export async function loadWorkspaceSyncState(workspaceId: string): Promise<WorkspaceSyncState | null> {
  return getProtected("workspaceSyncStates", workspaceId, "sync-state");
}

/**
 * Imports one revision-matched encrypted record from the retired Drive mirror.
 * @param workspaceId Central workspace identity.
 * @param entryId Stable provider entry identity.
 * @param path Current provider path.
 * @param observedRevision Current authoritative provider revision.
 * @returns Whether a valid matching record was imported.
 */
export async function importLegacyDriveMirror(
  workspaceId: string,
  entryId: string,
  path: string,
  observedRevision: WorkspaceRevision,
): Promise<boolean> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope?.connectedAccountId || !envelope.providerWorkspaceId) return false;
  const key = await accountKey(envelope.connectedAccountId, false);
  if (!key) return false;
  const database = await openDatabase();
  let record: { nonce: ArrayBuffer; ciphertext: ArrayBuffer } | undefined;
  try {
    record = await result(database.transaction("driveMirror").objectStore("driveMirror").get([envelope.providerWorkspaceId, path])) as typeof record;
  } finally {
    database.close();
  }
  if (!record) return false;
  try {
    const additionalData = new TextEncoder().encode(`${envelope.providerWorkspaceId}:${path}`);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.nonce, additionalData }, key, record.ciphertext);
    const document = JSON.parse(new TextDecoder().decode(plaintext)) as WorkspaceDocument;
    if (document.path !== path || document.revision.id !== observedRevision.id) return false;
    await commitCachedDocument({
      workspaceId,
      entryId,
      path,
      content: document.content,
      format: document.format,
      cachedContentRevision: document.revision,
      metadataFingerprint: document.metadataFingerprint,
      lastAccessedAt: Date.now(),
    });
    const verification = await loadCachedDocument(workspaceId, entryId);
    if (!verification || verification.cachedContentRevision.id !== observedRevision.id || verification.content !== document.content) return false;
    const cleanupDatabase = await openDatabase();
    try {
      const transaction = cleanupDatabase.transaction("driveMirror", "readwrite");
      transaction.objectStore("driveMirror").delete([envelope.providerWorkspaceId, path]);
      await completed(transaction);
    } finally {
      cleanupDatabase.close();
    }
    return true;
  } catch {
    await quarantine(workspaceId, "driveMirror", await opaqueKey(envelope.salt, entryId), "migration");
    return false;
  }
}

/**
 * Migrates non-rebuildable legacy records destination-first and purges plaintext Drive search sources.
 * @param workspaceId Central workspace identity.
 * @param identityByPath Stable provider identities keyed by current path.
 * @returns Nothing after independently resumable record migration.
 */
export async function migrateLegacyWorkspace(workspaceId: string, identityByPath: ReadonlyMap<string, string>): Promise<void> {
  const envelope = await loadRepositoryWorkspace(workspaceId);
  if (!envelope) return;
  const database = await openDatabase();
  let drafts: Array<{ workspaceId: string; path: string; content: string; format: DocumentFormat; baseRevision: WorkspaceRevision; cursor: number; updatedAt: number }> = [];
  let history: Array<{ id: string; workspaceId: string; path: string; content: string; format: DocumentFormat; baseRevision: WorkspaceRevision; cursor: number; updatedAt: number; reason: RepositoryHistoryEntry["reason"] }> = [];
  let sessions: Array<{ workspaceId: string; activePath: string | null; selectedPath: string | null; tabs: Array<{ path: string; cursor: number; viewMode: "editor" | "preview" }>; updatedAt: number }> = [];
  try {
    const transaction = database.transaction(["drafts", "history", "sessions"]);
    const draftsRequest = result(transaction.objectStore("drafts").getAll());
    const historyRequest = result(transaction.objectStore("history").getAll());
    const sessionsRequest = result(transaction.objectStore("sessions").getAll());
    drafts = ((await draftsRequest) as typeof drafts).filter((item) => item.workspaceId === workspaceId);
    history = ((await historyRequest) as typeof history).filter((item) => item.workspaceId === workspaceId);
    sessions = ((await sessionsRequest) as typeof sessions).filter((item) => item.workspaceId === workspaceId);
  } finally {
    database.close();
  }

  for (const draft of drafts) {
    try {
      const entryId = identityByPath.get(draft.path) ?? draft.path;
      const migrated = { ...draft, entryId };
      await saveRepositoryDraft(migrated);
      const verification = await loadRepositoryDraft(workspaceId, entryId);
      if (verification?.content !== draft.content || verification.baseRevision.id !== draft.baseRevision.id) continue;
      const cleanupDatabase = await openDatabase();
      try {
        const transaction = cleanupDatabase.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").delete([workspaceId, draft.path]);
        await completed(transaction);
      } finally {
        cleanupDatabase.close();
      }
    } catch {
      await quarantine(workspaceId, "drafts", await opaqueKey(envelope.salt, draft.path), "migration");
    }
  }

  for (const entry of history) {
    try {
      const entryId = identityByPath.get(entry.path) ?? entry.path;
      await saveRepositoryHistory({ ...entry, entryId });
      const verification = await loadRepositoryHistory(workspaceId, entryId);
      if (!verification.some((item) => item.id === entry.id && item.content === entry.content)) continue;
      const cleanupDatabase = await openDatabase();
      try {
        const transaction = cleanupDatabase.transaction("history", "readwrite");
        transaction.objectStore("history").delete(entry.id);
        await completed(transaction);
      } finally {
        cleanupDatabase.close();
      }
    } catch {
      await quarantine(workspaceId, "history", await opaqueKey(envelope.salt, entry.id), "migration");
    }
  }

  for (const session of sessions) {
    try {
      const migrated: RepositorySession = {
        workspaceId,
        activeEntryId: session.activePath ? identityByPath.get(session.activePath) ?? session.activePath : null,
        selectedEntryId: session.selectedPath ? identityByPath.get(session.selectedPath) ?? session.selectedPath : null,
        tabs: session.tabs.map((tab) => ({ ...tab, entryId: identityByPath.get(tab.path) ?? tab.path })),
        updatedAt: session.updatedAt,
      };
      await saveRepositorySession(migrated);
      const verification = await loadRepositorySession(workspaceId);
      if (!verification || verification.tabs.length !== migrated.tabs.length) continue;
      const cleanupDatabase = await openDatabase();
      try {
        const transaction = cleanupDatabase.transaction("sessions", "readwrite");
        transaction.objectStore("sessions").delete(workspaceId);
        await completed(transaction);
      } finally {
        cleanupDatabase.close();
      }
    } catch {
      await quarantine(workspaceId, "sessions", await opaqueKey(envelope.salt, "session"), "migration");
    }
  }

  if (envelope.providerType === "drive") {
    const cleanupDatabase = await openDatabase();
    try {
      const transaction = cleanupDatabase.transaction("searchDocuments", "readwrite");
      const store = transaction.objectStore("searchDocuments");
      const records = await result(store.getAll()) as Array<{ workspaceId: string; path: string }>;
      for (const record of records.filter((item) => item.workspaceId === workspaceId)) store.delete([record.workspaceId, record.path]);
      await completed(transaction);
    } finally {
      cleanupDatabase.close();
    }
  }
  await completeMigrationStep(workspaceId, "legacy-protected-records");
}

/**
 * Records an idempotent forward migration step.
 * @param workspaceId Workspace identity.
 * @param step Stable migration step name.
 * @returns Updated migration state.
 */
export async function completeMigrationStep(workspaceId: string, step: string): Promise<MigrationState> {
  const database = await openDatabase();
  try {
    const current = await result(database.transaction("migrationStates").objectStore("migrationStates").get(workspaceId)) as MigrationState | undefined;
    const next: MigrationState = {
      workspaceId,
      version: 4,
      completedSteps: Array.from(new Set([...(current?.completedSteps ?? []), step])),
      updatedAt: Date.now(),
    };
    const transaction = database.transaction("migrationStates", "readwrite");
    transaction.objectStore("migrationStates").put(next);
    await completed(transaction);
    return next;
  } finally {
    database.close();
  }
}

/**
 * Subscribes to committed manifest generations.
 * @param listener Framework-independent storage event consumer.
 * @returns Unsubscribe callback.
 */
export function subscribeStorageEvents(listener: (workspaceId: string, generation: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Evicts least-recently-used clean unopened content under browser quota pressure.
 * @param workspaceId Workspace identity.
 * @param protectedEntryIds Open or otherwise protected stable entry identities.
 * @param targetRatio Usage ratio below which cleanup stops.
 * @returns Number of rebuildable document records removed.
 */
export async function cleanupRebuildableCache(
  workspaceId: string,
  protectedEntryIds: ReadonlySet<string>,
  targetRatio = 0.75,
): Promise<number> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (!estimate?.usage || !estimate.quota || estimate.usage / estimate.quota < 0.85) return 0;
  const documents = (await loadCachedDocuments(workspaceId))
    .filter((document) => !protectedEntryIds.has(document.entryId))
    .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
  let removed = 0;
  let projectedUsage = estimate.usage;
  for (const document of documents) {
    if (projectedUsage / estimate.quota <= targetRatio) break;
    await deleteProtected("cachedDocuments", workspaceId, document.entryId);
    projectedUsage = Math.max(0, projectedUsage - new Blob([document.content]).size);
    removed += 1;
  }
  return removed;
}

/**
 * Requests durable browser storage and reports coarse quota state.
 * @returns Persistence and estimate result without workspace details.
 */
export async function inspectStoragePressure(): Promise<StoragePressure> {
  const persisted = await navigator.storage?.persist?.().catch(() => false) ?? false;
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return { persisted, usage: estimate?.usage, quota: estimate?.quota };
}

/**
 * Locks every encrypted Drive repository while retaining ciphertext.
 * @returns Nothing after active keys are removed.
 */
export async function lockDriveRepositories(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("driveKeys", "readwrite");
    transaction.objectStore("driveKeys").clear();
    await completed(transaction);
  } finally {
    database.close();
  }
}
