import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@note/workspace-core";
import { ApiRequestError } from "../account/apiClient";
import { classifyDriveTokenFailure, driveTokenFailure, providerWriteRetryDelay } from "./providerFailurePolicy";

describe("provider failure policy", () => {
  it("blocks an expired NoteMarkdown session until the user signs in again", () => {
    const failure = driveTokenFailure(new ApiRequestError("expired", 401, "unauthorized"));
    expect(failure).toMatchObject({ code: "permission" });
    expect(failure.message).toContain("session expired or was revoked");
    expect(providerWriteRetryDelay(failure, 0)).toBeNull();
    expect(classifyDriveTokenFailure(new ApiRequestError("expired", 401, "unauthorized", "request-1"))).toMatchObject({ category: "session-expired", source: "metadata-api", blocks: "account", recoveryAction: "sign-in", requestId: "request-1" });
  });

  it("blocks a saved workspace whose connected account no longer exists", () => {
    const failure = driveTokenFailure(new ApiRequestError("missing", 404, "not-found"));
    expect(failure).toMatchObject({ code: "permission" });
    expect(failure.message).toContain("saved workspace is no longer available");
    expect(providerWriteRetryDelay(failure, 0)).toBeNull();
  });

  it("blocks Google reauthorization and direct provider permission failures", () => {
    const reauthorization = driveTokenFailure(new ApiRequestError("reauthorize", 409, "reauthorization-required"));
    expect(providerWriteRetryDelay(reauthorization, 0)).toBeNull();
    expect(providerWriteRetryDelay(new WorkspaceError("permission", "Drive rejected access"), 0)).toBeNull();
  });

  it("retries temporary API failures with bounded server guidance", () => {
    const failure = driveTokenFailure(new ApiRequestError("temporary", 503, "provider-rate-limited", undefined, 12_000));
    expect(failure).toMatchObject({ code: "temporary", retryAfterMs: 12_000 });
    expect(providerWriteRetryDelay(failure, 0)).toBe(12_000);
    expect(providerWriteRetryDelay(failure, 8)).toBeNull();
    expect(classifyDriveTokenFailure(new ApiRequestError("limited", 503, "provider-rate-limited", undefined, 12_000))).toMatchObject({ category: "rate-limited", retryable: true, retryAfterMs: 12_000 });
  });
});
