import { describe, expect, it } from "vitest";
import { threeWayMerge } from "./threeWayMerge";

describe("three-way merge", () => {
  it("selects the side that changed from the base", () => {
    expect(threeWayMerge("base", "local", "base")).toEqual({ kind: "local", content: "local" });
    expect(threeWayMerge("base", "base", "remote")).toEqual({ kind: "remote", content: "remote" });
  });

  it("accepts identical local and remote content", () => {
    expect(threeWayMerge("base", "same", "same")).toEqual({ kind: "unchanged", content: "same" });
  });

  it("merges independent line edits", () => {
    const result = threeWayMerge(
      ["heading", "local target", "middle", "remote target", "end"].join("\n"),
      ["heading", "local changed", "middle", "remote target", "end"].join("\n"),
      ["heading", "local target", "middle", "remote changed", "end"].join("\n"),
    );

    expect(result).toEqual({
      kind: "merged",
      content: ["heading", "local changed", "middle", "remote changed", "end"].join("\n"),
    });
  });

  it("keeps overlapping edits as an explicit conflict", () => {
    expect(threeWayMerge("heading\ntarget\nend", "heading\nlocal\nend", "heading\nremote\nend")).toEqual({ kind: "conflict" });
  });

  it("merges insertions at different base positions", () => {
    expect(threeWayMerge("a\nb\nc", "a\nlocal\nb\nc", "a\nb\nc\nremote")).toEqual({ kind: "merged", content: "a\nlocal\nb\nc\nremote" });
  });
});
