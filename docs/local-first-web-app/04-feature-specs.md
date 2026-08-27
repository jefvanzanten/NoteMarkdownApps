# 04. Feature Specs

## Specification conventions

- Unless marked otherwise, every feature in this document is required for v1.
- “Locally durable” means work survives reload/crash in supporting browser storage before provider completion.
- Provider-specific behavior must implement the shared domain semantics rather than leaking special cases into unrelated UI.
- Accessibility, localization, performance, privacy, and tests are acceptance criteria for every feature.

## F01 — Workspace start and switching

### User value

Open the editor quickly and continue where work stopped.

### Requirements

- Attempt to reopen the last active workspace at launch.
- Restore it only if filesystem permission or Drive identity/repository lock state permits safe access.
- Otherwise show a workspace screen with recent workspaces and actions to open or create one.
- Remember multiple workspace references, but activate only one per app window.
- Switching workspace closes the active workspace context only after drafts and queue state are durable.
- Local workspace actions do not require login.
- Drive actions trigger Google authentication only when necessary.
- Restore a usable local manifest, tabs, active cached document, and warm search state before remote reconciliation. A local-directory cache remains locked until filesystem permission is confirmed; an encrypted Drive cache remains usable when its device key is available even if reauthentication is required for sync.
- Reconcile through one bounded priority queue: active document, other open tabs, pending writes/conflicts, then remaining new or changed documents.
- During a cold Drive activation, expose truthful authentication/scan/restore/index phases and make the first useful selected-folder level available without presenting an indeterminate complete-tree wait as progress.

### Acceptance criteria

- Relaunch restores the last usable workspace without unnecessary navigation.
- Revoked permission produces a clear reauthorization action, not data loss.
- Switching cannot mix tabs, indexes, histories, or sync operations between workspaces.
- On defined lower-end mobile benchmark hardware, a cached 10,000-entry workspace is interactive within one second without waiting for remote I/O.

## F02 — Local directory workspace

### User value

Edit ordinary files directly on the computer without an account.

### Requirements

- Open or create a real directory through supported browser capabilities.
- Read and write supported files through the provider abstraction.
- Detect permission loss and provide a reauthorization flow.
- Detect external changes on focus and through reasonable periodic checks while open.
- Preserve the directory as the provider source; never replace it with browser-only storage.
- Communicate unsupported local-directory capability and offer Drive where available.

### Acceptance criteria

- Edited content appears in the actual `.md` file.
- Changes made by another application are detected before NoteMarkdown overwrites them.
- Unsupported browsers do not show a misleading or broken local-workspace workflow.

## F03 — Google Drive workspace

### User value

Use one Drive folder as a cross-device, cross-browser Markdown workspace.

### Requirements

- Authenticate with Google only for Drive use.
- Let the user select one existing Drive folder or create a new folder.
- Never index the user's entire Drive.
- Remember linked folder IDs and display names through the API.
- Transfer files directly between browser and Drive using short-lived credentials.
- Maintain one local encrypted document repository and workspace manifest. All Drive-derived content and sensitive metadata, including names, paths, indexes, drafts, history, and pending operations, follow the repository locking rules.
- Mirror Markdown in background priority order. Keep image metadata in the manifest; load image binaries lazily until the milestone-4 image-mirroring work enables referenced-image mirroring and optional pinning.
- Load other supported images on demand and permit explicit offline pinning.
- Synchronize only while the app is open: at open, during use, and after reconnection.
- Expose queue, progress, checking, incomplete-index, errors, retry, and conflict states.
- Use metadata-first revision checks and download content only when the observed provider revision differs from the cached-content revision.
- Prefer SHA-256/MD5 content identity for Drive revisions. Treat an opaque provider-version change with the same strong checksum and size as unchanged content rather than a conflict.
- Traverse initial selected-folder metadata with deterministic bounded concurrency, never outside the selected folder, and progressively expose usable tree state while deeper discovery continues.
- After initialization, use Drive Changes tokens for normal delta discovery. Fall back to a full scan for missing/invalid tokens, ambiguous ancestry changes, and a periodic visible-online safety check.
- In-app Drive sharing management is not provided.

### Acceptance criteria

- Document/image payloads never reach the NoteMarkdown API.
- A linked workspace reappears on another device after login.
- The cached workspace remains usable offline according to repository retention and locking rules.
- Explicit logout locks retained repository content.
- A warm start with no remote changes downloads zero Markdown content; one changed document causes at most one required content download.
- A Google version-only increment with identical strong content identity does not create a false conflict.
- Cold activation identifies its current phase and remains responsive/cancellable while selected-folder metadata is discovered.

## F04 — File sidebar

### User value

Navigate a workspace without leaving the editor.

### Requirements

- Show a search field above the content area at all times.
- With no query, show a hierarchical file tree.
- With a query, replace the tree with search results.
- Allow folder expansion/collapse.
- Make the sidebar collapsible and width-adjustable on desktop.
- Place a workspace switcher at the bottom left for recent workspaces, local browsing, and Drive workspace selection/creation.
- Place a settings menu at the bottom right for global settings, diagnostics, recovery, and language; do not reserve a permanent application top bar for these actions.
- Present the sidebar as an accessible drawer on mobile, opened from the document tab row.
- Virtualize large trees and result sets.
- Show `.md` files and supported image formats.
- Hide dotfiles and common technical directories by default.
- Apply additional `.notemarkdownignore` patterns.

### Acceptance criteria

- Keyboard and screen-reader users can navigate, expand, select, and operate tree items.
- A 10,000-file workspace does not render 10,000 interactive rows at once.
- Clearing search restores the previous tree state.

## F05 — File and folder management

### User value

Manage a complete workspace from inside NoteMarkdown.

### Requirements

- Create, rename, move, trash, restore, and permanently delete supported documents, images, and folders as capabilities allow.
- New documents use `.md`.
- Deletion is recoverable by default.
- Drive uses Drive trash; local recovery uses a provider-appropriate app mechanism.
- Trash retention defaults to 30 days and can be manually emptied.
- Rename/move operations identify and update relative Markdown links and image references across the workspace.
- Show affected files before a broad reference update.
- Treat path changes and reference edits as one recoverable user transaction.
- Resolve name collisions explicitly; never overwrite silently.

### Acceptance criteria

- Moving a referenced document or image does not leave known references broken.
- A partial provider failure cannot be presented as a completed transaction.
- Trashed files can be restored before expiry.

## F06 — Tabs and session restoration

### User value

Work across several documents and return to the same context later.

### Requirements

- Open documents in multiple tabs in the single active workspace.
- Track active tab and per-tab cursor, selection, editor scroll, preview scroll, and view mode.
- Restore tabs and layout per workspace after reload/relaunch.
- Handle externally deleted, moved, or conflicted open files without crashing or losing the local buffer.
- Give the active document and open tabs immediate metadata-check priority. A confirmed remote delete closes the tab with a brief accessible “go up in smoke” transition; a dirty draft first becomes a persistent recovery item.
- Keep a stable Drive document open across remote rename/move and transactionally update all path-dependent state.
- Enforce one editing lease per document across browser tabs; non-owning tabs open read-only and may explicitly take over.
- Keep the active tab reachable on narrow screens.

### Acceptance criteria

- Relaunch returns to the prior active document and relevant position.
- Restored state never opens a document from a different workspace identity.
- A destroyed dirty draft remains discoverable and restorable as a new file until the user explicitly removes it.

## F07 — Shared Markdown editor

### User value

Use a fast, consistent Markdown editing experience across NoteMarkdown applications.

### Requirements

- Continue using CodeMirror 6 in `@note/editor`.
- Keep editor command implementations in the shared package.
- Provide a stable command registry with command IDs, labels, availability, execution, and default bindings.
- Support globally configurable keybindings per command and detect binding conflicts.
- Store anonymous keybindings locally and sync them as user preferences after sign-in.
- Provide Markdown syntax highlighting and normal undo/redo.
- Provide browser-native spelling control as a global preference.
- Provide relative link autocomplete for documents, supported images, and heading anchors.
- Do not provide a formatting toolbar, command palette, Vim mode, or Emacs mode in v1.
- Changes to `@note/editor` remain backward-compatible for existing apps during web v1 development.

### Acceptance criteria

- Shared commands do not require duplicate app-level implementations.
- Remapped bindings survive reload and account synchronization.
- Editor input remains responsive during rendering, indexing, sync, and autosave.

## F08 — Markdown preview

### User value

See a safe, fast representation of the current Markdown.

### Requirements

- Toggle between Editor and Preview in one main pane.
- Parse and render GFM through `pulldown-cmark` in Rust/WASM.
- Run rendering in one dedicated Web Worker, outside the UI thread.
- Re-render live using adaptive debounce while editing.
- Disable execution of raw HTML.
- Render safe relative links and supported images.
- Open relative `.md` links inside the app in tabs.
- Support heading anchors.
- Preserve relevant source/scroll position when toggling modes.
- Lazy-load syntax highlighting only for fenced-code languages present in the document.
- Use print-specific styles and support browser print-to-PDF.
- Do not interpret frontmatter specially.
- Do not support Math or Mermaid in v1.

### Acceptance criteria

- Toggling to preview is immediate under normal editing load.
- Untrusted Markdown and SVG fixtures cannot execute script or inject unsafe DOM.
- Preview and editor remain near the same logical document section.

## F09 — Image insertion and display

### User value

Add images without manually managing links and paths.

### Requirements

- Accept supported images through paste, drag/drop, or file selection.
- Write the original bytes unchanged to the active provider's configured `assets/` directory.
- Generate a safe unique file name on collision.
- Insert a relative Markdown image link through a shared editor command.
- Show supported images in the file tree.
- Display SVG only under the safe static policy.
- Do not automatically compress, resize, or convert images.

### Acceptance criteria

- A locally inserted image exists in the real local directory.
- A Drive-inserted image exists in the selected Drive workspace.
- Failed asset writes do not leave a successful Markdown reference to a nonexistent image.

## F10 — Autosave and local durability

### User value

Avoid losing work without repeatedly invoking Save.

### Requirements

- Persist changes to a local draft after a short debounce.
- Persist an idempotent pending-write record with the expected base revision, outbox format version, creation time, and last-attempt time for every document intended for provider synchronization.
- Write local-provider content or enqueue Drive writes after local durability.
- Make `Ctrl/Cmd+S` request immediate processing.
- Show distinct local-persistence and provider-sync states where relevant. Drive uses provider-specific language such as syncing, synchronized, queued, offline, and conflict rather than local-disk wording.
- Use adaptive behavior for very large files without sacrificing safety.
- Recover durable drafts after crash/reload.
- Never label a document fully synchronized while a provider write is pending, failed, or conflicted.
- When token acquisition fails, distinguish NoteMarkdown session expiry/revocation, Google reauthorization, internal API failure, and direct Drive/provider failure. State explicitly that the draft remains local and whether the write is queued.

### Acceptance criteria

- Closing/reopening after a network failure recovers typed Drive changes.
- A provider content-revision mismatch preserves base, local, and remote inputs and routes to conflict/merge rather than overwrite; provider version-only drift with the same strong checksum is not a content conflict.
- Editing from an unverified warm cache remains locally durable, while its provider write waits for metadata verification.
- A NoteMarkdown API 401 during Drive-token renewal performs no Drive mutation, keeps the draft durable and queued, and presents an explicit sign-in action rather than a generic operation/provider error.
- Legacy, unsupported-format, or more-than-30-day-old outbox items are never uploaded automatically. They become blocked while the draft remains durable; an explicit fresh save creates a current write. An `in-flight` item abandoned by a terminated runtime becomes resumable only after a bounded safety interval and fresh provider-revision verification.

## F11 — Offline behavior and synchronization

### User value

Keep working without a network and reconcile safely later.

### Requirements

- Cache the PWA shell and Rust/WASM assets for offline launch.
- Make all retained Drive Markdown and referenced images available offline according to repository retention and pinning policy.
- Persist sync operations durably.
- On reconnection while open, automatically discover remote changes and process the queue.
- Keep a manual sync/retry action.
- Continue syncing unrelated files when one file conflicts where safe.
- Do not claim closed-PWA background synchronization.
- Handle Drive throttling with bounded backoff, jitter, `Retry-After`, request deduplication, and visible status.
- Keep observed-provider revision, cached-content revision, and index revision separate. Never advance the content/index revision before matching data is durably committed.
- Pause low-priority content downloads when the app is hidden or data-saver/very-slow-network signals are active. Continue priority revision checks and user-requested synchronization where possible.
- Elect one sync leader per workspace across browser tabs; followers consume durable updates instead of duplicating provider scans.

### Acceptance criteria

- Offline edits survive reload and synchronize after reconnection.
- Retried operations are idempotent and do not create duplicate files.
- One conflict does not silently discard later operations.
- Reconnect processes active/open documents and pending writes before background index completeness work.

## F12 — Conflict resolution

### User value

Resolve concurrent edits without understanding Git conflict syntax.

### Requirements

- Keep a base revision for every synchronized editable document.
- Perform a deterministic three-way merge for base/local/remote.
- Apply non-overlapping changes automatically.
- Open unresolved overlaps in a visual conflict editor.
- Desktop presentation compares versions side by side; mobile uses a switchable/unified presentation.
- Preserve all inputs until the user confirms a result.
- Save and synchronize only the confirmed resolved result.
- Do not insert raw `<<<<<<<` markers as the primary UX.

### Acceptance criteria

- Standard merge fixtures produce deterministic results.
- Canceling resolution preserves the conflict and all versions.
- Resolving one conflict cannot overwrite a newer unseen provider revision.

## F13 — Full-text search

### User value

Find information quickly in large workspaces without uploading content.

### Requirements

- Index `.md` file names and Markdown content locally.
- Update the index incrementally on create, edit, move, rename, trash, restore, external change, and sync.
- Run expensive indexing work outside the UI thread.
- Search case-insensitively.
- Support exact phrases in quotation marks.
- Show file and contextual text snippets.
- Open results in tabs.
- Keep index data local and apply Drive-repository locking rules.
- Load the warm index immediately, track the revision/generation represented by each indexed document, and reconcile changed or removed documents incrementally.
- Regex and fuzzy matching are outside v1.

### Acceptance criteria

- Search remains interactive at approximately 10,000 files.
- Deleted/trash content does not appear as a normal live result.
- Search remains available during reconciliation and clearly indicates when background updates are incomplete.
- Search cannot leak content through API, analytics, logs, or URLs.

## F14 — Version history and trash

### User value

Recover from accidental edits and deletion even with autosave enabled.

### Requirements

- Persist history beyond CodeMirror's active undo stack.
- Store local-workspace history only on the current device.
- Use bounded and tiered retention with an enforceable storage ceiling.
- Integrate available Drive revisions where practical without depending on them exclusively.
- Provide revision preview and explicit restore.
- Keep trash separate from document revision history.
- Default trash expiry is 30 days.

### Acceptance criteria

- Restoring a revision creates a new current revision rather than deleting later evidence immediately.
- Quota cleanup follows deterministic retention rules and never deletes current drafts.

## F15 — Workspace diagnostics

### User value

Discover broken relationships before they are encountered manually.

### Requirements

- Detect missing targets for relative `.md` links.
- Detect missing supported images.
- Mark problems in editor/preview without blocking editing.
- Provide a workspace-level diagnostics view reachable without a command palette.
- Recalculate incrementally after path and content changes.
- Track diagnostics generations separately from observed metadata so a stale warm result is never represented as fully reconciled.

### Acceptance criteria

- A rename transaction that updates links clears corresponding diagnostics.
- False positives from ignored or unsupported content are minimized and test-covered.

## F16 — Global settings

### User value

Keep personal preferences consistent without project configuration complexity.

### Requirements

- V1 settings are global only.
- Include theme, language, spellcheck, keybindings, asset-directory default, and permitted UI preferences.
- Store settings locally for anonymous use.
- Synchronize allowed settings after Google sign-in.
- Resolve first-login local/server differences without silently discarding recent user changes.
- Keep a future-compatible scope field internally if useful, but do not expose workspace overrides.

### Acceptance criteria

- Settings apply consistently to shell, CodeMirror, preview, and mobile views.
- A self-hosted deployment can use the same settings contracts.

## F17 — PWA installation and updates

### User value

Install NoteMarkdown and use it like a desktop application.

### Requirements

- Provide valid install metadata and icons.
- Cache the versioned app shell, workers, and WASM.
- Detect available updates.
- Show an update prompt rather than force reloading.
- Enable reload only after current drafts and operation queues are durably safe.
- Keep local persistent schema migrations compatible across app versions.
- Coordinate schema upgrades across app tabs. A blocked upgrade asks older tabs to close/update and never clears site data.
- During the workspace-cache migration, purge rebuildable plaintext Drive search/cache data, transactionally encrypt irreplaceable drafts/history, and import existing encrypted mirror content only after its revision is matched.

### Acceptance criteria

- An update during active offline editing cannot lose work.
- A failed migration enters recoverable error handling rather than clearing storage.
- Corrupt cache records are isolated. Rebuildable records may be refetched, while drafts, pending writes, conflicts, base versions, and recovery items are retained for explicit recovery.

## F18 — Authentication, account, and preferences

### User value

Connect Drive securely without requiring an account for local work.

### Requirements

- V1 sign-in method is Google only.
- Keep internal User and ConnectedAccount identities separate.
- Use revocable server sessions and secure cookies.
- Let users disconnect Google and delete their NoteMarkdown account.
- Account deletion removes NoteMarkdown metadata, sessions, tokens, and preferences only.
- Linked Drive workspaces reappear on new devices after sign-in to the same NoteMarkdown deployment. Sessions and linked workspace references are deployment/origin specific; a local development database does not inherit production sessions or references.
- Distinguish an expired/revoked NoteMarkdown session from a connected Google account that requires renewed authorization.
- In-app Drive sharing controls are out of scope.

### Acceptance criteria

- One user's tokens and workspace references are inaccessible to every other user.
- Local workspace functionality remains available when signed out or the API is unavailable.
- Session-expiry and Google-reauthorization paths preserve every durable local draft and provide different actionable messages.

## F19 — Observability and diagnostics consent

### User value

Receive a reliable product without sacrificing document privacy.

### Requirements

- Collect operational service metrics by default.
- Collect minimal aggregate product usage by default under a published schema.
- Ask explicit consent for detailed client crash and performance diagnostics.
- Never include document content, file names, paths, directory structure, or permanent fingerprints.
- Correlate unexpected API failures with a random diagnostic reference present in both the safe client response and a reason-bearing server log. Never expose the internal exception to the client.
- Let self-hosters disable non-operational collection.
- Use replaceable OpenTelemetry, analytics, and crash adapters.

### Acceptance criteria

- Operators can detect a sudden increase to thousands of users through CDN/API/database/provider metrics.
- Event-schema tests reject forbidden properties.

## F20 — Self-hosting

### User value

Run a supported NoteMarkdown deployment outside the official service.

### Requirements

- Publish versioned web and API container images.
- Provide Docker Compose as the official v1 path.
- Document PostgreSQL, migrations, backups, restore, secrets, token-encryption keys, Google OAuth, TLS/reverse proxy, upgrades, and telemetry.
- Provide health/readiness behavior suitable for container operation.
- Keep deployment provider-independent.
- Do not claim official Kubernetes support in v1.

### Acceptance criteria

- A clean documented installation can sign in, link Drive, and upgrade between supported releases.
- Backup/restore and key-handling procedures are tested, not documentation-only assumptions.

## Feature-level exclusions recap

V1 deliberately excludes realtime collaboration, billing, browser-only workspaces, whole-Drive search, raw HTML, interactive SVG, frontmatter semantics, Math, Mermaid, custom wiki syntax, formatting toolbar, command palette, Vim/Emacs modes, regex/fuzzy search, image optimization, in-app Drive sharing, custom PDF generation, closed-app Drive sync, and immediate migration of existing apps.
