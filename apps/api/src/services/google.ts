import { z } from "zod";
import type { ApiConfig } from "../config.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_GOOGLE_RESPONSE_BYTES = 64 * 1024;
export const GOOGLE_OAUTH_SCOPES = `openid email profile ${DRIVE_SCOPE}`;

const TokenResponseSchema = z.object({ access_token: z.string(), expires_in: z.number().int(), refresh_token: z.string().optional(), token_type: z.string(), scope: z.string().optional() });
const IdentitySchema = z.object({ sub: z.string(), email: z.string().email(), name: z.string().min(1) });

export type GoogleServiceErrorKind = "reauthorization-required" | "rate-limited" | "temporary" | "invalid-response";

/** A privacy-safe, operationally classified failure from a Google identity or token endpoint. */
export class GoogleServiceError extends Error {
  constructor(
    readonly kind: GoogleServiceErrorKind,
    message: string,
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GoogleServiceError";
  }
}

/** Parses provider retry guidance without retaining response details. */
function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Reads one small Google JSON response and rejects unexpectedly large or malformed payloads. */
async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_GOOGLE_RESPONSE_BYTES) throw new GoogleServiceError("invalid-response", "Google returned an invalid response.", response.status);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_GOOGLE_RESPONSE_BYTES) throw new GoogleServiceError("invalid-response", "Google returned an invalid response.", response.status);
  try { return JSON.parse(text) as unknown; }
  catch (cause) { throw new GoogleServiceError("invalid-response", "Google returned an invalid response.", response.status, undefined, { cause }); }
}

/** Maps Google HTTP failures into stable authorization and transient categories. */
async function googleHttpError(response: Response): Promise<GoogleServiceError> {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  const payload = await readJson(response).catch(() => null) as { error?: string | { status?: string } } | null;
  const providerCode = typeof payload?.error === "string" ? payload.error : payload?.error?.status;
  if (providerCode === "invalid_grant" || response.status === 401 || response.status === 403) {
    return new GoogleServiceError("reauthorization-required", "Google authorization must be renewed.", response.status);
  }
  if (response.status === 429) return new GoogleServiceError("rate-limited", "Google temporarily limited authorization requests.", response.status, retryAfterMs);
  if (response.status >= 500) return new GoogleServiceError("temporary", "Google authorization services are temporarily unavailable.", response.status, retryAfterMs);
  return new GoogleServiceError("invalid-response", "Google rejected the authorization request.", response.status);
}

/** Executes a bounded Google request and classifies transport failures without exposing response content. */
async function googleRequest(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw await googleHttpError(response);
    return response;
  } catch (error) {
    if (error instanceof GoogleServiceError) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new GoogleServiceError("temporary", timedOut ? "Google authorization request timed out." : "Google authorization services could not be reached.", undefined, undefined, { cause: error });
  }
}

/**
 * Exchanges an OAuth authorization code using PKCE.
 * @param code Single-use Google authorization code.
 * @param verifier Matching PKCE verifier.
 * @param config OAuth client configuration.
 * @returns Validated provider token response.
 */
export async function exchangeGoogleCode(code: string, verifier: string, config: ApiConfig): Promise<z.infer<typeof TokenResponseSchema>> {
  const response = await googleRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, code_verifier: verifier, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.publicBaseUrl}/api/v1/auth/google/callback`, grant_type: "authorization_code" }) });
  const parsed = TokenResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new GoogleServiceError("invalid-response", "Google returned an invalid token response.", response.status, undefined, { cause: parsed.error });
  return parsed.data;
}

/**
 * Reads the signed-in Google identity for internal account mapping.
 * @param accessToken Short-lived Google access token.
 * @returns Validated provider identity.
 */
export async function loadGoogleIdentity(accessToken: string): Promise<z.infer<typeof IdentitySchema>> {
  const response = await googleRequest("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
  const parsed = IdentitySchema.safeParse(await readJson(response));
  if (!parsed.success) throw new GoogleServiceError("invalid-response", "Google returned an invalid identity response.", response.status, undefined, { cause: parsed.error });
  return parsed.data;
}

/**
 * Refreshes a short-lived browser-to-Drive credential.
 * @param refreshToken Decrypted server-side refresh credential.
 * @param config OAuth client configuration.
 * @returns Access token and absolute expiry.
 */
export async function refreshGoogleAccessToken(refreshToken: string, config: ApiConfig): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await googleRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret, grant_type: "refresh_token" }) });
  const parsed = TokenResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new GoogleServiceError("invalid-response", "Google returned an invalid token response.", response.status, undefined, { cause: parsed.error });
  const token = parsed.data;
  if (token.scope && !token.scope.split(/\s+/).includes(DRIVE_SCOPE)) throw new GoogleServiceError("reauthorization-required", "Google authorization must be renewed.", response.status);
  return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
}
