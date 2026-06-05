"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { MarkdownEditor } from "@note/editor";
import type { TabDto } from "@note/types";
import { FileTree, type WorkspaceFile } from "@/components/FileTree";

type WorkspaceEditorProps = {
  workspacePath: string;
};

type TabState = {
  tabs: TabDto[];
  activeTabId: string | null;
};

type TabAction =
  | { type: "UPSERT_TAB"; tab: TabDto }
  | { type: "SET_ACTIVE"; tabId: string | null }
  | { type: "REMOVE_TAB"; tabId: string }
  | { type: "UPDATE_CONTENT"; tabId: string; content: string; cursor: number }
  | { type: "SET_TABS"; tabs: TabDto[] };

function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "UPSERT_TAB": {
      const exists = state.tabs.some((tab) => tab.tab_id === action.tab.tab_id);
      const tabs = exists
        ? state.tabs.map((tab) => (tab.tab_id === action.tab.tab_id ? action.tab : tab))
        : [...state.tabs, action.tab];
      return { tabs, activeTabId: action.tab.tab_id };
    }
    case "SET_ACTIVE":
      return { ...state, activeTabId: action.tabId };
    case "REMOVE_TAB": {
      const tabs = state.tabs.filter((tab) => tab.tab_id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs.at(-1)?.tab_id ?? null
          : state.activeTabId;
      return { tabs, activeTabId };
    }
    case "UPDATE_CONTENT":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.tab_id === action.tabId
            ? { ...tab, content: action.content, cursor: action.cursor, is_dirty: true }
            : tab,
        ),
      };
    case "SET_TABS":
      return {
        tabs: action.tabs,
        activeTabId:
          action.tabs.some((tab) => tab.tab_id === state.activeTabId)
            ? state.activeTabId
            : action.tabs.at(-1)?.tab_id ?? null,
      };
    default:
      return state;
  }
}

async function listServerFiles(workspacePath: string): Promise<WorkspaceFile[]> {
  const response = await fetch(`/api/files?workspace=${encodeURIComponent(workspacePath)}`);
  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? "Failed to list files");
  }
  return response.json() as Promise<WorkspaceFile[]>;
}

async function readServerFile(workspacePath: string, filePath: string): Promise<string> {
  const response = await fetch(
    `/api/file?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}`,
  );
  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? `Failed to read ${filePath}`);
  }
  return response.text();
}

async function writeServerFile(
  workspacePath: string,
  filePath: string,
  content: string,
): Promise<void> {
  const response = await fetch(
    `/api/file?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}`,
    {
      method: "PUT",
      body: content,
    },
  );

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? `Failed to write ${filePath}`);
  }
}

async function deleteServerFile(workspacePath: string, filePath: string): Promise<void> {
  const response = await fetch(
    `/api/file?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? `Failed to delete ${filePath}`);
  }
}

async function renameServerFile(
  workspacePath: string,
  filePath: string,
  newPath: string,
): Promise<void> {
  const response = await fetch(
    `/api/file?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}&newPath=${encodeURIComponent(newPath)}`,
    { method: "PATCH" },
  );

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? `Failed to rename ${filePath}`);
  }
}

function getWorkspaceName(workspacePath: string): string {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? workspacePath;
}

function getFileTitle(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function getUntitledName(tabs: TabDto[]): string {
  const untitledCount = tabs.filter((tab) => tab.linked_path === null).length;
  return untitledCount === 0 ? "untitled" : `untitled (${untitledCount + 1})`;
}

export function WorkspaceEditor({ workspacePath }: WorkspaceEditorProps) {
  const [tabState, dispatch] = useReducer(tabReducer, { tabs: [], activeTabId: null });
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceName, setWorkspaceName] = useState(getWorkspaceName(workspacePath));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const dragStateRef = useRef<{ dragging: boolean }>({ dragging: false });

  const activeTab = tabState.tabs.find((tab) => tab.tab_id === tabState.activeTabId) ?? null;
  const activeFilePath = activeTab?.linked_path ?? null;

  useEffect(() => {
    setWorkspaceName(getWorkspaceName(workspacePath));
    setWorkspaceFiles([]);
    dispatch({ type: "SET_TABS", tabs: [] });
    void refreshWorkspace(true);
  }, [workspacePath]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.key === "s") {
        event.preventDefault();
        void saveActive();
      }

      if (ctrl && event.key === "w") {
        event.preventDefault();
        if (tabState.activeTabId) closeTab(tabState.activeTabId);
      }
    }

    function onMouseMove(event: MouseEvent) {
      if (!dragStateRef.current.dragging) return;

      const nextWidth = event.clientX;
      if (nextWidth < 60) {
        setSidebarCollapsed(true);
        return;
      }

      setSidebarCollapsed(false);
      setSidebarWidth(Math.max(140, Math.min(600, nextWidth)));
    }

    function onMouseUp() {
      dragStateRef.current.dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [tabState.activeTabId, activeTab, tabState.tabs, workspacePath]);

  useEffect(() => {
    if (!activeFilePath) return;
    localStorage.setItem("last-open-path", activeFilePath);
  }, [activeFilePath]);

  async function refreshWorkspace(restoreLastOpen: boolean) {
    setLoading(true);
    setErrorMessage("");

    try {
      const files = await listServerFiles(workspacePath);
      setWorkspaceFiles(files);

      if (restoreLastOpen) {
        const lastPath = localStorage.getItem("last-open-path");
        if (lastPath && files.some((file) => file.path === lastPath)) {
          await openFile(lastPath, files);
        }
      }
    } catch (loadError) {
      setErrorMessage(loadError instanceof Error ? loadError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function openFile(filePath: string, files = workspaceFiles) {
    const existing = tabState.tabs.find((tab) => tab.linked_path === filePath);
    if (existing) {
      dispatch({ type: "SET_ACTIVE", tabId: existing.tab_id });
      return;
    }

    const fileEntry = files.find((file) => file.path === filePath);
    if (!fileEntry) return;

    try {
      const content = (await readServerFile(workspacePath, filePath)).replace(/\r\n/g, "\n");
      dispatch({
        type: "UPSERT_TAB",
        tab: {
          tab_id: crypto.randomUUID(),
          title: fileEntry.name,
          is_temp: false,
          is_dirty: false,
          linked_path: filePath,
          content,
          cursor: 0,
        },
      });
    } catch (openError) {
      setErrorMessage(openError instanceof Error ? openError.message : `Failed to open ${filePath}`);
    }
  }

  function createNewTab() {
    dispatch({
      type: "UPSERT_TAB",
      tab: {
        tab_id: crypto.randomUUID(),
        title: getUntitledName(tabState.tabs),
        is_temp: true,
        is_dirty: false,
        linked_path: null,
        content: "",
        cursor: 0,
      },
    });
  }

  function closeTab(tabId: string) {
    dispatch({ type: "REMOVE_TAB", tabId });
  }

  async function saveActive() {
    if (!activeTab) return;

    if (!activeTab.linked_path) {
      const suggested = /\.md$/i.test(activeTab.title) ? activeTab.title : `${activeTab.title}.md`;
      const filename = window.prompt("Save as:", suggested);
      if (!filename) return;

      const finalPath = /\.(md|markdown)$/i.test(filename) ? filename : `${filename}.md`;

      try {
        await writeServerFile(workspacePath, finalPath, activeTab.content);
        const files = await listServerFiles(workspacePath);
        setWorkspaceFiles(files);
        dispatch({
          type: "UPSERT_TAB",
          tab: {
            ...activeTab,
            linked_path: finalPath,
            title: getFileTitle(finalPath),
            is_temp: false,
            is_dirty: false,
          },
        });
      } catch (saveError) {
        setErrorMessage(saveError instanceof Error ? saveError.message : "Failed to save file");
      }

      return;
    }

    try {
      await writeServerFile(workspacePath, activeTab.linked_path, activeTab.content);
      dispatch({ type: "UPSERT_TAB", tab: { ...activeTab, is_dirty: false } });
    } catch (saveError) {
      setErrorMessage(saveError instanceof Error ? saveError.message : "Failed to save file");
    }
  }

  async function handleRename(oldPath: string, newPath: string) {
    try {
      await renameServerFile(workspacePath, oldPath, newPath);
      const files = await listServerFiles(workspacePath);
      setWorkspaceFiles(files);
      dispatch({
        type: "SET_TABS",
        tabs: tabState.tabs.map((tab) => {
          if (tab.linked_path === oldPath) {
            return {
              ...tab,
              linked_path: newPath,
              title: getFileTitle(newPath),
            };
          }

          if (tab.linked_path?.startsWith(`${oldPath}/`)) {
            const updatedPath = `${newPath}${tab.linked_path.slice(oldPath.length)}`;
            return {
              ...tab,
              linked_path: updatedPath,
              title: getFileTitle(updatedPath),
            };
          }

          return tab;
        }),
      });
    } catch (renameError) {
      setErrorMessage(renameError instanceof Error ? renameError.message : "Failed to rename");
    }
  }

  async function handleDelete(path: string, kind: "file" | "folder") {
    const label = kind === "folder" ? `folder "${path}" and all its contents` : `"${path}"`;
    if (!window.confirm(`Delete ${label}?`)) return;

    try {
      await deleteServerFile(workspacePath, path);
      const files = await listServerFiles(workspacePath);
      setWorkspaceFiles(files);
      dispatch({
        type: "SET_TABS",
        tabs: tabState.tabs.filter((tab) => {
          if (!tab.linked_path) return true;
          if (tab.linked_path === path) return false;
          if (kind === "folder" && tab.linked_path.startsWith(`${path}/`)) return false;
          return true;
        }),
      });
    } catch (deleteError) {
      setErrorMessage(deleteError instanceof Error ? deleteError.message : "Failed to delete");
    }
  }

  return (
    <div
      style={{
        ...shellStyle,
        gridTemplateColumns: `${sidebarCollapsed ? 0 : sidebarWidth}px 4px 1fr`,
      }}
    >
      {loading ? (
        <div style={splashStyle}>Loading workspace...</div>
      ) : (
        <>
          <div style={headerFilesStyle}>
            <span style={workspaceNameStyle} title={workspaceName}>
              {workspaceName}
            </span>
          </div>

          <div style={headerTabsStyle}>
            <button
              type="button"
              style={toggleButtonStyle}
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? ">" : "<"}
            </button>
            <div style={tabBarStyle}>
              {tabState.tabs.map((tab) => (
                <div
                  key={tab.tab_id}
                  style={{
                    ...tabStyle,
                    ...(tab.tab_id === tabState.activeTabId ? activeTabStyle : null),
                  }}
                >
                  <button
                    type="button"
                    style={tabSelectButtonStyle}
                    onClick={() => dispatch({ type: "SET_ACTIVE", tabId: tab.tab_id })}
                  >
                    {tab.is_dirty ? `${tab.title} *` : tab.title}
                  </button>
                  <button
                    type="button"
                    style={tabCloseButtonStyle}
                    onClick={() => closeTab(tab.tab_id)}
                    title="Close tab"
                  >
                    x
                  </button>
                </div>
              ))}
              <button type="button" style={newTabButtonStyle} onClick={createNewTab} title="New tab">
                +
              </button>
            </div>
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            style={dragHandleStyle}
            onMouseDown={(event) => {
              dragStateRef.current.dragging = true;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              event.preventDefault();
            }}
          />

          <aside style={sidebarStyle}>
            <div style={sidebarBodyStyle}>
              <FileTree
                files={workspaceFiles}
                activeFilePath={activeFilePath}
                openPaths={tabState.tabs
                  .map((tab) => tab.linked_path)
                  .filter((path): path is string => Boolean(path))}
                dirtyPaths={tabState.tabs
                  .filter((tab) => tab.is_dirty && tab.linked_path)
                  .map((tab) => tab.linked_path as string)}
                storageKey={`collapsed-${workspaceName}`}
                onFileClick={(path) => void openFile(path)}
                onRename={(oldPath, newPath) => void handleRename(oldPath, newPath)}
                onDelete={(path, kind) => void handleDelete(path, kind)}
              />
            </div>

            <div style={workspaceFooterStyle}>
              <div style={workspaceFooterMetaStyle}>
                <span style={workspaceFooterLabelStyle}>Workspace</span>
                <span style={workspaceFooterNameStyle} title={workspacePath}>
                  {workspacePath}
                </span>
              </div>
            </div>
          </aside>

          <main style={editorPaneStyle}>
            {errorMessage && (
              <div style={errorBannerStyle}>
                <span>{errorMessage}</span>
                <button type="button" style={dismissButtonStyle} onClick={() => setErrorMessage("")}>
                  x
                </button>
              </div>
            )}

            {activeTab ? (
              <MarkdownEditor
                key={activeTab.tab_id}
                sessionId={activeTab.tab_id}
                content={activeTab.content}
                onChange={(sessionId, content, cursor) =>
                  dispatch({ type: "UPDATE_CONTENT", tabId: sessionId, content, cursor })
                }
              />
            ) : (
              <div style={emptyEditorStyle}>Open a file from the list or create a new tab.</div>
            )}
          </main>
        </>
      )}
    </div>
  );
}

const shellStyle = {
  height: "100vh",
  display: "grid",
  gridTemplateRows: "42px 1fr",
  overflow: "hidden",
  background: "var(--app-bg)",
} as const;

const splashStyle = {
  gridColumn: "1 / 4",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-dim)",
  fontSize: "0.92rem",
} as const;

const headerFilesStyle = {
  gridRow: 1,
  gridColumn: 1,
  display: "flex",
  alignItems: "center",
  padding: "0 12px",
  borderBottom: "1px solid var(--panel-border)",
  background: "var(--panel-bg)",
  minWidth: 0,
} as const;

const workspaceNameStyle = {
  color: "var(--text-muted)",
  fontSize: "0.82rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const headerTabsStyle = {
  gridRow: 1,
  gridColumn: 3,
  display: "flex",
  alignItems: "stretch",
  gap: "6px",
  borderBottom: "1px solid var(--panel-border)",
  background: "var(--panel-bg)",
  minWidth: 0,
  padding: "0 10px",
} as const;

const toggleButtonStyle = {
  border: "none",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  width: 28,
} as const;

const tabBarStyle = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "flex-end",
  gap: "4px",
  overflowX: "auto",
  paddingTop: "7px",
} as const;

const tabStyle = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  borderRadius: "6px 6px 0 0",
  border: "1px solid var(--panel-border)",
  borderBottom: "none",
  background: "#242424",
  minWidth: 0,
} as const;

const activeTabStyle = {
  borderColor: "var(--panel-border-strong)",
  background: "var(--app-bg)",
} as const;

const tabSelectButtonStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  padding: "8px 4px 8px 10px",
  fontSize: "0.83rem",
  whiteSpace: "nowrap",
} as const;

const tabCloseButtonStyle = {
  border: "none",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: "0 8px 0 0",
  fontSize: "0.84rem",
} as const;

const newTabButtonStyle = {
  border: "none",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: "0 8px 6px",
  fontSize: "1rem",
} as const;

const dragHandleStyle = {
  gridRow: "1 / 3",
  gridColumn: 2,
  background: "var(--panel-border)",
  cursor: "col-resize",
} as const;

const sidebarStyle = {
  gridRow: 2,
  gridColumn: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  overflow: "hidden",
  background: "var(--panel-bg)",
  borderRight: "1px solid var(--panel-border)",
} as const;

const sidebarBodyStyle = {
  flex: 1,
  minHeight: 0,
} as const;

const workspaceFooterStyle = {
  borderTop: "1px solid var(--panel-border)",
  padding: "10px 12px",
  background: "#262626",
} as const;

const workspaceFooterMetaStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
} as const;

const workspaceFooterLabelStyle = {
  fontSize: "0.7rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
} as const;

const workspaceFooterNameStyle = {
  fontSize: "0.78rem",
  color: "var(--text-muted)",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const editorPaneStyle = {
  gridRow: 2,
  gridColumn: 3,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  overflow: "hidden",
  background: "var(--app-bg)",
} as const;

const errorBannerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "8px 12px",
  background: "#4b1e24",
  color: "#fecdd3",
  borderBottom: "1px solid #6b2a33",
  fontSize: "0.84rem",
} as const;

const dismissButtonStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
} as const;

const emptyEditorStyle = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-dim)",
  fontSize: "0.9rem",
} as const;
