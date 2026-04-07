import os from "os";
import path from "path";

const KNOWN_FOLDERS: Record<string, string> = {
  documents: path.join(os.homedir(), "Documents"),
  downloads: path.join(os.homedir(), "Downloads"),
  desktop: path.join(os.homedir(), "Desktop"),
  pictures: path.join(os.homedir(), "Pictures"),
  home: os.homedir(),
};

export function resolveWorkspacePath(segments: string[]): string {
  if (segments.length === 0) return os.homedir();

  const [root, ...rest] = segments;
  const base = KNOWN_FOLDERS[root.toLowerCase()] ?? path.join(os.homedir(), root);

  if (rest.length === 0) return base;

  const joined = path.resolve(base, ...rest);
  if (!joined.startsWith(base + path.sep) && joined !== base) {
    throw new Error("Path traversal attempt detected");
  }
  return joined;
}
