import { describe, expect, it, vi } from "vitest";
import { retryOperation } from "./retryOperation";

const policy = { baseDelayMs: 100, maximumDelayMs: 1_000, maximumAttempts: 2, jitterRatio: 0 };

describe("retryOperation", () => {
  it("retries classified failures and reports bounded attempts", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("limited"), { retryAfterMs: 250 }))
      .mockResolvedValue("ok");
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    await expect(retryOperation(operation, {
      policy,
      sleep,
      onRetry,
      isRetryable: (error) => ({ retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs }),
    })).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(250);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 250 }));
  });

  it("does not retry unclassified or exhausted failures", async () => {
    const permanent = new Error("permanent");
    await expect(retryOperation(async () => { throw permanent; }, { policy, isRetryable: () => null })).rejects.toBe(permanent);

    const operation = vi.fn(async () => { throw new Error("temporary"); });
    await expect(retryOperation(operation, { policy, sleep: async () => undefined, isRetryable: () => ({}) })).rejects.toThrow("temporary");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
