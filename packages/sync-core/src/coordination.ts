export interface FencedLease {
  resource: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: number;
}

export interface LeaseStore {
  acquire(resource: string, ownerToken: string, ttlMs: number): Promise<FencedLease | null>;
  renew(lease: FencedLease, ttlMs: number): Promise<FencedLease | null>;
  release(lease: FencedLease): Promise<void>;
}

export interface SyncLeadership {
  readonly workspaceId: string;
  readonly fencingToken: number;
  release(): Promise<void>;
}

export interface EditingLease extends FencedLease {
  workspaceId: string;
  entryId: string;
}

/**
 * Checks whether an async result still belongs to the active fenced generation.
 * @param resultWorkspaceId Workspace carried by the result.
 * @param resultGeneration Generation carried by the result.
 * @param activeWorkspaceId Currently selected workspace.
 * @param activeGeneration Current cancellation generation.
 * @returns Whether state consumers may apply the result.
 */
export function isCurrentGeneration(
  resultWorkspaceId: string,
  resultGeneration: number,
  activeWorkspaceId: string,
  activeGeneration: number,
): boolean {
  return resultWorkspaceId === activeWorkspaceId && resultGeneration === activeGeneration;
}
