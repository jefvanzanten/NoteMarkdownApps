import type { OpenDocument } from "../state/workspaceStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { recordActivity } from "./activityJournal";

interface TrackedDocument {
  path: string;
  saveState: OpenDocument["saveState"];
  editingState: OpenDocument["editingState"];
  viewMode: OpenDocument["viewMode"];
  contentLength: number;
}

/** Reduces open documents to metadata-only snapshots that never retain note content. @param tabs Current open documents. @returns Entry-ID keyed document metadata. */
function documentSnapshots(tabs: OpenDocument[]): Map<string, TrackedDocument> {
  return new Map(tabs.map((document) => [document.entryId, {
    path: document.path,
    saveState: document.saveState,
    editingState: document.editingState,
    viewMode: document.viewMode,
    contentLength: document.content.length,
  }]));
}

/** Installs structured activity capture around observable Zustand workspace transitions. @returns Unsubscribe callback. */
export function installWorkspaceActivityTracking(): () => void {
  const initial = useWorkspaceStore.getState();
  let providerId = initial.provider?.id ?? null;
  let activePath = initial.activePath;
  let entryCount = initial.entries.length;
  let documents = documentSnapshots(initial.tabs);
  let error = initial.error;

  return useWorkspaceStore.subscribe((state) => {
    const nextProviderId = state.provider?.id ?? null;
    if (nextProviderId !== providerId) {
      recordActivity("workspace", nextProviderId ? "workspace.activated" : "workspace.closed", {
        provider: state.provider?.listChanges ? "drive" : state.provider ? "local" : "none",
        workspaceId: nextProviderId,
        workspaceName: state.provider?.name,
      });
      providerId = nextProviderId;
    }
    if (state.activePath !== activePath) {
      recordActivity("document", state.activePath ? "document.activated" : "document.deactivated", { path: state.activePath }, "debug");
      activePath = state.activePath;
    }
    if (state.entries.length !== entryCount) {
      recordActivity("workspace", "workspace.entries-changed", { previousCount: entryCount, count: state.entries.length }, "debug");
      entryCount = state.entries.length;
    }

    const nextDocuments = documentSnapshots(state.tabs);
    for (const [entryId, document] of nextDocuments) {
      const previous = documents.get(entryId);
      if (!previous) {
        recordActivity("document", "document.opened", { path: document.path, entryId, saveState: document.saveState, editingState: document.editingState });
        continue;
      }
      if (document.path !== previous.path) recordActivity("document", "document.path-changed", { previousPath: previous.path, path: document.path, entryId });
      if (document.saveState !== previous.saveState) {
        recordActivity("document", "document.save-state-changed", { path: document.path, entryId, previousState: previous.saveState, state: document.saveState, contentLength: document.contentLength });
      }
      if (document.saveState === "dirty-local" && previous.saveState !== "dirty-local") {
        recordActivity("document", "document.edit-started", { path: document.path, entryId, lengthDelta: document.contentLength - previous.contentLength, contentLength: document.contentLength });
      }
      if (document.editingState !== previous.editingState) recordActivity("document", "document.editing-state-changed", { path: document.path, entryId, previousState: previous.editingState, state: document.editingState });
      if (document.viewMode !== previous.viewMode) recordActivity("document", "document.view-mode-changed", { path: document.path, entryId, previousMode: previous.viewMode, mode: document.viewMode }, "debug");
    }
    for (const [entryId, document] of documents) {
      if (!nextDocuments.has(entryId)) recordActivity("document", "document.closed", { path: document.path, entryId, saveState: document.saveState });
    }
    documents = nextDocuments;

    if (state.error !== error) {
      if (state.error) recordActivity("workspace", "workspace.error", {}, "error");
      else if (error) recordActivity("workspace", "workspace.error-cleared", {}, "debug");
      error = state.error;
    }
  });
}
