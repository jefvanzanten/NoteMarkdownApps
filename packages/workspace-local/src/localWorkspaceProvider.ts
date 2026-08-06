/// <reference path="./file-system-access.d.ts" />

import {
  WorkspaceError,
  classifyWorkspaceEntry,
  joinWorkspacePath,
  normalizeWorkspacePath,
  workspaceDirname,
  type DocumentFormat,
  type TrashResult,
  type WorkspaceBinary,
  type WorkspaceDocument,
  type WorkspaceEntry,
  type WorkspaceEntryMetadata,
  type WorkspaceEntryTarget,
  type WorkspaceMetadataFingerprint,
  type WorkspaceProvider,
  type WorkspaceRevision,
  type WorkspaceScanBatch,
  type WriteDocumentInput,
} from "@note/workspace-core";

const encoder = new TextEncoder();
const transientTrashRecords = new Map<string, string>();

/**
 * Persists trash recovery metadata across browser sessions when available.
 * @param key Provider-scoped recovery key.
 * @param value Serialized recovery record.
 * @returns Nothing after storage.
 */
function setTrashRecord(key: string, value: string): void {
  if (typeof localStorage === "undefined") transientTrashRecords.set(key, value);
  else localStorage.setItem(key, value);
}

/**
 * Loads provider-scoped trash recovery metadata.
 * @param key Provider-scoped recovery key.
 * @returns Serialized recovery record or null.
 */
function getTrashRecord(key: string): string | null {
  return typeof localStorage === "undefined" ? transientTrashRecords.get(key) ?? null : localStorage.getItem(key);
}

/**
 * Removes provider-scoped trash recovery metadata.
 * @param key Provider-scoped recovery key.
 * @returns Nothing after removal.
 */
function removeTrashRecord(key: string): void {
  if (typeof localStorage === "undefined") transientTrashRecords.delete(key);
  else localStorage.removeItem(key);
}

/**
 * Converts browser file metadata and bytes into a revision identity.
 * @param file Provider file snapshot.
 * @param bytes Exact file bytes.
 * @returns A content-addressed workspace revision.
 */
async function createRevision(file: File, bytes: ArrayBuffer): Promise<WorkspaceRevision> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, modifiedAt: file.lastModified, size: file.size };
}

/**
 * Creates a cheap local metadata fingerprint without reading file content.
 * @param file Provider file snapshot.
 * @returns Weak startup fingerprint used only to decide whether content needs verification.
 */
function createMetadataFingerprint(file: File): WorkspaceMetadataFingerprint {
  return { id: `${file.lastModified}:${file.size}`, modifiedAt: file.lastModified, size: file.size };
}

/**
 * Maps browser filesystem failures to stable workspace error categories.
 * @param error Browser filesystem exception.
 * @param fallbackMessage Message used when the provider gives no useful detail.
 * @returns A provider-independent workspace error.
 */
function mapFileSystemError(error: unknown, fallbackMessage: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const name = error instanceof DOMException ? error.name : "";
  const code = name === "NotAllowedError"
    ? "permission"
    : name === "NotFoundError"
      ? "not-found"
      : name === "InvalidModificationError" || name === "TypeMismatchError"
        ? "collision"
        : name === "QuotaExceededError"
          ? "quota"
          : "fatal";
  return new WorkspaceError(code, error instanceof Error ? error.message : fallbackMessage, { cause: error });
}

/**
 * Detects the original text format while exposing normalized editor content.
 * @param bytes Exact UTF-8 file bytes.
 * @returns Decoded content and formatting metadata.
 */
function decodeDocument(bytes: ArrayBuffer): { content: string; format: DocumentFormat } {
  const view = new Uint8Array(bytes);
  const hasBom = view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? view.subarray(3) : view);
  const lineEnding = decoded.includes("\r\n") ? "\r\n" : "\n";
  return { content: decoded.replaceAll("\r\n", "\n"), format: { hasBom, lineEnding } };
}

/**
 * Encodes normalized editor content using the document's original format.
 * @param content Editor content with normalized line endings.
 * @param format Formatting metadata captured during read.
 * @returns Exact bytes for the provider write.
 */
function encodeDocument(content: string, format: DocumentFormat): Uint8Array {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const body = encoder.encode(format.lineEnding === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized);
  if (!format.hasBom) return body;
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return bytes;
}

/**
 * Opens a user-selected real directory as a local workspace.
 * @returns A local provider with read/write permission.
 */
export async function openLocalWorkspace(): Promise<LocalWorkspaceProvider> {
  if (!("showDirectoryPicker" in window)) {
    throw new WorkspaceError("unsupported", "This browser cannot open real local directories.");
  }
  const handle = await window.showDirectoryPicker({ id: "notemarkdown-workspace", mode: "readwrite" });
  return new LocalWorkspaceProvider(handle);
}

/**
 * Reopens a previously persisted directory handle without showing a picker.
 * @param handle Persisted File System Access directory handle.
 * @param id Stable browser-local workspace identity.
 * @param prompt Whether the browser may prompt the user for renewed permission.
 * @returns A local provider when permission is granted.
 */
export async function reopenLocalWorkspace(handle: FileSystemDirectoryHandle, id: string, prompt = false): Promise<LocalWorkspaceProvider> {
  const provider = new LocalWorkspaceProvider(handle, id);
  if (!await provider.requestPermission(prompt)) {
    throw new WorkspaceError("permission", "The workspace needs permission before it can be reopened.");
  }
  return provider;
}

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities = {
    canWrite: true,
    canMove: true,
    canTrash: true,
    canRestore: true,
    watchesExternalChanges: false,
  } as const;

  /**
   * Creates a local provider around a File System Access directory handle.
   * @param directoryHandle Real provider directory selected by the user.
   * @param id Optional stable browser-local workspace identity.
   * @returns A local workspace provider.
   */
  constructor(readonly directoryHandle: FileSystemDirectoryHandle, id?: string) {
    this.id = id ?? `local:${directoryHandle.name}:${crypto.randomUUID()}`;
    this.name = directoryHandle.name;
  }

  /**
   * Lists supported documents, images, and visible directories recursively.
   * @returns A deterministic hierarchical workspace tree.
   */
  async listEntries(): Promise<WorkspaceEntry[]> {
    try {
      return await this.listDirectory(this.directoryHandle, "");
    } catch (error) {
      throw mapFileSystemError(error, "The workspace could not be scanned.");
    }
  }

  /**
   * Reads and decodes a UTF-8 Markdown document.
   * @param path Workspace-relative Markdown path.
   * @returns Normalized text, original format, and revision.
   */
  async readDocument(path: string): Promise<WorkspaceDocument> {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath.toLowerCase().endsWith(".md")) {
      throw new WorkspaceError("unsupported", "Only .md files are editable.");
    }
    try {
      const handle = await this.getFileHandle(normalizedPath);
      const file = await handle.getFile();
      const bytes = await file.arrayBuffer();
      const decoded = decodeDocument(bytes);
      return {
        path: normalizedPath,
        ...decoded,
        revision: await createRevision(file, bytes),
        entryId: normalizedPath,
        metadataFingerprint: createMetadataFingerprint(file),
      };
    } catch (error) {
      throw mapFileSystemError(error, `Could not read ${normalizedPath}.`);
    }
  }

  /**
   * Reads weak file metadata without reading content bytes.
   * @param target Stable normalized path identity and/or current path.
   * @returns Current local metadata fingerprint.
   */
  async getEntryMetadata(target: WorkspaceEntryTarget): Promise<WorkspaceEntryMetadata> {
    const normalizedPath = normalizeWorkspacePath(target.path ?? target.entryId ?? "");
    try {
      const file = await (await this.getFileHandle(normalizedPath)).getFile();
      const name = normalizedPath.split("/").at(-1) ?? normalizedPath;
      const kind = classifyWorkspaceEntry(name, false);
      if (!kind) throw new WorkspaceError("unsupported", `${normalizedPath} is not a supported workspace entry.`);
      return {
        entryId: normalizedPath,
        path: normalizedPath,
        kind,
        parentEntryId: workspaceDirname(normalizedPath) || undefined,
        metadataFingerprint: createMetadataFingerprint(file),
        state: "live",
      };
    } catch (error) {
      throw mapFileSystemError(error, `Could not inspect ${normalizedPath}.`);
    }
  }

  /**
   * Returns one bounded compatibility scan batch.
   * @param cursor Opaque top-level offset from a previous batch.
   * @returns Deterministic top-level entries.
   */
  async scanEntries(cursor?: string): Promise<WorkspaceScanBatch> {
    const entries = await this.listEntries();
    const offset = Math.max(0, Number(cursor ?? 0) || 0);
    const batch = entries.slice(offset, offset + 250);
    const nextOffset = offset + batch.length;
    return { entries: batch, cursor: nextOffset < entries.length ? String(nextOffset) : undefined, done: nextOffset >= entries.length };
  }

  /**
   * Reads an image as an isolated browser Blob.
   * @param path Workspace-relative image path.
   * @returns Image bytes and revision.
   */
  async readBinary(path: string): Promise<WorkspaceBinary> {
    const normalizedPath = normalizeWorkspacePath(path);
    const name = normalizedPath.split("/").at(-1) ?? normalizedPath;
    if (classifyWorkspaceEntry(name, false) !== "image") {
      throw new WorkspaceError("unsupported", "Only supported image formats can be loaded as assets.");
    }
    try {
      const file = await (await this.getFileHandle(normalizedPath)).getFile();
      const bytes = await file.arrayBuffer();
      return { path: normalizedPath, blob: file, revision: await createRevision(file, bytes) };
    } catch (error) {
      throw mapFileSystemError(error, `Could not read ${normalizedPath}.`);
    }
  }

  /**
   * Writes an original image blob without conversion or silent overwrite.
   * @param path Workspace-relative asset path.
   * @param blob Original supported image bytes.
   * @returns The newly written provider revision.
   */
  async writeBinary(path: string, blob: Blob): Promise<WorkspaceRevision> {
    const normalizedPath = normalizeWorkspacePath(path);
    const name = normalizedPath.split("/").at(-1) ?? normalizedPath;
    if (classifyWorkspaceEntry(name, false) !== "image") {
      throw new WorkspaceError("unsupported", "Only supported image formats can be written as assets.");
    }
    try {
      const parent = await this.getDirectoryHandle(workspaceDirname(normalizedPath), true);
      if (await this.entryExists(parent, name)) throw new WorkspaceError("collision", `${normalizedPath} already exists.`);
      const handle = await parent.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const file = await handle.getFile();
      const bytes = await file.arrayBuffer();
      return await createRevision(file, bytes);
    } catch (error) {
      throw mapFileSystemError(error, `Could not write ${normalizedPath}.`);
    }
  }

  /**
   * Writes a document only when its expected revision is still current.
   * @param input Content, format, path, and optional expected revision.
   * @returns The newly written provider revision.
   */
  async writeDocument(input: WriteDocumentInput): Promise<WorkspaceRevision> {
    const path = normalizeWorkspacePath(input.path);
    try {
      const handle = await this.getFileHandle(path);
      if (input.expectedRevision) {
        const currentFile = await handle.getFile();
        const currentBytes = await currentFile.arrayBuffer();
        const currentRevision = await createRevision(currentFile, currentBytes);
        if (currentRevision.id !== input.expectedRevision.id) {
          throw new WorkspaceError("conflict", `${path} changed outside NoteMarkdown.`);
        }
      }
      const writable = await handle.createWritable();
      const encoded = encodeDocument(input.content, input.format);
      await writable.write(encoded.buffer as ArrayBuffer);
      await writable.close();
      const written = await handle.getFile();
      const bytes = await written.arrayBuffer();
      return await createRevision(written, bytes);
    } catch (error) {
      throw mapFileSystemError(error, `Could not save ${path}.`);
    }
  }

  /**
   * Creates a new Markdown document without overwriting an existing entry.
   * @param path Workspace-relative destination path.
   * @param content Optional initial Markdown content.
   * @returns The new document snapshot.
   */
  async createDocument(path: string, content = ""): Promise<WorkspaceDocument> {
    const normalizedPath = normalizeWorkspacePath(path.toLowerCase().endsWith(".md") ? path : `${path}.md`);
    try {
      const parent = await this.getDirectoryHandle(workspaceDirname(normalizedPath), false);
      const name = normalizedPath.split("/").at(-1) ?? normalizedPath;
      if (await this.entryExists(parent, name)) throw new WorkspaceError("collision", `${normalizedPath} already exists.`);
      await parent.getFileHandle(name, { create: true });
      const format: DocumentFormat = { hasBom: false, lineEnding: "\n" };
      const revision = await this.writeDocument({ path: normalizedPath, content, format });
      return { path: normalizedPath, content, format, revision };
    } catch (error) {
      throw mapFileSystemError(error, `Could not create ${normalizedPath}.`);
    }
  }

  /**
   * Creates a directory without overwriting a file.
   * @param path Workspace-relative directory path.
   * @returns Nothing after creation completes.
   */
  async createDirectory(path: string): Promise<void> {
    const normalizedPath = normalizeWorkspacePath(path);
    try {
      const parent = await this.getDirectoryHandle(workspaceDirname(normalizedPath), false);
      const name = normalizedPath.split("/").at(-1) ?? normalizedPath;
      if (await this.entryExists(parent, name)) throw new WorkspaceError("collision", `${normalizedPath} already exists.`);
      await parent.getDirectoryHandle(name, { create: true });
    } catch (error) {
      throw mapFileSystemError(error, `Could not create ${normalizedPath}.`);
    }
  }

  /**
   * Moves a file or directory by provider-safe copy followed by removal.
   * @param sourcePath Existing workspace-relative path.
   * @param destinationPath New workspace-relative path.
   * @returns Nothing after the move completes.
   */
  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const source = normalizeWorkspacePath(sourcePath);
    const destination = normalizeWorkspacePath(destinationPath);
    if (destination === source || destination.startsWith(`${source}/`)) {
      throw new WorkspaceError("unsupported", "An entry cannot be moved into itself.");
    }
    try {
      const sourceParent = await this.getDirectoryHandle(workspaceDirname(source), false);
      const destinationParent = await this.getDirectoryHandle(workspaceDirname(destination), false);
      const sourceName = source.split("/").at(-1) ?? source;
      const destinationName = destination.split("/").at(-1) ?? destination;
      if (await this.entryExists(destinationParent, destinationName)) {
        throw new WorkspaceError("collision", `${destination} already exists.`);
      }
      const sourceHandle = await sourceParent.getFileHandle(sourceName).catch(() => sourceParent.getDirectoryHandle(sourceName));
      await this.copyEntry(sourceHandle, destinationParent, destinationName);
      await sourceParent.removeEntry(sourceName, { recursive: sourceHandle.kind === "directory" });
    } catch (error) {
      throw mapFileSystemError(error, `Could not move ${source}.`);
    }
  }

  /**
   * Moves an entry to the workspace's hidden recovery directory.
   * @param path Workspace-relative entry path.
   * @returns A token that can restore the entry during this app session.
   */
  async trash(path: string): Promise<TrashResult> {
    const originalPath = normalizeWorkspacePath(path);
    const token = crypto.randomUUID();
    const name = originalPath.split("/").at(-1) ?? originalPath;
    const trashPath = joinWorkspacePath(".notemarkdown-trash", token, name);
    try {
      await this.getDirectoryHandle(joinWorkspacePath(".notemarkdown-trash", token), true);
      await this.move(originalPath, trashPath);
      setTrashRecord(`notemarkdown:trash:${this.id}:${token}`, JSON.stringify({ originalPath, trashPath, deletedAt: Date.now() }));
      return { token, originalPath };
    } catch (error) {
      throw mapFileSystemError(error, `Could not trash ${originalPath}.`);
    }
  }

  /**
   * Restores a previously trashed entry to its original path.
   * @param token Token returned by the trash operation.
   * @returns Nothing after restoration completes.
   */
  async restore(token: string): Promise<void> {
    const storageKey = `notemarkdown:trash:${this.id}:${token}`;
    const serialized = getTrashRecord(storageKey);
    if (!serialized) throw new WorkspaceError("not-found", "This recovery item is no longer available.");
    const record = JSON.parse(serialized) as { originalPath: string; trashPath: string; deletedAt: number };
    if (Date.now() - record.deletedAt > 30 * 86_400_000) {
      const parent = await this.getDirectoryHandle(workspaceDirname(record.trashPath), false);
      await parent.removeEntry(record.trashPath.split("/").at(-1) ?? "", { recursive: true });
      removeTrashRecord(storageKey);
      throw new WorkspaceError("not-found", "This recovery item expired after 30 days.");
    }
    await this.move(record.trashPath, record.originalPath);
    removeTrashRecord(storageKey);
    const tokenDirectory = joinWorkspacePath(".notemarkdown-trash", token);
    const parent = await this.getDirectoryHandle(workspaceDirname(tokenDirectory), false);
    await parent.removeEntry(token, { recursive: true }).catch(() => undefined);
  }

  /**
   * Requests read/write access to the selected directory.
   * @returns Whether read/write permission is currently granted.
   */
  async requestPermission(prompt = true): Promise<boolean> {
    const descriptor = { mode: "readwrite" as const };
    const current = await this.directoryHandle.queryPermission(descriptor);
    return current === "granted" || (prompt && await this.directoryHandle.requestPermission(descriptor) === "granted");
  }

  /**
   * Lists one provider directory and recursively builds visible children.
   * @param directory Directory handle to inspect.
   * @param parentPath Workspace-relative parent path.
   * @returns Sorted supported entries.
   */
  private async listDirectory(directory: FileSystemDirectoryHandle, parentPath: string): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    for await (const [name, handle] of directory.entries()) {
      const kind = classifyWorkspaceEntry(name, handle.kind === "directory");
      if (!kind) continue;
      const path = joinWorkspacePath(parentPath, name);
      const file = handle.kind === "file" ? await handle.getFile() : null;
      entries.push({
        kind,
        name,
        path,
        entryId: path,
        parentEntryId: parentPath || undefined,
        metadataFingerprint: file ? createMetadataFingerprint(file) : undefined,
        state: "live",
        children: handle.kind === "directory" ? await this.listDirectory(handle, path) : undefined,
      });
    }
    return entries.sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (right.kind === "directory" && left.kind !== "directory") return 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  /**
   * Resolves a directory handle below the selected root.
   * @param path Workspace-relative directory path.
   * @param create Whether missing directories may be created.
   * @returns Resolved directory handle.
   */
  private async getDirectoryHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let directory = this.directoryHandle;
    const normalized = path ? normalizeWorkspacePath(path) : "";
    for (const segment of normalized.split("/").filter(Boolean)) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return directory;
  }

  /**
   * Resolves a file handle below the selected root.
   * @param path Workspace-relative file path.
   * @returns Resolved file handle.
   */
  private async getFileHandle(path: string): Promise<FileSystemFileHandle> {
    const normalized = normalizeWorkspacePath(path);
    const parent = await this.getDirectoryHandle(workspaceDirname(normalized), false);
    return parent.getFileHandle(normalized.split("/").at(-1) ?? normalized);
  }

  /**
   * Checks whether a named entry already exists.
   * @param directory Parent directory handle.
   * @param name Child entry name.
   * @returns Whether either a file or directory uses the name.
   */
  private async entryExists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try {
      await directory.getFileHandle(name);
      return true;
    } catch {
      try {
        await directory.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Recursively copies one provider entry to a destination directory.
   * @param source Source file or directory handle.
   * @param destinationParent Destination parent directory.
   * @param destinationName Name assigned to the copy.
   * @returns Nothing after all bytes are copied.
   */
  private async copyEntry(
    source: FileSystemFileHandle | FileSystemDirectoryHandle,
    destinationParent: FileSystemDirectoryHandle,
    destinationName: string,
  ): Promise<void> {
    if (source.kind === "file") {
      const destination = await destinationParent.getFileHandle(destinationName, { create: true });
      const writable = await destination.createWritable();
      await writable.write(await source.getFile());
      await writable.close();
      return;
    }
    const destination = await destinationParent.getDirectoryHandle(destinationName, { create: true });
    for await (const [name, child] of source.entries()) await this.copyEntry(child, destination, name);
  }
}
