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

  it("uses a revision-matched mirror without an alt=media request", async () => {
    const requests: string[] = [];
    const revision = { id: "7:checksum:2025-01-01T00:00:00Z", modifiedAt: Date.parse("2025-01-01T00:00:00Z"), size: 7 };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [{ id: "stable-1", name: "note.md", mimeType: "text/markdown", modifiedTime: "2025-01-01T00:00:00Z", size: "7", version: "7", md5Checksum: "checksum", parents: ["folder-1"] }] }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({
      workspaceId: "workspace-1",
      folderId: "folder-1",
      displayName: "Notes",
      tokenProvider: { getAccessToken: async () => "short-token" },
      mirror: { loadDocument: async () => ({ path: "note.md", content: "cached", format: { hasBom: false, lineEnding: "\n" }, revision }), saveDocument: async () => undefined },
    });
    await provider.listEntries();
    expect((await provider.readDocument("note.md")).content).toBe("cached");
    expect(requests.some((url) => url.includes("alt=media"))).toBe(false);
  });

  it("looks up stable-ID metadata without downloading content", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const file = { id: "stable-1", name: "renamed.md", mimeType: "text/markdown", modifiedTime: "2025-01-02T00:00:00Z", size: "8", version: "8", parents: ["folder-1"] };
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [{ ...file, name: "note.md" }] }), { status: 200 });
      if (url.includes("/files/stable-1?fields=")) return new Response(JSON.stringify(file), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    await provider.listEntries();
    const metadata = await provider.getEntryMetadata({ entryId: "stable-1", path: "note.md" });
    expect(metadata).toMatchObject({ entryId: "stable-1", path: "renamed.md", state: "live" });
    expect(requests.some((url) => url.includes("alt=media"))).toBe(false);
  });

  it("uses a durable Changes cursor and scopes rename metadata without a folder scan", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("changes/startPageToken")) return new Response(JSON.stringify({ startPageToken: "start-1" }), { status: 200 });
      if (url.includes("/drive/v3/changes?")) return new Response(JSON.stringify({
        newStartPageToken: "next-1",
        changes: [
          { fileId: "stable-1", file: { id: "stable-1", name: "renamed.md", mimeType: "text/markdown", modifiedTime: "2025-01-02T00:00:00Z", size: "8", version: "8", parents: ["folder-1"] } },
          { fileId: "unrelated", file: { id: "unrelated", name: "other.md", mimeType: "text/markdown", version: "1", parents: [] } },
        ],
      }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    provider.primeEntries([{ kind: "document", name: "note.md", path: "note.md", entryId: "stable-1", parentEntryId: "folder-1", revision: { id: "R1", modifiedAt: 1, size: 7 } }]);
    expect(await provider.getChangesStartCursor()).toBe("start-1");
    expect(await provider.listChanges("start-1")).toMatchObject({
      done: true,
      nextCursor: "next-1",
      changes: [{ entryId: "stable-1", removed: false, metadata: { path: "renamed.md", state: "live" } }],
    });
    expect(requests.some((url) => url.includes("alt=media") || url.includes("/drive/v3/files?"))).toBe(false);
  });

  it("discovers a newly moved-in folder subtree through metadata only", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/drive/v3/changes?")) return new Response(JSON.stringify({
        newStartPageToken: "next-2",
        changes: [{ fileId: "moved-folder", file: { id: "moved-folder", name: "Moved", mimeType: "application/vnd.google-apps.folder", parents: ["folder-1"] } }],
      }), { status: 200 });
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [{ id: "nested", name: "nested.md", mimeType: "text/markdown", version: "2", parents: ["moved-folder"] }] }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    const page = await provider.listChanges("start-2");
    expect(page.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: "moved-folder", metadata: expect.objectContaining({ path: "Moved" }) }),
      expect.objectContaining({ entryId: "nested", metadata: expect.objectContaining({ path: "Moved/nested.md" }) }),
    ]));
    expect(requests.some((url) => url.includes("alt=media"))).toBe(false);
  });

  it("retains Drive Retry-After guidance for bounded reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "2" } })));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    await expect(provider.listChanges("limited")).rejects.toMatchObject({ code: "quota", retryAfterMs: 2_000 });
  });

  it("reports an expired Changes cursor as recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    await expect(provider.listChanges("expired")).rejects.toMatchObject({ code: "cursor-invalid" });
  });

  it("reports duplicate sibling paths instead of overwriting identity maps", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [
        { id: "one", name: "same.md", mimeType: "text/markdown", version: "1" },
        { id: "two", name: "same.md", mimeType: "text/markdown", version: "1" },
      ] }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    expect(await provider.listEntries()).toMatchObject([
      { entryId: "one", path: "same.md", state: "path-collision" },
      { entryId: "two", path: "same.md", state: "path-collision" },
    ]);
    await expect(provider.readDocument("same.md")).rejects.toMatchObject({ code: "collision" });
  });
});
