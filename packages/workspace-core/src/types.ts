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
  | "fatal";

export interface WorkspaceRevision {
  id: string;
  modifiedAt: number;
  size: number;
}

export interface WorkspaceEntry {
  kind: WorkspaceEntryKind;
  name: string;
  path: string;
  children?: WorkspaceEntry[];
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
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}
