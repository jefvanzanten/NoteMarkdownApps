import { PENDING_WRITE_FORMAT_VERSION, type PendingDocumentWrite } from "@note/browser-storage";

export const CURRENT_PENDING_WRITE_FORMAT = PENDING_WRITE_FORMAT_VERSION;
export const LEGACY_PENDING_WRITE_FORMAT = 1;
export const MAX_PENDING_WRITE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const ABANDONED_IN_FLIGHT_MS = 2 * 60 * 1_000;

export type PendingWriteResumeDecision =
  | { action: "process"; pending: PendingDocumentWrite }
  | { action: "skip"; pending: PendingDocumentWrite }
  | { action: "block-stale"; pending: PendingDocumentWrite; reason: "legacy-format" | "unsupported-format" | "expired" };

/**
 * Classifies a durable outbox item before a new runtime may send it.
 * @param pending Stored provider write from this or an earlier runtime.
 * @param now Current epoch time for deterministic staleness checks.
 * @returns Safe processing, skip, or stale-block decision.
 */
export function pendingWriteResumeDecision(pending: PendingDocumentWrite, now = Date.now()): PendingWriteResumeDecision {
  if (pending.state === "applied" || pending.state === "blocked" || pending.state === "conflicted") return { action: "skip", pending };
  if (pending.formatVersion === undefined || pending.createdAt === undefined) return { action: "block-stale", pending, reason: "legacy-format" };
  if (pending.formatVersion !== CURRENT_PENDING_WRITE_FORMAT && pending.formatVersion !== LEGACY_PENDING_WRITE_FORMAT) return { action: "block-stale", pending, reason: "unsupported-format" };
  if (now - pending.createdAt > MAX_PENDING_WRITE_AGE_MS) return { action: "block-stale", pending, reason: "expired" };
  if (pending.state === "in-flight") {
    const lastAttemptAt = pending.updatedAt ?? pending.createdAt;
    if (now - lastAttemptAt < ABANDONED_IN_FLIGHT_MS) return { action: "skip", pending };
    return { action: "process", pending: { ...pending, state: "pending", retryAt: undefined } };
  }
  if (pending.state === "retryable" && (pending.retryAt ?? 0) > now) return { action: "skip", pending };
  return { action: "process", pending };
}
