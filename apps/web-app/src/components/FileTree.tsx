import { useMemo, useState } from "react";
import type { WorkspaceEntry } from "@note/workspace-core";
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
}

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
 * Renders an accessible hierarchical workspace tree.
 * @param props Entries, selection, query, locale, and interaction callbacks.
 * @returns The file tree.
 */
export function FileTree({ entries, query, selectedPath, locale, onOpenDocument, onSelect }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const visibleEntries = useMemo(() => filterEntries(entries, query), [entries, query]);

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
  const renderEntries = (levelEntries: WorkspaceEntry[], level: number): React.ReactNode => levelEntries.map((entry) => {
    const isDirectory = entry.kind === "directory";
    const isExpanded = query.trim() ? true : expandedPaths.has(entry.path);
    const icon = isDirectory ? (isExpanded ? "▾" : "▸") : entry.kind === "document" ? "·" : "◇";
    return (
      <li key={entry.path} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined} aria-level={level}>
        <button
          type="button"
          className={`${styles.row} ${selectedPath === entry.path ? styles.selected : ""}`}
          style={{ paddingInlineStart: `${0.7 + (level - 1) * 1.05}rem` }}
          onClick={() => {
            if (isDirectory) toggleDirectory(entry.path);
            else {
              onSelect(entry.path);
              if (entry.kind === "document") onOpenDocument(entry.path);
            }
          }}
          title={entry.path}
        >
          <span className={styles.icon} aria-hidden="true">{icon}</span>
          <span className={styles.name}>{entry.name}</span>
          {entry.kind === "image" ? <span className={styles.srOnly}>{translate(locale, "image")}</span> : null}
        </button>
        {isDirectory && isExpanded && entry.children?.length ? (
          <ul className={styles.group} role="group">{renderEntries(entry.children, level + 1)}</ul>
        ) : null}
      </li>
    );
  });

  return <ul className={styles.tree} role="tree" aria-label={translate(locale, "files")}>{renderEntries(visibleEntries, 1)}</ul>;
}
