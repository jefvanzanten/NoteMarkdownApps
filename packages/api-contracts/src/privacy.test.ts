import { describe, expect, it } from "vitest";
import { ClientDiagnosticReportSchema, CreateWorkspaceSchema, PreferenceSchema, TokenRequestSchema } from "./index";

describe("metadata API privacy boundary", () => {
  it("rejects document content on Drive metadata routes", () => {
    expect(CreateWorkspaceSchema.safeParse({ connectedAccountId: crypto.randomUUID(), folderId: "folder", displayName: "Notes", markdown: "secret" }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ connectedAccountId: crypto.randomUUID(), content: "secret" }).success).toBe(false);
  });

  it("does not permit content fields in synchronized preferences", () => {
    expect(PreferenceSchema.safeParse({ preferences: { theme: "system", locale: "en", spellCheck: true, assetDirectory: "assets", keybindings: {}, updatedAt: 1, documentPaths: ["private.md"] } }).success).toBe(false);
  });

  it("rejects document and provider identities from temporary diagnostic reports", () => {
    const report = {
      reportId: crypto.randomUUID(),
      createdAt: 1,
      trigger: "workspace-error",
      buildMode: "production",
      pageState: { online: true, visibility: "visible", providerType: "drive", isOpening: false, isIndexing: true, entryCount: 2, tabCount: 1, saveStates: { queued: 1 } },
      failure: { name: "WorkspaceError", code: "temporary", stackFrames: [], causeNames: [] },
      metrics: {},
      events: [],
      documentPath: "private.md",
      driveFileId: "provider-identity",
      content: "secret",
    };
    expect(ClientDiagnosticReportSchema.safeParse(report).success).toBe(false);
  });
});
