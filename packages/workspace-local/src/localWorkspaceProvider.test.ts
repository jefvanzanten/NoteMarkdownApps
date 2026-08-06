import { beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceProvider } from "./localWorkspaceProvider";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  lastModified = 1;

  /**
   * Creates an in-memory browser file handle.
   * @param name Provider file name.
   * @param bytes Initial file bytes.
   * @returns An in-memory file handle.
   */
  constructor(readonly name: string, private bytes = new Uint8Array()) {}

  /** @returns A browser File snapshot of current bytes. */
  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { lastModified: this.lastModified });
  }

  /** @returns A minimal writable stream used by the provider contract. */
  async createWritable(): Promise<FileSystemWritableFileStream> {
    let nextBytes = this.bytes;
    return {
      write: async (data: FileSystemWriteChunkType) => {
        if (data instanceof Blob) nextBytes = new Uint8Array(await data.arrayBuffer());
        else if (typeof data === "string") nextBytes = new TextEncoder().encode(data);
        else if (data instanceof ArrayBuffer) nextBytes = new Uint8Array(data.slice(0));
        else if (ArrayBuffer.isView(data)) nextBytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      },
      close: async () => {
        this.bytes = nextBytes;
        this.lastModified += 1;
      },
    } as FileSystemWritableFileStream;
  }

  /**
   * Replaces bytes to simulate an external editor.
   * @param text New UTF-8 content.
   * @returns Nothing after mutation.
   */
  mutate(text: string): void {
    this.bytes = new TextEncoder().encode(text);
    this.lastModified += 1;
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

  /**
   * Creates an in-memory browser directory handle.
   * @param name Provider directory name.
   * @returns An in-memory directory handle.
   */
  constructor(readonly name: string) {}

  /** @returns Read/write permission for deterministic provider tests. */
  async queryPermission(): Promise<PermissionState> { return "granted"; }
  /** @returns Read/write permission for deterministic provider tests. */
  async requestPermission(): Promise<PermissionState> { return "granted"; }

  /**
   * Enumerates direct child handles.
   * @returns An async iterator of child names and handles.
   */
  async *entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
    for (const [name, handle] of this.children) {
      yield [name, handle as unknown as FileSystemFileHandle | FileSystemDirectoryHandle];
    }
  }

  /**
   * Resolves or creates a child file.
   * @param name Child file name.
   * @param options Creation options.
   * @returns Child file handle.
   */
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryFileHandle) return child as unknown as FileSystemFileHandle;
    if (child) throw new DOMException("Type mismatch", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing", "NotFoundError");
    const file = new MemoryFileHandle(name);
    this.children.set(name, file);
    return file as unknown as FileSystemFileHandle;
  }

  /**
   * Resolves or creates a child directory.
   * @param name Child directory name.
   * @param options Creation options.
   * @returns Child directory handle.
   */
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryDirectoryHandle) return child as unknown as FileSystemDirectoryHandle;
    if (child) throw new DOMException("Type mismatch", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing", "NotFoundError");
    const directory = new MemoryDirectoryHandle(name);
    this.children.set(name, directory);
    return directory as unknown as FileSystemDirectoryHandle;
  }

  /**
   * Removes a child provider entry.
   * @param name Child name.
   * @returns Nothing after removal.
   */
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("Missing", "NotFoundError");
  }
}

/**
 * Resolves a test file from an in-memory directory tree.
 * @param root Root test directory.
 * @param path Slash-separated provider path.
 * @returns The resolved file handle.
 */
function findFile(root: MemoryDirectoryHandle, path: string): MemoryFileHandle {
  const segments = path.split("/");
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    const child = directory.children.get(segment);
    if (!(child instanceof MemoryDirectoryHandle)) throw new Error(`Missing directory ${segment}`);
    directory = child;
  }
  const file = directory.children.get(segments.at(-1) ?? "");
  if (!(file instanceof MemoryFileHandle)) throw new Error(`Missing file ${path}`);
  return file;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });
});

describe("LocalWorkspaceProvider contract", () => {
  it("creates, reads, revision-checks, moves, trashes, and restores documents", async () => {
    const root = new MemoryDirectoryHandle("notes");
    const provider = new LocalWorkspaceProvider(root as unknown as FileSystemDirectoryHandle);
    const created = await provider.createDocument("daily/today.md").catch(async () => {
      await provider.createDirectory("daily");
      return provider.createDocument("daily/today.md");
    });
    expect((await provider.readDocument(created.path)).content).toBe("");

    const revision = await provider.writeDocument({
      path: created.path,
      content: "hello",
      format: created.format,
      expectedRevision: created.revision,
    });
    expect((await provider.readDocument(created.path)).content).toBe("hello");

    findFile(root, created.path).mutate("external");
    await expect(provider.writeDocument({
      path: created.path,
      content: "local",
      format: created.format,
      expectedRevision: revision,
    })).rejects.toMatchObject({ code: "conflict" });

    await provider.move(created.path, "daily/moved.md");
    const trashed = await provider.trash("daily/moved.md");
    await expect(provider.readDocument("daily/moved.md")).rejects.toMatchObject({ code: "not-found" });
    await provider.restore(trashed.token);
    expect((await provider.readDocument("daily/moved.md")).content).toBe("external");
  });

  it("preserves a UTF-8 BOM and CRLF line endings", async () => {
    const root = new MemoryDirectoryHandle("notes");
    const file = new MemoryFileHandle("format.md", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\ntwo\r\n")]));
    root.children.set(file.name, file);
    const provider = new LocalWorkspaceProvider(root as unknown as FileSystemDirectoryHandle);
    const document = await provider.readDocument("format.md");
    expect(document.format).toEqual({ hasBom: true, lineEnding: "\r\n" });
    expect(document.content).toBe("one\ntwo\n");
    await provider.writeDocument({ ...document, content: "one\nchanged\n", expectedRevision: document.revision });
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("one\r\nchanged\r\n");
  });
});
