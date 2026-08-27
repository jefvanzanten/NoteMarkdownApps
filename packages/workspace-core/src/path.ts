import { supportedImageExtensions, type WorkspaceEntry, type WorkspaceEntryKind } from "./types";

const hiddenDirectoryNames = new Set(["node_modules", ".git", ".notemarkdown-trash"]);

/**
 * Normalizes a provider-relative path and rejects root traversal.
 * @param path Untrusted workspace-relative path.
 * @returns A normalized slash-separated path.
 */
export function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("Workspace path traversal is not allowed.");
  }
  return segments.join("/");
}

/**
 * Joins workspace-relative path segments safely.
 * @param segments Path fragments to join.
 * @returns A normalized workspace-relative path.
 */
export function joinWorkspacePath(...segments: string[]): string {
  return normalizeWorkspacePath(segments.filter(Boolean).join("/"));
}

/**
 * Returns the parent of a workspace-relative path.
 * @param path Workspace-relative path.
 * @returns Parent path or an empty string for a root entry.
 */
export function workspaceDirname(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex < 0 ? "" : normalized.slice(0, separatorIndex);
}

/**
 * Ensures that a newly created document always uses the Markdown extension.
 * @param path Requested workspace-relative document path.
 * @returns Normalized path with a lowercase `.md` extension.
 */
export function ensureMarkdownPath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) throw new Error("A Markdown document needs a file name.");
  const parent = workspaceDirname(normalized);
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const markdownName = name.toLocaleLowerCase().endsWith(".md") ? `${name.slice(0, -3)}.md` : `${name}.md`;
  return joinWorkspacePath(parent, markdownName);
}

/**
 * Finds a collision-free Markdown document path in a workspace directory.
 * @param entries Hierarchical workspace entries to check for collisions.
 * @param directoryPath Destination directory, or an empty string for the workspace root.
 * @returns An available normalized path ending in `.md`.
 */
export function availableMarkdownPath(entries: WorkspaceEntry[], directoryPath = ""): string {
  const normalizedDirectory = normalizeWorkspacePath(directoryPath);
  const occupiedPaths = new Set<string>();
  /** Collects paths recursively from one workspace level. @param levelEntries Entries to inspect. @returns Nothing. */
  const collectPaths = (levelEntries: WorkspaceEntry[]): void => {
    for (const entry of levelEntries) {
      occupiedPaths.add(normalizeWorkspacePath(entry.path).toLocaleLowerCase());
      if (entry.children) collectPaths(entry.children);
    }
  };
  collectPaths(entries);
  let sequence = 1;
  while (true) {
    const name = sequence === 1 ? "untitled.md" : `untitled-${sequence}.md`;
    const candidate = joinWorkspacePath(normalizedDirectory, name);
    if (!occupiedPaths.has(candidate.toLocaleLowerCase())) return candidate;
    sequence += 1;
  }
}

/**
 * Resolves a relative content target against a document path.
 * @param documentPath Path of the Markdown document.
 * @param target Relative link or image target.
 * @returns Resolved workspace path, or null when the target escapes the root.
 */
export function resolveWorkspaceTarget(documentPath: string, target: string): string | null {
  let cleanTarget: string;
  try {
    cleanTarget = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
  if (!cleanTarget || cleanTarget.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(cleanTarget)) return null;
  const parts = [...workspaceDirname(documentPath).split("/").filter(Boolean)];
  for (const segment of cleanTarget.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/**
 * Classifies a supported workspace entry by file name.
 * @param name File or directory name.
 * @param isDirectory Whether the provider entry is a directory.
 * @returns Supported entry kind, or null when it should be hidden.
 */
export function classifyWorkspaceEntry(name: string, isDirectory: boolean): WorkspaceEntryKind | null {
  if (name.startsWith(".") || hiddenDirectoryNames.has(name)) return null;
  if (isDirectory) return "directory";
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".md")) return "document";
  return supportedImageExtensions.some((extension) => lowerName.endsWith(extension)) ? "image" : null;
}
