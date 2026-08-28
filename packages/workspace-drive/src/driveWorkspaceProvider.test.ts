import { beforeEach, describe, expect, it, vi } from "vitest";
import { DriveWorkspaceProvider } from "./driveWorkspaceProvider";

beforeEach(() => { vi.stubGlobal("navigator", { onLine: true }); });

/**
 * Pauses an asynchronous test operation.
 * @param milliseconds Delay duration.
 * @returns Nothing after the timer completes.
 */
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

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

  it("scans independent Drive folders with bounded concurrency", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const query = new URL(String(input)).searchParams.get("q") ?? "";
      if (query.startsWith("'folder-1'")) {
        return new Response(JSON.stringify({ files: Array.from({ length: 16 }, (_, index) => ({
          id: `folder-${index + 2}`,
          name: `Folder ${index + 1}`,
          mimeType: "application/vnd.google-apps.folder",
        })) }), { status: 200 });
      }
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await delay(10);
      activeRequests -= 1;
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    expect(await provider.listEntries()).toHaveLength(16);
    expect(maximumActiveRequests).toBe(14);
  });

  it("recovers an uncertain local-first create without uploading a duplicate", async () => {
    const existing = { id: "drive-created", name: "new.md", mimeType: "text/markdown", modifiedTime: "2025-01-01T00:00:00Z", size: "10", version: "1", parents: ["folder-1"], appProperties: { notemarkdownEntryId: "local:create" } };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/drive/v3/files?") && url.includes("appProperties")) return new Response(JSON.stringify({ files: [existing] }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });

    await expect(provider.createDocument("new.md", "# Untitled\n", { localEntryId: "local:create", recoverExisting: true })).resolves.toMatchObject({ entryId: "drive-created", path: "new.md" });
    expect(requests.some((url) => url.includes("/upload/"))).toBe(false);
  });

  it("uses a revision-matched mirror without an alt=media request", async () => {
    const requests: string[] = [];
    const revision = { id: "md5:checksum:7", modifiedAt: Date.parse("2025-01-01T00:00:00Z"), size: 7 };
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

  it("updates move indexes without scanning the whole Drive workspace", async () => {
    const requests: string[] = [];
    const original = { id: "stable-1", name: "note.md", mimeType: "text/markdown", modifiedTime: "2025-01-01T00:00:00Z", size: "7", version: "1", parents: ["folder-1"] };
    const moved = { ...original, name: "renamed.md", version: "2" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [original] }), { status: 200 });
      if (url.includes("/drive/v3/files/stable-1?") && url.includes("addParents")) return new Response(JSON.stringify(moved), { status: 200 });
      if (url.includes("/drive/v3/files/stable-1?fields=")) return new Response(JSON.stringify(moved), { status: 200 });
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    await provider.listEntries();
    await provider.move("note.md", "renamed.md");
    await expect(provider.getEntryMetadata({ entryId: "stable-1", path: "renamed.md" })).resolves.toMatchObject({ path: "renamed.md" });
    expect(requests.filter((url) => url.includes("/drive/v3/files?")).length).toBe(1);
  });

  it("accepts a second write after Google advances only its internal version", async () => {
    const original = { id: "stable-1", name: "note.md", mimeType: "text/markdown", modifiedTime: "2025-01-01T00:00:00Z", size: "7", version: "27", md5Checksum: "original-sum", parents: ["folder-1"] };
    const changed = { ...original, modifiedTime: "2025-01-02T00:00:00Z", size: "8", version: "29", md5Checksum: "changed-sum" };
    let uploadCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [original] }), { status: 200 });
      if (url.includes("/drive/v3/files/stable-1?fields=")) return new Response(JSON.stringify(uploadCount === 0 ? original : changed), { status: 200 });
      if (url.includes("/upload/drive/v3/files/stable-1")) {
        uploadCount += 1;
        return new Response(JSON.stringify(uploadCount === 1 ? { ...changed, version: "28" } : { ...original, version: "30" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    const initial = (await provider.listEntries())[0].revision!;
    const firstWrite = await provider.writeDocument({ path: "note.md", content: "changed!", format: { hasBom: false, lineEnding: "\n" }, expectedRevision: initial });
    await expect(provider.writeDocument({ path: "note.md", content: "initial", format: { hasBom: false, lineEnding: "\n" }, expectedRevision: firstWrite })).resolves.toMatchObject({ id: "md5:original-sum:7" });
    expect(uploadCount).toBe(2);
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

  it("invalidates and refreshes a cached token once after Google returns 401", async () => {
    const tokens = ["expired-token", "fresh-token"];
    const invalidateAccessToken = vi.fn();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      return authorization === "Bearer expired-token"
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify({ files: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DriveWorkspaceProvider({
      workspaceId: "workspace-1",
      folderId: "folder-1",
      displayName: "Notes",
      tokenProvider: { getAccessToken: async () => tokens.shift() ?? "fresh-token", invalidateAccessToken },
    });
    await expect(provider.listEntries()).resolves.toEqual([]);
    expect(invalidateAccessToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps browser fetch failures to a retryable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const provider = new DriveWorkspaceProvider({ workspaceId: "workspace-1", folderId: "folder-1", displayName: "Notes", tokenProvider: { getAccessToken: async () => "short-token" } });
    await expect(provider.listEntries()).rejects.toMatchObject({ code: "temporary" });
  });

  it("reports path-free request outcomes to diagnostics", async () => {
    const results: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const provider = new DriveWorkspaceProvider({
      workspaceId: "workspace-1",
      folderId: "folder-1",
      displayName: "Notes",
      tokenProvider: { getAccessToken: async () => "short-token" },
      diagnostics: { recordRequest: () => undefined, recordContentDownload: () => undefined, recordRequestResult: (result) => results.push(result) },
    });
    await expect(provider.listEntries()).rejects.toMatchObject({ code: "temporary" });
    expect(results).toMatchObject([{ kind: "list", outcome: "failed", status: 503, errorCode: "temporary" }]);
    expect(JSON.stringify(results)).not.toContain("folder-1");
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
