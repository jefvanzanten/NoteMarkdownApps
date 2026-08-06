import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitCachedDocument,
  commitWorkspaceChangePage,
  importLegacyDriveMirror,
  loadCachedDocument,
  loadPendingWrites,
  loadRepositoryDraft,
  loadRepositorySession,
  loadWorkspaceManifest,
  loadWorkspaceSyncState,
  lockDriveRepositories,
  migrateLegacyWorkspace,
  openDatabase,
  registerRepositoryWorkspace,
  savePendingWrite,
  saveRepositoryDraft,
  saveRepositorySession,
  saveWorkspaceManifest,
} from "./index";

/**
 * Resolves a browser database request in repository tests.
 * @param request IndexedDB request.
 * @returns Request result.
 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Waits for a test transaction to commit.
 * @param transaction IndexedDB transaction.
 * @returns Nothing after completion.
 */
function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Deletes the fixed repository database between deterministic tests.
 * @returns Nothing after deletion.
 */
function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("notemarkdown-local-first");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Creates a realistic version-three database containing one dirty Drive draft.
 * @returns Nothing after the legacy fixture commits.
 */
async function createVersionThreeFixture(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("notemarkdown-local-first", 3);
    request.onupgradeneeded = () => {
      const value = request.result;
      value.createObjectStore("workspaces", { keyPath: "id" });
      value.createObjectStore("drafts", { keyPath: ["workspaceId", "path"] });
      const history = value.createObjectStore("history", { keyPath: "id" });
      history.createIndex("by-document", ["workspaceId", "path", "updatedAt"]);
      value.createObjectStore("sessions", { keyPath: "workspaceId" });
      value.createObjectStore("searchDocuments", { keyPath: ["workspaceId", "path"] });
      value.createObjectStore("driveKeys", { keyPath: "connectedAccountId" });
      value.createObjectStore("driveMirror", { keyPath: ["workspaceId", "path"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("drafts", "readwrite");
  transaction.objectStore("drafts").put({ workspaceId: "drive:fixture", path: "fixture.md", content: "irreplaceable", format: { hasBom: false, lineEnding: "\n" }, baseRevision: revision, cursor: 4, updatedAt: 1 });
  await transactionCompleted(transaction);
  database.close();
}

beforeEach(async () => {
  await resetDatabase();
});

const revision = { id: "R1", modifiedAt: 1, size: 4 };

describe("central browser repository", () => {
  it("commits and restores revision-matched local manifest and content", async () => {
    await registerRepositoryWorkspace({ id: "local:one", name: "Notes", providerType: "local", lastOpenedAt: 1 });
    await saveWorkspaceManifest({
      workspaceId: "local:one",
      generation: 1,
      updatedAt: 1,
      entries: [{ workspaceId: "local:one", entryId: "note.md", path: "note.md", kind: "document", observedProviderRevision: revision, state: "live", updatedAt: 1 }],
    });
    await commitCachedDocument({ workspaceId: "local:one", entryId: "note.md", path: "note.md", content: "note", format: { hasBom: false, lineEnding: "\n" }, cachedContentRevision: revision, lastAccessedAt: 1 });
    expect((await loadWorkspaceManifest("local:one"))?.entries[0].observedProviderRevision?.id).toBe("R1");
    expect((await loadCachedDocument("local:one", "note.md"))?.cachedContentRevision.id).toBe("R1");
  });

  it("commits a change cursor and every path-derived move atomically", async () => {
    await registerRepositoryWorkspace({ id: "local:delta", name: "Delta", providerType: "local", lastOpenedAt: 1 });
    await saveWorkspaceManifest({ workspaceId: "local:delta", generation: 1, updatedAt: 1, entries: [{ workspaceId: "local:delta", entryId: "stable", path: "old.md", kind: "document", observedProviderRevision: revision, state: "live", updatedAt: 1 }] });
    await commitCachedDocument({ workspaceId: "local:delta", entryId: "stable", path: "old.md", content: "note", format: { hasBom: false, lineEnding: "\n" }, cachedContentRevision: revision, lastAccessedAt: 1 });
    await saveRepositoryDraft({ workspaceId: "local:delta", entryId: "stable", path: "old.md", content: "dirty", format: { hasBom: false, lineEnding: "\n" }, baseRevision: revision, cursor: 1, updatedAt: 1 });
    await savePendingWrite({ id: "write", workspaceId: "local:delta", entryId: "stable", targetPath: "old.md", expectedBaseRevision: revision, draftRevision: "D1", state: "pending", attempt: 0 });
    await saveRepositorySession({ workspaceId: "local:delta", activeEntryId: "stable", selectedEntryId: "stable", tabs: [{ entryId: "stable", path: "old.md", cursor: 1, viewMode: "editor" }], updatedAt: 1 });

    await commitWorkspaceChangePage(
      { workspaceId: "local:delta", generation: 2, updatedAt: 2, entries: [{ workspaceId: "local:delta", entryId: "stable", path: "new.md", kind: "document", observedProviderRevision: revision, state: "live", updatedAt: 2 }] },
      { workspaceId: "local:delta", providerType: "drive", driveChangeToken: "cursor-2", lastReconciledAt: 2 },
      [{ entryId: "stable", previousPath: "old.md", nextPath: "new.md" }],
    );

    expect((await loadWorkspaceManifest("local:delta"))?.entries[0].path).toBe("new.md");
    expect((await loadWorkspaceSyncState("local:delta"))?.driveChangeToken).toBe("cursor-2");
    expect((await loadCachedDocument("local:delta", "stable"))?.path).toBe("new.md");
    expect((await loadRepositoryDraft("local:delta", "stable"))?.path).toBe("new.md");
    expect((await loadPendingWrites("local:delta"))[0].targetPath).toBe("new.md");
    expect((await loadRepositorySession("local:delta"))?.tabs[0].path).toBe("new.md");
  });

  it("encrypts Drive paths and content and remains locked after key removal", async () => {
    await registerRepositoryWorkspace({ id: "drive:one", name: "Drive", providerType: "drive", connectedAccountId: "account", providerWorkspaceId: "one", folderId: "folder", lastOpenedAt: 1 });
    await commitCachedDocument({ workspaceId: "drive:one", entryId: "provider-secret-id", path: "secret-name.md", content: "secret content", format: { hasBom: false, lineEnding: "\n" }, cachedContentRevision: revision, lastAccessedAt: 1 });
    expect((await loadCachedDocument("drive:one", "provider-secret-id"))?.content).toBe("secret content");

    const database = await openDatabase();
    const raw = await requestResult(database.transaction("cachedDocuments").objectStore("cachedDocuments").getAll()) as Array<Record<string, unknown>>;
    database.close();
    const serialized = JSON.stringify(raw);
    expect(raw[0]).toMatchObject({ encrypted: true });
    expect(serialized).not.toContain("secret-name.md");
    expect(serialized).not.toContain("secret content");
    expect(serialized).not.toContain("provider-secret-id");

    await lockDriveRepositories();
    expect(await loadCachedDocument("drive:one", "provider-secret-id")).toBeNull();
  });

  it("imports only a revision-matched encrypted legacy Drive mirror", async () => {
    await registerRepositoryWorkspace({ id: "drive:one", name: "Drive", providerType: "drive", connectedAccountId: "account", providerWorkspaceId: "one", folderId: "folder", lastOpenedAt: 1 });
    await commitCachedDocument({ workspaceId: "drive:one", entryId: "key-bootstrap", path: "bootstrap.md", content: "", format: { hasBom: false, lineEnding: "\n" }, cachedContentRevision: revision, lastAccessedAt: 1 });
    const database = await openDatabase();
    const keyRecord = await requestResult(database.transaction("driveKeys").objectStore("driveKeys").get("account")) as { key: CryptoKey };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const document = { path: "note.md", content: "legacy encrypted", format: { hasBom: false, lineEnding: "\n" as const }, revision };
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("one:note.md") }, keyRecord.key, new TextEncoder().encode(JSON.stringify(document)));
    const transaction = database.transaction("driveMirror", "readwrite");
    transaction.objectStore("driveMirror").put({ workspaceId: "one", path: "note.md", connectedAccountId: "account", nonce: nonce.buffer, ciphertext });
    await transactionCompleted(transaction);
    database.close();

    expect(await importLegacyDriveMirror("drive:one", "stable-id", "note.md", { ...revision, id: "other" })).toBe(false);
    expect(await importLegacyDriveMirror("drive:one", "stable-id", "note.md", revision)).toBe(true);
    expect((await loadCachedDocument("drive:one", "stable-id"))?.content).toBe("legacy encrypted");
  });

  it("upgrades a realistic version-three fixture idempotently", async () => {
    await createVersionThreeFixture();
    await registerRepositoryWorkspace({ id: "drive:fixture", name: "Drive", providerType: "drive", connectedAccountId: "account", providerWorkspaceId: "fixture", folderId: "folder", lastOpenedAt: 1 });
    const identities = new Map([["fixture.md", "stable-fixture-id"]]);
    await migrateLegacyWorkspace("drive:fixture", identities);
    await migrateLegacyWorkspace("drive:fixture", identities);
    expect((await loadRepositoryDraft("drive:fixture", "stable-fixture-id"))?.content).toBe("irreplaceable");
  });

  it("migrates a dirty plaintext draft destination-first and removes its source", async () => {
    await registerRepositoryWorkspace({ id: "drive:one", name: "Drive", providerType: "drive", connectedAccountId: "account", providerWorkspaceId: "one", folderId: "folder", lastOpenedAt: 1 });
    const database = await openDatabase();
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put({ workspaceId: "drive:one", path: "note.md", content: "dirty", format: { hasBom: false, lineEnding: "\n" }, baseRevision: revision, cursor: 3, updatedAt: 1 });
    await transactionCompleted(transaction);
    database.close();

    await migrateLegacyWorkspace("drive:one", new Map([["note.md", "stable-id"]]));
    expect((await loadRepositoryDraft("drive:one", "stable-id"))?.content).toBe("dirty");
    const verificationDatabase = await openDatabase();
    const legacy = await requestResult(verificationDatabase.transaction("drafts").objectStore("drafts").get(["drive:one", "note.md"]));
    verificationDatabase.close();
    expect(legacy).toBeUndefined();
  });
});
