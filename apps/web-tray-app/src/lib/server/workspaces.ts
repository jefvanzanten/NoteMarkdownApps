import fs from "fs/promises";
import os from "os";
import path from "path";

export type WorkspaceRecord = {
  slug: string;
  name: string;
  path: string;
  lastOpenedAt: string;
};

export type ServerFile = {
  path: string;
  name: string;
};

type LegacyWorkspaceRecord = {
  path: string;
  name: string;
};

const STORAGE_DIR = path.join(os.homedir(), ".note-markdown");
const WORKSPACES_PATH = path.join(STORAGE_DIR, "workspaces.json");
const LEGACY_RECENTS_PATH = path.join(STORAGE_DIR, "recents.json");

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

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WorkspaceRecord).slug === "string" &&
    typeof (value as WorkspaceRecord).name === "string" &&
    typeof (value as WorkspaceRecord).path === "string" &&
    typeof (value as WorkspaceRecord).lastOpenedAt === "string"
  );
}

function isLegacyWorkspaceRecord(value: unknown): value is LegacyWorkspaceRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LegacyWorkspaceRecord).path === "string" &&
    typeof (value as LegacyWorkspaceRecord).name === "string"
  );
}

function defaultWorkspaceNameFromPath(workspacePath: string): string {
  const cleaned = workspacePath.replace(/[\\/]+$/, "");
  return path.basename(cleaned) || "workspace";
}

function slugifyWorkspaceName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

function uniqueWorkspaceSlug(
  baseSlug: string,
  records: WorkspaceRecord[],
  currentRecord?: WorkspaceRecord,
): string {
  let candidate = baseSlug;
  let counter = 2;

  while (
    records.some(
      (record) =>
        record.slug === candidate &&
        (!currentRecord || !comparePaths(record.path, currentRecord.path)),
    )
  ) {
    candidate = `${baseSlug}-${counter}`;
    counter += 1;
  }

  return candidate;
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

async function readLegacyRecents(): Promise<LegacyWorkspaceRecord[]> {
  try {
    const raw = await fs.readFile(LEGACY_RECENTS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLegacyWorkspaceRecord);
  } catch {
    return [];
  }
}

async function writeWorkspaces(records: WorkspaceRecord[]): Promise<void> {
  await ensureDirectoryExists(STORAGE_DIR);
  await fs.writeFile(WORKSPACES_PATH, JSON.stringify(records, null, 2), "utf-8");
}

async function migrateLegacyRecents(): Promise<WorkspaceRecord[]> {
  const legacyRecords = await readLegacyRecents();
  if (legacyRecords.length === 0) return [];

  const migrated: WorkspaceRecord[] = [];

  for (let index = 0; index < legacyRecords.length; index += 1) {
    const legacy = legacyRecords[index];
    const baseSlug = slugifyWorkspaceName(legacy.name || defaultWorkspaceNameFromPath(legacy.path));
    const slug = uniqueWorkspaceSlug(baseSlug, migrated);

    migrated.push({
      slug,
      name: legacy.name || defaultWorkspaceNameFromPath(legacy.path),
      path: legacy.path,
      lastOpenedAt: new Date(Date.now() - index * 1000).toISOString(),
    });
  }

  await writeWorkspaces(migrated);
  return migrated;
}

async function readWorkspaces(): Promise<WorkspaceRecord[]> {
  try {
    const raw = await fs.readFile(WORKSPACES_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return migrateLegacyRecents();
    return parsed.filter(isWorkspaceRecord).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  } catch {
    return migrateLegacyRecents();
  }
}

async function resolveWorkspaceRootBySlug(workspaceSlug: string): Promise<string> {
  const workspace = await getWorkspaceBySlug(workspaceSlug);
  return resolveWorkspaceRoot(workspace.path);
}

export function getDefaultWorkspaceName(workspacePath: string): string {
  return defaultWorkspaceNameFromPath(workspacePath);
}

export async function listRecentWorkspaces(): Promise<WorkspaceRecord[]> {
  return readWorkspaces();
}

export async function getWorkspaceBySlug(workspaceSlug: string): Promise<WorkspaceRecord> {
  const slug = workspaceSlug.trim().toLowerCase();
  const workspaces = await readWorkspaces();
  const workspace = workspaces.find((entry) => entry.slug === slug);

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  return workspace;
}

export async function findWorkspaceByPath(workspacePath: string): Promise<WorkspaceRecord | null> {
  const resolvedPath = await resolveWorkspaceRoot(workspacePath);
  const workspaces = await readWorkspaces();
  return workspaces.find((entry) => comparePaths(entry.path, resolvedPath)) ?? null;
}

export async function registerWorkspace(
  workspacePath: string,
  name: string,
): Promise<WorkspaceRecord> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Workspace name is required");
  }

  const resolvedPath = await resolveWorkspaceRoot(workspacePath);
  const workspaces = await readWorkspaces();
  const current = workspaces.find((entry) => comparePaths(entry.path, resolvedPath));
  const slug = uniqueWorkspaceSlug(slugifyWorkspaceName(trimmedName), workspaces, current);
  const nextWorkspace: WorkspaceRecord = {
    slug,
    name: trimmedName,
    path: resolvedPath,
    lastOpenedAt: new Date().toISOString(),
  };

  const remaining = workspaces.filter((entry) => !comparePaths(entry.path, resolvedPath));
  remaining.unshift(nextWorkspace);

  await writeWorkspaces(remaining.slice(0, 50));
  return nextWorkspace;
}

export async function listWorkspaceFiles(workspaceSlug: string): Promise<ServerFile[]> {
  const rootPath = await resolveWorkspaceRootBySlug(workspaceSlug);
  const results: ServerFile[] = [];
  await scanWorkspaceDir(rootPath, "", results);
  return results;
}

export async function readWorkspaceFile(
  workspaceSlug: string,
  relativePath: string,
): Promise<string> {
  const rootPath = await resolveWorkspaceRootBySlug(workspaceSlug);
  const filePath = await resolveExistingWorkspacePath(rootPath, relativePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  return fs.readFile(filePath, "utf-8");
}

export async function writeWorkspaceFile(
  workspaceSlug: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRootBySlug(workspaceSlug);
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
  workspaceSlug: string,
  relativePath: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRootBySlug(workspaceSlug);
  const targetPath = await resolveExistingWorkspacePath(rootPath, relativePath);
  const stat = await fs.stat(targetPath);

  if (stat.isDirectory()) {
    await fs.rm(targetPath, { recursive: true, force: false });
    return;
  }

  await fs.unlink(targetPath);
}

export async function renameWorkspaceEntry(
  workspaceSlug: string,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<void> {
  const rootPath = await resolveWorkspaceRootBySlug(workspaceSlug);
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
