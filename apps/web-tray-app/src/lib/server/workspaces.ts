import fs from "fs/promises";
import os from "os";
import path from "path";

export type RecentWorkspace = {
  path: string;
  name: string;
};

export type ServerFile = {
  path: string;
  name: string;
};

export type DirEntry = {
  name: string;
  path: string;
};

export type DirListing = {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
};

const RECENTS_PATH = path.join(os.homedir(), ".note-markdown", "recents.json");

function comparePaths(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const lhs = process.platform === "win32" ? root.toLowerCase() : root;
  const rhs = process.platform === "win32" ? candidate.toLowerCase() : candidate;

  return rhs === lhs || rhs.startsWith(`${lhs}${path.sep}`);
}

function toWorkspacePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readRecents(): Promise<RecentWorkspace[]> {
  try {
    const raw = await fs.readFile(RECENTS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentWorkspace =>
        typeof item === "object" &&
        item !== null &&
        typeof item.path === "string" &&
        typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

async function writeRecents(recents: RecentWorkspace[]): Promise<void> {
  await ensureDirectoryExists(path.dirname(RECENTS_PATH));
  await fs.writeFile(RECENTS_PATH, JSON.stringify(recents, null, 2), "utf-8");
}

async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  const resolved = await fs.realpath(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Workspace path is not a directory");
  }
  return resolved;
}

function resolveTargetPath(rootPath: string, relativePath: string): string {
  const targetPath = path.resolve(rootPath, relativePath);
  if (!isWithinRoot(rootPath, targetPath)) {
    throw new Error("Access denied");
  }
  return targetPath;
}

async function resolveExistingWorkspacePath(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const targetPath = resolveTargetPath(rootPath, relativePath);
  const resolved = await fs.realpath(targetPath);
  if (!isWithinRoot(rootPath, resolved)) {
    throw new Error("Access denied");
  }
  return resolved;
}

async function scanWorkspaceDir(
  currentDir: string,
  prefix: string,
  results: ServerFile[],
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const nextPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await scanWorkspaceDir(absolutePath, nextPath, results);
      continue;
    }

    if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      results.push({ name: entry.name, path: nextPath });
    }
  }
}

export async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return readRecents();
}

export async function registerWorkspace(
  workspacePath: string,
  name: string,
): Promise<void> {
  const resolved = await resolveWorkspaceRoot(workspacePath);
  const recents = await readRecents();
  const nextEntry: RecentWorkspace = {
    path: resolved,
    name: name.trim() || path.basename(resolved) || "workspace",
  };

  const deduped = recents.filter((item) => !comparePaths(item.path, resolved));
  deduped.unshift(nextEntry);

  await writeRecents(deduped.slice(0, 20));
}

export async function listWorkspaceFiles(workspacePath: string): Promise<ServerFile[]> {
  const rootPath = await resolveWorkspaceRoot(workspacePath);
  const results: ServerFile[] = [];
  await scanWorkspaceDir(rootPath, "", results);
  return results;
}

export async function readWorkspaceFile(
  workspacePath: string,
  relativePath: string,
): Promise<string> {
  const rootPath = await resolveWorkspaceRoot(workspacePath);
  const filePath = await resolveExistingWorkspacePath(rootPath, relativePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  return fs.readFile(filePath, "utf-8");
}

export async function writeWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRoot(workspacePath);
  const filePath = resolveTargetPath(rootPath, relativePath);
  const parentPath = path.dirname(filePath);
  const resolvedParent = await fs.realpath(parentPath).catch(() => null);

  if (resolvedParent && !isWithinRoot(rootPath, resolvedParent)) {
    throw new Error("Access denied");
  }

  await ensureDirectoryExists(parentPath);
  await fs.writeFile(filePath, content, "utf-8");
}

export async function deleteWorkspaceEntry(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRoot(workspacePath);
  const targetPath = await resolveExistingWorkspacePath(rootPath, relativePath);
  const stat = await fs.stat(targetPath);

  if (stat.isDirectory()) {
    await fs.rm(targetPath, { recursive: true, force: false });
    return;
  }

  await fs.unlink(targetPath);
}

export async function renameWorkspaceEntry(
  workspacePath: string,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRoot(workspacePath);
  const oldPath = await resolveExistingWorkspacePath(rootPath, oldRelativePath);
  const newPath = resolveTargetPath(rootPath, newRelativePath);
  const parentPath = path.dirname(newPath);
  const resolvedParent = await fs.realpath(parentPath).catch(() => null);

  if (!resolvedParent) {
    throw new Error("Target directory does not exist");
  }
  if (!isWithinRoot(rootPath, resolvedParent)) {
    throw new Error("Access denied");
  }

  const existingTarget = await fs
    .access(newPath)
    .then(() => true)
    .catch(() => false);
  if (existingTarget) {
    throw new Error("Target already exists");
  }

  await fs.rename(oldPath, newPath);
}

export async function listDirectories(currentPath?: string): Promise<DirListing> {
  const initialPath = currentPath?.trim() ? currentPath : os.homedir();
  const resolvedPath = await fs.realpath(initialPath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = path.dirname(resolvedPath);
  const parent = comparePaths(parentPath, resolvedPath) ? null : parentPath;

  return {
    current: resolvedPath,
    parent,
    dirs,
  };
}

export function getWorkspaceDisplayName(workspacePath: string): string {
  const cleaned = workspacePath.replace(/[\\/]+$/, "");
  const baseName = path.basename(cleaned);
  return baseName || toWorkspacePath(cleaned);
}
