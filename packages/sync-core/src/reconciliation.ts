export type ReconciliationAction =
  | "cache-hit"
  | "download-new"
  | "download-update"
  | "apply-clean-update"
  | "create-conflict"
  | "mark-possibly-removed"
  | "remove-clean"
  | "create-recovery"
  | "move"
  | "block-collision"
  | "verify-pending-write"
  | "apply-pending-write";

export interface ReconciliationInput {
  existsInManifest: boolean;
  remoteState: "live" | "unknown" | "removed" | "path-collision";
  remoteRevision?: string;
  cachedContentRevision?: string;
  baseRevision?: string;
  dirty: boolean;
  pathChanged: boolean;
  hasPendingWrite: boolean;
  writeVerified?: boolean;
}

export interface ReconciliationDecision {
  action: ReconciliationAction;
  preserveLocal: boolean;
  mayAdvanceObservedRevision: boolean;
  mayAdvanceCachedRevision: boolean;
}

/**
 * Selects one deterministic reconciliation transition without performing I/O.
 * @param input Durable local facts and newly observed provider facts.
 * @returns Transition preserving revision and dirty-work invariants.
 */
export function decideReconciliation(input: ReconciliationInput): ReconciliationDecision {
  if (input.remoteState === "path-collision") return decision("block-collision", true, false, false);
  if (input.remoteState === "unknown") return decision("mark-possibly-removed", true, false, false);
  if (input.remoteState === "removed") return decision(input.dirty ? "create-recovery" : "remove-clean", input.dirty, true, false);
  if (input.pathChanged) return decision("move", input.dirty, true, false);
  if (input.hasPendingWrite) return decision(input.writeVerified ? "apply-pending-write" : "verify-pending-write", true, true, false);
  if (!input.existsInManifest || !input.cachedContentRevision) return decision("download-new", input.dirty, true, false);
  if (input.remoteRevision === input.cachedContentRevision) return decision("cache-hit", input.dirty, true, false);
  if (input.dirty || (input.baseRevision !== undefined && input.baseRevision !== input.cachedContentRevision)) {
    return decision("create-conflict", true, true, false);
  }
  return decision(input.cachedContentRevision ? "download-update" : "download-new", false, true, false);
}

/**
 * Creates one transition result with explicit revision permissions.
 * @param action Selected state-machine action.
 * @param preserveLocal Whether unsynchronized content must survive.
 * @param mayAdvanceObservedRevision Whether remote observation may commit.
 * @param mayAdvanceCachedRevision Whether cached bytes may be relabeled without another content commit.
 * @returns Complete deterministic decision.
 */
function decision(
  action: ReconciliationAction,
  preserveLocal: boolean,
  mayAdvanceObservedRevision: boolean,
  mayAdvanceCachedRevision: boolean,
): ReconciliationDecision {
  return { action, preserveLocal, mayAdvanceObservedRevision, mayAdvanceCachedRevision };
}
