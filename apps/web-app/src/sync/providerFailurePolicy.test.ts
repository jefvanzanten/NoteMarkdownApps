import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@note/workspace-core";
import { ApiRequestError } from "../account/apiClient";
import { driveTokenFailure, providerWriteRetryDelay } from "./providerFailurePolicy";

describe("provider failure policy", () => {
  it("keeps an expired NoteMarkdown session retryable after sign-in", () => {
    const failure = driveTokenFailure(new ApiRequestError("expired", 401, "unauthorized"));
    expect(failure).toMatchObject({ code: "permission" });
    expect(failure.message).toContain("session expired or was revoked");
    expect(providerWriteRetryDelay(failure, 0)).toEqual(expect.any(Number));
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

  it("retries temporary API failures with a bounded delay", () => {
    const failure = driveTokenFailure(new ApiRequestError("temporary", 503, "internal"));
    expect(failure).toMatchObject({ code: "temporary" });
    expect(providerWriteRetryDelay(failure, 0)).toEqual(expect.any(Number));
    expect(providerWriteRetryDelay(failure, 8)).toBeNull();
  });
});
