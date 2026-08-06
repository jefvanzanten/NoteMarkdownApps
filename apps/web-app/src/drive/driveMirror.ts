import type { WorkspaceDocument } from "@note/workspace-core";
import type { DriveMirror } from "@note/workspace-drive";
import { openDatabase } from "../storage/browserStorage";

interface KeyRecord { connectedAccountId: string; key: CryptoKey }
interface MirrorRecord { workspaceId: string; path: string; connectedAccountId: string; nonce: ArrayBuffer; ciphertext: ArrayBuffer }

/** Resolves an IndexedDB request. @param request Browser storage request. @returns Request result. */
function result<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }

/** Waits until a browser storage transaction is durably committed. @param transaction IndexedDB transaction. @returns Nothing after commit. */
function completed(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }

/** Loads or creates a non-extractable per-account browser key. @param connectedAccountId Connected account identity. @returns AES-GCM key. */
async function getOrCreateKey(connectedAccountId: string): Promise<CryptoKey> { const current = await loadKey(connectedAccountId); if (current) return current; const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); const database = await openDatabase(); try { const transaction = database.transaction("driveKeys", "readwrite"); transaction.objectStore("driveKeys").put({ connectedAccountId, key } satisfies KeyRecord); await completed(transaction); return key; } finally { database.close(); } }

/** Loads an existing active mirror key without unlocking after explicit logout. @param connectedAccountId Connected account identity. @returns Key or null. */
async function loadKey(connectedAccountId: string): Promise<CryptoKey | null> { const database = await openDatabase(); try { return ((await result(database.transaction("driveKeys").objectStore("driveKeys").get(connectedAccountId))) as KeyRecord | undefined)?.key ?? null; } finally { database.close(); } }

/** Creates an encrypted Drive mirror adapter for one account and folder. @param connectedAccountId Account owning the browser key. @param workspaceId Linked workspace ID. @returns Drive mirror adapter. */
export function createDriveMirror(connectedAccountId: string, workspaceId: string): DriveMirror {
  const additionalData = (path: string): ArrayBuffer => new TextEncoder().encode(`${workspaceId}:${path}`).buffer as ArrayBuffer;
  return {
    loadDocument: async (path) => { const key = await loadKey(connectedAccountId); if (!key) return null; const database = await openDatabase(); try { const record = await result(database.transaction("driveMirror").objectStore("driveMirror").get([workspaceId, path])) as MirrorRecord | undefined; if (!record) return null; const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.nonce, additionalData: additionalData(path) }, key, record.ciphertext); return JSON.parse(new TextDecoder().decode(plaintext)) as WorkspaceDocument; } catch { return null; } finally { database.close(); } },
    saveDocument: async (document) => { const key = await getOrCreateKey(connectedAccountId); const nonce = crypto.getRandomValues(new Uint8Array(12)).buffer as ArrayBuffer; const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: additionalData(document.path) }, key, new TextEncoder().encode(JSON.stringify(document))); const database = await openDatabase(); try { const transaction = database.transaction("driveMirror", "readwrite"); transaction.objectStore("driveMirror").put({ workspaceId, path: document.path, connectedAccountId, nonce, ciphertext } satisfies MirrorRecord); await completed(transaction); } finally { database.close(); } },
  };
}

/** Removes active decryption keys while retaining encrypted mirror records in a locked state. @returns Nothing after key deletion. */
export async function lockAllDriveMirrors(): Promise<void> { const database = await openDatabase(); try { const transaction = database.transaction("driveKeys", "readwrite"); transaction.objectStore("driveKeys").clear(); await completed(transaction); } finally { database.close(); } }
