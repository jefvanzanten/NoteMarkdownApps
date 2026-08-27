import { WorkspaceError, type WorkspaceChangePage, type WorkspaceEntry, type WorkspaceProvider } from "@note/workspace-core";
import { applyWorkspaceChanges, compareWorkspaceManifests, retryOperation, type ManifestPathMove } from "@note/sync-core";
import {
  commitWorkspaceChangePage,
  createManifestEntries,
  loadWorkspaceManifest,
  loadWorkspaceSyncState,
  manifestToWorkspaceEntries,
  saveWorkspaceSyncState,
  type WorkspaceManifest,
  type WorkspaceSyncState,
} from "../storage/browserStorage";
import {
  recordSyncDiagnostic,
  recordWorkspaceMetric,
  reportSlowSyncOperation,
  type SyncDiagnosticErrorCode,
} from "./workspaceDiagnostics";

export interface ProviderDiscoveryResult {
  entries: WorkspaceEntry[];
  changedEntryIds: Set<string>;
  removedPaths: Set<string>;
  moves: ManifestPathMove[];
  fullScan: boolean;
}

const DRIVE_SAFETY_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const initialDriveCursors = new Map<string, string>();

/** Retains the scan-boundary cursor acquired immediately before initial traversal. */
export function setInitialDriveCursor(providerId: string, cursor: string): void { initialDriveCursors.set(providerId, cursor); }

/** Reduces provider failures to content-free diagnostic categories. */
function diagnosticErrorCode(error: unknown): SyncDiagnosticErrorCode {
  return error instanceof WorkspaceError ? error.code : "unexpected";
}

/**
 * Compares an authoritative scan with the previous manifest.
 * @param previous Previous durable manifest.
 * @param next Next authoritative manifest.
 * @returns Incremental content, removal, and path-move work caused by the scan.
 */
export function compareManifests(previous: WorkspaceManifest | null, next: WorkspaceManifest): Omit<ProviderDiscoveryResult, "entries" | "fullScan"> {
  return compareWorkspaceManifests(previous?.entries ?? [], next.entries);
}

/**
 * Tests whether a low-priority selected-folder safety scan may run now.
 * @returns Whether the browser is visible, online, and not conserving data.
 */
function mayRunDriveSafetyScan(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return navigator.onLine
    && document.visibilityState === "visible"
    && connection?.saveData !== true
    && connection?.effectiveType !== "slow-2g"
    && connection?.effectiveType !== "2g";
}

/**
 * Performs an authoritative selected-folder metadata scan without reading content.
 * @param provider Drive provider being reconciled.
 * @param previous Previous durable manifest.
 * @param generation Active app workspace generation.
 * @param syncState Current durable sync state.
 * @param retainCursor Whether an existing valid change cursor remains usable.
 * @returns Scanned manifest, sync facts, and incremental effects.
 */
async function scanDriveManifest(
  provider: WorkspaceProvider,
  previous: WorkspaceManifest | null,
  generation: number,
  syncState: WorkspaceSyncState | null,
  retainCursor: boolean,
): Promise<{ manifest: WorkspaceManifest; syncState: WorkspaceSyncState; difference: Omit<ProviderDiscoveryResult, "entries" | "fullScan"> }> {
  const startedAt = performance.now();
  recordSyncDiagnostic({ operation: "manifest", outcome: "started" });
  const entries = await withProviderRetry(() => provider.listEntries());
  provider.primeEntries?.(entries);
  const manifest: WorkspaceManifest = {
    workspaceId: provider.id,
    entries: createManifestEntries(provider.id, entries),
    generation: Math.max(previous?.generation ?? 0, generation) + 1,
    updatedAt: Date.now(),
  };
  const nextSyncState: WorkspaceSyncState = {
    workspaceId: provider.id,
    providerType: "drive",
    driveChangeToken: retainCursor ? syncState?.driveChangeToken : undefined,
    lastFullScanAt: Date.now(),
    lastReconciledAt: syncState?.lastReconciledAt,
  };
  const difference = compareManifests(previous, manifest);
  await commitWorkspaceChangePage(manifest, nextSyncState, difference.moves);
  const durationMs = performance.now() - startedAt;
  recordSyncDiagnostic({ operation: "manifest", outcome: "succeeded", durationMs, itemCount: manifest.entries.length });
  reportSlowSyncOperation("manifest", durationMs);
  return { manifest, syncState: nextSyncState, difference };
}

/**
 * Retries a throttled or temporary provider operation with bounded guidance-aware backoff.
 * @param operation Provider operation to execute.
 * @returns Successful provider result.
 */
export async function withProviderRetry<T>(operation: () => Promise<T>): Promise<T> {
  return retryOperation(operation, {
    isRetryable: (error) => error instanceof WorkspaceError && (error.code === "quota" || error.code === "temporary") ? { retryAfterMs: error.retryAfterMs } : null,
    onRetry: ({ error, attempt, delayMs }) => {
      recordWorkspaceMetric("provider_retry_count");
      recordSyncDiagnostic({ operation: "drive-request", outcome: "retrying", attempt, retryDelayMs: delayMs, errorCode: diagnosticErrorCode(error) });
    },
  });
}

/**
 * Discovers Drive deltas, initializing or recovering the cursor with a scan when required.
 * @param provider Drive provider with Changes API capabilities.
 * @param generation Active app workspace generation.
 * @returns Current entries and only the work affected by scan or delta pages.
 */
export async function discoverDriveChanges(provider: WorkspaceProvider, generation: number): Promise<ProviderDiscoveryResult> {
  if (!provider.getChangesStartCursor || !provider.listChanges) throw new WorkspaceError("unsupported", "Drive change discovery is unavailable.");
  recordSyncDiagnostic({ operation: "changes", outcome: "started" });
  let manifest = await loadWorkspaceManifest(provider.id);
  let syncState = await loadWorkspaceSyncState(provider.id);
  let cursor = syncState?.driveChangeToken;
  let fullScan = false;
  const changedEntryIds = new Set<string>();
  const removedPaths = new Set<string>();
  const moveByEntryId = new Map<string, ManifestPathMove>();

  /**
   * Coalesces repeated moves while retaining the path known before this reconciliation.
   * @param pageMoves Path moves from one scan or change page.
   * @returns Nothing after cumulative move facts update.
   */
  const collectMoves = (pageMoves: readonly ManifestPathMove[]): void => {
    for (const move of pageMoves) {
      const existing = moveByEntryId.get(move.entryId);
      moveByEntryId.set(move.entryId, { entryId: move.entryId, previousPath: existing?.previousPath ?? move.previousPath, nextPath: move.nextPath });
    }
  };

  /**
   * Collects the incremental effects of an authoritative scan.
   * @param difference Compared scan result.
   * @returns Nothing after cumulative discovery facts update.
   */
  const collectScan = (difference: Omit<ProviderDiscoveryResult, "entries" | "fullScan">): void => {
    for (const entryId of difference.changedEntryIds) changedEntryIds.add(entryId);
    for (const path of difference.removedPaths) removedPaths.add(path);
    collectMoves(difference.moves);
  };

  if (!cursor) {
    const activationCursor = initialDriveCursors.get(provider.id);
    if (activationCursor && manifest) {
      cursor = activationCursor;
      provider.primeEntries?.(manifestToWorkspaceEntries(manifest.entries));
      syncState = {
        workspaceId: provider.id,
        providerType: "drive",
        lastFullScanAt: manifest.updatedAt,
      };
      await saveWorkspaceSyncState(syncState);
      for (const entry of manifest.entries) changedEntryIds.add(entry.entryId);
      fullScan = true;
    } else {
      cursor = await withProviderRetry(() => provider.getChangesStartCursor!());
      const scanned = await scanDriveManifest(provider, manifest, generation, syncState, false);
      initialDriveCursors.set(provider.id, cursor);
      manifest = scanned.manifest;
      syncState = scanned.syncState;
      collectScan(scanned.difference);
      fullScan = true;
    }
  } else {
    provider.primeEntries?.(manifest ? manifestToWorkspaceEntries(manifest.entries) : []);
    const safetyDue = !syncState?.lastFullScanAt || Date.now() - syncState.lastFullScanAt >= DRIVE_SAFETY_SCAN_INTERVAL_MS;
    if (safetyDue && mayRunDriveSafetyScan()) {
      const scanned = await scanDriveManifest(provider, manifest, generation, syncState, true);
      manifest = scanned.manifest;
      syncState = scanned.syncState;
      collectScan(scanned.difference);
      fullScan = true;
    }
  }

  if (!cursor) throw new WorkspaceError("ambiguous", "Drive change initialization did not produce a cursor.");
  let recoveredCursor = false;
  while (true) {
    try {
      const pageCursor: string = cursor;
      const page = await withProviderRetry<WorkspaceChangePage>(() => provider.listChanges!(pageCursor));
      const applied = applyWorkspaceChanges(manifest?.entries ?? [], page.changes, provider.id);
      const nextManifest: WorkspaceManifest = {
        workspaceId: provider.id,
        entries: applied.entries,
        generation: Math.max(manifest?.generation ?? 0, generation) + 1,
        updatedAt: Date.now(),
      };
      const nextSyncState: WorkspaceSyncState = {
        workspaceId: provider.id,
        providerType: "drive",
        driveChangeToken: page.nextCursor,
        lastFullScanAt: syncState?.lastFullScanAt,
        lastReconciledAt: Date.now(),
      };
      await commitWorkspaceChangePage(nextManifest, nextSyncState, applied.moves);
      manifest = nextManifest;
      syncState = nextSyncState;
      cursor = page.nextCursor;
      for (const entryId of applied.changedEntryIds) changedEntryIds.add(entryId);
      for (const path of applied.removedPaths) removedPaths.add(path);
      collectMoves(applied.moves);
      if (page.done) break;
    } catch (error) {
      const recoverable = error instanceof WorkspaceError && (error.code === "cursor-invalid" || error.code === "ambiguous");
      if (!recoverable || recoveredCursor) throw error;
      recoveredCursor = true;
      cursor = await withProviderRetry(() => provider.getChangesStartCursor!());
      const scanned = await scanDriveManifest(provider, manifest, generation, syncState, false);
      initialDriveCursors.set(provider.id, cursor);
      manifest = scanned.manifest;
      syncState = scanned.syncState;
      collectScan(scanned.difference);
      fullScan = true;
    }
  }

  initialDriveCursors.delete(provider.id);
  const entries = manifestToWorkspaceEntries(manifest?.entries ?? []);
  provider.primeEntries?.(entries);
  recordSyncDiagnostic({ operation: "changes", outcome: "succeeded", itemCount: changedEntryIds.size + removedPaths.size });
  return { entries, changedEntryIds, removedPaths, moves: Array.from(moveByEntryId.values()), fullScan };
}

