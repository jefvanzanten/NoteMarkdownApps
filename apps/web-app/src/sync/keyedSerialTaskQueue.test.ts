import { describe, expect, it, vi } from "vitest";
import { KeyedSerialTaskQueue } from "./keyedSerialTaskQueue";

/** Creates a manually resolved promise for deterministic queue tests. @returns Promise and resolver pair. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("keyed serial task queue", () => {
  it("serializes work with the same key", async () => {
    const queue = new KeyedSerialTaskQueue();
    const firstGate = deferred();
    const calls: string[] = [];
    const first = queue.run("document", async () => { calls.push("first-start"); await firstGate.promise; calls.push("first-end"); });
    const second = queue.run("document", async () => { calls.push("second"); });

    await vi.waitFor(() => expect(calls).toEqual(["first-start"]));
    expect(queue.has("document")).toBe(true);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual(["first-start", "first-end", "second"]);
    expect(queue.has("document")).toBe(false);
  });

  it("allows different keys to run concurrently", async () => {
    const queue = new KeyedSerialTaskQueue();
    const gate = deferred();
    let secondStarted = false;
    const first = queue.run("first", async () => { await gate.promise; });
    const second = queue.run("second", async () => { secondStarted = true; });

    await second;
    expect(secondStarted).toBe(true);
    gate.resolve();
    await first;
  });

  it("continues after a rejected predecessor", async () => {
    const queue = new KeyedSerialTaskQueue();
    const first = queue.run("document", async () => { throw new Error("failed"); });
    const second = queue.run("document", async () => "recovered");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("recovered");
  });
});
