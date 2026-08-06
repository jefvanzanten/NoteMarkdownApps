# 02. Domain & Glossary

## Purpose

This document defines product language and domain invariants. Names in code, API contracts, storage schemas, tests, and UI copy should follow these definitions unless an architecture decision explicitly says otherwise.

## Core domain model

### User

An internal NoteMarkdown identity. A user exists only after Google sign-in in v1. The internal user ID must not be a Google subject ID so that additional login providers can be added later.

### Anonymous user

A person using a local workspace without an account. Their preferences, keybindings, sessions, and history remain on the current browser/device.

### Connected account

A provider identity linked to a NoteMarkdown user. In v1 the only connected-account type is Google. It owns OAuth grants and encrypted refresh-token metadata, not document content.

### Session

A revocable authenticated API session. The browser receives only an opaque identifier in a secure, HTTP-only cookie. API instances remain stateless; durable session state is server-side.

### Workspace

The boundary within which files, folders, tabs, search, history, sync, and settings operate. Exactly one workspace is active per app window.

A workspace has one real provider and a stable app-side identity. Multiple workspaces may be remembered, but their file trees are never merged into one active tree in v1.

### Local workspace

A workspace whose provider source is a real directory on the user's computer. The directory and its ordinary files are primary. Browser storage may hold recovery data, history, indexes, and session metadata, but is not the workspace itself.

Full local-directory behavior is capability-dependent and primarily available in Chromium browsers.

### Drive workspace

A workspace whose provider source is one explicitly selected Google Drive folder. It is not the entire Drive. The browser keeps a durable local mirror for offline work and reconciles it with Drive while the app is open.

### Browser-only workspace

A workspace whose canonical files exist only in OPFS or IndexedDB. **This is not a supported domain concept.** Browser storage cannot be selected as a third provider in v1.

### Workspace provider

An adapter implementing the shared file and revision operations required by the workspace domain. Initial implementations are `LocalWorkspaceProvider` and `DriveWorkspaceProvider`.

Provider capability differences must be explicit. The core must not infer provider type through scattered conditionals.

### Provider source

The externally visible files controlled by the selected provider: a real local directory or Drive folder. The backend is never a provider source.

### Local mirror

A browser-resident working copy of Drive workspace content used for offline access, local-first writes, and synchronization. It is encrypted and tied to the account/device lifecycle.

A local workspace may also cache content for recovery and indexing, but its real directory remains primary.

### Cache

Rebuildable local data used to improve performance, such as parsed metadata, tree state, rendered results, and fetched images. Deleting only a cache must not destroy the provider files.

### Draft

A durable local representation of editor changes that may not yet have reached the provider source. Draft persistence precedes provider writes so a crash or network interruption does not lose typed work.

### Revision

A known version of a file. A revision may be represented by Drive revision metadata, local file metadata plus a content hash, or a local history ID.

### Base revision

The last version known to be common between local and remote/provider state. It is the base input for three-way merge.

### Local revision

The content currently edited or queued on the device.

### Remote revision

A newer provider version discovered after the base revision, typically from Drive or an external local editor.

### Sync operation

A durable intended provider mutation: create, update, rename, move, trash, restore, or asset write. Operations have stable IDs and retry-safe semantics.

### Sync queue

The ordered set of pending Drive operations. It is processed only while the app is open. It survives reloads and network loss.

### Synchronization

The foreground process that discovers provider changes, applies queued operations, checks revisions, and updates the base state. It starts at app/workspace open, during use, and when an open app regains connectivity.

### Conflict

A state where both local and remote content changed from the same base and cannot be merged safely without a user decision.

### Three-way merge

A merge using base, local, and remote revisions. Non-overlapping changes are merged automatically. Overlapping changes enter the visual conflict editor. No strategy may silently discard one side.

### External change

A provider mutation made outside the current NoteMarkdown session, for example in VS Code or the Google Drive interface.

### Autosave

The debounced process that first persists editor state locally and then writes or queues it for the active provider. `Ctrl/Cmd+S` requests immediate processing but does not bypass revision safety.

### Document

An editable UTF-8 file with a `.md` extension. No other extension is treated as Markdown in v1.

### Asset

A supported image stored in the active workspace and referenced from Markdown. Supported formats are PNG, JPEG/JPG, GIF, WebP, AVIF, and SVG.

### Asset directory

The globally configured workspace-relative directory used when NoteMarkdown inserts pasted, dropped, or selected images. The default is `assets/`.

### Safe SVG

An SVG displayed only as a static image under restrictive policy. It must not inject arbitrary inline DOM, run scripts, attach event handlers, or load uncontrolled external resources.

### Raw HTML

HTML authored inside Markdown. Raw HTML is unsupported in v1 and must not be executed in preview output.

### File tree

The hierarchical view of supported workspace folders, `.md` documents, and supported images. It is collapsible, resizable on desktop, and displayed as a drawer on mobile.

### Search index

A local, incrementally maintained index of Markdown file names and content. It never leaves the device and must not be stored by the API.

### Workspace diagnostics

Locally derived issues such as broken internal links and missing image targets.

### Tab

An open document view with per-document cursor, scroll, and Editor/Preview state. Multiple tabs may be open within the single active workspace.

### Session restoration

Restoring active workspace, tabs, active tab, cursor positions, scroll positions, view modes, sidebar state, and relevant unsynchronized work.

### Trash

A recoverable deletion state implemented according to provider capabilities. Drive uses Drive trash; local/browser support uses an app-managed recovery mechanism. Default retention is 30 days.

### Version history

Persisted recoverable document revisions beyond in-memory undo/redo. Local history is device-bound, bounded, and tiered. Drive history may additionally expose available provider revisions.

### Command

A named editor or app action with stable identity, availability rules, and optional keybinding. Shared Markdown editing commands belong to `@note/editor`.

### Keybinding

A configurable mapping from a keyboard chord to a command. V1 provides a standard keymap and per-command remapping, not Vim or Emacs modal modes.

### Renderer

The Rust/WASM pipeline that transforms GFM Markdown into safe preview HTML and mapping metadata.

### Render worker

The Web Worker hosting the single-threaded WASM renderer. Single-threaded refers to one render task; the application may use other workers concurrently.

### Source mapping

Offsets linking Markdown source ranges to rendered sections. Source mapping supports preserving the user's document position when switching between Editor and Preview.

### PWA app shell

The static HTML, CSS, JavaScript, worker, and WASM assets required to launch NoteMarkdown offline.

### API

The Hono service responsible for authentication, connected accounts, sessions, Drive workspace references, global preferences, and operational endpoints. It is not a content or render service.

### Operational metrics

Always-on infrastructure measurements such as request volume, latency, errors, active sessions, database load, CDN load, and provider quota pressure.

### Product analytics

Minimal aggregate events such as app starts and provider-category usage. They must not include document content, file names, paths, or a permanent fingerprint.

### Detailed diagnostics

Opt-in client crash and performance data, including appropriately bucketed workspace scale or WASM timings. It must obey the same content and path exclusions.

## Domain invariants

1. A workspace has exactly one provider.
2. Browser storage is never the only canonical workspace provider.
3. Only one workspace is active per app window.
4. Backend endpoints never accept Markdown or image payloads.
5. Provider content flows only between the browser and local filesystem or Drive.
6. Every write is locally durable before a remote write is considered complete.
7. A provider update must be revision-checked before overwrite.
8. Conflicts preserve base, local, and remote inputs until resolved.
9. Deletion is recoverable until retention expiry or explicit permanent deletion.
10. Search and diagnostics are computed locally.
11. Explicit logout locks retained Drive mirror content.
12. Account deletion never deletes provider files.
13. Global settings are the only user-configurable settings scope in v1.
14. Workspace-specific ignore behavior may be declared by `.notemarkdownignore`; that file is workspace content, not a global setting.
15. File-management transactions that change paths update known internal references or fail without partial silent corruption.

## Common state vocabularies

### Document save state

- `clean`
- `dirty-local`
- `persisting-local`
- `queued-provider-write`
- `syncing`
- `synced`
- `conflicted`
- `error-retryable`
- `error-blocking`

### Workspace connectivity state

- `local`
- `offline`
- `online-idle`
- `syncing`
- `attention-required`
- `permission-required`
- `locked`

### Sync operation state

- `pending`
- `in-flight`
- `applied`
- `retryable`
- `conflicted`
- `failed`

The exact TypeScript representation may differ, but UI, telemetry, and tests should use one shared semantic vocabulary.
