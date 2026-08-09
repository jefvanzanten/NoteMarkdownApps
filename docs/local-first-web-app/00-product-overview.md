# 00. Product Overview

## Status

Living product specification. The decisions in this document were confirmed during the initial product grilling session.

## Product

**NoteMarkdown** is a local-first Markdown editor delivered as an installable web app. It opens ordinary Markdown workspaces, edits them with the shared CodeMirror 6 editor, and parses and renders previews locally with Rust compiled to WebAssembly.

A workspace is backed by exactly one real storage provider:

- a directory on the user's computer; or
- one explicitly selected folder in Google Drive.

Browser storage supports caching, offline work, search, drafts, and history. It is never a standalone source of truth.

## Product promise

Users keep control of their documents. NoteMarkdown does not require an account for local workspaces, does not copy document content to its backend, and does not invent a proprietary document format.

The product should feel like a focused desktop Markdown editor while retaining the reach and installability of a PWA.

## Primary audience

Version 1 is personal-first: it must work well for one person without requiring account or server infrastructure for local work. Its identities, sessions, provider connections, and backend storage must nevertheless be multi-user-safe from the start.

The public product may later serve many users, but v1 does not include billing or realtime collaborative editing.

## Core principles

1. **Local-first** — edits are durably captured on the device before remote synchronization.
2. **Ordinary files** — Markdown and images remain accessible through the selected storage provider.
3. **Privacy boundary** — document content never passes through or persists on the NoteMarkdown API.
4. **Offline capable** — the PWA, editor, renderer, search, cached documents, and pending edits work without a network connection.
5. **Provider abstraction** — local directories and Drive folders implement one shared workspace contract.
6. **Performance by design** — parsing runs locally in a worker and performance budgets are release gates.
7. **Safe by default** — no raw HTML, no executable SVG, no silent conflict overwrite, and recoverable deletion.
8. **Portable deployment** — the official service and self-hosted installations use the same provider-independent architecture.
9. **Shared foundations** — editor and workspace capabilities live in packages that existing NoteMarkdown apps can adopt later.
10. **Instant return** — a cached workspace becomes interactive from local durable state before remote reconciliation completes; remote providers are never on the warm-start render path.

## Primary user journeys

### Local workspace

1. Open NoteMarkdown without signing in.
2. Choose or create a real local directory where the browser supports directory access.
3. Browse files in the tree and open documents in tabs.
4. Edit with CodeMirror and toggle to the Rust-rendered preview.
5. Save automatically to the real directory while local recovery data and history remain in browser storage.

### Google Drive workspace

1. Sign in with Google only when Drive is needed.
2. Open an existing Drive folder or create a new workspace folder.
3. Mirror all Markdown and referenced images locally for offline use.
4. Edit locally and synchronize automatically while the app is open.
5. Resolve concurrent or external edits through revision checks and three-way merge.

### Returning user

1. Launch the installed PWA or website.
2. Reopen the last workspace when permission and identity allow it.
3. Restore the local workspace manifest, tabs, active cached document, search index, cursor, scroll positions, sidebar dimensions, and Editor/Preview mode without waiting for remote I/O; Drive-derived sensitive state is encrypted.
4. Prioritize revision checks for the active document and open tabs, then reconcile the rest of the workspace in bounded background batches.
5. Download and re-index only new or changed Markdown content; unchanged content remains in the local cache.

## Main experience

- Collapsible and resizable file sidebar on desktop.
- Sidebar drawer on mobile.
- Search field permanently above the file tree; search results replace the tree while a query is active.
- Multiple open documents in tabs.
- One main document pane with a top-right **Editor / Preview** toggle; no permanent split view.
- No formatting toolbar and no command palette.
- Shared editor command registry with configurable keybindings.
- Light, dark, and system themes.
- Dutch and English UI.
- Full mobile editing and preview support.

## Supported content

### Editable

- UTF-8 `.md` files only.
- GitHub Flavored Markdown (GFM).

### Assets

- PNG
- JPEG/JPG
- GIF
- WebP
- AVIF
- SVG, rendered statically and safely

Other document and attachment types are outside v1.

### Rendering rules

- Rust/WASM parses and renders Markdown with `pulldown-cmark`.
- Raw HTML is not supported or executed.
- Code blocks receive lazy-loaded syntax highlighting.
- Math, Mermaid, wiki-link syntax, and special frontmatter handling are outside v1.
- Preview and editor positions remain associated when toggling.

## Supported environments

- Latest two stable major versions of Chrome, Edge, Firefox, and Safari.
- Current iOS and Android browsers.
- Full local directory access depends on browser capability and is expected primarily in Chromium.
- Drive workspaces are the full cross-browser workspace path.
- Installable PWA with an offline app shell.

## Privacy and data ownership

The backend may store:

- internal user identity;
- connected Google account metadata;
- encrypted refresh tokens;
- server-side sessions;
- global user preferences and keybindings;
- Drive folder IDs and user-facing workspace display names;
- operational and explicitly allowed analytics data.

The backend must not receive or store:

- Markdown content;
- image content;
- file names;
- document paths;
- workspace directory trees;
- search indexes.

Account deletion removes NoteMarkdown account data and provider connections, never local or Drive files.

## v1 goals

- Complete local and Drive workspace flows.
- Durable offline editing and automatic foreground synchronization.
- Safe autosave, history, trash, external-change detection, and conflict handling.
- Fast local rendering and full-text search for serious workspaces.
- Accessible, responsive, bilingual PWA.
- Multi-user-safe hosted API and supported Docker Compose self-hosting.
- Reliable migrations, tests, observability, and upgrade behavior.
- A warm 10,000-entry workspace that is locally interactive within one second on defined lower-end mobile benchmark hardware and performs no content download for unchanged Drive Markdown.

## Explicit non-goals for v1

- Realtime co-editing or presence.
- A proprietary NoteMarkdown cloud document store.
- Raw HTML execution.
- Full Google Drive indexing.
- In-app Drive sharing controls.
- Browser-only canonical workspaces.
- Rich-text/WYSIWYG editing.
- Formatting toolbar or command palette.
- Vim or Emacs editing modes.
- Regex or fuzzy search.
- Math or Mermaid rendering.
- Custom PDF engine; browser print-to-PDF is sufficient.
- Billing and subscriptions.
- Official Kubernetes support.
- Immediate migration of existing tray and desktop apps.

## v1 completion

`v1.0` is not the first local prototype. It is reached only after all roadmap milestones deliver local-first editing, PWA/offline behavior, Drive authentication and synchronization, cross-browser hardening, accessibility, performance, migration safety, and public-release quality.

Current protected desktop Drive evidence supports an MVP/private-beta sync verdict but leaves cold progressive discovery, passive propagation cadence, and the browser/mobile/conflict matrix open. See [Google Drive Sync Qualification](08-drive-sync-qualification.md).
