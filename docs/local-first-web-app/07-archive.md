# 07. Archive

## Purpose

This document preserves superseded product decisions and retired specification material. Archived decisions are not current requirements, but retaining their context prevents the same questions from being reopened without new evidence.

When archiving a decision, record:

- date or release context;
- former decision;
- replacement decision;
- reason for change;
- affected documents or code;
- migration or compatibility consequences.

## Superseded decisions from initial discovery

### Personal-only architecture

**Former direction:** Build only for one personal user.

**Replacement:** V1 is personal-first but multi-user-safe from the beginning. Users, sessions, connected accounts, tokens, workspace references, and preferences are always scoped by internal user identity.

**Reason:** A public multi-user version is an expected future requirement and must not require removing global singleton state later.

### Google Drive as the universal source of truth

**Former direction:** Google Drive is the source of truth for every document.

**Replacement:** A workspace has either a real local directory or one selected Drive folder as provider. Drive is authoritative only for Drive workspaces; local directories are authoritative for local workspaces.

**Reason:** The product was clarified as local-first with Drive as an optional workspace provider.

### Standalone browser-storage workspace

**Former direction:** Safari and Firefox could use OPFS/IndexedDB as a standalone local workspace, requiring ZIP import/export.

**Replacement:** No browser-only workspace exists. OPFS/IndexedDB is supporting cache, mirror, draft, history, index, and session storage only. Safari/Firefox users use Drive for the complete workspace experience when real directory access is unavailable.

**Reason:** A hidden browser-only source contradicted the requirement that documents live either in a real local directory or Google Drive, and created unnecessary export/lock-in behavior.

### Permanent split preview

**Former direction:** Desktop could show editor and preview side by side.

**Replacement:** One main pane with an Editor/Preview toggle. The left file tree remains collapsible. Source and scroll mapping preserve context across toggles.

**Reason:** The desired interaction is a focused single view rather than a split layout.

### Comrak Markdown engine

**Former direction:** Use `comrak` for its AST and direct GFM support.

**Replacement:** Use `pulldown-cmark` for Rust/WASM parsing and rendering.

**Reason:** Parsing performance is the stronger priority. `pulldown-cmark` is designed for minimal allocation and supports the required GFM extensions without always constructing a full AST.

### Next.js Backend-for-Frontend

**Former direction:** Put OAuth and preference endpoints inside a Next.js application.

**Replacement:** React/Vite static PWA plus an independent Hono API service.

**Reason:** The product is client-heavy, offline, worker/WASM-oriented, and has no SSR/SEO need. A separate small API keeps responsibilities and deployments clean.

### Workspace-scoped settings in v1

**Former direction:** Global defaults plus per-workspace overrides.

**Replacement:** Only global user settings are exposed in v1. The persistence model may leave room for future scopes.

**Reason:** Workspace overrides add storage, sync, and UI complexity without enough immediate value. `.notemarkdownignore` handles workspace filtering separately.

### No spelling control

**Former direction:** Do not support spelling control.

**Replacement:** Offer browser-native spelling control as a global user preference.

**Reason:** The decision was explicitly revised. No external grammar or spelling service is introduced.

### Open source without supported self-hosting

**Former direction:** Publish source but support only the official hosted deployment.

**Replacement:** Open source under AGPL-3.0 with DCO and officially supported Docker Compose self-hosting.

**Reason:** Community operation and the ability for others to host at larger scale are desired product characteristics.

## Rejected v1 options

These are not necessarily permanently rejected; they require a new decision and roadmap placement.

- Entire Google Drive indexing instead of one selected folder.
- Backend proxying or storing document content.
- Realtime collaborative editing.
- Raw HTML execution.
- Interactive inline SVG.
- Browser-only canonical storage.
- Formatting toolbar.
- Command palette.
- Vim/Emacs modes.
- Frontmatter-specific behavior.
- Math and Mermaid rendering.
- Regex and fuzzy search.
- Automatic image compression.
- In-app Drive sharing controls.
- Long-lived JWTs in browser storage.
- Multithreaded WASM requiring cross-origin isolation.
- Official Kubernetes support in v1.
- Billing in v1.
- Immediate migration of existing tray and desktop applications.

## Archive entries after v1 planning

No additional entries yet.

### Entry template

```md
### Decision title

**Context/date:**

**Former decision:**

**Replacement:**

**Reason:**

**Consequences:**

**References:**
```
