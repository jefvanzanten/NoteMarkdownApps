import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { PreferenceValue } from "@note/api-contracts";
import type { Database } from "./db/client.js";
import { connectedAccounts, driveWorkspaces, oauthAttempts, preferences, sessions, users } from "./db/schema.js";

export class ApiRepository {
  /** Creates a user-scoped API repository. @param db Typed Drizzle database client. @returns Repository instance. */
  constructor(private readonly db: Database) {}

  /** Confirms PostgreSQL is reachable for readiness probes. @returns Nothing when ready. */
  async checkReady(): Promise<void> { await this.db.execute(sql`select 1`); }

  /** Stores a single-use OAuth attempt. @param attempt Hashed state, verifier, return path, and expiry. @returns Nothing. */
  async createOAuthAttempt(attempt: typeof oauthAttempts.$inferInsert): Promise<void> { await this.db.insert(oauthAttempts).values(attempt); }

  /** Consumes a valid OAuth attempt atomically enough for single-callback use. @param stateHash Hashed OAuth state. @returns Attempt or null. */
  async consumeOAuthAttempt(stateHash: string): Promise<typeof oauthAttempts.$inferSelect | null> {
    const rows = await this.db.delete(oauthAttempts).where(and(eq(oauthAttempts.stateHash, stateHash), gt(oauthAttempts.expiresAt, new Date()))).returning();
    return rows[0] ?? null;
  }

  /** Finds an active session owner. @param idHash Stored opaque-token digest. @returns User ID or null. */
  async findSessionUser(idHash: string): Promise<string | null> {
    const rows = await this.db.select({ userId: sessions.userId }).from(sessions).where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))).limit(1);
    return rows[0]?.userId ?? null;
  }

  /** Creates a revocable server-side session. @param values Session digest, owner, and expiry. @returns Nothing. */
  async createSession(values: typeof sessions.$inferInsert): Promise<void> { await this.db.insert(sessions).values(values); }

  /** Revokes one session immediately. @param idHash Session token digest. @returns Nothing. */
  async revokeSession(idHash: string): Promise<void> { await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.idHash, idHash)); }

  /** Finds or creates the internal user and Google connected account. @param identity Google identity and encrypted credential. @returns Internal IDs. */
  async upsertGoogleIdentity(identity: { subject: string; displayName: string; email: string; ciphertext: string; keyVersion: number }, reconnectUserId?: string | null): Promise<{ userId: string; connectedAccountId: string }> {
    const existing = await this.db.select().from(connectedAccounts).where(and(eq(connectedAccounts.provider, "google"), eq(connectedAccounts.providerSubject, identity.subject))).limit(1);
    if (existing[0]) {
      await this.db.update(connectedAccounts).set({ displayName: identity.displayName, email: identity.email, refreshTokenCiphertext: identity.ciphertext, refreshTokenKeyVersion: identity.keyVersion, status: "active" }).where(eq(connectedAccounts.id, existing[0].id));
      await this.db.update(users).set({ displayName: identity.displayName, email: identity.email }).where(eq(users.id, existing[0].userId));
      return { userId: existing[0].userId, connectedAccountId: existing[0].id };
    }
    return this.db.transaction(async (transaction) => {
      const userId = reconnectUserId ?? (await transaction.insert(users).values({ displayName: identity.displayName, email: identity.email }).returning())[0].id;
      if (reconnectUserId) await transaction.update(users).set({ displayName: identity.displayName, email: identity.email }).where(eq(users.id, reconnectUserId));
      const [account] = await transaction.insert(connectedAccounts).values({ userId, provider: "google", providerSubject: identity.subject, displayName: identity.displayName, email: identity.email, refreshTokenCiphertext: identity.ciphertext, refreshTokenKeyVersion: identity.keyVersion }).returning();
      return { userId, connectedAccountId: account.id };
    });
  }

  /** Loads account identity data with strict user scope. @param userId Internal user ID. @returns Current user and connected accounts. */
  async getMe(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const accounts = await this.db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
    return { user, accounts };
  }

  /** Loads one encrypted provider credential with user scope. @param userId Owner ID. @param accountId Connected account ID. @returns Credential row or null. */
  async getConnectedAccount(userId: string, accountId: string): Promise<typeof connectedAccounts.$inferSelect | null> {
    const rows = await this.db.select().from(connectedAccounts).where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.userId, userId))).limit(1);
    return rows[0] ?? null;
  }

  /** Marks provider authorization as requiring repair. @param userId Owner ID. @param accountId Connected account ID. @returns Nothing. */
  async requireReauthorization(userId: string, accountId: string): Promise<void> { await this.db.update(connectedAccounts).set({ status: "reauthorization-required" }).where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.userId, userId))); }

  /** Lists only the current user's Drive references. @param userId Owner ID. @returns Linked workspace rows. */
  async listDriveWorkspaces(userId: string) { return this.db.select().from(driveWorkspaces).where(eq(driveWorkspaces.userId, userId)); }

  /** Creates or returns a user-scoped Drive folder reference. @param userId Owner ID. @param value Validated folder metadata. @returns Workspace reference. */
  async createDriveWorkspace(userId: string, value: { connectedAccountId: string; folderId: string; displayName: string }) {
    const account = await this.getConnectedAccount(userId, value.connectedAccountId);
    if (!account) return null;
    const rows = await this.db.insert(driveWorkspaces).values({ userId, ...value }).onConflictDoUpdate({ target: [driveWorkspaces.userId, driveWorkspaces.connectedAccountId, driveWorkspaces.folderId], set: { displayName: value.displayName } }).returning();
    return rows[0] ?? null;
  }

  /** Deletes a linked reference without touching Drive content. @param userId Owner ID. @param id Reference ID. @returns Whether a scoped row existed. */
  async deleteDriveWorkspace(userId: string, id: string): Promise<boolean> { return (await this.db.delete(driveWorkspaces).where(and(eq(driveWorkspaces.id, id), eq(driveWorkspaces.userId, userId))).returning({ id: driveWorkspaces.id })).length > 0; }

  /** Deletes one connected account and its references without touching provider files. @param userId Owner ID. @param id Connected account ID. @returns Whether a row existed. */
  async disconnectAccount(userId: string, id: string): Promise<boolean> { return (await this.db.delete(connectedAccounts).where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.userId, userId))).returning({ id: connectedAccounts.id })).length > 0; }

  /** Loads synchronized global preferences. @param userId Owner ID. @returns Preference snapshot or null. */
  async getPreferences(userId: string): Promise<PreferenceValue | null> {
    const rows = await this.db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
    return rows[0]?.value as PreferenceValue | undefined ?? null;
  }

  /** Replaces synchronized preferences under the current user. @param userId Owner ID. @param value Validated global preferences. @returns Nothing. */
  async putPreferences(userId: string, value: PreferenceValue): Promise<void> { await this.db.insert(preferences).values({ userId, value, updatedAt: new Date(value.updatedAt) }).onConflictDoUpdate({ target: preferences.userId, set: { value, updatedAt: new Date(value.updatedAt) } }); }

  /** Idempotently deletes all NoteMarkdown data through cascading foreign keys. @param userId Owner ID. @returns Nothing. */
  async deleteUser(userId: string): Promise<void> { await this.db.delete(users).where(eq(users.id, userId)); }
}
