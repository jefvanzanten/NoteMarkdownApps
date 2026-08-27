import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../config.js";
import { GoogleServiceError, refreshGoogleAccessToken } from "./google.js";

const config = {
  googleClientId: "client",
  googleClientSecret: "secret",
  publicBaseUrl: "https://notes.example",
} as ApiConfig;

afterEach(() => vi.unstubAllGlobals());

describe("Google token service failure classification", () => {
  it("returns a validated short-lived token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/drive" }), { status: 200 })));
    const result = await refreshGoogleAccessToken("refresh", config);
    expect(result.accessToken).toBe("access");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("classifies invalid_grant as requiring reauthorization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    await expect(refreshGoogleAccessToken("refresh", config)).rejects.toMatchObject({ kind: "reauthorization-required", providerStatus: 400 });
  });

  it("preserves rate-limit retry guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "12" } })));
    await expect(refreshGoogleAccessToken("refresh", config)).rejects.toMatchObject({ kind: "rate-limited", providerStatus: 429, retryAfterMs: 12_000 });
  });

  it("keeps provider outages temporary rather than revoking the grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "server_error" }), { status: 503 })));
    await expect(refreshGoogleAccessToken("refresh", config)).rejects.toMatchObject({ kind: "temporary", providerStatus: 503 });
  });

  it("classifies transport and malformed response failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection detail"); }));
    await expect(refreshGoogleAccessToken("refresh", config)).rejects.toMatchObject({ kind: "temporary" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(refreshGoogleAccessToken("refresh", config)).rejects.toMatchObject({ kind: "invalid-response" });
  });
});
