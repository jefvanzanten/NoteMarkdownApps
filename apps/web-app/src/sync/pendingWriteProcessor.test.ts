import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDocumentWrite } from "../storage/browserStorage";
import type { WorkspaceProvider } from "@note/workspace-core";

const storage = vi.hoisted(() => ({
  commitDocumentAndAcknowledgeWrite: vi.fn(),
  deleteRepositoryDraft: vi.fn(),
  loadCachedDocument: vi.fn(),
  loadPendingWrites: vi.fn(),
  loadRepositoryDraft: vi.fn(),
  saveConflict: vi.fn(),
  saveRepositoryDraft: vi.fn(),
  updatePendingWriteIfCurrent: vi.fn(),
}));
vi.mock("../storage/browserStorage", () => storage);
vi.mock("./workspaceDiagnostics", () => ({ recordSyncDiagnostic: vi.fn(), reportSyncFailure: vi.fn() }));

import { processPendingWrite } from "./pendingWriteProcessor";

const pending: PendingDocumentWrite = {
  id: "pending-1",
  formatVersion: 1,
  workspaceId: "drive:w",
  entryId: "file-1",
  targetPath: "note.md",
  expectedBaseRevision: { id: "R1", modifiedAt: 1, size: 1 },
  draftRevision: "draft-1",
  state: "pending",
  attempt: 0,
  createdAt: 1,
  updatedAt: 1,
};

const provider = {
  id: "drive:w",
  getEntryMetadata: vi.fn(async () => ({ entryId: "file-1", path: "note.md", kind: "document" as const, revision: pending.expectedBaseRevision, state: "live" as const })),
  readDocument: vi.fn(),
  writeDocument: vi.fn(async () => ({ id: "R2", modifiedAt: 2, size: 2 })),
} as unknown as WorkspaceProvider;

beforeEach(() => {
  vi.clearAllMocks();
  storage.updatePendingWriteIfCurrent.mockResolvedValue(true);
  storage.commitDocumentAndAcknowledgeWrite.mockResolvedValue(true);
  storage.deleteRepositoryDraft.mockResolvedValue(undefined);
  storage.loadCachedDocument.mockResolvedValue(null);
  storage.loadPendingWrites.mockResolvedValue([]);
  storage.saveConflict.mockResolvedValue(undefined);
  storage.saveRepositoryDraft.mockImplementation(async (draft) => draft);
});

describe("pending write processor", () => {
  it("blocks an outbox item whose durable draft is missing", async () => {
    storage.loadRepositoryDraft.mockResolvedValue(null);
    await expect(processPendingWrite(provider, pending, async () => true)).resolves.toEqual({ entryId: "file-1", saveState: "error-blocking" });
    expect(storage.updatePendingWriteIfCurrent).toHaveBeenCalledWith(expect.objectContaining({ state: "blocked", attempt: 1 }));
    expect(provider.writeDocument).not.toHaveBeenCalled();
  });

  it("checks leadership immediately before mutating the provider", async () => {
    storage.loadRepositoryDraft.mockResolvedValue({ workspaceId: "drive:w", entryId: "file-1", path: "note.md", content: "draft", format: { hasBom: false, lineEnding: "\n" }, updatedAt: 2 });
    const result = await processPendingWrite(provider, pending, async () => false);
    expect(result.saveState).toBe("queued");
    expect(provider.writeDocument).not.toHaveBeenCalled();
    expect(storage.updatePendingWriteIfCurrent).toHaveBeenLastCalledWith(expect.objectContaining({ state: "retryable", attempt: 1 }));
  });

  it("atomically acknowledges a successful provider write", async () => {
    const draft = { workspaceId: "drive:w", entryId: "file-1", path: "note.md", content: "draft", format: { hasBom: false, lineEnding: "\n" as const }, updatedAt: 2 };
    storage.loadRepositoryDraft.mockResolvedValueOnce(draft).mockResolvedValueOnce(draft);
    const result = await processPendingWrite(provider, pending, async () => true);
    expect(result).toMatchObject({ entryId: "file-1", saveState: "clean", content: "draft", revision: { id: "R2" } });
    expect(storage.commitDocumentAndAcknowledgeWrite).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "drive:w", entryId: "file-1", cachedContentRevision: { id: "R2", modifiedAt: 2, size: 2 } }), pending);
    expect(storage.deleteRepositoryDraft).toHaveBeenCalledWith("drive:w", "file-1");
  });

  it("uses an immutable version-two snapshot when the latest draft is missing", async () => {
    storage.loadRepositoryDraft.mockResolvedValue(null);
    const snapshotPending = { ...pending, formatVersion: 2, content: "attempted", format: { hasBom: false, lineEnding: "\n" as const } };

    const result = await processPendingWrite(provider, snapshotPending, async () => true);

    expect(result).toMatchObject({ saveState: "clean", content: "attempted" });
    expect(provider.writeDocument).toHaveBeenCalledWith(expect.objectContaining({ content: "attempted" }));
  });

  it("rebases a superseding pending revision and newer draft after the older write succeeds", async () => {
    const snapshotPending = { ...pending, formatVersion: 2, content: "attempted", format: { hasBom: false, lineEnding: "\n" as const } };
    const successor = { ...snapshotPending, draftRevision: "newer", content: "newer", state: "pending" as const };
    const latestDraft = { localRevision: "newer", workspaceId: "drive:w", entryId: "file-1", path: "note.md", content: "newer", format: snapshotPending.format, baseRevision: pending.expectedBaseRevision, cursor: 0, updatedAt: 3 };
    storage.commitDocumentAndAcknowledgeWrite.mockResolvedValueOnce(false);
    storage.loadRepositoryDraft.mockResolvedValue(latestDraft);
    storage.loadPendingWrites.mockResolvedValue([successor]);

    const result = await processPendingWrite(provider, snapshotPending, async () => true);

    expect(result).toMatchObject({ saveState: "clean", content: "attempted", revision: { id: "R2" } });
    expect(storage.updatePendingWriteIfCurrent).toHaveBeenCalledWith(expect.objectContaining({ draftRevision: "newer", expectedBaseRevision: expect.objectContaining({ id: "R2" }), state: "pending" }));
    expect(storage.saveRepositoryDraft).toHaveBeenCalledWith(expect.objectContaining({ localRevision: "newer", baseRevision: expect.objectContaining({ id: "R2" }) }));
  });

  it("acknowledges an uncertain write when Drive already contains the attempted snapshot", async () => {
    const snapshotPending = { ...pending, formatVersion: 2, content: "attempted", format: { hasBom: false, lineEnding: "\n" as const }, state: "in-flight" as const };
    storage.loadRepositoryDraft.mockResolvedValue({ localRevision: "newer", workspaceId: "drive:w", entryId: "file-1", path: "note.md", content: "newer", format: snapshotPending.format, baseRevision: pending.expectedBaseRevision, cursor: 0, updatedAt: 3 });
    vi.mocked(provider.getEntryMetadata!).mockResolvedValueOnce({ entryId: "file-1", path: "note.md", kind: "document", revision: { id: "R2", modifiedAt: 2, size: 2 }, state: "live" });
    vi.mocked(provider.readDocument).mockResolvedValueOnce({ entryId: "file-1", path: "note.md", content: "attempted", format: snapshotPending.format, revision: { id: "R2", modifiedAt: 2, size: 2 } });

    const result = await processPendingWrite(provider, snapshotPending, async () => true);

    expect(result).toMatchObject({ saveState: "clean", content: "attempted", revision: { id: "R2" } });
    expect(provider.writeDocument).not.toHaveBeenCalled();
    expect(storage.commitDocumentAndAcknowledgeWrite).toHaveBeenCalled();
    expect(storage.deleteRepositoryDraft).not.toHaveBeenCalled();
  });
});
