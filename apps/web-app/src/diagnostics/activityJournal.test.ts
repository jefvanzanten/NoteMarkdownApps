import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActivityJournal,
  configureActivityJournal,
  exportActivityJournal,
  getActivitySnapshot,
  getHourlyMetricsSnapshot,
  recordActivity,
  type ActivityEvent,
} from "./activityJournal";
import { ACTIVITY_EVENT_POLICIES, classifyActivity } from "./activityPolicy";

/** Resets module-level journal state between unit tests. @returns Nothing after events and metrics are cleared. */
afterEach(async () => {
  configureActivityJournal({ enabled: false, buildMode: "test" });
  await clearActivityJournal();
  vi.useRealTimers();
});

describe("activity journal", () => {
  it("records ordered scalar metadata without undefined values", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });

    const first = recordActivity("document", "document.opened", { path: "notes/example.md", omitted: undefined });
    const second = recordActivity("sync", "sync.provider-write.succeeded", { durationMs: 42 }, "info", "correlation-1");

    expect(first).not.toBeNull();
    expect(second?.sequence).toBe((first?.sequence ?? 0) + 1);
    expect(first?.details).toEqual({ path: "notes/example.md" });
    expect(getActivitySnapshot().map((event) => event.event)).toEqual([
      "document.opened",
      "sync.provider-write.succeeded",
    ]);
  });

  it("continuously records while enabled and ignores activity while disabled", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    recordActivity("application", "before-disable");
    configureActivityJournal({ enabled: false, buildMode: "test" });

    expect(recordActivity("application", "while-disabled")).toBeNull();
    expect(getActivitySnapshot().map((event) => event.event)).toEqual(["before-disable"]);
  });

  it("drops registered noise and safely retains an unknown event", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });

    expect(recordActivity("application", "window.focused", {}, "debug")).toBeNull();
    expect(recordActivity("application", "future.unclassified-event", {}, "debug")).not.toBeNull();
    expect(classifyActivity("window.focused", {}, "debug")).toBe("drop");
    expect(ACTIVITY_EVENT_POLICIES["window.focused"]).toBe("drop");
  });

  it("aggregates routine successes into an hourly bucket and retains mutations", async () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    recordActivity("sync", "sync.token-request.started");
    recordActivity("sync", "sync.token-request.succeeded", { durationMs: 20 });
    recordActivity("sync", "sync.drive-request.succeeded", { requestKind: "content", durationMs: 12, responseBytes: 40 });
    recordActivity("sync", "sync.drive-request.succeeded", { requestKind: "mutation", durationMs: 20 });

    expect(getHourlyMetricsSnapshot().at(-1)).toMatchObject({
      tokenSuccessCount: 1,
      tokenDurationMs: 20,
      driveReadCount: 1,
      driveReadDurationMs: 12,
      driveReadBytes: 40,
    });
    expect(getActivitySnapshot()).toContainEqual(expect.objectContaining({ event: "sync.drive-request.succeeded", details: expect.objectContaining({ requestKind: "mutation" }) }));

    const exported = JSON.parse(await exportActivityJournal()) as { hourlyMetrics: unknown[]; events: ActivityEvent[] };
    expect(exported.hourlyMetrics).toHaveLength(1);
    expect(exported.events.some((event) => event.event.endsWith(".summary"))).toBe(false);
  });

  it("retains slow routine successes as individual events", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });

    recordActivity("api", "api.request.succeeded", { durationMs: 4_999 });
    recordActivity("api", "api.request.succeeded", { durationMs: 5_000 });
    recordActivity("sync", "sync.reconciliation.succeeded", { durationMs: 30_000 });

    expect(getHourlyMetricsSnapshot().at(-1)?.apiSuccessCount).toBe(1);
    expect(getActivitySnapshot().map((event) => event.event)).toEqual([
      "api.request.succeeded",
      "sync.reconciliation.succeeded",
    ]);
  });

  it("reserves retention for older warnings and errors", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    for (let index = 0; index < 120; index += 1) recordActivity("workspace", `warning.${index}`, {}, "warning");
    for (let index = 0; index < 500; index += 1) recordActivity("document", `normal.${index}`);

    const retained = getActivitySnapshot();
    expect(retained).toHaveLength(500);
    expect(retained.filter((event) => event.level === "warning")).toHaveLength(100);
    expect(retained.filter((event) => event.level === "info")).toHaveLength(400);
  });

  it("removes events outside the rolling 24-hour window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    configureActivityJournal({ enabled: true, buildMode: "test" });
    recordActivity("document", "document.old");
    vi.setSystemTime(new Date("2025-01-02T00:00:00.001Z"));
    recordActivity("document", "document.current");

    expect(getActivitySnapshot().map((event) => event.event)).toEqual(["document.current"]);
  });

  it("exports readable JSON within the hard byte limit", async () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    for (let index = 0; index < 500; index += 1) {
      recordActivity("document", `document.large-${index}`, { path: "x".repeat(2_000) });
    }

    const json = await exportActivityJournal();
    const exported = JSON.parse(json) as { eventCount: number; truncated: boolean; truncatedReasons: string[]; events: ActivityEvent[] };

    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(512 * 1_024);
    expect(exported.eventCount).toBe(exported.events.length);
    expect(exported.truncated).toBe(true);
    expect(exported.truncatedReasons).toContain("size");
  });
});
