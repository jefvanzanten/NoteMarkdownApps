import { z } from "zod";
import type { ApiConfig } from "../config.js";

const TokenResponseSchema = z.object({ access_token: z.string(), expires_in: z.number().int(), refresh_token: z.string().optional(), token_type: z.string() });
const IdentitySchema = z.object({ sub: z.string(), email: z.string().email(), name: z.string().min(1) });

/**
 * Exchanges an OAuth authorization code using PKCE.
 * @param code Single-use Google authorization code.
 * @param verifier Matching PKCE verifier.
 * @param config OAuth client configuration.
 * @returns Validated provider token response.
 */
export async function exchangeGoogleCode(code: string, verifier: string, config: ApiConfig): Promise<z.infer<typeof TokenResponseSchema>> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, code_verifier: verifier, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.publicBaseUrl}/api/v1/auth/google/callback`, grant_type: "authorization_code" }) });
  if (!response.ok) throw new Error("Google rejected the authorization code.");
  return TokenResponseSchema.parse(await response.json());
}

/**
 * Reads the signed-in Google identity for internal account mapping.
 * @param accessToken Short-lived Google access token.
 * @returns Validated provider identity.
 */
export async function loadGoogleIdentity(accessToken: string): Promise<z.infer<typeof IdentitySchema>> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("Google identity lookup failed.");
  return IdentitySchema.parse(await response.json());
}

/**
 * Refreshes a short-lived browser-to-Drive credential.
 * @param refreshToken Decrypted server-side refresh credential.
 * @param config OAuth client configuration.
 * @returns Access token and absolute expiry.
 */
export async function refreshGoogleAccessToken(refreshToken: string, config: ApiConfig): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret, grant_type: "refresh_token" }) });
  if (!response.ok) throw new Error("Google authorization must be renewed.");
  const token = TokenResponseSchema.parse(await response.json());
  return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
}
