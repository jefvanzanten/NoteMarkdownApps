import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSyncDiagnosticEvents, getSyncDiagnosticEvents, recordSyncDiagnostic } from "./workspaceDiagnostics";

interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Creates an isolated localStorage-compatible test double.
 * @returns In-memory key/value storage.
 */
function createStorage(): StorageStub {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorage());
  clearSyncDiagnosticEvents();
});

describe("workspace sync diagnostics", () => {
  it("persists path-free provider failure facts locally", () => {
    recordSyncDiagnostic({ operation: "drive-request", requestKind: "mutation", outcome: "failed", status: 503, errorCode: "temporary", durationMs: 42 });
    expect(getSyncDiagnosticEvents()).toMatchObject([{
      operation: "drive-request",
      requestKind: "mutation",
      outcome: "failed",
      status: 503,
      errorCode: "temporary",
      durationMs: 42,
    }]);
    expect(JSON.stringify(getSyncDiagnosticEvents())).not.toMatch(/workspace|folder|path|content|entryId/);
  });

  it("bounds retained events and clears them", () => {
    for (let attempt = 0; attempt < 205; attempt += 1) recordSyncDiagnostic({ operation: "provider-write", outcome: "queued", attempt });
    expect(getSyncDiagnosticEvents()).toHaveLength(200);
    expect(getSyncDiagnosticEvents()[0].attempt).toBe(5);
    clearSyncDiagnosticEvents();
    expect(getSyncDiagnosticEvents()).toEqual([]);
  });
});
