import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSyncDiagnosticEvents,
  configureSyncDiagnostics,
  createDriveDiagnostics,
  getSyncDiagnosticEvents,
  recordSyncDiagnostic,
  reportSyncFailure,
  resetWorkspaceMetrics,
} from "./workspaceDiagnostics";

beforeEach(() => {
  clearSyncDiagnosticEvents();
  resetWorkspaceMetrics();
  configureSyncDiagnostics({
    enabled: true,
    slowOperationMs: 30_000,
    buildMode: "test",
    getPageState: () => ({ providerType: "drive", isOpening: false, isIndexing: true, entryCount: 4, tabCount: 1, saveStates: { queued: 1 } }),
  });
});

describe("workspace sync diagnostics", () => {
  it("retains path-free provider facts only in bounded process memory", () => {
    const localStorageWrite = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localStorageWrite });
    recordSyncDiagnostic({ operation: "drive-request", requestKind: "mutation", outcome: "failed", status: 503, errorCode: "temporary", durationMs: 42 });

    expect(getSyncDiagnosticEvents()).toMatchObject([{
      operation: "drive-request",
      requestKind: "mutation",
      outcome: "failed",
      status: 503,
      errorCode: "temporary",
      durationMs: 42,
    }]);
    expect(localStorageWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(getSyncDiagnosticEvents())).not.toMatch(/workspaceId|folder|path|content|entryId/);
  });

  it("bounds the temporary event timeline", () => {
    for (let attempt = 0; attempt < 305; attempt += 1) recordSyncDiagnostic({ operation: "provider-write", outcome: "queued", attempt });
    expect(getSyncDiagnosticEvents()).toHaveLength(300);
    expect(getSyncDiagnosticEvents()[0].attempt).toBe(5);
  });

  it("correlates concurrent Drive request starts and results", () => {
    const diagnostics = createDriveDiagnostics();
    const operationId = diagnostics.recordRequest("mutation");
    diagnostics.recordRequestResult?.({ kind: "mutation", operationId, outcome: "succeeded", status: 200, durationMs: 12, requestBytes: 8, responseBytes: 4 });

    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getSyncDiagnosticEvents()).toMatchObject([
      { operation: "drive-request", operationId, outcome: "started", requestKind: "mutation" },
      { operation: "drive-request", operationId, outcome: "succeeded", requestKind: "mutation", requestBytes: 8, responseBytes: 4 },
    ]);
  });

  it("uploads a content-free report only after a failure", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    recordSyncDiagnostic({ operation: "pending-write", outcome: "queued", itemCount: 1 });

    reportSyncFailure(Object.assign(new Error("private/path.md failed"), { name: "WorkspaceError", code: "temporary" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const report = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(report).toMatchObject({ trigger: "workspace-error", buildMode: "test" });
    expect(JSON.stringify(report)).not.toContain("private/path.md");
    expect(JSON.stringify(report)).toContain("pending-write");
  });

  it("deduplicates the same error object without dropping a distinct concurrent failure", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = new Error("first");
    reportSyncFailure(first);
    reportSyncFailure(first);
    reportSyncFailure(new Error("second"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("trims oldest breadcrumbs so reports remain below the API body limit", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      recordSyncDiagnostic({ operation: "provider-write", outcome: "failed", attempt, errorCode: "x".repeat(80), durationMs: 1, retryDelayMs: 1 });
    }
    reportSyncFailure(Object.assign(new Error("bounded"), { code: "temporary" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = String(request.body);
    const report = JSON.parse(body) as { events: Array<{ attempt?: number }> };
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(60 * 1_024);
    expect(report.events.at(-1)?.attempt).toBe(299);
  });

  it("does nothing while the temporary feature flag is disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configureSyncDiagnostics({
      enabled: false,
      slowOperationMs: 30_000,
      buildMode: "test",
      getPageState: () => ({ providerType: "none", isOpening: false, isIndexing: false, entryCount: 0, tabCount: 0, saveStates: {} }),
    });

    recordSyncDiagnostic({ operation: "reconciliation", outcome: "failed" });
    reportSyncFailure(new Error("disabled"));
    expect(getSyncDiagnosticEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
