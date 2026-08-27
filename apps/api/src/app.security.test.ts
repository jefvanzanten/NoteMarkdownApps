import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import type { ApiRepository } from "./repository.js";
import { encryptRefreshToken } from "./security/tokens.js";

const config = { publicOrigin: "https://notes.example", publicBaseUrl: "https://notes.example/notes", googleClientId: "client", googleClientSecret: "secret", secureCookies: true, syncDiagnosticsEnabled: true, tokenEncryptionKeys: new Map([[1, Buffer.alloc(32, 7)]]), currentKeyVersion: 1 } as ApiConfig;

afterEach(() => vi.unstubAllGlobals());

/** Creates an API with an isolated repository double. @param overrides Repository methods under test. @returns Hono API. */
function testApp(overrides: Partial<ApiRepository>) { return createApiApp({ config, repository: { findSessionUser: async () => "11111111-1111-4111-8111-111111111111", ...overrides } as ApiRepository }); }

describe("API security boundaries", () => {
  it("rejects revoked sessions before a protected repository is called", async () => {
    const listDriveWorkspaces = vi.fn();
    const app = testApp({ findSessionUser: async () => null, listDriveWorkspaces } as Partial<ApiRepository>);
    const response = await app.request("/api/v1/drive/workspaces", { headers: { cookie: "nm_session=revoked" } });
    expect(response.status).toBe(401);
    expect(listDriveWorkspaces).not.toHaveBeenCalled();
  });

  it("rejects accidental document payloads at runtime", async () => {
    const getConnectedAccount = vi.fn();
    const app = testApp({ getConnectedAccount } as Partial<ApiRepository>);
    const response = await app.request("/api/v1/drive/token", { method: "POST", headers: { cookie: "nm_session=valid", origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ connectedAccountId: "22222222-2222-4222-8222-222222222222", markdown: "private" }) });
    expect(response.status).toBe(400);
    expect(getConnectedAccount).not.toHaveBeenCalled();
  });

  it("passes only the authenticated internal user scope to owned queries", async () => {
    const listDriveWorkspaces = vi.fn(async () => []);
    const app = testApp({ listDriveWorkspaces } as Partial<ApiRepository>);
    const response = await app.request("/api/v1/drive/workspaces", { headers: { cookie: "nm_session=valid" } });
    expect(response.status).toBe(200);
    expect(listDriveWorkspaces).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("does not revoke a Google grant during a temporary provider outage", async () => {
    const encrypted = encryptRefreshToken("refresh-token", config);
    const requireReauthorization = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "server_error" }), { status: 503 })));
    const app = testApp({
      getConnectedAccount: async () => ({ id: "22222222-2222-4222-8222-222222222222", refreshTokenCiphertext: encrypted.ciphertext, refreshTokenKeyVersion: encrypted.keyVersion }) as never,
      requireReauthorization,
    } as Partial<ApiRepository>);
    const response = await app.request("/api/v1/drive/token", { method: "POST", headers: { cookie: "nm_session=valid", origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ connectedAccountId: "22222222-2222-4222-8222-222222222222" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "provider-unavailable", message: "Google authorization services are temporarily unavailable." } });
    expect(requireReauthorization).not.toHaveBeenCalled();
  });

  it("accepts a bounded content-free client report even after its session expired", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = testApp({ findSessionUser: async () => null });
    const reportId = crypto.randomUUID();
    const response = await app.request("/api/v1/diagnostics/client-errors", {
      method: "POST",
      headers: { origin: config.publicOrigin, "content-type": "application/json", cookie: "nm_session=expired" },
      body: JSON.stringify({
        reportId,
        createdAt: 1,
        trigger: "workspace-error",
        buildMode: "production",
        pageState: { online: true, visibility: "visible", providerType: "drive", isOpening: false, isIndexing: true, entryCount: 3, tabCount: 1, saveStates: { queued: 1 } },
        failure: { name: "WorkspaceError", code: "temporary", stackFrames: ["at saveDocument (assets/app.js:1:2)"], causeNames: ["TypeError"] },
        metrics: { drive_metadata_request_count: 4 },
        events: [{ timestamp: 1, operation: "provider-write", outcome: "failed", errorCode: "temporary" }],
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ reportId });
    const logged = JSON.parse(String(consoleError.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({ type: "client-sync-diagnostic", userId: null, reportId });
    expect(JSON.stringify(logged)).not.toContain("nm_session");
    consoleError.mockRestore();
  });

  it("hides the temporary diagnostics route when its runtime flag is disabled", async () => {
    const app = createApiApp({ config: { ...config, syncDiagnosticsEnabled: false }, repository: { findSessionUser: async () => null } as unknown as ApiRepository });
    const response = await app.request("/api/v1/diagnostics/client-errors", {
      method: "POST",
      headers: { origin: config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        reportId: crypto.randomUUID(),
        createdAt: 1,
        trigger: "workspace-error",
        buildMode: "production",
        pageState: { online: true, visibility: "visible", providerType: "none", isOpening: false, isIndexing: false, entryCount: 0, tabCount: 0, saveStates: {} },
        failure: { name: "Error", stackFrames: [], causeNames: [] },
        metrics: {},
        events: [],
      }),
    });
    expect(response.status).toBe(404);
  });

  it("correlates an internal response with a reason-bearing server log without exposing the reason", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const correlationId = "client-operation-123";
    const app = testApp({ listDriveWorkspaces: async () => { throw new Error("database diagnostic detail"); } } as Partial<ApiRepository>);
    const response = await app.request("/api/v1/drive/workspaces", { headers: { cookie: "nm_session=valid", "x-correlation-id": correlationId } });
    const body = await response.json() as { error: { code: string; message: string } };
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(500);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    expect(body.error).toEqual({ code: "internal", message: `The API request failed internally. Diagnostic reference: ${requestId}.` });
    expect(body.error.message).not.toContain("database diagnostic detail");
    expect(consoleError).toHaveBeenCalledWith("API request failed", expect.objectContaining({ requestId, correlationId, message: "database diagnostic detail" }));
    consoleError.mockRestore();
  });
});
