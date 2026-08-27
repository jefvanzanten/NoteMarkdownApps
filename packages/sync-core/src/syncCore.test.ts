import { describe, expect, it } from "vitest";
import { applyWorkspaceChanges, compareWorkspaceManifests } from "./changes";
import { decideReconciliation } from "./reconciliation";
import { PriorityScheduler } from "./scheduler";

/** @returns A promise and its external resolver for scheduler tests. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("PriorityScheduler", () => {
  it("deduplicates work and selects active work before queued background work", async () => {
    const gate = deferred();
    const order: string[] = [];
    const scheduler = new PriorityScheduler({ concurrency: 1 });
    const running = scheduler.enqueue({ key: "running", workspaceId: "w", generation: 1, priority: 4, run: async () => { await gate.promise; order.push("running"); return 1; } });
    const background = scheduler.enqueue({ key: "background", workspaceId: "w", generation: 1, priority: 5, run: async () => { order.push("background"); return 2; } });
    const active = scheduler.enqueue({ key: "active", workspaceId: "w", generation: 1, priority: 1, run: async () => { order.push("active"); return 3; } });
    const duplicate = scheduler.enqueue({ key: "active", workspaceId: "w", generation: 1, priority: 1, run: async () => 4 });
    gate.resolve();
    expect(await Promise.all([running, background, active, duplicate])).toEqual([1, 2, 3, 3]);
    expect(order).toEqual(["running", "active", "background"]);
  });
});

describe("Drive change application", () => {
  const directory = { workspaceId: "drive:w", entryId: "folder", path: "old", kind: "directory" as const, state: "live" as const, updatedAt: 1 };
  const document = { workspaceId: "drive:w", entryId: "file", path: "old/note.md", kind: "document" as const, parentEntryId: "folder", observedProviderRevision: { id: "R1", modifiedAt: 1, size: 1 }, state: "live" as const, updatedAt: 1 };

  it("compares authoritative revisions, removals, and stable-ID moves", () => {
    const moved = { ...document, path: "new/note.md", observedProviderRevision: { ...document.observedProviderRevision, id: "R2" } };
    const result = compareWorkspaceManifests([directory, document], [moved]);
    expect(result.changedEntryIds).toEqual(new Set(["file"]));
    expect(result.removedPaths).toEqual(new Set(["old"]));
    expect(result.moves).toEqual([{ entryId: "file", previousPath: "old/note.md", nextPath: "new/note.md" }]);
  });

  it("propagates a stable folder move to descendants", () => {
    const result = applyWorkspaceChanges([directory, document], [{ entryId: "folder", removed: false, metadata: { entryId: "folder", path: "new", kind: "directory", state: "live" } }], "drive:w", 2);
    expect(result.entries.find((entry) => entry.entryId === "file")?.path).toBe("new/note.md");
    expect(result.moves).toContainEqual({ entryId: "file", previousPath: "old/note.md", nextPath: "new/note.md" });
  });

  it("removes a folder and descendants authoritatively", () => {
    const result = applyWorkspaceChanges([directory, document], [{ entryId: "folder", removed: true }], "drive:w", 2);
    expect(result.removedEntryIds).toEqual(new Set(["folder", "file"]));
    expect(result.entries.every((entry) => entry.state === "removed")).toBe(true);
  });

  it("marks duplicate live paths as collisions", () => {
    const result = applyWorkspaceChanges([document], [{ entryId: "other", removed: false, metadata: { entryId: "other", path: "old/note.md", kind: "document", state: "live" } }], "drive:w", 2);
    expect(result.entries.map((entry) => entry.state)).toEqual(["path-collision", "path-collision"]);
  });
});

describe("reconciliation state machine", () => {
  it("never advances cached revision after metadata observation", () => {
    const result = decideReconciliation({ existsInManifest: true, remoteState: "live", remoteRevision: "R2", cachedContentRevision: "R1", baseRevision: "R1", dirty: false, pathChanged: false, hasPendingWrite: false });
    expect(result.action).toBe("download-update");
    expect(result.mayAdvanceObservedRevision).toBe(true);
    expect(result.mayAdvanceCachedRevision).toBe(false);
  });

  it("preserves dirty content as recovery after confirmed removal", () => {
    expect(decideReconciliation({ existsInManifest: true, remoteState: "removed", cachedContentRevision: "R1", dirty: true, pathChanged: false, hasPendingWrite: false })).toMatchObject({ action: "create-recovery", preserveLocal: true });
  });
});
