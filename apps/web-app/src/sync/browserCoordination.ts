import { openDatabase } from "@note/browser-storage";

interface LeaseRecord {
  resource: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: number;
}

export interface LeadershipHandle {
  isLeader: boolean;
  fencingToken: number;
  broadcastGeneration(generation: number): void;
  requestSync(): void;
  isCurrent(): Promise<boolean>;
  release(): Promise<void>;
}

export interface EditingLeaseHandle {
  fencingToken: number;
  release(): Promise<void>;
}

/**
 * Resolves one IndexedDB request.
 * @param request Browser storage request.
 * @returns Request result.
 */
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Coordination storage failed."));
  });
}

/**
 * Waits for a coordination transaction to commit.
 * @param transaction IndexedDB transaction.
 * @returns Nothing after completion.
 */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Coordination transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Coordination transaction was aborted."));
  });
}

/**
 * Acquires or renews a fenced IndexedDB lease.
 * @param resource Workspace or document resource identity.
 * @param ownerToken Browser-tab owner identity.
 * @param ttlMs Lease lifetime.
 * @returns Current lease or null when held by another live owner.
 */
async function acquireLease(resource: string, ownerToken: string, ttlMs: number): Promise<LeaseRecord | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("coordinationLeases", "readwrite");
    const store = transaction.objectStore("coordinationLeases");
    const current = await result(store.get(resource)) as LeaseRecord | undefined;
    const now = Date.now();
    if (current && current.ownerToken !== ownerToken && current.expiresAt > now) {
      transaction.abort();
      return null;
    }
    const lease: LeaseRecord = {
      resource,
      ownerToken,
      fencingToken: current?.ownerToken === ownerToken ? current.fencingToken : (current?.fencingToken ?? 0) + 1,
      expiresAt: now + ttlMs,
    };
    store.put(lease);
    await completed(transaction);
    return lease;
  } finally {
    database.close();
  }
}

/**
 * Releases a lease only when its owner and fencing token are still current.
 * @param lease Lease snapshot to release.
 * @returns Nothing after best-effort release.
 */
async function releaseLease(lease: LeaseRecord): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("coordinationLeases", "readwrite");
    const store = transaction.objectStore("coordinationLeases");
    const current = await result(store.get(lease.resource)) as LeaseRecord | undefined;
    if (current?.ownerToken === lease.ownerToken && current.fencingToken === lease.fencingToken) store.delete(lease.resource);
    await completed(transaction);
  } finally {
    database.close();
  }
}

/**
 * Acquires one workspace sync leadership handle using Web Locks when available.
 * @param workspaceId Stable workspace identity.
 * @param onGeneration Follower callback for committed repository generations.
 * @returns Leadership handle or null when this tab is a follower.
 */
export async function acquireWorkspaceLeadership(
  workspaceId: string,
  onGeneration: (generation: number) => void,
  onSyncRequested: () => void = () => undefined,
): Promise<LeadershipHandle | null> {
  const ownerToken = crypto.randomUUID();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`notemarkdown:sync:${workspaceId}`);
  channel?.addEventListener("message", (event: MessageEvent<{ generation?: number; requestSync?: boolean }>) => {
    if (typeof event.data.generation === "number") onGeneration(event.data.generation);
    if (event.data.requestSync) onSyncRequested();
  });
  const resource = `workspace:${workspaceId}`;

  if (navigator.locks) {
    let releaseLock = (): void => undefined;
    let resolveAcquired: (acquired: boolean) => void = () => undefined;
    const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve; });
    void navigator.locks.request(resource, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolveAcquired(false);
        return;
      }
      resolveAcquired(true);
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    if (!await acquired) {
      return {
        isLeader: false,
        fencingToken: 0,
        broadcastGeneration: () => undefined,
        requestSync: () => channel?.postMessage({ requestSync: true }),
        isCurrent: async () => false,
        release: async () => { channel?.close(); },
      };
    }
    return {
      isLeader: true,
      fencingToken: 1,
      broadcastGeneration: (generation) => channel?.postMessage({ generation }),
      requestSync: () => undefined,
      isCurrent: async () => true,
      release: async () => {
        releaseLock();
        channel?.close();
      },
    };
  }

  let lease = await acquireLease(resource, ownerToken, 15_000);
  if (!lease) {
    return {
      isLeader: false,
      fencingToken: 0,
      broadcastGeneration: () => undefined,
      requestSync: () => channel?.postMessage({ requestSync: true }),
      isCurrent: async () => false,
      release: async () => { channel?.close(); },
    };
  }
  const heartbeat = window.setInterval(() => {
    void acquireLease(resource, ownerToken, 15_000).then((renewed) => { if (renewed) lease = renewed; });
  }, 5_000);
  return {
    isLeader: true,
    fencingToken: lease.fencingToken,
    broadcastGeneration: (generation) => channel?.postMessage({ generation, fencingToken: lease?.fencingToken }),
    requestSync: () => undefined,
    isCurrent: async () => {
      const database = await openDatabase();
      try {
        const current = await result(database.transaction("coordinationLeases").objectStore("coordinationLeases").get(resource)) as LeaseRecord | undefined;
        return current?.ownerToken === ownerToken && current.fencingToken === lease?.fencingToken && current.expiresAt > Date.now();
      } finally {
        database.close();
      }
    },
    release: async () => {
      window.clearInterval(heartbeat);
      if (lease) await releaseLease(lease);
      channel?.close();
    },
  };
}

/**
 * Force-advances one document lease fencing token after explicit user takeover.
 * @param workspaceId Stable workspace identity.
 * @param entryId Stable document identity.
 * @param ownerToken New browser-tab editor identity.
 * @returns New heartbeating fenced lease.
 */
export async function takeOverDocumentEditingLease(
  workspaceId: string,
  entryId: string,
  ownerToken: string,
): Promise<EditingLeaseHandle> {
  const resource = `document:${workspaceId}:${entryId}`;
  const database = await openDatabase();
  let lease: LeaseRecord;
  try {
    const transaction = database.transaction("coordinationLeases", "readwrite");
    const store = transaction.objectStore("coordinationLeases");
    const current = await result(store.get(resource)) as LeaseRecord | undefined;
    lease = { resource, ownerToken, fencingToken: (current?.fencingToken ?? 0) + 1, expiresAt: Date.now() + 15_000 };
    store.put(lease);
    await completed(transaction);
  } finally {
    database.close();
  }
  const heartbeat = window.setInterval(() => {
    void acquireLease(resource, ownerToken, 15_000).then((renewed) => { if (renewed) lease = renewed; });
  }, 5_000);
  return {
    fencingToken: lease.fencingToken,
    release: async () => {
      window.clearInterval(heartbeat);
      await releaseLease(lease);
    },
  };
}

/**
 * Attempts to acquire one expiring document editing lease.
 * @param workspaceId Stable workspace identity.
 * @param entryId Stable document identity.
 * @param ownerToken Browser-tab editor identity.
 * @returns Heartbeating fenced lease or null when another editor owns the document.
 */
export async function acquireDocumentEditingLease(
  workspaceId: string,
  entryId: string,
  ownerToken: string,
): Promise<EditingLeaseHandle | null> {
  const resource = `document:${workspaceId}:${entryId}`;
  let lease = await acquireLease(resource, ownerToken, 15_000);
  if (!lease) return null;
  const heartbeat = window.setInterval(() => {
    void acquireLease(resource, ownerToken, 15_000).then((renewed) => { if (renewed) lease = renewed; });
  }, 5_000);
  return {
    fencingToken: lease.fencingToken,
    release: async () => {
      window.clearInterval(heartbeat);
      if (lease) await releaseLease(lease);
    },
  };
}
