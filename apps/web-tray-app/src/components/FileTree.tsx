"use client";

import { useEffect, useRef, useState } from "react";

export type WorkspaceFile = {
  name: string;
  path: string;
};

type FileTreeProps = {
  files: WorkspaceFile[];
  activeFilePath: string | null;
  openPaths: string[];
  dirtyPaths: string[];
  storageKey: string;
  onFileClick: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
};

type FolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
};

type FileNode = {
  kind: "file";
  name: string;
  path: string;
};

type TreeNode = FolderNode | FileNode;

type DisplayItem =
  | { kind: "folder"; name: string; path: string; depth: number }
  | { kind: "file"; name: string; path: string; depth: number };

type ContextMenuState = {
  x: number;
  y: number;
  item: DisplayItem;
};

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={svgIconStyle}>
      <path
        d="M1.5 4.5h4l1.2 1.5h7.8v6.2c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3z"
        fill="none"
        stroke="#d0a54f"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={svgIconStyle}>
      <path
        d="M4 1.8h5l3 3v8.4c0 .6-.5 1.1-1.1 1.1H4c-.6 0-1.1-.5-1.1-1.1V2.9c0-.6.5-1.1 1.1-1.1z"
        fill="none"
        stroke="#979797"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M9 1.8v3h3" fill="none" stroke="#979797" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

function buildTree(files: WorkspaceFile[]): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const folderPath = parts.slice(0, index + 1).join("/");
      let folder = current.children.find(
        (node): node is FolderNode => node.kind === "folder" && node.path === folderPath,
      );

      if (!folder) {
        folder = { kind: "folder", name: parts[index], path: folderPath, children: [] };
        current.children.push(folder);
      }

      current = folder;
    }

    current.children.push({ kind: "file", name: file.name, path: file.path });
  }

  return root.children;
}

function flattenTree(
  nodes: TreeNode[],
  collapsedFolders: Set<string>,
  depth = 0,
): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const node of nodes) {
    if (node.kind === "folder") {
      items.push({ kind: "folder", name: node.name, path: node.path, depth });
      if (!collapsedFolders.has(node.path)) {
        items.push(...flattenTree(node.children, collapsedFolders, depth + 1));
      }
      continue;
    }

    items.push({ kind: "file", name: node.name, path: node.path, depth });
  }

  return items;
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.(md|markdown)$/i, "");
}

export function FileTree({
  files,
  activeFilePath,
  openPaths,
  dirtyPaths,
  storageKey,
  onFileClick,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as string[];
      setCollapsedFolders(new Set(parsed));
    } catch {
      setCollapsedFolders(new Set());
    }
  }, [storageKey]);

  useEffect(() => {
    if (!renamingPath) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingPath]);

  useEffect(() => {
    function handleWindowClick() {
      setContextMenu(null);
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    }

    window.addEventListener("click", handleWindowClick);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("click", handleWindowClick);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  const displayItems = flattenTree(buildTree(files), collapsedFolders);
  const dirtySet = new Set(dirtyPaths);
  const openSet = new Set(openPaths);

  function updateCollapsed(next: Set<string>) {
    setCollapsedFolders(next);
    localStorage.setItem(storageKey, JSON.stringify([...next]));
  }

  function toggleFolder(path: string) {
    const next = new Set(collapsedFolders);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    updateCollapsed(next);
  }

  function beginRename(item: DisplayItem) {
    setContextMenu(null);
    setRenamingPath(item.path);
    setRenameValue(item.kind === "file" ? stripMarkdownExtension(item.name) : item.name);
  }

  function submitRename(item: DisplayItem) {
    const trimmed = renameValue.trim();
    setRenamingPath(null);

    if (!trimmed) return;

    if (item.kind === "file") {
      const lastSlash = item.path.lastIndexOf("/");
      const parent = lastSlash >= 0 ? item.path.slice(0, lastSlash + 1) : "";
      const extensionMatch = item.name.match(/\.(md|markdown)$/i);
      const extension = extensionMatch?.[0] ?? "";
      const finalName = /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}${extension}`;
      const newPath = `${parent}${finalName}`;
      if (newPath !== item.path) onRename(item.path, newPath);
      return;
    }

    const lastSlash = item.path.lastIndexOf("/");
    const parent = lastSlash >= 0 ? item.path.slice(0, lastSlash + 1) : "";
    const newPath = `${parent}${trimmed}`;
    if (newPath !== item.path) onRename(item.path, newPath);
  }

  return (
    <div style={treeStyle}>
      {displayItems.map((item) => {
        const isFolder = item.kind === "folder";
        const isRenaming = renamingPath === item.path;
        const isCollapsed = collapsedFolders.has(item.path);

        return (
          <button
            key={item.path}
            type="button"
            title={item.path}
            style={{
              ...rowStyle,
              ...(isFolder ? folderRowStyle : fileRowStyle),
              ...(item.path === activeFilePath ? activeFileRowStyle : null),
              paddingLeft: `${item.depth * 14 + (isFolder ? 10 : 26)}px`,
            }}
            onClick={() => {
              if (isRenaming) return;
              if (isFolder) {
                toggleFolder(item.path);
              } else {
                onFileClick(item.path);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY, item });
            }}
          >
            {isFolder ? (
              <>
                <span style={chevronStyle}>{isCollapsed ? ">" : "v"}</span>
                <span style={iconStyle}>
                  <FolderIcon />
                </span>
              </>
            ) : (
              <span style={iconStyle}>
                <FileIcon />
              </span>
            )}

            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => submitRename(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitRename(item);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingPath(null);
                  }
                }}
                style={renameInputStyle}
              />
            ) : (
              <>
                <span style={nameStyle}>{item.name}</span>
                {!isFolder && dirtySet.has(item.path) && <span style={dirtyStyle}>*</span>}
                {!isFolder && !dirtySet.has(item.path) && openSet.has(item.path) && (
                  <span style={openStyle} />
                )}
              </>
            )}
          </button>
        );
      })}

      {displayItems.length === 0 && <p style={emptyStyle}>No markdown files found.</p>}

      {contextMenu && (
        <div
          style={{
            ...contextMenuStyle,
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            style={contextButtonStyle}
            onClick={() => beginRename(contextMenu.item)}
          >
            Rename
          </button>
          <button
            type="button"
            style={{ ...contextButtonStyle, ...dangerButtonStyle }}
            onClick={() => {
              setContextMenu(null);
              onDelete(contextMenu.item.path, contextMenu.item.kind);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

const treeStyle = {
  height: "100%",
  overflowY: "auto",
  padding: "8px 0 10px",
  background: "var(--panel-bg)",
} as const;

const rowStyle = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: "6px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  paddingTop: "5px",
  paddingRight: "10px",
  paddingBottom: "5px",
  textAlign: "left",
  color: "var(--text-main)",
} as const;

const folderRowStyle = {
  color: "var(--text-main)",
  fontWeight: 600,
} as const;

const fileRowStyle = {
  color: "var(--text-muted)",
} as const;

const activeFileRowStyle = {
  background: "var(--accent-active)",
  color: "#fff",
} as const;

const chevronStyle = {
  width: 10,
  color: "var(--text-dim)",
  fontSize: "0.72rem",
} as const;

const iconStyle = {
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
} as const;

const svgIconStyle = {
  width: 16,
  height: 16,
  display: "block",
} as const;

const nameStyle = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "0.82rem",
} as const;

const renameInputStyle = {
  flex: 1,
  minWidth: 0,
  border: "1px solid #6b7280",
  borderRadius: "4px",
  background: "#1f1f1f",
  color: "#fff",
  padding: "3px 6px",
  fontSize: "0.82rem",
  outline: "none",
} as const;

const dirtyStyle = {
  color: "var(--accent-warm)",
  fontSize: "0.95rem",
} as const;

const openStyle = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#9d9d9d",
  flexShrink: 0,
} as const;

const emptyStyle = {
  margin: 0,
  padding: "10px 12px",
  color: "var(--text-dim)",
  fontSize: "0.84rem",
} as const;

const contextMenuStyle = {
  position: "fixed",
  zIndex: 1200,
  display: "flex",
  flexDirection: "column",
  minWidth: 140,
  padding: 6,
  borderRadius: 8,
  border: "1px solid var(--panel-border-strong)",
  background: "#2b2b2b",
  boxShadow: "0 16px 40px rgba(0, 0, 0, 0.35)",
} as const;

const contextButtonStyle = {
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-main)",
  cursor: "pointer",
  padding: "8px 10px",
  textAlign: "left",
} as const;

const dangerButtonStyle = {
  color: "#fda4af",
} as const;
