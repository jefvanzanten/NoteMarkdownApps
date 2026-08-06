import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./db/client.js";
import { ApiRepository } from "./repository.js";
import { hashToken } from "./security/tokens.js";

const databaseUrl = process.env.RUN_DATABASE_TESTS === "true" ? process.env.DATABASE_URL : undefined;
const integration = databaseUrl ? describe : describe.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : null;
const repository = database ? new ApiRepository(database.db) : null;
const createdUserIds: string[] = [];

/** Creates an isolated Google identity for database tests. @param label Unique test label. @returns Internal user and connected-account IDs. */
async function createIdentity(label: string): Promise<{ userId: string; connectedAccountId: string }> {
  const identity = await repository!.upsertGoogleIdentity({ subject: `${label}-${crypto.randomUUID()}`, displayName: label, email: `${label}-${crypto.randomUUID()}@example.test`, ciphertext: "test-ciphertext", keyVersion: 1 });
  createdUserIds.push(identity.userId);
  return identity;
}

integration("PostgreSQL repository boundaries", () => {
  beforeAll(async () => { await migrate(database!.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname }); });
  afterAll(async () => { for (const userId of createdUserIds) await repository!.deleteUser(userId); await database!.pool.end(); });

  it("isolates Drive references and connected accounts by internal user", async () => {
    const userA = await createIdentity("user-a"); const userB = await createIdentity("user-b");
    const workspace = await repository!.createDriveWorkspace(userA.userId, { connectedAccountId: userA.connectedAccountId, folderId: "folder-a", displayName: "A notes" });
    expect(workspace?.displayName).toBe("A notes");
    expect(await repository!.createDriveWorkspace(userB.userId, { connectedAccountId: userA.connectedAccountId, folderId: "guessed-folder", displayName: "Stolen" })).toBeNull();
    expect(await repository!.listDriveWorkspaces(userA.userId)).toHaveLength(1);
    expect(await repository!.listDriveWorkspaces(userB.userId)).toHaveLength(0);
    expect(await repository!.getConnectedAccount(userB.userId, userA.connectedAccountId)).toBeNull();
  });

  it("revokes opaque sessions immediately", async () => {
    const user = await createIdentity("session-user"); const tokenHash = hashToken(`session-${crypto.randomUUID()}`);
    await repository!.createSession({ idHash: tokenHash, userId: user.userId, expiresAt: new Date(Date.now() + 60_000) });
    expect(await repository!.findSessionUser(tokenHash)).toBe(user.userId);
    await repository!.revokeSession(tokenHash);
    expect(await repository!.findSessionUser(tokenHash)).toBeNull();
  });

  it("deletes account metadata idempotently through database cascades", async () => {
    const user = await createIdentity("deleted-user");
    await repository!.createDriveWorkspace(user.userId, { connectedAccountId: user.connectedAccountId, folderId: "provider-file-stays", displayName: "Provider data is external" });
    await repository!.deleteUser(user.userId); await repository!.deleteUser(user.userId);
    expect(await repository!.getMe(user.userId)).toEqual({ user: undefined, accounts: [] });
    expect(await repository!.listDriveWorkspaces(user.userId)).toEqual([]);
  });
});
