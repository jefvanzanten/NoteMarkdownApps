import { useEffect, useCallback } from "react";
import { MarkdownEditor } from "@note/editor";
import { useTabs, createNewTab } from "./context/TabContext.js";

const styles = {
  app: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    background: "#0f172a",
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
  tab: (active: boolean, dirty: boolean) => ({
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
    fontFamily: "system-ui, sans-serif",
    userSelect: "none" as const,
  }),
  tabTitle: (dirty: boolean) => ({
    fontStyle: dirty ? "italic" : "normal",
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
  },
  newTabBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: 1,
    padding: "2px 8px",
    borderRadius: "6px",
  },
  editorArea: {
    flex: 1,
    overflow: "hidden",
  },
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#475569",
    fontSize: "14px",
    fontFamily: "system-ui, sans-serif",
  },
};

export function App() {
  const { tabs, activeTabId, activeTab, upsertTab, removeTab, setActive, updateContent } = useTabs();

  // Open a default tab on first load
  useEffect(() => {
    const tab = createNewTab("Voorbeeld");
    tab.content = `# Welkom bij NoteMarkdown

Begin hier met typen...

## Checklists

- [x] CodeMirror 6 editor
- [x] Syntax highlighting
- [ ] Meer functies

## Bullet lists

- Item één
- Item twee
- Item drie

## Code

\`\`\`typescript
const greeting = "Hallo wereld";
console.log(greeting);
\`\`\`
`;
    upsertTab(tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewTab = useCallback(() => {
    upsertTab(createNewTab());
  }, [upsertTab]);

  const handleChange = useCallback(
    (sessionId: string, content: string, cursor: number) => {
      updateContent(sessionId, content, cursor);
    },
    [updateContent],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      removeTab(tabId);
    },
    [removeTab],
  );

  // Ctrl+S: mark active tab as saved
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeTab) {
          upsertTab({ ...activeTab, is_dirty: false });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, upsertTab]);

  return (
    <div style={styles.app}>
      <div style={styles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.tab_id}
            style={styles.tab(tab.tab_id === activeTabId, tab.is_dirty)}
            onClick={() => setActive(tab.tab_id)}
          >
            <span style={styles.tabTitle(tab.is_dirty)}>
              {tab.is_dirty ? `${tab.title} •` : tab.title}
            </span>
            <button
              style={styles.closeBtn}
              onClick={(e) => handleClose(e, tab.tab_id)}
              title="Sluiten"
            >
              ×
            </button>
          </button>
        ))}
        <button style={styles.newTabBtn} onClick={handleNewTab} title="Nieuw tabblad">
          +
        </button>
      </div>

      <div style={styles.editorArea}>
        {activeTab ? (
          <MarkdownEditor
            key={activeTab.tab_id}
            sessionId={activeTab.tab_id}
            content={activeTab.content}
            onChange={handleChange}
          />
        ) : (
          <div style={styles.empty}>Geen tabblad open. Klik op + om te beginnen.</div>
        )}
      </div>
    </div>
  );
}
