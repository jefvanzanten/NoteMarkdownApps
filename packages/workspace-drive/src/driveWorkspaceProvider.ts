import {
  WorkspaceError, supportedImageExtensions,
  type DocumentFormat, type TrashResult, type WorkspaceBinary, type WorkspaceDocument,
  type WorkspaceEntry, type WorkspaceProvider, type WorkspaceRevision, type WriteDocumentInput,
} from "@note/workspace-core";

const FOLDER_MIME = "application/vnd.google-apps.folder";
interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; md5Checksum?: string; version?: string; parents?: string[]; trashed?: boolean }
export interface DriveAccessTokenProvider { getAccessToken(): Promise<string> }
export interface DriveMirror {
  loadDocument(path: string): Promise<WorkspaceDocument | null>;
  saveDocument(document: WorkspaceDocument): Promise<void>;
}
export interface DriveWorkspaceOptions { workspaceId: string; folderId: string; displayName: string; tokenProvider: DriveAccessTokenProvider; mirror?: DriveMirror }

/** Maps a Drive response into shared provider error categories without exposing response bodies. @param response Failed Drive response. @returns Typed provider error. */
function driveError(response: Response): WorkspaceError {
  if (response.status === 401 || response.status === 403) return new WorkspaceError("permission", "Google Drive authorization is required.");
  if (response.status === 404) return new WorkspaceError("not-found", "The Drive entry was not found.");
  if (response.status === 409 || response.status === 412) return new WorkspaceError("conflict", "The Drive entry changed before the operation completed.");
  if (response.status === 429) return new WorkspaceError("quota", "Google Drive temporarily limited requests.");
  return new WorkspaceError("fatal", `Google Drive request failed (${response.status}).`);
}

/** Creates a shared revision from non-content Drive metadata. @param file Drive file metadata. @returns Provider revision. */
function revision(file: DriveFile): WorkspaceRevision {
  return { id: `${file.version ?? "0"}:${file.md5Checksum ?? "none"}:${file.modifiedTime ?? "unknown"}`, modifiedAt: Date.parse(file.modifiedTime ?? "") || 0, size: Number(file.size ?? 0) };
}

/** Converts a Markdown blob while preserving BOM and line-ending intent. @param path Workspace path. @param file Drive metadata. @param bytes Downloaded bytes. @returns Shared document. */
function decodeDocument(path: string, file: DriveFile, bytes: ArrayBuffer): WorkspaceDocument {
  const data = new Uint8Array(bytes); const hasBom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const content = new TextDecoder().decode(hasBom ? data.subarray(3) : data);
  return { path, content, format: { hasBom, lineEnding: content.includes("\r\n") ? "\r\n" : "\n" }, revision: revision(file) };
}

/** Encodes Markdown using the retained source format. @param content Editor text. @param format BOM and line-ending metadata. @returns Upload blob. */
function encodeDocument(content: string, format: DocumentFormat): Blob {
  const normalized = format.lineEnding === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : content.replace(/\r\n/g, "\n");
  return new Blob([format.hasBom ? new Uint8Array([0xef, 0xbb, 0xbf]) : new Uint8Array(), new TextEncoder().encode(normalized)], { type: "text/markdown;charset=utf-8" });
}

export class DriveWorkspaceProvider implements WorkspaceProvider {
  readonly id: string; readonly name: string;
  readonly capabilities = { canWrite: true, canMove: true, canTrash: true, canRestore: true, watchesExternalChanges: true } as const;
  private filesByPath = new Map<string, DriveFile>();
  private pathsById = new Map<string, string>();

  /** Creates a provider scoped to one explicitly selected Drive folder. @param options Stable folder identity and token source. @returns Drive provider. */
  constructor(private readonly options: DriveWorkspaceOptions) { this.id = `drive:${options.workspaceId}`; this.name = options.displayName; }

  /** Performs one authenticated Drive request. @param url Drive API URL. @param init Request options. @returns Successful response. */
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (!navigator.onLine) throw new WorkspaceError("offline", "Google Drive is unavailable while offline.");
    const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.options.tokenProvider.getAccessToken()}`, ...init.headers } });
    if (!response.ok) throw driveError(response); return response;
  }

  /** Lists direct children for one Drive folder. @param parentId Drive parent ID. @returns Supported child metadata. */
  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = []; let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`, fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,version,parents,trashed)", pageSize: "1000", orderBy: "folder,name", ...(pageToken ? { pageToken } : {}) });
      const response = await this.request(`https://www.googleapis.com/drive/v3/files?${params}`); const page = await response.json() as { files?: DriveFile[]; nextPageToken?: string }; files.push(...(page.files ?? [])); pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  /** Recursively scans only the selected folder and creates the shared file tree. @param parentId Current Drive folder ID. @param prefix Workspace-relative path prefix. @returns Supported entries. */
  private async scan(parentId: string, prefix = ""): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = [];
    for (const file of await this.listChildren(parentId)) {
      const path = prefix ? `${prefix}/${file.name}` : file.name;
      const extension = `.${file.name.split(".").at(-1)?.toLowerCase()}`;
      const kind = file.mimeType === FOLDER_MIME ? "directory" : extension === ".md" ? "document" : supportedImageExtensions.includes(extension as typeof supportedImageExtensions[number]) ? "image" : null;
      if (!kind) continue;
      this.filesByPath.set(path, file); this.pathsById.set(file.id, path);
      result.push({ kind, name: file.name, path, children: kind === "directory" ? await this.scan(file.id, path) : undefined });
    }
    return result;
  }

  /** Lists supported Markdown, image, and directory entries under the selected folder. @returns Scoped Drive tree. */
  async listEntries(): Promise<WorkspaceEntry[]> { this.filesByPath.clear(); this.pathsById.clear(); return this.scan(this.options.folderId); }

  /** Ensures path metadata exists in the current scoped scan. @param path Workspace-relative path. @returns Drive metadata. */
  private async resolve(path: string): Promise<DriveFile> { let file = this.filesByPath.get(path); if (!file) { await this.listEntries(); file = this.filesByPath.get(path); } if (!file) throw new WorkspaceError("not-found", `${path} was not found in the Drive workspace.`); return file; }

  /** Downloads one Markdown document directly from Drive and retains an encrypted browser mirror when configured. @param path Workspace-relative path. @returns Decoded document or offline mirror. */
  async readDocument(path: string): Promise<WorkspaceDocument> {
    try {
      const file = await this.resolve(path); const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`); const document = decodeDocument(path, file, await response.arrayBuffer());
      await this.options.mirror?.saveDocument(document); return document;
    } catch (error) {
      const mirrored = await this.options.mirror?.loadDocument(path);
      if (mirrored && error instanceof WorkspaceError && error.code === "offline") return mirrored;
      throw error;
    }
  }

  /** Downloads one image directly from Drive. @param path Workspace-relative path. @returns Binary and revision. */
  async readBinary(path: string): Promise<WorkspaceBinary> { const file = await this.resolve(path); const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`); return { path, blob: await response.blob(), revision: revision(file) }; }

  /** Resolves and creates intermediate Drive directories. @param path Directory path. @returns Final folder ID. */
  private async ensureDirectory(path: string): Promise<string> {
    let parentId = this.options.folderId; let current = "";
    for (const segment of path.split("/").filter(Boolean)) { current = current ? `${current}/${segment}` : segment; const existing = this.filesByPath.get(current); if (existing?.mimeType === FOLDER_MIME) { parentId = existing.id; continue; } const created = await this.createMetadata({ name: segment, mimeType: FOLDER_MIME, parents: [parentId] }); this.filesByPath.set(current, created); parentId = created.id; }
    return parentId;
  }

  /** Creates a metadata-only Drive entry. @param metadata Name, MIME type, and parent. @returns Created metadata. */
  private async createMetadata(metadata: { name: string; mimeType: string; parents: string[] }): Promise<DriveFile> { const response = await this.request("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,size,md5Checksum,version,parents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) }); return response.json() as Promise<DriveFile>; }

  /** Uploads a new file with metadata in one multipart request. @param path Workspace path. @param blob File bytes. @param mimeType Content MIME. @returns Created metadata. */
  private async createFile(path: string, blob: Blob, mimeType: string): Promise<DriveFile> {
    const parts = path.split("/"); const name = parts.pop()!; const parentId = await this.ensureDirectory(parts.join("/"));
    const boundary = `nm_${crypto.randomUUID()}`; const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    const response = await this.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum,version,parents", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    const file = await response.json() as DriveFile; this.filesByPath.set(path, file); return file;
  }

  /** Replaces bytes after checking fresh Drive metadata against the expected revision. @param path Workspace path. @param blob New bytes. @param expected Expected shared revision. @returns New revision. */
  private async updateFile(path: string, blob: Blob, expected?: WorkspaceRevision): Promise<WorkspaceRevision> { const file = await this.resolve(path); const metadataResponse = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name,mimeType,modifiedTime,size,md5Checksum,version,parents`); const current = await metadataResponse.json() as DriveFile; if (expected && revision(current).id !== expected.id) throw new WorkspaceError("conflict", `${path} changed in Drive.`); const etag = metadataResponse.headers.get("etag"); const response = await this.request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id,name,mimeType,modifiedTime,size,md5Checksum,version,parents`, { method: "PATCH", headers: { "content-type": blob.type || "application/octet-stream", ...(etag ? { "if-match": etag } : {}) }, body: blob }); const updated = await response.json() as DriveFile; this.filesByPath.set(path, updated); return revision(updated); }

  /** Writes an image directly to Drive. @param path Workspace path. @param blob Image bytes. @returns New revision. */
  async writeBinary(path: string, blob: Blob): Promise<WorkspaceRevision> { return this.filesByPath.has(path) ? this.updateFile(path, blob) : revision(await this.createFile(path, blob, blob.type || "application/octet-stream")); }

  /** Writes Markdown directly to Drive with expected-revision checks and updates the encrypted mirror. @param input Shared write operation. @returns New Drive revision. */
  async writeDocument(input: WriteDocumentInput): Promise<WorkspaceRevision> {
    const blob = encodeDocument(input.content, input.format); const nextRevision = this.filesByPath.has(input.path) ? await this.updateFile(input.path, blob, input.expectedRevision) : revision(await this.createFile(input.path, blob, "text/markdown"));
    await this.options.mirror?.saveDocument({ path: input.path, content: input.content, format: input.format, revision: nextRevision }); return nextRevision;
  }

  /** Creates a Markdown document and its encrypted mirror record. @param path Workspace path. @param content Initial Markdown. @returns Created document. */
  async createDocument(path: string, content = ""): Promise<WorkspaceDocument> { if (this.filesByPath.has(path)) throw new WorkspaceError("collision", `${path} already exists.`); const format: DocumentFormat = { hasBom: false, lineEnding: "\n" }; const file = await this.createFile(path, encodeDocument(content, format), "text/markdown"); const document = { path, content, format, revision: revision(file) }; await this.options.mirror?.saveDocument(document); return document; }

  /** Creates a Drive directory path. @param path Workspace-relative directory path. @returns Nothing. */
  async createDirectory(path: string): Promise<void> { await this.ensureDirectory(path); }

  /** Moves or renames one Drive entry inside the selected folder. @param sourcePath Existing path. @param destinationPath New path. @returns Nothing. */
  async move(sourcePath: string, destinationPath: string): Promise<void> { const file = await this.resolve(sourcePath); const parts = destinationPath.split("/"); const name = parts.pop()!; const parentId = await this.ensureDirectory(parts.join("/")); const oldParents = file.parents?.join(",") ?? ""; const params = new URLSearchParams({ addParents: parentId, removeParents: oldParents, fields: "id,name,mimeType,modifiedTime,size,md5Checksum,version,parents" }); await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?${params}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await this.listEntries(); }

  /** Moves one Drive entry to Drive trash. @param path Workspace-relative path. @returns Recoverable token. */
  async trash(path: string): Promise<TrashResult> { const file = await this.resolve(path); await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) }); this.filesByPath.delete(path); return { token: JSON.stringify({ id: file.id, path }), originalPath: path }; }

  /** Restores one Drive entry from Drive trash. @param token Provider restore token. @returns Nothing. */
  async restore(token: string): Promise<void> { const value = JSON.parse(token) as { id: string }; await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(value.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: false }) }); await this.listEntries(); }

  /** Confirms that a short-lived Drive token can be acquired. @returns Whether authorization is available. */
  async requestPermission(): Promise<boolean> { try { await this.options.tokenProvider.getAccessToken(); return true; } catch { return false; } }
}
