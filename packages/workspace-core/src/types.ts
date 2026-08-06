export const supportedImageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"] as const;

export type WorkspaceEntryKind = "directory" | "document" | "image";
export type WorkspaceErrorCode =
  | "conflict"
  | "permission"
  | "not-found"
  | "collision"
  | "unsupported"
  | "quota"
  | "offline"
  | "cursor-invalid"
  | "ambiguous"
  | "temporary"
  | "fatal";

export interface WorkspaceRevision {
  id: string;
  modifiedAt: number;
  size: number;
}

export interface WorkspaceMetadataFingerprint {
  id: string;
  modifiedAt: number;
  size: number;
}

export type WorkspaceEntryState = "live" | "possibly-removed" | "removed" | "path-collision";

export interface WorkspaceEntry {
  kind: WorkspaceEntryKind;
  name: string;
  path: string;
  children?: WorkspaceEntry[];
  entryId?: string;
  parentEntryId?: string;
  revision?: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  state?: WorkspaceEntryState;
}

export interface WorkspaceEntryTarget {
  entryId?: string;
  path?: string;
}

export interface WorkspaceEntryMetadata {
  entryId: string;
  path: string;
  kind: WorkspaceEntryKind;
  parentEntryId?: string;
  revision?: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  state: WorkspaceEntryState;
}

export interface WorkspaceScanBatch {
  entries: WorkspaceEntry[];
  cursor?: string;
  done: boolean;
}

export interface WorkspaceChange {
  entryId: string;
  removed: boolean;
  metadata?: WorkspaceEntryMetadata;
}

export interface WorkspaceChangePage {
  changes: WorkspaceChange[];
  nextCursor: string;
  done: boolean;
}

export interface DocumentFormat {
  hasBom: boolean;
  lineEnding: "\n" | "\r\n";
}

export interface WorkspaceDocument {
  path: string;
  content: string;
  format: DocumentFormat;
  revision: WorkspaceRevision;
  entryId?: string;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
}

export interface WorkspaceBinary {
  path: string;
  blob: Blob;
  revision: WorkspaceRevision;
}

export interface WriteDocumentInput {
  path: string;
  content: string;
  format: DocumentFormat;
  expectedRevision?: WorkspaceRevision;
}

export interface TrashResult {
  token: string;
  originalPath: string;
}

export interface WorkspaceCapabilities {
  canWrite: boolean;
  canMove: boolean;
  canTrash: boolean;
  canRestore: boolean;
  watchesExternalChanges: boolean;
}

export interface WorkspaceProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: WorkspaceCapabilities;
  listEntries(): Promise<WorkspaceEntry[]>;
  getEntryMetadata?(target: WorkspaceEntryTarget): Promise<WorkspaceEntryMetadata>;
  scanEntries?(cursor?: string): Promise<WorkspaceScanBatch>;
  primeEntries?(entries: WorkspaceEntry[]): void;
  getChangesStartCursor?(): Promise<string>;
  listChanges?(cursor: string): Promise<WorkspaceChangePage>;
  readDocument(path: string): Promise<WorkspaceDocument>;
  readBinary(path: string): Promise<WorkspaceBinary>;
  writeBinary(path: string, blob: Blob): Promise<WorkspaceRevision>;
  writeDocument(input: WriteDocumentInput): Promise<WorkspaceRevision>;
  createDocument(path: string, content?: string): Promise<WorkspaceDocument>;
  createDirectory(path: string): Promise<void>;
  move(sourcePath: string, destinationPath: string): Promise<void>;
  trash(path: string): Promise<TrashResult>;
  restore(token: string): Promise<void>;
  requestPermission(): Promise<boolean>;
}

export class WorkspaceError extends Error {
  /**
   * Creates a provider-independent workspace error.
   * @param code Stable error category used by UI and tests.
   * @param message Human-readable diagnostic message.
   * @param cause Original provider error, when available.
   * @returns A typed workspace error.
   */
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "WorkspaceError";
    this.retryAfterMs = options?.retryAfterMs;
  }

  readonly retryAfterMs?: number;
}
