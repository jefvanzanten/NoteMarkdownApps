import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@note/editor";
import { availableMarkdownPath, ensureMarkdownPath } from "@note/workspace-core";
import type { OpenDocument } from "./state/workspaceStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { detectLocale, translate, type Locale } from "./i18n";
import { ErrorBanner } from "./components/ErrorBanner";
import { FileTree } from "./components/FileTree";
import { MarkdownPreview } from "./components/MarkdownPreview";
import { ConflictDialog } from "./components/ConflictDialog";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { RecoveryToast } from "./components/RecoveryToast";
import { Tabs } from "./components/Tabs";
import { Welcome } from "./components/Welcome";
import { SearchResults } from "./components/SearchResults";
import { SettingsDialog } from "./components/SettingsDialog";
import { HistoryDialog } from "./components/HistoryDialog";
import { DiagnosticsDialog } from "./components/DiagnosticsDialog";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { DriveDialog } from "./components/DriveDialog";
import { WorkspaceLoadingOverlay } from "./components/WorkspaceLoadingOverlay";
import { SidebarControls } from "./components/SidebarControls";
import { useDriveWorkspacesQuery, useMeQuery, usePreferencesQuery, usePutPreferencesMutation } from "./account/queries";
import { searchDocuments, type SearchResult } from "./search/searchClient";
import { initializeSettings, saveSettings, type AppSettings } from "./state/settings";
import { activatePwaUpdate } from "./pwa";
import styles from "./App.module.css";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "notemarkdown:sidebar-collapsed";

/**
 * Schedules debounced provider writes for every dirty open document.
 * @param tabs Current open document snapshots.
 * @param saveDocument Store action that performs revision-safe provider writes.
 * @returns Nothing; timers are managed for the component lifetime.
 */
function useAutosave(tabs: OpenDocument[], saveDocument: (path: string) => Promise<void>): void {
  const timers = useRef(new Map<string, { content: string; timeout: number }>());

  useEffect(() => {
    const livePaths = new Set(tabs.map((tab) => tab.path));
    for (const [path, pending] of timers.current) {
      if (!livePaths.has(path)) {
        window.clearTimeout(pending.timeout);
        timers.current.delete(path);
      }
    }
    for (const tab of tabs) {
      const pending = timers.current.get(tab.path);
      if (tab.saveState !== "dirty-local" && tab.saveState !== "dirty-durable") {
        if (pending) window.clearTimeout(pending.timeout);
        timers.current.delete(tab.path);
        continue;
      }
      if (pending?.content === tab.content) continue;
      if (pending) window.clearTimeout(pending.timeout);
      const timeout = window.setTimeout(() => {
        timers.current.delete(tab.path);
        void saveDocument(tab.path);
      }, tab.content.length > 1_000_000 ? 900 : 520);
      timers.current.set(tab.path, { content: tab.content, timeout });
    }
  }, [saveDocument, tabs]);

  useEffect(() => () => {
    for (const pending of timers.current.values()) window.clearTimeout(pending.timeout);
    timers.current.clear();
  }, []);
}

/**
 * Maps domain save state to localized visible status.
 * @param document Active document snapshot.
 * @param locale Active UI locale.
 * @param isDrive Whether the provider saves directly to Google Drive.
 * @returns User-facing save status.
 */
function saveStatus(document: OpenDocument, locale: Locale, isDrive: boolean): string {
  if (document.editingState === "read-only") return translate(locale, "readOnlyLease");
  switch (document.saveState) {
    case "checking": return translate(locale, "checking");
    case "dirty-local": return translate(locale, "savingLocally");
    case "dirty-durable": return translate(locale, isDrive ? "waitingForDrive" : "waitingForDisk");
    case "persisting-local": return translate(locale, isDrive ? "syncingDrive" : "saving");
    case "queued": return translate(locale, "queued");
    case "destroyed": return translate(locale, "removedExternally");
    case "conflicted": return translate(locale, "conflict");
    case "error-blocking": return translate(locale, "saveError");
    default: return translate(locale, isDrive ? "syncedDrive" : "saved");
  }
}

/**
 * Detects Brave without relying only on its Chromium-compatible user agent.
 * @returns Whether Brave-specific browser APIs identify the current browser.
 */
function isBraveBrowser(): boolean {
  const navigatorWithBrave = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> }; userAgentData?: { brands?: Array<{ brand: string }> } };
  return navigatorWithBrave.userAgentData?.brands?.some(({ brand }) => brand === "Brave") === true || navigatorWithBrave.brave !== undefined;
}

/**
 * Renders the durable, searchable milestone-two local-first PWA shell.
 * @returns The welcome journey or active local workspace editor.
 */
export function App() {
  const provider = useWorkspaceStore((state) => state.provider);
  const entries = useWorkspaceStore((state) => state.entries);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activePath = useWorkspaceStore((state) => state.activePath);
  const selectedPath = useWorkspaceStore((state) => state.selectedPath);
  const isOpening = useWorkspaceStore((state) => state.isOpening);
  const resumableWorkspace = useWorkspaceStore((state) => state.resumableWorkspace);
  const error = useWorkspaceStore((state) => state.error);
  const lastTrash = useWorkspaceStore((state) => state.lastTrash);
  const diagnostics = useWorkspaceStore((state) => state.diagnostics);
  const conflicts = useWorkspaceStore((state) => state.conflicts);
  const recoveryItems = useWorkspaceStore((state) => state.recoveryItems);
  const isIndexing = useWorkspaceStore((state) => state.isIndexing);
  const initialize = useWorkspaceStore((state) => state.initialize);
  const resumeWorkspace = useWorkspaceStore((state) => state.resumeWorkspace);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const openRecentWorkspace = useWorkspaceStore((state) => state.openRecentWorkspace);
  const openDriveWorkspace = useWorkspaceStore((state) => state.openDriveWorkspace);
  const openDocument = useWorkspaceStore((state) => state.openDocument);
  const closeDocument = useWorkspaceStore((state) => state.closeDocument);
  const selectPath = useWorkspaceStore((state) => state.selectPath);
  const updateDocument = useWorkspaceStore((state) => state.updateDocument);
  const setViewMode = useWorkspaceStore((state) => state.setViewMode);
  const requestEditingTakeover = useWorkspaceStore((state) => state.requestEditingTakeover);
  const saveDocument = useWorkspaceStore((state) => state.saveDocument);
  const createDocument = useWorkspaceStore((state) => state.createDocument);
  const createDirectory = useWorkspaceStore((state) => state.createDirectory);
  const moveEntry = useWorkspaceStore((state) => state.moveEntry);
  const trashEntry = useWorkspaceStore((state) => state.trashEntry);
  const restoreLastTrash = useWorkspaceStore((state) => state.restoreLastTrash);
  const restoreRecoveryItem = useWorkspaceStore((state) => state.restoreRecoveryItem);
  const removeRecoveryItem = useWorkspaceStore((state) => state.removeRecoveryItem);
  const resolveConflict = useWorkspaceStore((state) => state.resolveConflict);
  const insertAssets = useWorkspaceStore((state) => state.insertAssets);
  const checkExternalChanges = useWorkspaceStore((state) => state.checkExternalChanges);
  const getHistory = useWorkspaceStore((state) => state.getHistory);
  const restoreHistory = useWorkspaceStore((state) => state.restoreHistory);
  const flushDurableDrafts = useWorkspaceStore((state) => state.flushDurableDrafts);
  const clearError = useWorkspaceStore((state) => state.clearError);
  const [settings, setSettings] = useState<AppSettings>(initializeSettings);
  const locale: Locale = settings.locale ?? detectLocale();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true");
  const [sidebarWidth, setSidebarWidth] = useState(292);
  const [dialog, setDialog] = useState<"settings" | "history" | "diagnostics" | "drive" | "recovery" | "conflicts" | null>(null);
  const meQuery = useMeQuery();
  const account = meQuery.data ?? null;
  const preferencesQuery = usePreferencesQuery(Boolean(account));
  const driveWorkspacesQuery = useDriveWorkspacesQuery(Boolean(account));
  const putPreferencesMutation = usePutPreferencesMutation();
  const metadataFailure = meQuery.error ?? preferencesQuery.error ?? driveWorkspacesQuery.error ?? putPreferencesMutation.error;
  const [dismissedMetadataFailure, setDismissedMetadataFailure] = useState<unknown>(null);
  const metadataError = metadataFailure && metadataFailure !== dismissedMetadataFailure
    ? metadataFailure instanceof Error ? metadataFailure.message : "Account synchronization failed."
    : null;
  const synchronizedUser = useRef<string | null>(null);
  const [isOnline, setOnline] = useState(navigator.onLine);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const assetInput = useRef<HTMLInputElement>(null);
  const activeDocument = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [activePath, tabs]);
  const isSupported = "showDirectoryPicker" in window;
  const isBrave = isBraveBrowser();

  useAutosave(tabs, saveDocument);

  useEffect(() => { void initialize(); }, [initialize]);

  useEffect(() => {
    if (!account || !preferencesQuery.isFetched || preferencesQuery.isError || synchronizedUser.current === account.user.id) return;
    synchronizedUser.current = account.user.id;
    const serverSettings = preferencesQuery.data;
    if (serverSettings && serverSettings.updatedAt > settings.updatedAt) {
      const nextSettings: AppSettings = { ...serverSettings, keybindings: serverSettings.keybindings };
      saveSettings(nextSettings);
      setSettings(nextSettings);
      return;
    }
    putPreferencesMutation.mutate({ ...settings, keybindings: Object.fromEntries(Object.entries(settings.keybindings).map(([id, bindings]) => [id, [...(bindings ?? [])]])) });
  }, [account, preferencesQuery.data, preferencesQuery.isError, preferencesQuery.isFetched, putPreferencesMutation, settings]);

  useEffect(() => {
    if (!provider) return;
    const savedWidth = Number(localStorage.getItem(`notemarkdown:sidebar:${provider.id}`));
    if (Number.isFinite(savedWidth) && savedWidth >= 220 && savedWidth <= 440) setSidebarWidth(savedWidth);
  }, [provider]);

  useEffect(() => {
    if (provider) localStorage.setItem(`notemarkdown:sidebar:${provider.id}`, String(sidebarWidth));
  }, [provider, sidebarWidth]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }
      void searchDocuments(query).then(setSearchResults);
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    /** Flushes unresolved editor state when the browser may suspend this page. @returns Nothing after the best-effort flush starts. */
    const flushBeforeSuspension = (): void => { void flushDurableDrafts(); };
    /** Flushes only when the document is leaving the visible lifecycle. @returns Nothing after an optional flush starts. */
    const flushWhenHidden = (): void => { if (document.visibilityState === "hidden") flushBeforeSuspension(); };
    window.addEventListener("pagehide", flushBeforeSuspension);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushBeforeSuspension);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushDurableDrafts]);

  useEffect(() => {
    let running = false;
    let lastLifecycleCheckAt = 0;
    const check = async (lifecycle = false): Promise<void> => {
      if (running || !navigator.onLine || document.visibilityState !== "visible") return;
      if (lifecycle && Date.now() - lastLifecycleCheckAt < 1_000) return;
      if (lifecycle) lastLifecycleCheckAt = Date.now();
      running = true;
      try {
        await checkExternalChanges();
      } finally {
        running = false;
      }
    };
    const refreshOnline = (): void => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void check(true);
    };
    const handleFocus = (): void => { void check(true); };
    const handleVisibility = (): void => { if (document.visibilityState === "visible") void check(true); };
    const interval = window.setInterval(() => { void check(); }, 30_000);
    window.addEventListener("online", refreshOnline);
    window.addEventListener("offline", refreshOnline);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", refreshOnline);
      window.removeEventListener("offline", refreshOnline);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [checkExternalChanges]);

  useEffect(() => {
    const showUpdate = () => setUpdateAvailable(true);
    window.addEventListener("notemarkdown:update-available", showUpdate);
    return () => window.removeEventListener("notemarkdown:update-available", showUpdate);
  }, []);

  const handleOpenDocument = useCallback((path: string) => {
    void openDocument(path);
    if (window.matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
  }, [openDocument]);

  /**
   * Switches and persists the global UI language.
   * @returns Nothing after the preference changes.
   */
  const toggleLocale = (): void => {
    const nextSettings = { ...settings, locale: locale === "en" ? "nl" as const : "en" as const, updatedAt: Date.now() };
    localStorage.setItem("notemarkdown:locale", nextSettings.locale);
    saveSettings(nextSettings);
    setSettings(nextSettings);
    if (account) putPreferencesMutation.mutate({ ...nextSettings, keybindings: Object.fromEntries(Object.entries(nextSettings.keybindings).map(([id, bindings]) => [id, [...(bindings ?? [])]])) });
  };

  /**
   * Toggles and persists the collapsed desktop sidebar rail.
   * @returns Nothing after the desktop preference changes.
   */
  const toggleDesktopSidebar = (): void => {
    const nextCollapsed = !isSidebarCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
    setSidebarCollapsed(nextCollapsed);
  };

  /** Dismisses the current metadata failure while allowing a later failure to appear. @returns Nothing after the current failure is remembered. */
  const dismissMetadataError = (): void => {
    setDismissedMetadataFailure(metadataFailure);
    putPreferencesMutation.reset();
  };

  /**
   * Persists and applies one complete settings snapshot.
   * @param nextSettings Updated global settings.
   * @returns Nothing after settings are applied.
   */
  const updateSettings = (nextSettings: AppSettings): void => {
    const timestamped = { ...nextSettings, updatedAt: Date.now() };
    saveSettings(timestamped);
    setSettings(timestamped);
    if (account) putPreferencesMutation.mutate({ ...timestamped, keybindings: Object.fromEntries(Object.entries(timestamped.keybindings).map(([id, bindings]) => [id, [...(bindings ?? [])]])) });
  };

  /**
   * Handles pasted, dropped, or selected supported image files.
   * @param files Browser file collection.
   * @returns Nothing after provider asset insertion starts.
   */
  const addImages = (files: FileList | File[]): void => {
    void insertAssets(Array.from(files), settings.assetDirectory);
  };

  /**
   * Starts pointer-driven desktop sidebar resizing.
   * @param event Pointer-down event on the resize separator.
   * @returns Nothing after listeners are installed.
   */
  const startSidebarResize = (event: React.PointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.min(440, Math.max(220, startWidth + moveEvent.clientX - startX)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  /**
   * Creates and opens one collision-free Markdown note from the leading plus tab.
   * @returns Nothing after the provider operation is requested.
   */
  const requestCreateDocument = (directoryPath = ""): void => {
    void createDocument(availableMarkdownPath(entries, directoryPath));
  };

  /**
   * Prompts for and creates one provider directory.
   * @returns Nothing after the provider operation is requested.
   */
  const requestCreateDirectory = (): void => {
    const path = window.prompt(translate(locale, "promptFolder"), "notes")?.trim();
    if (path) void createDirectory(path);
  };

  /**
   * Prompts for a new name while keeping the entry in its current directory.
   * @param path Entry path to rename.
   * @returns Nothing after the provider operation is requested.
   */
  const requestRename = (path: string): void => {
    const segments = path.split("/");
    const currentName = segments.pop() ?? path;
    const nextName = window.prompt(translate(locale, "promptRename"), currentName)?.trim();
    if (!nextName || nextName === currentName || nextName.includes("/")) return;
    const destination = [...segments, nextName].filter(Boolean).join("/");
    void moveEntry(path, currentName.toLocaleLowerCase().endsWith(".md") ? ensureMarkdownPath(destination) : destination);
  };

  /**
   * Prompts for a replacement path for the selected entry.
   * @returns Nothing after the provider operation is requested.
   */
  const requestMove = (): void => {
    if (!selectedPath) return;
    const destination = window.prompt(translate(locale, "promptMove"), selectedPath)?.trim();
    if (destination && destination !== selectedPath) void moveEntry(selectedPath, destination);
  };

  /**
   * Confirms recoverable deletion for one entry.
   * @param path Entry path to delete.
   * @returns Nothing after the provider operation is requested.
   */
  const requestTrash = (path: string): void => {
    if (window.confirm(translate(locale, "confirmTrash"))) void trashEntry(path);
  };

  if (!provider) {
    return (
      <>
        <button type="button" className={styles.languageWelcome} onClick={toggleLocale}>{translate(locale, "language")}</button>
        <Welcome locale={locale} isOpening={isOpening} isSupported={isSupported} isBrave={isBrave} resumableWorkspaceName={resumableWorkspace?.name ?? null} onResume={() => void resumeWorkspace()} onOpen={() => void openWorkspace()} onDrive={() => setDialog("drive")} />
        {dialog === "drive" ? <DriveDialog locale={locale} onOpen={(workspace) => { setDialog(null); void openDriveWorkspace(workspace); }} onClose={() => setDialog(null)} /> : null}
        {isOpening ? <WorkspaceLoadingOverlay locale={locale} /> : null}
        {error ? <ErrorBanner message={error} locale={locale} onClose={clearError} /> : null}
        {metadataError ? <ErrorBanner message={metadataError} locale={locale} onClose={dismissMetadataError} /> : null}
      </>
    );
  }

  return (
    <div className={styles.app}>
      <div className={styles.workspace}>
        {isSidebarOpen ? <button type="button" className={styles.scrim} onClick={() => setSidebarOpen(false)} aria-label={translate(locale, "close")} /> : null}
        <aside id="file-sidebar" className={`${styles.sidebar} ${isSidebarOpen ? styles.sidebarOpen : ""} ${isSidebarCollapsed ? styles.sidebarCollapsed : ""}`} style={{ width: sidebarWidth }}>
          <div className={styles.sidebarHeading}>
            <span>{translate(locale, "files")}</span>
            <button type="button" className={styles.desktopCollapse} onClick={toggleDesktopSidebar} aria-controls="file-sidebar" aria-expanded={!isSidebarCollapsed} aria-label={translate(locale, isSidebarCollapsed ? "menu" : "collapse")}>{isSidebarCollapsed ? "›" : "‹"}</button>
            <button type="button" className={styles.mobileCollapse} onClick={() => setSidebarOpen(false)} aria-controls="file-sidebar" aria-expanded={isSidebarOpen} aria-label={translate(locale, "collapse")}>‹</button>
          </div>
          <div className={styles.searchWrap}>
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={translate(locale, "search")} aria-label={translate(locale, "search")} />
          </div>
          <div className={styles.fileActions}>
            <button type="button" onClick={requestCreateDirectory} title={translate(locale, "newFolder")}>+ dir</button>
            <button type="button" onClick={() => assetInput.current?.click()} disabled={!activeDocument} title={translate(locale, "chooseImages")}>+ img</button>
            <button type="button" onClick={() => { if (selectedPath) requestRename(selectedPath); }} disabled={!selectedPath} title={translate(locale, "rename")}>Aa</button>
            <button type="button" onClick={requestMove} disabled={!selectedPath} title={translate(locale, "move")}>↗</button>
            <button type="button" onClick={() => { if (selectedPath) requestTrash(selectedPath); }} disabled={!selectedPath} title={translate(locale, "trash")}>×</button>
            <input ref={assetInput} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml" multiple onChange={(event) => { if (event.target.files) addImages(event.target.files); event.target.value = ""; }} />
          </div>
          <div className={styles.treeScroll}>
            {query.trim() ? <SearchResults results={searchResults} locale={locale} onOpen={handleOpenDocument} /> : <FileTree entries={entries} query="" selectedPath={selectedPath} locale={locale} onOpenDocument={handleOpenDocument} onSelect={selectPath} onMoveEntry={(sourcePath, destinationPath) => void moveEntry(sourcePath, destinationPath)} onCreateDocument={requestCreateDocument} onRename={requestRename} onTrash={requestTrash} />}
          </div>
          <SidebarControls
            locale={locale}
            providerId={provider.id}
            providerName={provider.name}
            providerStatus={isIndexing ? translate(locale, "indexing") : provider.id.startsWith("drive:") ? `Google Drive / ${isOnline ? "online" : "offline"}` : `local / ${isOnline ? "direct" : "offline"}`}
            driveWorkspaces={driveWorkspacesQuery.data ?? []}
            diagnosticsCount={diagnostics.length}
            recoveryCount={recoveryItems.length}
            onOpenLocal={(workspace) => void openRecentWorkspace(workspace)}
            onOpenDrive={(workspace) => void openDriveWorkspace(workspace)}
            onBrowse={() => void openWorkspace()}
            onManageDrive={() => setDialog("drive")}
            onSettings={() => setDialog("settings")}
            onDiagnostics={() => setDialog("diagnostics")}
            onRecovery={() => setDialog("recovery")}
            onToggleLocale={toggleLocale}
          />
          <div className={styles.resizer} role="separator" aria-orientation="vertical" onPointerDown={startSidebarResize} />
        </aside>

        <main className={styles.main}>
          <div className={styles.documentBar}>
            <button type="button" className={styles.mobileMenu} onClick={() => setSidebarOpen(true)} aria-label={translate(locale, "menu")}>☰</button>
            <Tabs tabs={tabs} activePath={activePath} locale={locale} onActivate={handleOpenDocument} onClose={(path) => window.setTimeout(() => closeDocument(path), 320)} onCreate={requestCreateDocument} />
            {activeDocument ? (
              <div className={styles.modeToggle} role="group" aria-label={`${translate(locale, "editor")} / ${translate(locale, "preview")}`}>
                {activeDocument.editingState === "read-only" ? <button type="button" onClick={() => void requestEditingTakeover(activeDocument.path)}>{translate(locale, "takeOverEditing")}</button> : null}
                {activeDocument.saveState === "conflicted" ? <button type="button" onClick={() => setDialog("conflicts")}>{translate(locale, "resolveConflicts")}</button> : null}
                {activeDocument.saveState === "error-blocking" ? <button type="button" onClick={() => void saveDocument(activeDocument.path)}>{translate(locale, "retrySync")}</button> : null}
                <button type="button" className={activeDocument.viewMode === "editor" ? styles.modeActive : ""} onClick={() => setViewMode(activeDocument.path, "editor")}>{translate(locale, "editor")}</button>
                <button type="button" className={activeDocument.viewMode === "preview" ? styles.modeActive : ""} onClick={() => setViewMode(activeDocument.path, "preview")}>{translate(locale, "preview")}</button>
              </div>
            ) : null}
          </div>

          <div
            className={styles.documentPane}
            onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); addImages(files); } }}
            onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }}
            onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); addImages(files); } }}
          >
            {activeDocument ? (
              activeDocument.viewMode === "editor" ? (
                <MarkdownEditor
                  key={`editor:${settings.spellCheck}:${activeDocument.editingState}`}
                  sessionId={activeDocument.path}
                  content={activeDocument.content}
                  onChange={(path, content, cursor) => updateDocument(path, content, cursor)}
                  onSave={(path) => void saveDocument(path)}
                  spellCheck={settings.spellCheck}
                  readOnly={activeDocument.editingState === "read-only"}
                  keybindings={settings.keybindings}
                  initialCursor={activeDocument.cursor}
                />
              ) : (
                <MarkdownPreview
                  documentPath={activeDocument.path}
                  markdown={activeDocument.content}
                  provider={provider}
                  locale={locale}
                  onOpenDocument={handleOpenDocument}
                />
              )
            ) : (
              <div className={styles.emptyState}><span aria-hidden="true">N_</span><p>{translate(locale, "noDocument")}</p></div>
            )}
          </div>

          <footer className={styles.statusbar}>
            <span>{activeDocument?.path ?? provider.name}</span>
            <span aria-live="polite" data-state={activeDocument?.saveState}>{!isOnline ? translate(locale, "offline") : activeDocument ? saveStatus(activeDocument, locale, provider.id.startsWith("drive:")) : provider.id.startsWith("drive:") ? "Google Drive" : "local"}</span>
          </footer>
        </main>
      </div>

      {dialog === "settings" ? <SettingsDialog locale={locale} settings={settings} onChange={updateSettings} onClose={() => setDialog(null)} /> : null}
      {dialog === "drive" ? <DriveDialog locale={locale} onOpen={(workspace) => { setDialog(null); void openDriveWorkspace(workspace); }} onClose={() => setDialog(null)} /> : null}
      {dialog === "history" && activeDocument ? <HistoryDialog locale={locale} path={activeDocument.path} load={getHistory} onRestore={(entry) => void restoreHistory(entry)} onClose={() => setDialog(null)} /> : null}
      {dialog === "diagnostics" ? <DiagnosticsDialog locale={locale} diagnostics={diagnostics} onOpen={handleOpenDocument} onClose={() => setDialog(null)} /> : null}
      {dialog === "recovery" ? <RecoveryDialog locale={locale} items={recoveryItems} onRestore={(id, path) => void restoreRecoveryItem(id, path)} onDelete={(id) => void removeRecoveryItem(id)} onClose={() => setDialog(null)} /> : null}
      {dialog === "conflicts" ? <ConflictDialog locale={locale} conflicts={conflicts} onResolve={(id, content) => void resolveConflict(id, content)} onClose={() => setDialog(null)} /> : null}
      {updateAvailable ? <UpdatePrompt locale={locale} onUpdate={() => window.setTimeout(() => void flushDurableDrafts().then(activatePwaUpdate), 320)} /> : null}
      {lastTrash ? <RecoveryToast locale={locale} onRestore={() => void restoreLastTrash()} /> : null}
      {isOpening ? <WorkspaceLoadingOverlay locale={locale} /> : null}
      {error ? <ErrorBanner message={error} locale={locale} onClose={clearError} /> : null}
      {metadataError ? <ErrorBanner message={metadataError} locale={locale} onClose={dismissMetadataError} /> : null}
    </div>
  );
}
