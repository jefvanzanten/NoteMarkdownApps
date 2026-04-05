import { createContext, useContext, useReducer, useCallback } from "react";
import type { ReactNode } from "react";
import type { TabDto } from "@note/types";

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

type TabContextValue = {
  tabs: TabDto[];
  activeTabId: string | null;
  activeTab: TabDto | null;
  upsertTab: (tab: TabDto) => void;
  removeTab: (tabId: string) => void;
  setActive: (tabId: string) => void;
  updateContent: (tabId: string, content: string, cursor: number) => void;
};

const TabContext = createContext<TabContextValue | null>(null);

let nextTabId = 1;

export function TabProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tabReducer, { tabs: [], activeTabId: null });

  const upsertTab = useCallback((tab: TabDto) => dispatch({ type: "UPSERT_TAB", tab }), []);
  const removeTab = useCallback((tabId: string) => dispatch({ type: "REMOVE_TAB", tabId }), []);
  const setActive = useCallback((tabId: string) => dispatch({ type: "SET_ACTIVE", tabId }), []);
  const updateContent = useCallback(
    (tabId: string, content: string, cursor: number) =>
      dispatch({ type: "UPDATE_CONTENT", tabId, content, cursor }),
    [],
  );

  const activeTab = state.tabs.find((t) => t.tab_id === state.activeTabId) ?? null;

  return (
    <TabContext.Provider value={{ ...state, activeTab, upsertTab, removeTab, setActive, updateContent }}>
      {children}
    </TabContext.Provider>
  );
}

export function useTabs(): TabContextValue {
  const ctx = useContext(TabContext);
  if (!ctx) throw new Error("useTabs must be used inside TabProvider");
  return ctx;
}

export function createNewTab(title = "Nieuw bestand"): TabDto {
  return {
    tab_id: String(nextTabId++),
    title,
    is_temp: true,
    is_dirty: false,
    linked_path: null,
    content: "",
    cursor: 0,
  };
}
