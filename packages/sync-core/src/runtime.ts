import type { WorkspaceEntry, WorkspaceFailure } from "@note/workspace-core";

export interface SyncClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemSyncClock: SyncClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export type SyncDocumentState = "checking" | "clean" | "dirty-local" | "persisting-local" | "queued" | "conflicted" | "destroyed" | "error-blocking";

/** Content-free events emitted by framework-independent sync orchestration. */
export type SyncEvent =
  | { type: "workspace-activation-started"; generation: number }
  | { type: "manifest-updated"; generation: number; entries: WorkspaceEntry[] }
  | { type: "document-state-changed"; generation: number; entryId: string; state: SyncDocumentState }
  | { type: "remote-document-updated"; generation: number; entryId: string }
  | { type: "pending-write-blocked"; generation: number; entryId: string; failure: WorkspaceFailure }
  | { type: "workspace-failed"; generation: number; failure: WorkspaceFailure };

export interface SyncEventSink { emit(event: SyncEvent): void }
export const noopSyncEventSink: SyncEventSink = { emit: () => undefined };
