const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:\\/;

export const toDirectory = (path: string | null) => {
  if (!path) return null;

  const normalized = path.replace(/[\\/]+/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : null;
};

export const joinPath = (directory: string | null, fileName: string) => {
  if (!directory) return fileName;

  const separator = WINDOWS_PATH_PATTERN.test(directory) ? "\\" : "/";
  const trimmed = directory.replace(/[\\/]+$/, "");
  return `${trimmed}${separator}${fileName}`;
};

export const ensureMarkdownFileName = (name: string) =>
  name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
