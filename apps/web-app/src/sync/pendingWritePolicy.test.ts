import { describe, expect, it } from "vitest";
import type { PendingDocumentWrite } from "@note/browser-storage";
import {
  ABANDONED_IN_FLIGHT_MS,
  CURRENT_PENDING_WRITE_FORMAT,
  LEGACY_PENDING_WRITE_FORMAT,
  MAX_PENDING_WRITE_AGE_MS,
  pendingWriteResumeDecision,
} from "./pendingWritePolicy";

const now = 2_000_000_000_000;
const pending: PendingDocumentWrite = {
  id: "document:entry",
  workspaceId: "drive:workspace",
  entryId: "entry",
  targetPath: "existing.md",
  expectedBaseRevision: { id: "revision", modifiedAt: 1, size: 1 },
  draftRevision: "draft",
  state: "pending",
  attempt: 0,
  formatVersion: CURRENT_PENDING_WRITE_FORMAT,
  createdAt: now - 1_000,
  updatedAt: now - 1_000,
};

describe("pending write resume policy", () => {
  it("processes a current recent pending write", () => {
    expect(pendingWriteResumeDecision(pending, now).action).toBe("process");
  });

  it("resumes the previous durable format but blocks unversioned, unsupported, and expired writes", () => {
    expect(pendingWriteResumeDecision({ ...pending, formatVersion: LEGACY_PENDING_WRITE_FORMAT }, now).action).toBe("process");
    expect(pendingWriteResumeDecision({ ...pending, formatVersion: undefined }, now)).toMatchObject({ action: "block-stale", reason: "legacy-format" });
    expect(pendingWriteResumeDecision({ ...pending, formatVersion: CURRENT_PENDING_WRITE_FORMAT + 1 }, now)).toMatchObject({ action: "block-stale", reason: "unsupported-format" });
    expect(pendingWriteResumeDecision({ ...pending, createdAt: now - MAX_PENDING_WRITE_AGE_MS - 1 }, now)).toMatchObject({ action: "block-stale", reason: "expired" });
  });

  it("recovers only an abandoned in-flight write", () => {
    expect(pendingWriteResumeDecision({ ...pending, state: "in-flight", updatedAt: now - ABANDONED_IN_FLIGHT_MS + 1 }, now).action).toBe("skip");
    expect(pendingWriteResumeDecision({ ...pending, state: "in-flight", updatedAt: now - ABANDONED_IN_FLIGHT_MS - 1 }, now)).toMatchObject({ action: "process", pending: { state: "pending" } });
  });

  it("waits for a retry deadline and never resumes terminal states", () => {
    expect(pendingWriteResumeDecision({ ...pending, state: "retryable", retryAt: now + 1 }, now).action).toBe("skip");
    expect(pendingWriteResumeDecision({ ...pending, state: "blocked" }, now).action).toBe("skip");
    expect(pendingWriteResumeDecision({ ...pending, state: "conflicted" }, now).action).toBe("skip");
    expect(pendingWriteResumeDecision({ ...pending, state: "applied" }, now).action).toBe("skip");
  });
});
