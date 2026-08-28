import {
  WorkspaceError,
  ensureMarkdownPath,
  supportedImageExtensions,
  type DocumentFormat,
  type TrashResult,
  type WorkspaceBinary,
  type WorkspaceChange,
  type WorkspaceChangePage,
  type WorkspaceDocument,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceEntryMetadata,
  type WorkspaceEntryTarget,
  type WorkspaceMetadataFingerprint,
  type WorkspaceProvider,
  type WorkspaceErrorCode,
  type WorkspaceRevision,
  type WorkspaceScanBatch,
  type WriteDocumentInput,
} from "@note/workspace-core";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_FIELDS = "id,name,mimeType,modifiedTime,size,md5Checksum,sha256Checksum,version,parents,trashed";
const DRIVE_SCAN_CONCURRENCY = 14;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  version?: string;
  parents?: string[];
  trashed?: boolean;
  knownRevision?: WorkspaceRevision;
  knownFingerprint?: WorkspaceMetadataFingerprint;
}

interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

interface DriveScanTask {
  parentId: string;
  prefix: string;
  target: WorkspaceEntry[];
}

export type DriveRequestKind = "metadata" | "list" | "change" | "content" | "mutation";

export interface DriveRequestResult {
  kind: DriveRequestKind;
  operationId?: string;
  outcome: "succeeded" | "failed" | "auth-retry";
  durationMs: number;
  status?: number;
  errorCode?: WorkspaceErrorCode | "unexpected";
  requestBytes?: number;
  responseBytes?: number;
}

export interface DriveDiagnostics {
  recordRequest(kind: DriveRequestKind): string | undefined;
  recordRequestResult?(result: DriveRequestResult): void;
  recordContentDownload(bytes: number): void;
}

export interface DriveAccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidateAccessToken?(): void;
}

export interface DriveMirror {
  loadDocument(path: string): Promise<WorkspaceDocument | null>;
  saveDocument(document: WorkspaceDocument): Promise<void>;
}

export interface DriveWorkspaceOptions {
  workspaceId: string;
  folderId: string;
  displayName: string;
  tokenProvider: DriveAccessTokenProvider;
  mirror?: DriveMirror;
  diagnostics?: DriveDiagnostics;
}

/**
 * Parses provider retry guidance without retaining request details.
 * @param value Retry-After header value.
 * @returns Non-negative delay or undefined for invalid guidance.
 */
function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Maps a Drive response into a shared provider error category.
 * @param response Failed Drive response.
 * @returns Typed provider error without response content.
 */
function driveError(response: Response): WorkspaceError {
  if (response.status === 401 || response.status === 403) return new WorkspaceError("permission", "Google Drive authorization is required.");
  if (response.status === 404) return new WorkspaceError("not-found", "The Drive entry was not found.");
  if (response.status === 409 || response.status === 412) return new WorkspaceError("conflict", "The Drive entry changed before the operation completed.");
  if (response.status === 410) return new WorkspaceError("cursor-invalid", "The Google Drive changes cursor expired.");
  const retryAfterMs = parseRetryAfterMilliseconds(response.headers.get("retry-after"));
  if (response.status === 429) return new WorkspaceError("quota", "Google Drive temporarily limited requests.", { retryAfterMs });
  if (response.status >= 500) return new WorkspaceError("temporary", "Google Drive is temporarily unavailable.", { retryAfterMs });
  return new WorkspaceError("fatal", `Google Drive request failed (${response.status}).`);
}

/**
 * Calculates a request-body size without reading or retaining body content.
 * @param body Optional fetch request body.
 * @returns Known byte count or undefined for streaming/multipart bodies.
 */
function requestBodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

/**
 * Reads a trustworthy non-negative response length when Google supplies one.
 * @param response Drive response.
 * @returns Declared byte count or undefined.
 */
function responseBodyBytes(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Performs one bounded Drive fetch while preserving caller cancellation. */
function fetchDrive(url: string, init: RequestInit, kind: DriveRequestKind): Promise<Response> {
  const timeout = AbortSignal.timeout(kind === "content" || kind === "mutation" ? 60_000 : 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}

/**
 * Creates a revision from Drive metadata that changes with provider content.
 * @param file Drive file metadata.
 * @returns Provider revision.
 */
function revision(file: DriveFile): WorkspaceRevision {
  if (file.knownRevision) return file.knownRevision;
  const size = Number(file.size ?? 0);
  const checksum = file.sha256Checksum ?? file.md5Checksum;
  const checksumAlgorithm = file.sha256Checksum ? "sha256" : "md5";
  return {
    id: checksum
      ? `${checksumAlgorithm}:${checksum}:${size}`
      : `version:${file.version ?? "0"}:${file.modifiedTime ?? "unknown"}:${size}`,
    modifiedAt: Date.parse(file.modifiedTime ?? "") || 0,
    size,
  };
}

/**
 * Creates the metadata fingerprint exposed alongside a Drive revision.
 * @param file Drive file metadata.
 * @returns Stable metadata fingerprint.
 */
function metadataFingerprint(file: DriveFile): WorkspaceMetadataFingerprint {
  if (file.knownFingerprint) return file.knownFingerprint;
  const value = revision(file);
  return { ...value, id: `drive:${value.id}:${file.parents?.join(",") ?? "root"}` };
}

/**
 * Classifies one supported Drive entry.
 * @param file Drive metadata.
 * @returns Shared entry kind or null for unsupported files.
 */
function classifyDriveFile(file: DriveFile): WorkspaceEntryKind | null {
  if (file.mimeType === FOLDER_MIME) return "directory";
  const extension = `.${file.name.split(".").at(-1)?.toLowerCase()}`;
  if (extension === ".md") return "document";
  return supportedImageExtensions.includes(extension as typeof supportedImageExtensions[number]) ? "image" : null;
}

/**
 * Decodes a Markdown payload while preserving its source format.
 * @param path Workspace-relative path.
 * @param file Drive metadata matching the downloaded payload.
 * @param bytes Downloaded bytes.
 * @returns Shared document snapshot.
 */
function decodeDocument(path: string, file: DriveFile, bytes: ArrayBuffer): WorkspaceDocument {
  const data = new Uint8Array(bytes);
  const hasBom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const content = new TextDecoder().decode(hasBom ? data.subarray(3) : data);
  return {
    path,
    content,
    format: { hasBom, lineEnding: content.includes("\r\n") ? "\r\n" : "\n" },
    revision: revision(file),
    entryId: file.id,
    metadataFingerprint: metadataFingerprint(file),
  };
}

/**
 * Replaces a path prefix for a moved entry and its descendants.
 * @param path Existing workspace-relative path.
 * @param sourcePath Moved source path.
 * @param destinationPath New source path.
 * @returns Updated workspace-relative path.
 */
function replacePathPrefix(path: string, sourcePath: string, destinationPath: string): string {
  if (path === sourcePath) return destinationPath;
  return path.startsWith(`${sourcePath}/`) ? `${destinationPath}${path.slice(sourcePath.length)}` : path;
}

/**
 * Flattens provider entries for incremental subtree change emission.
 * @param entries Hierarchical provider entries.
 * @returns Entries in parent-first order.
 */
function flattenWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenWorkspaceEntries(entry.children ?? [])]);
}

/**
 * Converts a shared entry into change metadata.
 * @param entry Shared provider entry.
 * @returns Incremental metadata retaining stable identity.
 */
function entryMetadata(entry: WorkspaceEntry): WorkspaceEntryMetadata {
  return {
    entryId: entry.entryId ?? entry.path,
    path: entry.path,
    kind: entry.kind,
    parentEntryId: entry.parentEntryId,
    revision: entry.revision,
    metadataFingerprint: entry.metadataFingerprint,
    state: entry.state ?? "live",
  };
}

/**
 * Encodes Markdown using retained formatting metadata.
 * @param content Normalized editor content.
 * @param format BOM and line-ending metadata.
 * @returns Upload payload.
 */
function encodeDocument(content: string, format: DocumentFormat): Blob {
  const normalized = format.lineEnding === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : content.replace(/\r\n/g, "\n");
  const bom = format.hasBom ? new Uint8Array([0xef, 0xbb, 0xbf]) : new Uint8Array();
  return new Blob([bom, new TextEncoder().encode(normalized)], { type: "text/markdown;charset=utf-8" });
}

export class DriveWorkspaceProvider implements WorkspaceProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities = {
    canWrite: true,
    canMove: true,
    canTrash: true,
    canRestore: true,
    watchesExternalChanges: true,
  } as const;

  private readonly filesByPath = new Map<string, DriveFile>();
  private readonly filesById = new Map<string, DriveFile>();
  private readonly pathsById = new Map<string, string>();
  private readonly collisions = new Set<string>();

  /**
   * Creates a provider scoped to one explicitly selected Drive folder.
   * @param options Stable folder identity, token source, and optional diagnostics.
   */
  constructor(private readonly options: DriveWorkspaceOptions) {
    this.id = `drive:${options.workspaceId}`;
    this.name = options.displayName;
    this.pathsById.set(options.folderId, "");
  }

  /**
   * Rebuilds path and collision lookups from stable-ID metadata.
   * @returns Nothing after all lookup maps agree.
   */
  private rebuildPathLookups(): void {
    this.filesByPath.clear();
    this.collisions.clear();
    const grouped = new Map<string, DriveFile[]>();
    for (const [entryId, path] of this.pathsById) {
      if (entryId === this.options.folderId || !path) continue;
      const file = this.filesById.get(entryId);
      if (file) grouped.set(path, [...(grouped.get(path) ?? []), file]);
    }
    for (const [path, files] of grouped) {
      if (files.length > 1) this.collisions.add(path);
      else if (!files[0].trashed) this.filesByPath.set(path, files[0]);
    }
  }

  /**
   * Removes one known entry and path descendants from provider lookup maps.
   * @param entryId Stable root identity being removed or moved outside the workspace.
   * @returns Nothing after stale ancestry is discarded.
   */
  private removeMetadataSubtree(entryId: string): void {
    const path = this.pathsById.get(entryId);
    for (const [candidateId, candidatePath] of this.pathsById) {
      if (candidateId === this.options.folderId) continue;
      if (candidateId === entryId || (path && candidatePath.startsWith(`${path}/`))) {
        this.pathsById.delete(candidateId);
        this.filesById.delete(candidateId);
      }
    }
  }

  /**
   * Seeds provider lookup maps from a durable manifest without network I/O.
   * @param entries Warm hierarchical manifest entries.
   * @returns Nothing after stable IDs, paths, parents, and revisions are retained.
   */
  primeEntries(entries: WorkspaceEntry[]): void {
    this.filesById.clear();
    this.pathsById.clear();
    this.pathsById.set(this.options.folderId, "");
    for (const entry of flattenWorkspaceEntries(entries)) {
      const entryId = entry.entryId ?? entry.path;
      this.pathsById.set(entryId, entry.path);
      this.filesById.set(entryId, {
        id: entryId,
        name: entry.name,
        mimeType: entry.kind === "directory" ? FOLDER_MIME : entry.kind === "document" ? "text/markdown" : "application/octet-stream",
        parents: entry.parentEntryId ? [entry.parentEntryId] : [this.options.folderId],
        trashed: entry.state === "removed",
        knownRevision: entry.revision,
        knownFingerprint: entry.metadataFingerprint,
      });
    }
    this.rebuildPathLookups();
  }

  /**
   * Fetches metadata for ancestry resolution without downloading content.
   * @param entryId Stable Drive file identity.
   * @returns Current file metadata.
   */
  private async fetchMetadata(entryId: string): Promise<DriveFile> {
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entryId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {}, "metadata");
    return response.json() as Promise<DriveFile>;
  }

  /**
   * Resolves one parent to a selected-folder-relative path.
   * @param parentId Candidate parent identity.
   * @param visited Cycle guard for malformed ancestry.
   * @returns Parent path, empty root path, or null when outside the workspace.
   */
  private async resolveParentPath(parentId: string, visited = new Set<string>()): Promise<string | null> {
    if (parentId === this.options.folderId) return "";
    const known = this.pathsById.get(parentId);
    if (known !== undefined) return known;
    if (visited.has(parentId)) throw new WorkspaceError("ambiguous", "Google Drive returned cyclic folder ancestry.");
    visited.add(parentId);
    let folder: DriveFile;
    try {
      folder = await this.fetchMetadata(parentId);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "not-found") return null;
      throw error;
    }
    if (folder.trashed || folder.mimeType !== FOLDER_MIME) return null;
    for (const ancestorId of folder.parents ?? []) {
      const ancestorPath = await this.resolveParentPath(ancestorId, visited);
      if (ancestorPath === null) continue;
      const path = ancestorPath ? `${ancestorPath}/${folder.name}` : folder.name;
      this.filesById.set(folder.id, folder);
      this.pathsById.set(folder.id, path);
      return path;
    }
    return null;
  }

  /**
   * Resolves changed metadata into selected-folder-relative metadata.
   * @param file Current Drive change metadata.
   * @returns Workspace metadata or null for an unrelated account entry.
   */
  private async resolveChangedMetadata(file: DriveFile): Promise<WorkspaceEntryMetadata | null> {
    const kind = classifyDriveFile(file);
    if (!kind) return null;
    let parentPath: string | null = null;
    let parentEntryId: string | undefined;
    for (const parentId of file.parents ?? []) {
      const candidate = await this.resolveParentPath(parentId);
      if (candidate === null) continue;
      parentPath = candidate;
      parentEntryId = parentId;
      break;
    }
    if (parentPath === null) return null;
    const path = parentPath ? `${parentPath}/${file.name}` : file.name;
    this.filesById.set(file.id, file);
    this.pathsById.set(file.id, path);
    return {
      entryId: file.id,
      path,
      kind,
      parentEntryId,
      revision: kind === "directory" ? undefined : revision(file),
      metadataFingerprint: metadataFingerprint(file),
      state: file.trashed ? "removed" : "live",
    };
  }

  /**
   * Performs one authenticated Drive request.
   * @param url Drive API URL.
   * @param init Fetch options.
   * @param kind Privacy-safe request category.
   * @returns Successful response.
   */
  private async request(url: string, init: RequestInit = {}, kind: DriveRequestKind = "metadata"): Promise<Response> {
    if (!navigator.onLine) throw new WorkspaceError("offline", "Google Drive is unavailable while offline.");
    const startedAt = Date.now();
    const sentBytes = requestBodyBytes(init.body);
    const operationId = this.options.diagnostics?.recordRequest(kind);
    let response: Response;
    try {
      let accessToken = await this.options.tokenProvider.getAccessToken();
      response = await fetchDrive(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, ...init.headers },
      }, kind);
      if (response.status === 401 && this.options.tokenProvider.invalidateAccessToken) {
        this.options.diagnostics?.recordRequestResult?.({ kind, operationId, outcome: "auth-retry", status: 401, durationMs: Date.now() - startedAt, errorCode: "permission", requestBytes: sentBytes, responseBytes: responseBodyBytes(response) });
        this.options.tokenProvider.invalidateAccessToken();
        accessToken = await this.options.tokenProvider.getAccessToken();
        response = await fetchDrive(url, {
          ...init,
          headers: { authorization: `Bearer ${accessToken}`, ...init.headers },
        }, kind);
      }
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      const providerError = error instanceof WorkspaceError
        ? error
        : new WorkspaceError(navigator.onLine ? "temporary" : "offline", timedOut ? "Google Drive request timed out." : "Google Drive could not be reached.", { cause: error });
      this.options.diagnostics?.recordRequestResult?.({ kind, operationId, outcome: "failed", durationMs: Date.now() - startedAt, errorCode: providerError.code, requestBytes: sentBytes });
      throw providerError;
    }
    if (!response.ok) {
      const error = driveError(response);
      this.options.diagnostics?.recordRequestResult?.({ kind, operationId, outcome: "failed", status: response.status, durationMs: Date.now() - startedAt, errorCode: error.code, requestBytes: sentBytes, responseBytes: responseBodyBytes(response) });
      throw error;
    }
    this.options.diagnostics?.recordRequestResult?.({ kind, operationId, outcome: "succeeded", status: response.status, durationMs: Date.now() - startedAt, requestBytes: sentBytes, responseBytes: responseBodyBytes(response) });
    return response;
  }

  /**
   * Lists direct children for one Drive folder.
   * @param parentId Drive parent ID.
   * @returns Supported and unsupported child metadata for classification.
   */
  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: `nextPageToken,files(${DRIVE_FIELDS})`,
        pageSize: "1000",
        orderBy: "folder,name",
        spaces: "drive",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await this.request(`https://www.googleapis.com/drive/v3/files?${params}`, {}, "list");
      const page = await response.json() as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  /**
   * Retains metadata maps and creates a shared tree with bounded breadth-first requests.
   * @param parentId Current Drive folder ID.
   * @param prefix Workspace-relative parent path.
   * @returns Supported child entries with explicit collision state.
   */
  private async scan(parentId: string, prefix = ""): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = [];
    const queue: DriveScanTask[] = [{ parentId, prefix, target: result }];

    while (queue.length > 0) {
      const batch = queue.splice(0, DRIVE_SCAN_CONCURRENCY);
      const childRequests: Array<Promise<DriveFile[]>> = [];
      for (const task of batch) childRequests.push(this.listChildren(task.parentId));
      const childBatches = await Promise.all(childRequests);

      for (let taskIndex = 0; taskIndex < batch.length; taskIndex += 1) {
        const task = batch[taskIndex];
        const children = childBatches[taskIndex];
        const nameCounts = new Map<string, number>();
        for (const file of children) nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1);

        for (const file of children) {
          const kind = classifyDriveFile(file);
          if (!kind) continue;
          const path = task.prefix ? `${task.prefix}/${file.name}` : file.name;
          const collided = (nameCounts.get(file.name) ?? 0) > 1;
          const nestedEntries: WorkspaceEntry[] | undefined = kind === "directory" ? [] : undefined;
          this.filesById.set(file.id, file);
          this.pathsById.set(file.id, path);
          if (collided) this.collisions.add(path);
          task.target.push({
            kind,
            name: file.name,
            path,
            entryId: file.id,
            parentEntryId: task.parentId,
            revision: kind === "document" || kind === "image" ? revision(file) : undefined,
            metadataFingerprint: metadataFingerprint(file),
            state: collided ? "path-collision" : "live",
            children: nestedEntries,
          });
          if (nestedEntries) queue.push({ parentId: file.id, prefix: path, target: nestedEntries });
        }
      }
    }
    return result;
  }

  /**
   * Lists supported entries under the selected folder.
   * @returns Scoped Drive tree.
   */
  async listEntries(): Promise<WorkspaceEntry[]> {
    this.filesByPath.clear();
    this.filesById.clear();
    this.collisions.clear();
    this.pathsById.clear();
    this.pathsById.set(this.options.folderId, "");
    const entries = await this.scan(this.options.folderId);
    this.rebuildPathLookups();
    return entries;
  }

  /**
   * Returns one bounded scan batch while retaining the compatibility scan.
   * @param cursor Opaque offset returned by the previous batch.
   * @returns A deterministic top-level batch.
   */
  async scanEntries(cursor?: string): Promise<WorkspaceScanBatch> {
    const entries = await this.listEntries();
    const offset = Math.max(0, Number(cursor ?? 0) || 0);
    const batch = entries.slice(offset, offset + 250);
    const nextOffset = offset + batch.length;
    return { entries: batch, cursor: nextOffset < entries.length ? String(nextOffset) : undefined, done: nextOffset >= entries.length };
  }

  /**
   * Acquires a Drive cursor immediately before an authoritative initialization scan.
   * @returns Opaque start page token.
   */
  async getChangesStartCursor(): Promise<string> {
    const params = new URLSearchParams({ fields: "startPageToken", supportsAllDrives: "true" });
    const response = await this.request(`https://www.googleapis.com/drive/v3/changes/startPageToken?${params}`, {}, "change");
    const payload = await response.json() as { startPageToken?: string };
    if (!payload.startPageToken) throw new WorkspaceError("fatal", "Google Drive did not return a changes cursor.");
    return payload.startPageToken;
  }

  /**
   * Lists and scopes one account-wide Drive change page to the selected folder.
   * @param cursor Opaque Drive page token.
   * @returns Scoped changes and the cursor that must commit with this page.
   */
  async listChanges(cursor: string): Promise<WorkspaceChangePage> {
    const params = new URLSearchParams({
      pageToken: cursor,
      pageSize: "1000",
      spaces: "drive",
      includeRemoved: "true",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_FIELDS}))`,
    });
    const response = await this.request(`https://www.googleapis.com/drive/v3/changes?${params}`, {}, "change");
    const page = await response.json() as { changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string };
    const changes: WorkspaceChange[] = [];
    const knownAtPageStart = new Set(this.filesById.keys());
    const directoriesToScan = new Map<string, WorkspaceEntryMetadata>();
    for (const change of page.changes ?? []) {
      const wasKnown = this.filesById.has(change.fileId);
      if (change.removed || change.file?.trashed) {
        if (wasKnown) changes.push({ entryId: change.fileId, removed: true });
        this.removeMetadataSubtree(change.fileId);
        continue;
      }
      if (!change.file) continue;
      const metadata = await this.resolveChangedMetadata(change.file);
      if (!metadata) {
        if (wasKnown) {
          changes.push({ entryId: change.fileId, removed: true });
          this.removeMetadataSubtree(change.fileId);
        }
        continue;
      }
      changes.push({ entryId: change.fileId, removed: false, metadata });
      if (!wasKnown && metadata.kind === "directory" && (change.file.parents?.some((parentId) => parentId === this.options.folderId || knownAtPageStart.has(parentId)) ?? false)) {
        directoriesToScan.set(metadata.entryId, metadata);
      }
    }
    for (const [entryId, file] of this.filesById) {
      if (knownAtPageStart.has(entryId) || entryId === this.options.folderId || file.mimeType !== FOLDER_MIME) continue;
      const path = this.pathsById.get(entryId);
      if (path === undefined) continue;
      const metadata: WorkspaceEntryMetadata = {
        entryId,
        path,
        kind: "directory",
        parentEntryId: file.parents?.[0],
        metadataFingerprint: metadataFingerprint(file),
        state: "live",
      };
      if (!changes.some((change) => change.entryId === entryId)) changes.push({ entryId, removed: false, metadata });
      const parentWasKnown = file.parents?.some((parentId) => parentId === this.options.folderId || knownAtPageStart.has(parentId)) ?? false;
      if (parentWasKnown) directoriesToScan.set(entryId, metadata);
    }
    for (const directory of directoriesToScan.values()) {
      const subtree = await this.scan(directory.entryId, directory.path);
      for (const entry of flattenWorkspaceEntries(subtree)) changes.push({ entryId: entry.entryId ?? entry.path, removed: false, metadata: entryMetadata(entry) });
    }
    this.rebuildPathLookups();
    const normalizedChanges = changes.map((change) => change.metadata && this.collisions.has(change.metadata.path)
      ? { ...change, metadata: { ...change.metadata, state: "path-collision" as const } }
      : change);
    const nextCursor = page.nextPageToken ?? page.newStartPageToken;
    if (!nextCursor) throw new WorkspaceError("ambiguous", "Google Drive returned a change page without a continuation cursor.");
    return { changes: normalizedChanges, nextCursor, done: page.nextPageToken === undefined };
  }

  /**
   * Resolves cached metadata by path without a provider request.
   * @param path Workspace-relative path.
   * @returns Cached Drive metadata.
   */
  private async resolve(path: string): Promise<DriveFile> {
    if (this.collisions.has(path)) throw new WorkspaceError("collision", `${path} resolves to multiple Drive entries.`);
    let file = this.filesByPath.get(path);
    if (!file) {
      await this.listEntries();
      file = this.filesByPath.get(path);
    }
    if (!file) throw new WorkspaceError("not-found", `${path} was not found in the Drive workspace.`);
    return file;
  }

  /**
   * Fetches fresh metadata by stable ID or a compatibility path lookup.
   * @param target Stable entry ID and/or current path.
   * @returns Current provider metadata without downloading content.
   */
  async getEntryMetadata(target: WorkspaceEntryTarget): Promise<WorkspaceEntryMetadata> {
    let file = target.entryId ? this.filesById.get(target.entryId) : undefined;
    if (!file && target.path) file = await this.resolve(target.path);
    const entryId = target.entryId ?? file?.id;
    if (!entryId) throw new WorkspaceError("not-found", "The Drive entry identity is unavailable.");
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entryId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {}, "metadata");
    const current = await response.json() as DriveFile;
    const kind = classifyDriveFile(current);
    if (!kind) throw new WorkspaceError("unsupported", "The Drive entry type is unsupported.");
    const oldPath = target.path ?? this.pathsById.get(current.id) ?? current.name;
    const parentPath = current.parents?.map((id) => this.pathsById.get(id)).find((path) => path !== undefined);
    const path = parentPath === undefined ? oldPath : parentPath ? `${parentPath}/${current.name}` : current.name;
    this.filesById.set(current.id, current);
    this.pathsById.set(current.id, path);
    if (!current.trashed && !this.collisions.has(path)) this.filesByPath.set(path, current);
    return {
      entryId: current.id,
      path,
      kind,
      parentEntryId: current.parents?.[0],
      revision: kind === "directory" ? undefined : revision(current),
      metadataFingerprint: metadataFingerprint(current),
      state: current.trashed ? "removed" : this.collisions.has(path) ? "path-collision" : "live",
    };
  }

  /**
   * Reads Markdown, using a revision-matched transitional mirror when supplied.
   * @param path Workspace-relative path.
   * @returns Current decoded document or an offline mirrored snapshot.
   */
  async readDocument(path: string): Promise<WorkspaceDocument> {
    const mirrored = await this.options.mirror?.loadDocument(path);
    try {
      const file = await this.resolve(path);
      const currentRevision = revision(file);
      if (mirrored?.revision.id === currentRevision.id) return { ...mirrored, entryId: file.id, metadataFingerprint: metadataFingerprint(file) };
      const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {}, "content");
      const bytes = await response.arrayBuffer();
      this.options.diagnostics?.recordContentDownload(bytes.byteLength);
      const document = decodeDocument(path, file, bytes);
      await this.options.mirror?.saveDocument(document);
      return document;
    } catch (error) {
      if (mirrored && error instanceof WorkspaceError && error.code === "offline") return mirrored;
      throw error;
    }
  }

  /**
   * Downloads one image directly from Drive.
   * @param path Workspace-relative path.
   * @returns Binary and metadata revision.
   */
  async readBinary(path: string): Promise<WorkspaceBinary> {
    const file = await this.resolve(path);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {}, "content");
    const blob = await response.blob();
    this.options.diagnostics?.recordContentDownload(blob.size);
    return { path, blob, revision: revision(file) };
  }

  /**
   * Resolves and creates intermediate Drive directories.
   * @param path Directory path.
   * @returns Final folder ID.
   */
  private async ensureDirectory(path: string): Promise<string> {
    let parentId = this.options.folderId;
    let currentPath = "";
    for (const segment of path.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.filesByPath.get(currentPath);
      if (existing?.mimeType === FOLDER_MIME) {
        parentId = existing.id;
        continue;
      }
      const created = await this.createMetadata({ name: segment, mimeType: FOLDER_MIME, parents: [parentId] });
      this.filesByPath.set(currentPath, created);
      this.filesById.set(created.id, created);
      this.pathsById.set(created.id, currentPath);
      parentId = created.id;
    }
    return parentId;
  }

  /**
   * Creates one metadata-only Drive entry.
   * @param metadata Name, MIME type, and parent identity.
   * @returns Created metadata.
   */
  private async createMetadata(metadata: { name: string; mimeType: string; parents: string[] }): Promise<DriveFile> {
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata),
    }, "mutation");
    return response.json() as Promise<DriveFile>;
  }

  /**
   * Uploads a new file and metadata in one multipart request.
   * @param path Workspace-relative destination.
   * @param blob File payload.
   * @param mimeType Content MIME type.
   * @returns Created metadata.
   */
  private async createFile(path: string, blob: Blob, mimeType: string): Promise<DriveFile> {
    const parts = path.split("/");
    const name = parts.pop()!;
    const parentId = await this.ensureDirectory(parts.join("/"));
    const boundary = `nm_${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    const response = await this.request(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FIELDS)}`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    }, "mutation");
    const file = await response.json() as DriveFile;
    this.filesByPath.set(path, file);
    this.filesById.set(file.id, file);
    this.pathsById.set(file.id, path);
    return file;
  }

  /**
   * Replaces bytes after a fresh strong provider revision check.
   * @param path Workspace-relative path.
   * @param blob New bytes.
   * @param expected Expected base revision.
   * @returns New provider revision.
   */
  private async updateFile(path: string, blob: Blob, expected?: WorkspaceRevision): Promise<WorkspaceRevision> {
    const file = await this.resolve(path);
    const metadataResponse = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {}, "metadata");
    const current = await metadataResponse.json() as DriveFile;
    if (expected && revision(current).id !== expected.id) throw new WorkspaceError("conflict", `${path} changed in Drive.`);
    const etag = metadataResponse.headers.get("etag");
    const response = await this.request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media&fields=${encodeURIComponent(DRIVE_FIELDS)}`, {
      method: "PATCH",
      headers: { "content-type": blob.type || "application/octet-stream", ...(etag ? { "if-match": etag } : {}) },
      body: blob,
    }, "mutation");
    const updated = await response.json() as DriveFile;
    this.filesByPath.set(path, updated);
    this.filesById.set(updated.id, updated);
    return revision(updated);
  }

  /**
   * Writes an image directly to Drive.
   * @param path Workspace-relative destination.
   * @param blob Image bytes.
   * @returns New provider revision.
   */
  async writeBinary(path: string, blob: Blob): Promise<WorkspaceRevision> {
    return this.filesByPath.has(path)
      ? this.updateFile(path, blob)
      : revision(await this.createFile(path, blob, blob.type || "application/octet-stream"));
  }

  /**
   * Writes Markdown with expected-revision verification.
   * @param input Shared write operation.
   * @returns New Drive revision.
   */
  async writeDocument(input: WriteDocumentInput): Promise<WorkspaceRevision> {
    const blob = encodeDocument(input.content, input.format);
    const nextRevision = this.filesByPath.has(input.path)
      ? await this.updateFile(input.path, blob, input.expectedRevision)
      : revision(await this.createFile(input.path, blob, "text/markdown"));
    const file = this.filesByPath.get(input.path);
    await this.options.mirror?.saveDocument({
      path: input.path,
      content: input.content,
      format: input.format,
      revision: nextRevision,
      entryId: file?.id,
      metadataFingerprint: file ? metadataFingerprint(file) : undefined,
    });
    return nextRevision;
  }

  /**
   * Creates a Markdown document without silent overwrite.
   * @param path Workspace-relative destination.
   * @param content Initial Markdown.
   * @returns Created document.
   */
  async createDocument(path: string, content = ""): Promise<WorkspaceDocument> {
    const normalizedPath = ensureMarkdownPath(path);
    if (this.filesByPath.has(normalizedPath) || this.collisions.has(normalizedPath)) throw new WorkspaceError("collision", `${normalizedPath} already exists.`);
    const format: DocumentFormat = { hasBom: false, lineEnding: "\n" };
    const file = await this.createFile(normalizedPath, encodeDocument(content, format), "text/markdown");
    const document = { path: normalizedPath, content, format, revision: revision(file), entryId: file.id, metadataFingerprint: metadataFingerprint(file) };
    await this.options.mirror?.saveDocument(document);
    return document;
  }

  /**
   * Creates a Drive directory path.
   * @param path Workspace-relative path.
   * @returns Nothing.
   */
  async createDirectory(path: string): Promise<void> {
    await this.ensureDirectory(path);
  }

  /**
   * Applies a successful move to the in-memory identity and path indexes.
   * @param sourcePath Existing path.
   * @param destinationPath New path.
   * @param movedFile Fresh metadata returned by Drive.
   * @returns Nothing after all affected paths are rebuilt.
   */
  private applyMoveMetadata(sourcePath: string, destinationPath: string, movedFile: DriveFile): void {
    for (const [entryId, path] of this.pathsById) {
      if (path === sourcePath || path.startsWith(`${sourcePath}/`)) {
        this.pathsById.set(entryId, replacePathPrefix(path, sourcePath, destinationPath));
      }
    }
    this.filesById.set(movedFile.id, movedFile);
    this.rebuildPathLookups();
  }

  /**
   * Moves or renames one Drive entry while preserving stable identity.
   * @param sourcePath Existing path.
   * @param destinationPath New path.
   * @returns Nothing after local metadata indexes are updated.
   */
  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const file = await this.resolve(sourcePath);
    const parts = destinationPath.split("/");
    const name = parts.pop()!;
    const parentId = await this.ensureDirectory(parts.join("/"));
    const params = new URLSearchParams({
      addParents: parentId,
      removeParents: file.parents?.join(",") ?? "",
      fields: DRIVE_FIELDS,
    });
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?${params}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }, "mutation");
    const responseFile = await response.json() as DriveFile;
    this.applyMoveMetadata(sourcePath, destinationPath, {
      ...file,
      ...responseFile,
      id: file.id,
      name,
      parents: responseFile.parents ?? [parentId],
    });
  }

  /**
   * Moves one Drive entry to trash.
   * @param path Workspace-relative path.
   * @returns Recoverable provider token.
   */
  async trash(path: string): Promise<TrashResult> {
    const file = await this.resolve(path);
    await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    }, "mutation");
    this.filesByPath.delete(path);
    return { token: JSON.stringify({ id: file.id, path }), originalPath: path };
  }

  /**
   * Restores one Drive entry from trash.
   * @param token Provider restore token.
   * @returns Nothing after the scoped tree is refreshed.
   */
  async restore(token: string): Promise<void> {
    const value = JSON.parse(token) as { id: string };
    await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(value.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashed: false }),
    }, "mutation");
    await this.listEntries();
  }

  /**
   * Confirms that a short-lived Drive token can be acquired.
   * @returns Whether authorization is currently available.
   */
  async requestPermission(): Promise<boolean> {
    try {
      await this.options.tokenProvider.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}
