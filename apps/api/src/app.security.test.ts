import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import type { ApiRepository } from "./repository.js";

const config = { publicOrigin: "https://notes.example", googleClientId: "client", secureCookies: true } as ApiConfig;

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
});
