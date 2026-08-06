import { beforeEach, describe, expect, it, vi } from "vitest";
import { DriveWorkspaceProvider } from "./driveWorkspaceProvider";

beforeEach(() => { vi.stubGlobal("navigator", { onLine: true }); });

describe("DriveWorkspaceProvider privacy boundary", () => {
  it("downloads content directly from Google and mirrors the decoded document", async () => {
    const mirrored: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [{ id: "file-1", name: "note.md", mimeType: "text/markdown", modifiedTime: "2025-01-01T00:00:00Z", size: "7", version: "1" }] }), { status: 200 });
      if (url.includes("file-1?alt=media")) return new Response("# Note\n", { status: 200 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" }, mirror: { loadDocument: async () => null, saveDocument: async (document) => { mirrored.push(document.content); } } });
    expect(await provider.listEntries()).toMatchObject([{ path: "note.md", kind: "document" }]);
    expect((await provider.readDocument("note.md")).content).toBe("# Note\n");
    expect(mirrored).toEqual(["# Note\n"]);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://www.googleapis.com/"))).toBe(true);
  });
});
