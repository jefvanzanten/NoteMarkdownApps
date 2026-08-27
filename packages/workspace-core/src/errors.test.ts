import { describe, expect, it } from "vitest";
import { classifyWorkspaceError } from "./errors";
import { WorkspaceError } from "./types";

describe("workspace failure classification", () => {
  it("keeps temporary retry guidance machine readable", () => {
    expect(classifyWorkspaceError(new WorkspaceError("temporary", "safe", { retryAfterMs: 4_000 }), "google-drive")).toEqual({
      category: "provider-temporary",
      source: "google-drive",
      retryable: true,
      retryAfterMs: 4_000,
      blocks: "operation",
      preservesDraft: true,
      recoveryAction: "retry",
    });
  });

  it("marks revision conflicts as document-scoped and non-retryable", () => {
    expect(classifyWorkspaceError(new WorkspaceError("conflict", "safe"), "google-drive")).toMatchObject({
      category: "revision-conflict",
      retryable: false,
      blocks: "document",
      preservesDraft: true,
      recoveryAction: "resolve-conflict",
    });
  });

  it("allows an adapter to distinguish session expiry from provider permission", () => {
    expect(classifyWorkspaceError(new WorkspaceError("permission", "safe"), "metadata-api", {
      category: "session-expired",
      blocks: "account",
      recoveryAction: "sign-in",
    })).toMatchObject({ category: "session-expired", source: "metadata-api", blocks: "account", recoveryAction: "sign-in" });
  });
});
