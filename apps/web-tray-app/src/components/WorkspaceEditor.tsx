"use client";

import { useEffect, useCallback, useReducer, useState } from "react";
import type { ReactNode } from "react";
import { MarkdownEditor } from "@note/editor";
import type { TabDto } from "@note/types";

// ── Tab state management (port van demo/src/context/TabContext.tsx) ──────────

type TabState = {
  tabs: TabDto[];
  activeTabId: string | null;
};

type Action =
  | { type: "UPSERT_TAB"; tab: TabDto }
  | { type: "REMOVE_TAB"; tabId: string }
  | { type: "SET_ACTIVE"; tabId: string }
  | { type: "UPDATE_CONTENT"; tabId: string; content: string; cursor: number };

function tabReducer(state: TabState, action: Action): TabState {
  switch (action.type) {
    case "UPSERT_TAB": {
      const exists = state.tabs.some((t) => t.tab_id === action.tab.tab_id);
      const tabs = exists
        ? state.tabs.map((t) => (t.tab_id === action.tab.tab_id ? action.tab : t))
        : [...state.tabs, action.tab];
      return { ...state, tabs, activeTabId: action.tab.tab_id };
    }
    case "REMOVE_TAB": {
      const tabs = state.tabs.filter((t) => t.tab_id !== action.tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === action.tabId) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].tab_id : null;
      }
      return { ...state, tabs, activeTabId };
    }
    case "SET_ACTIVE":
      return { ...state, activeTabId: action.tabId };
    case "UPDATE_CONTENT":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.tab_id === action.tabId
            ? { ...t, content: action.content, cursor: action.cursor, is_dirty: true }
            : t,
        ),
      };
    default:
      return state;
  }
}

let nextTabId = 1;

function createTab(title = "Nieuw bestand", filePath: string | null = null): TabDto {
  return {
    tab_id: String(nextTabId++),
    title,
    is_temp: filePath === null,
    is_dirty: false,
    linked_path: filePath,
    content: "",
    cursor: 0,
  };
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

type FsItem = {
  name: string;
  type: "file" | "directory";
  path: string;
};

async function listDir(pathSegments: string[]): Promise<{ items: FsItem[]; resolvedPath: string }> {
  const res = await fetch(`/api/fs/list?path=${pathSegments.join("/")}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function readFile(filePath: string): Promise<string> {
  const res = await fetch(`/api/fs/read?file=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.content as string;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  const res = await fetch("/api/fs/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, content }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  root: {
    display: "flex",
    height: "100vh",
    background: "#0f172a",
    color: "#e2e8f0",
    fontFamily: "system-ui, sans-serif",
    overflow: "hidden",
  } as const,
  sidebar: {
    width: "220px",
    minWidth: "180px",
    borderRight: "1px solid #1e293b",
    display: "flex",
    flexDirection: "column" as const,
    background: "#0d1829",
    overflow: "hidden",
  },
  sidebarHeader: {
    padding: "10px 12px",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.08em",
    color: "#64748b",
    textTransform: "uppercase" as const,
    borderBottom: "1px solid #1e293b",
  },
  sidebarList: {
    flex: 1,
    overflow: "auto",
    padding: "4px 0",
  },
  sidebarItem: (active: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: "13px",
    color: active ? "#e2e8f0" : "#94a3b8",
    background: active ? "#1e293b" : "transparent",
    userSelect: "none" as const,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  tabBar: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "6px 8px 0",
    background: "#0f172a",
    borderBottom: "1px solid #1e293b",
    minHeight: "38px",
  },
  tab: (active: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: "6px 6px 0 0",
    border: "1px solid",
    borderBottom: "none",
    borderColor: active ? "#334155" : "transparent",
    background: active ? "#1e293b" : "transparent",
    color: active ? "#e2e8f0" : "#64748b",
    cursor: "pointer",
    fontSize: "13px",
    userSelect: "none" as const,
  }),
  closeBtn: {
    background: "none",
    border: "none",
    color: "inherit",
    cursor: "pointer",
    padding: "0 2px",
    fontSize: "14px",
    lineHeight: 1,
    opacity: 0.6,
  } as const,
  newTabBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: 1,
    padding: "2px 8px",
    borderRadius: "6px",
  } as const,
  editorArea: {
    flex: 1,
    overflow: "hidden",
  } as const,
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#475569",
    fontSize: "14px",
  } as const,
  resolvedPath: {
    padding: "4px 12px",
    fontSize: "11px",
    color: "#475569",
    borderTop: "1px solid #1e293b",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

interface WorkspaceEditorProps {
  pathSegments: string[];
}

export function WorkspaceEditor({ pathSegments }: WorkspaceEditorProps) {
  const [tabState, dispatch] = useReducer(tabReducer, { tabs: [], activeTabId: null });
  const [files, setFiles] = useState<FsItem[]>([]);
  const [resolvedPath, setResolvedPath] = useState("");

  const activeTab = tabState.tabs.find((t) => t.tab_id === tabState.activeTabId) ?? null;

  // Laad bestandslijst bij mount of route-wijziging
  useEffect(() => {
    listDir(pathSegments)
      .then(({ items, resolvedPath }) => {
        setFiles(items);
        setResolvedPath(resolvedPath);
      })
      .catch(console.error);
  }, [pathSegments.join("/")]);

  const handleFileClick = useCallback(
    async (item: FsItem) => {
      if (item.type === "directory") return;

      // Als dit bestand al open is, activeer het tab
      const existing = tabState.tabs.find((t) => t.linked_path === item.path);
      if (existing) {
        dispatch({ type: "SET_ACTIVE", tabId: existing.tab_id });
        return;
      }

      try {
        const content = await readFile(item.path);
        const tab = createTab(item.name.replace(/\.md$/, ""), item.path);
        tab.content = content;
        dispatch({ type: "UPSERT_TAB", tab });
      } catch (err) {
        console.error("Kan bestand niet lezen:", err);
      }
    },
    [tabState.tabs],
  );

  const handleNewTab = useCallback(() => {
    dispatch({ type: "UPSERT_TAB", tab: createTab() });
  }, []);

  const handleChange = useCallback((sessionId: string, content: string, cursor: number) => {
    dispatch({ type: "UPDATE_CONTENT", tabId: sessionId, content, cursor });
  }, []);

  const handleClose = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    dispatch({ type: "REMOVE_TAB", tabId });
  }, []);

  // Ctrl+S: sla op naar schijf
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!activeTab) return;
        if (activeTab.linked_path) {
          try {
            await writeFile(activeTab.linked_path, activeTab.content);
            dispatch({ type: "UPSERT_TAB", tab: { ...activeTab, is_dirty: false } });
          } catch (err) {
            console.error("Opslaan mislukt:", err);
          }
        } else {
          // Tijdelijk bestand: markeer als opgeslagen (geen schijfpad)
          dispatch({ type: "UPSERT_TAB", tab: { ...activeTab, is_dirty: false } });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab]);

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <div style={s.sidebarHeader}>Bestanden</div>
        <div style={s.sidebarList}>
          {files.map((item) => (
            <div
              key={item.path}
              style={s.sidebarItem(activeTab?.linked_path === item.path)}
              onClick={() => handleFileClick(item)}
              title={item.path}
            >
              {item.type === "directory" ? "📁" : "📄"} {item.name}
            </div>
          ))}
          {files.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: "12px", color: "#475569" }}>
              Geen .md bestanden gevonden
            </div>
          )}
        </div>
        {resolvedPath && <div style={s.resolvedPath} title={resolvedPath}>{resolvedPath}</div>}
      </aside>

      {/* Hoofdvenster */}
      <div style={s.main}>
        <div style={s.tabBar}>
          {tabState.tabs.map((tab) => (
            <button
              key={tab.tab_id}
              style={s.tab(tab.tab_id === tabState.activeTabId)}
              onClick={() => dispatch({ type: "SET_ACTIVE", tabId: tab.tab_id })}
            >
              <span style={{ fontStyle: tab.is_dirty ? "italic" : "normal" }}>
                {tab.is_dirty ? `${tab.title} •` : tab.title}
              </span>
              <button
                style={s.closeBtn}
                onClick={(e) => handleClose(e, tab.tab_id)}
                title="Sluiten"
              >
                ×
              </button>
            </button>
          ))}
          <button style={s.newTabBtn} onClick={handleNewTab} title="Nieuw tabblad">
            +
          </button>
        </div>

        <div style={s.editorArea}>
          {activeTab ? (
            <MarkdownEditor
              key={activeTab.tab_id}
              sessionId={activeTab.tab_id}
              content={activeTab.content}
              onChange={handleChange}
            />
          ) : (
            <div style={s.empty}>
              Selecteer een bestand of klik op + voor een nieuw tabblad
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
