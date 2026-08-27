import { useEffect, useMemo, useState } from "react";
import { workspaceDirname, type WorkspaceEntry } from "@note/workspace-core";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./FileTree.module.css";

interface FileTreeProps {
  entries: WorkspaceEntry[];
  query: string;
  selectedPath: string | null;
  locale: Locale;
  onOpenDocument: (path: string) => void;
  onSelect: (path: string) => void;
  onMoveEntry: (sourcePath: string, destinationPath: string) => void;
  onCreateDocument: (directoryPath: string) => void;
  onRename: (path: string) => void;
  onTrash: (path: string) => void;
}

interface ContextMenuState {
  entry: WorkspaceEntry | null;
  x: number;
  y: number;
}

const WORKSPACE_ENTRY_DRAG_TYPE = "application/x-notemarkdown-entry";

/**
 * Filters a tree while retaining directories that contain matching descendants.
 * @param entries Hierarchical workspace entries.
 * @param query Case-insensitive file-name query.
 * @returns A filtered tree without mutating provider state.
 */
function filterEntries(entries: WorkspaceEntry[], query: string): WorkspaceEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;
  return entries.flatMap((entry) => {
    const children = entry.children ? filterEntries(entry.children, normalizedQuery) : undefined;
    if (entry.name.toLocaleLowerCase().includes(normalizedQuery) || children?.length) {
      return [{ ...entry, children }];
    }
    return [];
  });
}

/**
 * Groups directories before files while retaining their existing order within each group.
 * @param entries Entries at one tree level.
 * @returns A new directory-first entry list.
 */
function groupDirectoriesFirst(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [
    ...entries.filter((entry) => entry.kind === "directory"),
    ...entries.filter((entry) => entry.kind !== "directory"),
  ];
}

/**
 * Renders an accessible hierarchical workspace tree.
 * @param props Entries, selection, query, locale, and interaction callbacks.
 * @returns The file tree.
 */
export function FileTree({ entries, query, selectedPath, locale, onOpenDocument, onSelect, onMoveEntry, onCreateDocument, onRename, onTrash }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const visibleEntries = useMemo(() => filterEntries(entries, query), [entries, query]);

  useEffect(() => {
    if (!contextMenu) return;
    /** Closes the menu after an interaction outside it. @returns Nothing after state is cleared. */
    const closeMenu = (): void => setContextMenu(null);
    /** Closes the menu from the standard keyboard dismissal key. @param event Browser key event. @returns Nothing. */
    const closeMenuWithKeyboard = (event: KeyboardEvent): void => { if (event.key === "Escape") closeMenu(); };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [contextMenu]);

  /**
   * Opens an entry-specific context menu within the visible viewport.
   * @param event Pointer context-menu event.
   * @param entry Entry receiving the menu.
   * @returns Nothing after selection and menu placement.
   */
  const openContextMenu = (event: React.MouseEvent, entry: WorkspaceEntry): void => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(entry.path);
    setContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 144)),
    });
  };

  /**
   * Opens the workspace-root context menu.
   * @param event Pointer context-menu event.
   * @returns Nothing after menu placement.
   */
  const openRootContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    setContextMenu({
      entry: null,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 144)),
    });
  };

  /**
   * Starts dragging one Markdown document.
   * @param event Browser drag event.
   * @param path Source document path.
   * @returns Nothing after transfer metadata is installed.
   */
  const startEntryDrag = (event: React.DragEvent, path: string): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_TYPE, path);
    event.dataTransfer.setData("text/plain", path);
  };

  /**
   * Allows a dragged workspace document to be dropped on a directory.
   * @param event Browser drag event.
   * @param path Candidate directory path.
   * @returns Nothing after drop feedback is updated.
   */
  const allowDirectoryDrop = (event: React.DragEvent, path: string): void => {
    if (!Array.from(event.dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetPath(path);
  };

  /**
   * Moves a dragged document into the target directory.
   * @param event Browser drop event.
   * @param directoryPath Destination directory path.
   * @returns Nothing after the move callback is invoked.
   */
  const dropEntry = (event: React.DragEvent, directoryPath: string): void => {
    event.preventDefault();
    event.stopPropagation();
    const sourcePath = event.dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE);
    setDropTargetPath(null);
    if (!sourcePath) return;
    const fileName = sourcePath.split("/").at(-1) ?? sourcePath;
    const destinationPath = `${directoryPath}/${fileName}`;
    if (destinationPath !== sourcePath) {
      setExpandedPaths((current) => new Set(current).add(directoryPath));
      onMoveEntry(sourcePath, destinationPath);
    }
  };

  /**
   * Toggles one directory's expanded state.
   * @param path Directory path.
   * @returns Nothing after state changes.
   */
  const toggleDirectory = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    onSelect(path);
  };

  /**
   * Recursively renders one tree level.
   * @param levelEntries Entries at the current hierarchy level.
   * @param level One-based accessibility nesting level.
   * @returns Tree rows and child groups.
   */
  const renderEntries = (levelEntries: WorkspaceEntry[], level: number): React.ReactNode => groupDirectoriesFirst(levelEntries).map((entry) => {
    const isDirectory = entry.kind === "directory";
    const isExpanded = query.trim() ? true : expandedPaths.has(entry.path);
    const icon = entry.kind === "document" ? "·" : "◇";
    return (
      <li key={entry.path} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined} aria-level={level}>
        <button
          type="button"
          className={`${styles.row} ${selectedPath === entry.path ? styles.selected : ""} ${dropTargetPath === entry.path ? styles.dropTarget : ""}`}
          style={{ paddingInlineStart: `${0.7 + (level - 1) * 1.05}rem` }}
          draggable={entry.kind === "document"}
          onDragStart={(event) => startEntryDrag(event, entry.path)}
          onDragEnd={() => setDropTargetPath(null)}
          onDragOver={isDirectory ? (event) => allowDirectoryDrop(event, entry.path) : undefined}
          onDragLeave={isDirectory ? () => setDropTargetPath((current) => current === entry.path ? null : current) : undefined}
          onDrop={isDirectory ? (event) => dropEntry(event, entry.path) : undefined}
          onContextMenu={(event) => openContextMenu(event, entry)}
          onClick={() => {
            if (isDirectory) toggleDirectory(entry.path);
            else {
              onSelect(entry.path);
              if (entry.kind === "document") onOpenDocument(entry.path);
            }
          }}
          title={entry.path}
        >
          {isDirectory ? (
            <>
              <span className={styles.disclosure} aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
              <svg className={styles.folderIcon} aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3 6.25A2.25 2.25 0 0 1 5.25 4h4.13c.6 0 1.17.24 1.59.66l1.34 1.34h6.44A2.25 2.25 0 0 1 21 8.25v8.5A2.25 2.25 0 0 1 18.75 19H5.25A2.25 2.25 0 0 1 3 16.75V6.25Z" />
              </svg>
            </>
          ) : (
            <>
              <span className={styles.disclosure} aria-hidden="true" />
              <span className={styles.icon} aria-hidden="true">{icon}</span>
            </>
          )}
          <span className={styles.name}>{entry.name}</span>
          {entry.kind === "image" ? <span className={styles.srOnly}>{translate(locale, "image")}</span> : null}
        </button>
        {isDirectory && isExpanded && entry.children?.length ? (
          <ul className={styles.group} role="group">{renderEntries(entry.children, level + 1)}</ul>
        ) : null}
      </li>
    );
  });

  return (
    <>
      <ul className={styles.tree} role="tree" aria-label={translate(locale, "files")} onContextMenu={openRootContextMenu}>{renderEntries(visibleEntries, 1)}</ul>
      {contextMenu ? (
        <div
          className={styles.contextMenu}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => {
            const directoryPath = contextMenu.entry?.kind === "directory" ? contextMenu.entry.path : contextMenu.entry ? workspaceDirname(contextMenu.entry.path) : "";
            setContextMenu(null);
            onCreateDocument(directoryPath);
          }}>
            {translate(locale, "newNote")}
          </button>
          {contextMenu.entry ? (
            <>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onRename(contextMenu.entry!.path); }}>
                {translate(locale, "rename")}
              </button>
              <button type="button" role="menuitem" className={styles.dangerAction} onClick={() => { setContextMenu(null); onTrash(contextMenu.entry!.path); }}>
                {translate(locale, "deleteEntry")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
