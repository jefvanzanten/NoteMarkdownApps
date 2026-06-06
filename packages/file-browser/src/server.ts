import fs from "fs/promises";
import os from "os";
import path from "path";
import type { DirectoryBrowserEntry, DirectoryBreadcrumb, DirectoryListing } from "./types";

function comparePaths(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function normalizePathLabel(targetPath: string): string {
  if (process.platform === "win32") {
    const parsed = path.parse(targetPath);
    if (comparePaths(parsed.root, targetPath)) {
      return parsed.root.replace(/[\\/]+$/, "");
    }
  }

  const cleaned = targetPath.replace(/[\\/]+$/, "");
  return path.basename(cleaned) || cleaned || targetPath;
}

function buildBreadcrumbs(targetPath: string): DirectoryBreadcrumb[] {
  if (process.platform === "win32") {
    const parsed = path.parse(targetPath);
    const root = parsed.root;
    const remainder = targetPath.slice(root.length).split(path.sep).filter(Boolean);
    const crumbs: DirectoryBreadcrumb[] = [{ label: root.replace(/[\\/]+$/, ""), path: root }];
    let current = root;

    for (const segment of remainder) {
      current = path.join(current, segment);
      crumbs.push({ label: segment, path: current });
    }

    return crumbs;
  }

  const parts = targetPath.split(path.sep).filter(Boolean);
  const crumbs: DirectoryBreadcrumb[] = [{ label: path.sep, path: path.sep }];
  let current: string = path.sep;

  for (const segment of parts) {
    current = path.join(current, segment);
    crumbs.push({ label: segment, path: current });
  }

  return crumbs;
}

async function listWindowsDrives(): Promise<DirectoryBrowserEntry[]> {
  const entries: DirectoryBrowserEntry[] = [];

  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      const stat = await fs.stat(drive);
      if (stat.isDirectory()) {
        entries.push({
          kind: "drive",
          label: drive.replace(/[\\/]+$/, ""),
          path: drive,
        });
      }
    } catch {
      // Ignore unavailable drives.
    }
  }

  return entries;
}

async function listQuickLocations(): Promise<DirectoryBrowserEntry[]> {
  const home = os.homedir();
  const locations: DirectoryBrowserEntry[] = [
    {
      kind: "special",
      label: "Home",
      path: home,
    },
  ];

  if (process.platform === "win32") {
    const drives = await listWindowsDrives();
    return locations.concat(drives.filter((entry) => !comparePaths(entry.path, home)));
  }

  locations.unshift({
    kind: "drive",
    label: path.sep,
    path: path.sep,
  });
  return locations;
}

export async function listDirectoryBrowser(currentPath?: string): Promise<DirectoryListing> {
  const initialPath = currentPath?.trim() ? currentPath : os.homedir();
  const resolvedPath = await fs.realpath(initialPath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      kind: "directory" as const,
      label: entry.name,
      path: path.join(resolvedPath, entry.name),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const parentPath = path.dirname(resolvedPath);
  const parent = comparePaths(parentPath, resolvedPath) ? null : parentPath;
  const locations = await listQuickLocations();

  if (!locations.some((entry) => comparePaths(entry.path, resolvedPath))) {
    locations.unshift({
      kind: "special",
      label: normalizePathLabel(resolvedPath),
      path: resolvedPath,
    });
  }

  return {
    current: resolvedPath,
    parent,
    breadcrumbs: buildBreadcrumbs(resolvedPath),
    locations,
    directories,
  };
}
