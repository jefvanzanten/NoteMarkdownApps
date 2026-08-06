import { describe, expect, it } from "vitest";
import { CreateWorkspaceSchema, PreferenceSchema, TokenRequestSchema } from "./index";

describe("metadata API privacy boundary", () => {
  it("rejects document content on Drive metadata routes", () => {
    expect(CreateWorkspaceSchema.safeParse({ connectedAccountId: crypto.randomUUID(), folderId: "folder", displayName: "Notes", markdown: "secret" }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ connectedAccountId: crypto.randomUUID(), content: "secret" }).success).toBe(false);
  });

  it("does not permit content fields in synchronized preferences", () => {
    expect(PreferenceSchema.safeParse({ preferences: { theme: "system", locale: "en", spellCheck: true, assetDirectory: "assets", keybindings: {}, updatedAt: 1, documentPaths: ["private.md"] } }).success).toBe(false);
  });
});
