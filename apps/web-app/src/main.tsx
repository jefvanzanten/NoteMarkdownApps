import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { registerPwa } from "./pwa";
import { useWorkspaceStore } from "./state/workspaceStore";
import { configureSyncDiagnostics, installGlobalDiagnosticHandlers } from "./sync/workspaceDiagnostics";
import { configureActivityJournal, installActivityJournalHandlers } from "./diagnostics/activityJournal";
import { installWorkspaceActivityTracking } from "./diagnostics/workspaceActivity";
import "./styles/tokens.css";
import "./styles/global.css";

/**
 * Reads the temporary slow-operation threshold with a safe fallback.
 * @returns Positive millisecond threshold.
 */
function slowDiagnosticThreshold(): number {
  const configured = Number(import.meta.env.VITE_SYNC_SLOW_ACTIVATION_MS ?? 30_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

configureActivityJournal({
  enabled: import.meta.env.DEV || import.meta.env.VITE_ACTIVITY_LOG_ENABLED === "true",
  buildMode: import.meta.env.MODE,
});
installActivityJournalHandlers();
installWorkspaceActivityTracking();

configureSyncDiagnostics({
  enabled: import.meta.env.VITE_SYNC_DIAGNOSTICS_ENABLED === "true",
  slowOperationMs: slowDiagnosticThreshold(),
  buildMode: import.meta.env.MODE,
  getPageState: () => {
    const state = useWorkspaceStore.getState();
    const saveStates = Object.fromEntries(Array.from(
      state.tabs.reduce((counts, tab) => counts.set(tab.saveState, (counts.get(tab.saveState) ?? 0) + 1), new Map<string, number>()),
    ));
    return {
      providerType: state.provider ? state.provider.listChanges ? "drive" : "local" : "none",
      isOpening: state.isOpening,
      isIndexing: state.isIndexing,
      entryCount: state.entries.length,
      tabCount: state.tabs.length,
      saveStates,
    };
  },
});
installGlobalDiagnosticHandlers();

const root = document.getElementById("root");
if (!root) throw new Error("The NoteMarkdown root element is missing.");
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } });

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);

void registerPwa();
