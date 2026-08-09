import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceLeadership } from "./browserCoordination";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace leadership", () => {
  it("promotes a follower after the previous Web Lock leader disappears", async () => {
    vi.useFakeTimers();
    let available = false;
    const locks = {
      request: vi.fn(async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => callback(available ? {} as Lock : null)),
    };
    vi.stubGlobal("navigator", { locks });
    vi.stubGlobal("window", { setInterval, clearInterval });
    const promoted = vi.fn();

    const handle = await acquireWorkspaceLeadership("drive:test", () => undefined, promoted);
    expect(handle?.isLeader).toBe(false);

    available = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(handle?.isLeader).toBe(true));
    expect(promoted).toHaveBeenCalledOnce();
    expect(await handle?.isCurrent()).toBe(true);

    await handle?.release();
    expect(handle?.isLeader).toBe(false);
  });
});
