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

export type Me = z.infer<typeof MeSchema>;
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;
export type DriveWorkspaceReference = z.infer<typeof DriveWorkspaceSchema>;
export type PreferenceValue = z.infer<typeof PreferenceValueSchema>;
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;
