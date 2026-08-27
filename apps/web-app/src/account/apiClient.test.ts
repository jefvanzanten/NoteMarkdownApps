import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, loadMe, loadPreferences } from "./apiClient";

const apiError = (status: number, code: string, headers?: HeadersInit): Response => new Response(
  JSON.stringify({ error: { code, message: `safe ${code}` } }),
  { status, headers: { "content-type": "application/json", ...headers } },
);

afterEach(() => vi.unstubAllGlobals());

describe("metadata API client error boundaries", () => {
  it("treats only an unauthorized /me response as anonymous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiError(401, "unauthorized")));
    await expect(loadMe()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => apiError(503, "provider-unavailable")));
    await expect(loadMe()).rejects.toMatchObject({ status: 503, code: "provider-unavailable" });
  });

  it("treats only a preference 404 as an absent snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiError(404, "not-found")));
    await expect(loadPreferences()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => apiError(500, "internal", { "x-request-id": "request-1" })));
    await expect(loadPreferences()).rejects.toMatchObject({ status: 500, code: "internal", requestId: "request-1" });
  });

  it("rejects successful but invalid API payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: { id: "not-a-uuid" }, connectedAccounts: [] }), { status: 200 })));
    await expect(loadMe()).rejects.toMatchObject({ status: 200, code: "invalid-response" });
  });

  it("classifies network failures without pretending the session expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network detail"); }));
    await expect(loadMe()).rejects.toMatchObject({ status: 0, code: "network-error" });
  });
});
