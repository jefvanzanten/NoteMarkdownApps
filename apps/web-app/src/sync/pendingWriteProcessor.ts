import { WorkspaceError, type DocumentFormat, type WorkspaceProvider, type WorkspaceRevision } from "@note/workspace-core";
import { CancelledWorkError } from "@note/sync-core";
import {
  commitDocumentAndAcknowledgeWrite,
  deleteRepositoryDraft,
  loadCachedDocument,
  loadPendingWrites,
  loadRepositoryDraft,
  saveConflict,
  saveRepositoryDraft,
  updatePendingWriteIfCurrent,
  type PendingDocumentWrite,
} from "../storage/browserStorage";
import { providerWriteRetryDelay } from "./providerFailurePolicy";
import { recordSyncDiagnostic, reportSyncFailure, type SyncDiagnosticErrorCode } from "./workspaceDiagnostics";

export type PendingWriteSaveState = "clean" | "queued" | "conflicted" | "error-blocking";
export interface PendingWriteResult { entryId: string; saveState: PendingWriteSaveState; content?: string; revision?: WorkspaceRevision }

function diagnosticErrorCode(error: unknown): SyncDiagnosticErrorCode {
  if (error instanceof WorkspaceError) return error.code;
  if (error instanceof CancelledWorkError) return "cancelled";
  return "unexpected";
}

/**
 * Compares source-format facts that affect provider bytes.
 * @param left First document format.
 * @param right Second document format.
 * @returns Whether both formats encode content identically.
 */
export function documentFormatsMatch(left: DocumentFormat, right: DocumentFormat): boolean {
  return left.hasBom === right.hasBom && left.lineEnding === right.lineEnding;
}

/**
 * Applies one durable pending write after fresh provider revision verification.
 * @param provider Active sync-leader provider.
 * @param pending Durable outbox item.
 * @returns Applied content facts, or null after a durable retry/conflict state.
 */
export async function processPendingWrite(
  provider: WorkspaceProvider,
  pending: PendingDocumentWrite,
  mayMutate: () => Promise<boolean>,
): Promise<PendingWriteResult> {
  const operationId = crypto.randomUUID();
  const draft = await loadRepositoryDraft(provider.id, pending.entryId);
  const content = pending.content ?? draft?.content;
  const format = pending.format ?? draft?.format;
  if (content === undefined || !format) {
    const blocked = await updatePendingWriteIfCurrent({ ...pending, state: "blocked", attempt: pending.attempt + 1, retryAt: undefined });
    if (!blocked) return { entryId: pending.entryId, saveState: "queued" };
    recordSyncDiagnostic({ operation: "provider-write", operationId, outcome: "failed", attempt: pending.attempt + 1, errorCode: "missing-draft" });
    reportSyncFailure(Object.assign(new Error("Pending write has no immutable snapshot or durable draft"), { name: "PendingWriteError", code: "missing-draft" }));
    return { entryId: pending.entryId, saveState: "error-blocking" };
  }
  const startedAt = Date.now();
  recordSyncDiagnostic({ operation: "provider-write", operationId, outcome: "started", attempt: pending.attempt + 1 });
  try {
    let confirmedRevision: WorkspaceRevision | null = null;
    if (provider.getEntryMetadata) {
      const metadata = await provider.getEntryMetadata({ entryId: pending.entryId, path: pending.targetPath });
      if (metadata.state === "removed") throw new WorkspaceError("not-found", `${pending.targetPath} was removed.`);
      if (metadata.revision && metadata.revision.id !== pending.expectedBaseRevision.id) {
        const remote = await provider.readDocument(metadata.path);
        if (remote.content === content && documentFormatsMatch(remote.format, format)) {
          confirmedRevision = remote.revision;
          recordSyncDiagnostic({ operation: "provider-write", operationId, outcome: "skipped", attempt: pending.attempt + 1 });
        } else {
          const base = await loadCachedDocument(provider.id, pending.entryId);
          await saveConflict({
            id: `${provider.id}:${pending.entryId}`,
            workspaceId: provider.id,
            entryId: pending.entryId,
            path: metadata.path,
            baseContent: base?.content,
            localContent: content,
            remoteContent: remote.content,
            baseRevision: pending.expectedBaseRevision,
            remoteRevision: remote.revision,
            createdAt: Date.now(),
          });
          throw new WorkspaceError("conflict", `${pending.targetPath} changed before queued save.`);
        }
      }
    }
    if (!confirmedRevision) {
      if (!await mayMutate()) throw new CancelledWorkError();
      const claimed = await updatePendingWriteIfCurrent({ ...pending, state: "in-flight" });
      if (!claimed) return { entryId: pending.entryId, saveState: "queued" };
      confirmedRevision = await provider.writeDocument({
        path: pending.targetPath,
        content,
        format,
        expectedRevision: pending.expectedBaseRevision,
      });
    }
    const acknowledged = await commitDocumentAndAcknowledgeWrite({
      workspaceId: provider.id,
      entryId: pending.entryId,
      path: pending.targetPath,
      content,
      format,
      cachedContentRevision: confirmedRevision,
      lastAccessedAt: Date.now(),
    }, pending);
    if (!acknowledged) {
      const successor = (await loadPendingWrites(provider.id)).find((item) => item.id === pending.id && item.draftRevision !== pending.draftRevision);
      if (successor) await updatePendingWriteIfCurrent({ ...successor, expectedBaseRevision: confirmedRevision, state: "pending", retryAt: undefined });
    }
    const latestDraft = await loadRepositoryDraft(provider.id, pending.entryId);
    if (acknowledged && latestDraft?.content === content && documentFormatsMatch(latestDraft.format, format)) {
      await deleteRepositoryDraft(provider.id, pending.entryId);
    } else if (latestDraft && latestDraft.baseRevision.id === pending.expectedBaseRevision.id) {
      await saveRepositoryDraft({ ...latestDraft, baseRevision: confirmedRevision, updatedAt: Date.now() });
    }
    recordSyncDiagnostic({ operation: "provider-write", operationId, outcome: "succeeded", attempt: pending.attempt + 1, durationMs: Date.now() - startedAt });
    return { entryId: pending.entryId, saveState: "clean", content, revision: confirmedRevision };
  } catch (error) {
    const conflicted = error instanceof WorkspaceError && (error.code === "conflict" || error.code === "not-found");
    const retryDelayMs = conflicted ? null : providerWriteRetryDelay(error, pending.attempt);
    const updated = await updatePendingWriteIfCurrent({
      ...pending,
      state: conflicted ? "conflicted" : retryDelayMs === null ? "blocked" : "retryable",
      attempt: pending.attempt + 1,
      retryAt: retryDelayMs === null ? undefined : Date.now() + retryDelayMs,
    });
    if (!updated) return { entryId: pending.entryId, saveState: "queued" };
    recordSyncDiagnostic({
      operation: "provider-write",
      operationId,
      outcome: "failed",
      attempt: pending.attempt + 1,
      durationMs: Date.now() - startedAt,
      errorCode: diagnosticErrorCode(error),
      retryDelayMs: retryDelayMs ?? undefined,
    });
    reportSyncFailure(error);
    return { entryId: pending.entryId, saveState: conflicted ? "conflicted" : retryDelayMs === null ? "error-blocking" : "queued" };
  }
}

