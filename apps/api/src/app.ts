import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import {
  ApiErrorSchema, CreateWorkspaceSchema, DriveTokenSchema, EmptySchema, IdParameterSchema, MeSchema,
  PreferenceSchema, TokenRequestSchema, WorkspaceListSchema, DriveWorkspaceSchema,
} from "@note/api-contracts";
import type { ApiConfig } from "./config.js";
import type { ApiRepository } from "./repository.js";
import { decryptRefreshToken, encryptRefreshToken, hashToken, pkceChallenge, randomToken } from "./security/tokens.js";
import { exchangeGoogleCode, loadGoogleIdentity, refreshGoogleAccessToken } from "./services/google.js";

interface AppDependencies { config: ApiConfig; repository: ApiRepository }
type Variables = { userId: string; sessionHash: string };
const SESSION_COOKIE = "nm_session";
const errorResponse = { description: "Stable API error", content: { "application/json": { schema: ApiErrorSchema } } } as const;
/** Builds an OpenAPI JSON response declaration. @param description Response purpose. @param schema Runtime response schema. @returns OpenAPI response declaration. */
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });

/** Builds the runtime-validated, content-blind milestone-three API. @param dependencies Configuration and durable repository. @returns Hono application and OpenAPI registry. */
export function createApiApp({ config, repository }: AppDependencies): OpenAPIHono<{ Variables: Variables }> {
  const app = new OpenAPIHono<{ Variables: Variables }>();
  app.use("*", secureHeaders());
  app.use("/api/*", async (context, next) => {
    const length = Number(context.req.header("content-length") ?? 0);
    if (length > 65_536) return context.json({ error: { code: "payload-too-large", message: "API metadata payload is too large." } }, 413);
    const origin = context.req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method) && origin && origin !== config.publicOrigin) return context.json({ error: { code: "invalid-origin", message: "Request origin is not allowed." } }, 403);
    await next();
  });

  const authenticate: MiddlewareHandler<{ Variables: Variables }> = async (context, next) => {
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return context.json({ error: { code: "unauthorized", message: "Sign in is required." } }, 401);
    const sessionHash = hashToken(token);
    const userId = await repository.findSessionUser(sessionHash);
    if (!userId) return context.json({ error: { code: "unauthorized", message: "The session expired or was revoked." } }, 401);
    context.set("userId", userId); context.set("sessionHash", sessionHash); await next();
  };
  app.use("/api/v1/me", authenticate);
  app.use("/api/v1/session/*", authenticate);
  app.use("/api/v1/drive/*", authenticate);
  app.use("/api/v1/preferences", authenticate);
  app.use("/api/v1/account", authenticate);
  app.use("/api/v1/connected-accounts/*", authenticate);

  const oauthStart = createRoute({ method: "get", path: "/api/v1/auth/google/start", request: { query: z.object({ returnTo: z.string().optional() }) }, responses: { 302: { description: "Google OAuth redirect" }, 400: errorResponse } });
  app.openapi(oauthStart, async (context) => {
    const requested = context.req.valid("query").returnTo ?? "/";
    const returnTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
    const state = randomToken(); const verifier = randomToken(48); const currentSession = getCookie(context, SESSION_COOKIE); const userId = currentSession ? await repository.findSessionUser(hashToken(currentSession)) : null;
    await repository.createOAuthAttempt({ stateHash: hashToken(state), userId, verifier, returnTo, expiresAt: new Date(Date.now() + 10 * 60_000) });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: `${config.publicBaseUrl}/api/v1/auth/google/callback`, response_type: "code", scope: "openid email profile https://www.googleapis.com/auth/drive.file", access_type: "offline", prompt: "consent", state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", include_granted_scopes: "true" }).toString();
    return context.redirect(url.toString());
  });

  const oauthCallback = createRoute({ method: "get", path: "/api/v1/auth/google/callback", request: { query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() }) }, responses: { 302: { description: "Application redirect" }, 400: errorResponse } });
  app.openapi(oauthCallback, async (context) => {
    const query = context.req.valid("query");
    const attempt = await repository.consumeOAuthAttempt(hashToken(query.state));
    if (!attempt || query.error || !query.code) return context.json({ error: { code: "oauth-failed", message: "Google authorization was denied or expired." } }, 400);
    const token = await exchangeGoogleCode(query.code, attempt.verifier, config);
    if (!token.refresh_token) return context.json({ error: { code: "oauth-refresh-missing", message: "Google did not issue a renewable authorization." } }, 400);
    const identity = await loadGoogleIdentity(token.access_token);
    const encrypted = encryptRefreshToken(token.refresh_token, config);
    const account = await repository.upsertGoogleIdentity({ subject: identity.sub, displayName: identity.name, email: identity.email, ciphertext: encrypted.ciphertext, keyVersion: encrypted.keyVersion }, attempt.userId);
    const sessionToken = randomToken();
    await repository.createSession({ idHash: hashToken(sessionToken), userId: account.userId, expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    setCookie(context, SESSION_COOKIE, sessionToken, { httpOnly: true, secure: config.secureCookies, sameSite: "Lax", path: "/", maxAge: 30 * 86_400 });
    return context.redirect(`${config.publicOrigin}${attempt.returnTo}`);
  });

  const meRoute = createRoute({ method: "get", path: "/api/v1/me", responses: { 200: jsonResponse("Current identity", MeSchema), 401: errorResponse } });
  app.openapi(meRoute, async (context) => {
    const result = await repository.getMe(context.get("userId"));
    if (!result.user) return context.json({ error: { code: "unauthorized", message: "The account no longer exists." } }, 401);
    return context.json({ user: { id: result.user.id, displayName: result.user.displayName, email: result.user.email }, connectedAccounts: result.accounts.map((account) => ({ id: account.id, provider: "google" as const, displayName: account.displayName, email: account.email, status: account.status === "active" ? "active" as const : "reauthorization-required" as const })) }, 200);
  });

  const logoutRoute = createRoute({ method: "post", path: "/api/v1/session/logout", responses: { 200: jsonResponse("Logged out", EmptySchema), 401: errorResponse } });
  app.openapi(logoutRoute, async (context) => { await repository.revokeSession(context.get("sessionHash")); deleteCookie(context, SESSION_COOKIE, { path: "/", secure: config.secureCookies }); return context.json({ ok: true as const }, 200); });

  const tokenRoute = createRoute({ method: "post", path: "/api/v1/drive/token", request: { body: { content: { "application/json": { schema: TokenRequestSchema } } } }, responses: { 200: jsonResponse("Short-lived browser-to-Drive token", DriveTokenSchema), 401: errorResponse, 404: errorResponse, 409: errorResponse } });
  app.openapi(tokenRoute, async (context) => {
    const account = await repository.getConnectedAccount(context.get("userId"), context.req.valid("json").connectedAccountId);
    if (!account) return context.json({ error: { code: "not-found", message: "Connected account was not found." } }, 404);
    try { return context.json(await refreshGoogleAccessToken(decryptRefreshToken(account.refreshTokenCiphertext, account.refreshTokenKeyVersion, config), config), 200); }
    catch { await repository.requireReauthorization(context.get("userId"), account.id); return context.json({ error: { code: "reauthorization-required", message: "Google authorization must be renewed." } }, 409); }
  });

  const listWorkspaces = createRoute({ method: "get", path: "/api/v1/drive/workspaces", responses: { 200: jsonResponse("Linked Drive folders", WorkspaceListSchema), 401: errorResponse } });
  app.openapi(listWorkspaces, async (context) => context.json({ workspaces: (await repository.listDriveWorkspaces(context.get("userId"))).map(({ id, connectedAccountId, folderId, displayName }) => ({ id, connectedAccountId, folderId, displayName })) }, 200));
  const createWorkspace = createRoute({ method: "post", path: "/api/v1/drive/workspaces", request: { body: { content: { "application/json": { schema: CreateWorkspaceSchema } } } }, responses: { 201: jsonResponse("Linked Drive folder", DriveWorkspaceSchema), 401: errorResponse, 404: errorResponse } });
  app.openapi(createWorkspace, async (context) => { const result = await repository.createDriveWorkspace(context.get("userId"), context.req.valid("json")); return result ? context.json({ id: result.id, connectedAccountId: result.connectedAccountId, folderId: result.folderId, displayName: result.displayName }, 201) : context.json({ error: { code: "not-found", message: "Connected account was not found." } }, 404); });
  const deleteWorkspace = createRoute({ method: "delete", path: "/api/v1/drive/workspaces/{id}", request: { params: IdParameterSchema }, responses: { 200: jsonResponse("Reference removed", EmptySchema), 401: errorResponse, 404: errorResponse } });
  app.openapi(deleteWorkspace, async (context) => await repository.deleteDriveWorkspace(context.get("userId"), context.req.valid("param").id) ? context.json({ ok: true as const }, 200) : context.json({ error: { code: "not-found", message: "Workspace reference was not found." } }, 404));

  const getPreferences = createRoute({ method: "get", path: "/api/v1/preferences", responses: { 200: jsonResponse("Global preferences", PreferenceSchema), 401: errorResponse, 404: errorResponse } });
  app.openapi(getPreferences, async (context) => { const value = await repository.getPreferences(context.get("userId")); return value ? context.json({ preferences: value }, 200) : context.json({ error: { code: "not-found", message: "No synchronized preferences exist." } }, 404); });
  const putPreferences = createRoute({ method: "put", path: "/api/v1/preferences", request: { body: { content: { "application/json": { schema: PreferenceSchema } } } }, responses: { 200: jsonResponse("Saved preferences", PreferenceSchema), 401: errorResponse } });
  app.openapi(putPreferences, async (context) => { const value = context.req.valid("json").preferences; await repository.putPreferences(context.get("userId"), value); return context.json({ preferences: value }, 200); });

  const disconnect = createRoute({ method: "delete", path: "/api/v1/connected-accounts/{id}", request: { params: IdParameterSchema }, responses: { 200: jsonResponse("Provider disconnected", EmptySchema), 401: errorResponse, 404: errorResponse } });
  app.openapi(disconnect, async (context) => await repository.disconnectAccount(context.get("userId"), context.req.valid("param").id) ? context.json({ ok: true as const }, 200) : context.json({ error: { code: "not-found", message: "Connected account was not found." } }, 404));
  const deleteAccount = createRoute({ method: "delete", path: "/api/v1/account", responses: { 200: jsonResponse("Account metadata deleted", EmptySchema), 401: errorResponse } });
  app.openapi(deleteAccount, async (context) => { await repository.deleteUser(context.get("userId")); deleteCookie(context, SESSION_COOKIE, { path: "/", secure: config.secureCookies }); return context.json({ ok: true as const }, 200); });

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/ready", async (context) => { try { await repository.checkReady(); return context.json({ status: "ready" }); } catch { return context.json({ status: "unavailable" }, 503); } });
  app.get("/openapi.json", (context) => context.json(app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "NoteMarkdown metadata API", version: "1.0.0", description: "Authentication, preferences, and Drive folder references. Document content is forbidden." } })));
  app.onError((error, context) => { console.error("API request failed", { name: error.name }); return context.json({ error: { code: "internal", message: "The request could not be completed." } }, 500); });
  return app;
}
