import { afterEach, describe, expect, it } from "vitest";
import {
  clearActivityJournal,
  configureActivityJournal,
  exportActivityJournal,
  getActivityRecordingSnapshot,
  getActivitySnapshot,
  recordActivity,
  setActivityRecording,
  type ActivityEvent,
} from "./activityJournal";

/** Resets module-level journal state between unit tests. @returns Nothing after recording and events are cleared. */
afterEach(async () => {
  configureActivityJournal({ enabled: false, buildMode: "test" });
  await clearActivityJournal();
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

  it("stops and resumes recording without deleting captured events", () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    recordActivity("application", "before-stop");

    expect(setActivityRecording(false)).toBe(false);
    expect(getActivityRecordingSnapshot()).toBe(false);
    expect(recordActivity("application", "while-stopped")).toBeNull();
    expect(setActivityRecording(true)).toBe(true);
    recordActivity("application", "after-resume");

    expect(getActivitySnapshot().map((event) => event.event)).toEqual([
      "before-stop",
      "activity-recording.stopped",
      "activity-recording.started",
      "after-resume",
    ]);
  });

  it("exports retained event metadata and range facts asynchronously", async () => {
    configureActivityJournal({ enabled: true, buildMode: "test" });
    recordActivity("document", "document.changed", { contentLength: 12 });

    const exported = JSON.parse(await exportActivityJournal()) as { eventCount: number; rangeStart: string | null; rangeEnd: string | null; events: ActivityEvent[] };

    expect(exported.eventCount).toBe(exported.events.length);
    expect(exported.rangeStart).not.toBeNull();
    expect(exported.rangeEnd).not.toBeNull();
    expect(exported.events.at(-1)?.event).toBe("document.changed");
  });
});
