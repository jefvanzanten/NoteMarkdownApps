import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectedAccounts = pgTable("connected_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  refreshTokenKeyVersion: integer("refresh_token_key_version").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("connected_provider_identity").on(table.provider, table.providerSubject), index("connected_user_idx").on(table.userId)]);

export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("session_user_idx").on(table.userId), index("session_expiry_idx").on(table.expiresAt)]);

export const oauthAttempts = pgTable("oauth_attempts", {
  stateHash: text("state_hash").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  verifier: text("verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const driveWorkspaces = pgTable("drive_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectedAccountId: uuid("connected_account_id").notNull().references(() => connectedAccounts.id, { onDelete: "cascade" }),
  folderId: text("folder_id").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("drive_workspace_user_folder").on(table.userId, table.connectedAccountId, table.folderId), index("drive_workspace_user_idx").on(table.userId)]);

export const preferences = pgTable("preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const diagnosticConsents = pgTable("diagnostic_consents", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  detailedDiagnostics: boolean("detailed_diagnostics").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
