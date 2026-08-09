import { z } from "@hono/zod-openapi";

export const ApiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).openapi("ApiError");
export const UserSchema = z.object({ id: z.string().uuid(), displayName: z.string().min(1), email: z.string().email() }).openapi("User");
export const ConnectedAccountSchema = z.object({ id: z.string().uuid(), provider: z.literal("google"), displayName: z.string(), email: z.string().email(), status: z.enum(["active", "reauthorization-required"]) }).openapi("ConnectedAccount");
export const DriveWorkspaceSchema = z.object({ id: z.string().uuid(), connectedAccountId: z.string().uuid(), folderId: z.string().min(1).max(255), displayName: z.string().min(1).max(255) }).openapi("DriveWorkspace");
export const PreferenceValueSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  locale: z.enum(["en", "nl"]),
  spellCheck: z.boolean(),
  assetDirectory: z.string().min(1).max(120),
  keybindings: z.record(z.string(), z.array(z.string().max(80))).default({}),
  updatedAt: z.number().int().nonnegative(),
}).strict().openapi("PreferenceValue");
export const MeSchema = z.object({ user: UserSchema, connectedAccounts: z.array(ConnectedAccountSchema) }).openapi("Me");
export const DriveTokenSchema = z.object({ accessToken: z.string(), expiresAt: z.number().int() }).openapi("DriveToken");
export const WorkspaceListSchema = z.object({ workspaces: z.array(DriveWorkspaceSchema) }).openapi("WorkspaceList");
export const CreateWorkspaceSchema = z.object({ connectedAccountId: z.string().uuid(), folderId: z.string().min(1).max(255), displayName: z.string().min(1).max(255) }).strict().openapi("CreateWorkspace");
export const TokenRequestSchema = z.object({ connectedAccountId: z.string().uuid() }).strict().openapi("TokenRequest");
export const PreferenceSchema = z.object({ preferences: PreferenceValueSchema }).strict().openapi("Preference");
export const EmptySchema = z.object({ ok: z.literal(true) }).openapi("Success");
export const IdParameterSchema = z.object({ id: z.string().uuid() });

export const ClientDiagnosticEventSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  operation: z.enum(["workspace-activation", "reconciliation", "manifest", "changes", "token-request", "drive-request", "provider-write", "pending-write", "leadership", "document-reconciliation"]),
  outcome: z.enum(["started", "queued", "succeeded", "failed", "auth-retry", "retrying", "slow", "skipped"]),
  operationId: z.string().uuid().optional(),
  requestKind: z.enum(["metadata", "list", "change", "content", "mutation"]).optional(),
  errorCode: z.string().max(80).optional(),
  status: z.number().int().min(0).max(599).optional(),
  attempt: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  retryDelayMs: z.number().nonnegative().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  requestBytes: z.number().int().nonnegative().optional(),
  responseBytes: z.number().int().nonnegative().optional(),
}).strict().openapi("ClientDiagnosticEvent");
export const ClientDiagnosticReportSchema = z.object({
  reportId: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  trigger: z.enum(["workspace-error", "unhandled-error", "unhandled-rejection", "slow-operation"]),
  buildMode: z.string().max(40),
  pageState: z.object({
    online: z.boolean(),
    visibility: z.enum(["visible", "hidden", "prerender", "unloaded", "unknown"]),
    providerType: z.enum(["drive", "local", "none"]),
    isOpening: z.boolean(),
    isIndexing: z.boolean(),
    entryCount: z.number().int().nonnegative(),
    tabCount: z.number().int().nonnegative(),
    saveStates: z.record(z.string().max(40), z.number().int().nonnegative()),
  }).strict(),
  failure: z.object({
    name: z.string().max(100),
    code: z.string().max(100).optional(),
    status: z.number().int().min(0).max(599).optional(),
    apiCode: z.string().max(100).optional(),
    stackFrames: z.array(z.string().max(300)).max(20),
    causeNames: z.array(z.string().max(100)).max(8),
  }).strict(),
  metrics: z.record(z.string().max(80), z.number()),
  events: z.array(ClientDiagnosticEventSchema).max(300),
}).strict().openapi("ClientDiagnosticReport");
export const ClientDiagnosticAcceptedSchema = z.object({ reportId: z.string().uuid() }).strict().openapi("ClientDiagnosticAccepted");

export type Me = z.infer<typeof MeSchema>;
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;
export type DriveWorkspaceReference = z.infer<typeof DriveWorkspaceSchema>;
export type PreferenceValue = z.infer<typeof PreferenceValueSchema>;
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;
export type ClientDiagnosticEvent = z.infer<typeof ClientDiagnosticEventSchema>;
export type ClientDiagnosticReport = z.infer<typeof ClientDiagnosticReportSchema>;
