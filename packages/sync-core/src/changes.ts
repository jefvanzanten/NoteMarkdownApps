import type {
  WorkspaceChange,
  WorkspaceEntryKind,
  WorkspaceEntryState,
  WorkspaceMetadataFingerprint,
  WorkspaceRevision,
} from "@note/workspace-core";

export interface DeltaManifestEntry {
  workspaceId: string;
  entryId: string;
  path: string;
  kind: WorkspaceEntryKind;
  parentEntryId?: string;
  observedProviderRevision?: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  state: WorkspaceEntryState;
  updatedAt: number;
}

export interface ManifestPathMove {
  entryId: string;
  previousPath: string;
  nextPath: string;
}

export interface AppliedWorkspaceChanges {
  entries: DeltaManifestEntry[];
  changedEntryIds: Set<string>;
  removedEntryIds: Set<string>;
  removedPaths: Set<string>;
  moves: ManifestPathMove[];
}

/**
 * Rewrites one path when a stable parent directory moves.
 * @param path Existing workspace-relative path.
 * @param previousPrefix Previous directory path.
 * @param nextPrefix New directory path.
 * @returns Updated path or the original when unrelated.
 */
function replacePathPrefix(path: string, previousPrefix: string, nextPrefix: string): string {
  if (path === previousPrefix) return nextPrefix;
  return path.startsWith(`${previousPrefix}/`) ? `${nextPrefix}${path.slice(previousPrefix.length)}` : path;
}

/**
 * Marks an entry and all stable-ID descendants as authoritatively removed.
 * @param entries Mutable manifest map.
 * @param entryId Removed root identity.
 * @param removedEntries Collector for removed identities.
 * @param removedPaths Collector for paths that must leave derived indexes.
 * @param updatedAt Provider observation timestamp.
 * @returns Nothing after recursive marking.
 */
function markRemoved(
  entries: Map<string, DeltaManifestEntry>,
  entryId: string,
  removedEntries: Set<string>,
  removedPaths: Set<string>,
  updatedAt: number,
): void {
  const entry = entries.get(entryId);
  if (!entry || removedEntries.has(entryId)) return;
  removedEntries.add(entryId);
  removedPaths.add(entry.path);
  entries.set(entryId, { ...entry, state: "removed", updatedAt });
  for (const child of entries.values()) {
    if (child.parentEntryId === entryId) markRemoved(entries, child.entryId, removedEntries, removedPaths, updatedAt);
  }
}

/**
 * Applies one provider change page to flat manifest facts deterministically.
 * @param currentEntries Current durable manifest entries.
 * @param changes Scoped provider change page.
 * @param workspaceId Workspace identity assigned to newly discovered entries.
 * @param updatedAt Observation timestamp shared by this page.
 * @returns Next entries plus content, removal, and path-move work.
 */
export function applyWorkspaceChanges(
  currentEntries: readonly DeltaManifestEntry[],
  changes: readonly WorkspaceChange[],
  workspaceId: string,
  updatedAt = Date.now(),
): AppliedWorkspaceChanges {
  const entries = new Map(currentEntries.map((entry) => [entry.entryId, { ...entry }]));
  const changedEntryIds = new Set<string>();
  const removedEntryIds = new Set<string>();
  const removedPaths = new Set<string>();
  const moveByEntryId = new Map<string, ManifestPathMove>();

  for (const change of changes) {
    const existing = entries.get(change.entryId);
    if (change.removed) {
      markRemoved(entries, change.entryId, removedEntryIds, removedPaths, updatedAt);
      continue;
    }
    if (!change.metadata) continue;
    const metadata = change.metadata;
    entries.set(change.entryId, {
      workspaceId: existing?.workspaceId ?? workspaceId,
      entryId: change.entryId,
      path: metadata.path,
      kind: metadata.kind,
      parentEntryId: metadata.parentEntryId,
      observedProviderRevision: metadata.revision,
      metadataFingerprint: metadata.metadataFingerprint,
      state: metadata.state,
      updatedAt,
    });
    changedEntryIds.add(change.entryId);
    if (existing && existing.path !== metadata.path) {
      moveByEntryId.set(change.entryId, { entryId: change.entryId, previousPath: existing.path, nextPath: metadata.path });
      if (existing.kind === "directory") {
        for (const descendant of entries.values()) {
          if (descendant.entryId === existing.entryId || descendant.state === "removed") continue;
          const nextPath = replacePathPrefix(descendant.path, existing.path, metadata.path);
          if (nextPath === descendant.path) continue;
          moveByEntryId.set(descendant.entryId, { entryId: descendant.entryId, previousPath: descendant.path, nextPath });
          entries.set(descendant.entryId, { ...descendant, path: nextPath, updatedAt });
        }
      }
    }
  }

  const livePaths = new Map<string, string[]>();
  for (const entry of entries.values()) {
    if (entry.state === "removed") continue;
    livePaths.set(entry.path, [...(livePaths.get(entry.path) ?? []), entry.entryId]);
  }
  for (const entry of entries.values()) {
    if (entry.state === "removed") continue;
    const collided = (livePaths.get(entry.path)?.length ?? 0) > 1;
    entries.set(entry.entryId, { ...entry, state: collided ? "path-collision" : entry.state === "path-collision" ? "live" : entry.state });
  }

  return {
    entries: Array.from(entries.values()),
    changedEntryIds,
    removedEntryIds,
    removedPaths,
    moves: Array.from(moveByEntryId.values()),
  };
}
