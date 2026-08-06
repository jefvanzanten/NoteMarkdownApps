# 03. Product-wide Standards

## 1. Privacy and data minimization

- The API must never receive or store Markdown, images, file names, document paths, directory trees, rendered HTML, or search-index content.
- Drive content requests run directly between the browser and Google Drive with short-lived access tokens.
- Every new endpoint and analytics event must document its data fields and purpose.
- Sensitive values must not appear in logs, traces, URLs, error messages, or analytics properties.
- Local workspaces require no account.
- Explicit account deletion removes NoteMarkdown identity, sessions, connected-account credentials, preferences, and Drive workspace references, but never provider files.
- Self-hosters must be able to disable all non-operational telemetry.

## 2. Security

- Use opaque session IDs in `HttpOnly`, `Secure`, appropriately `SameSite` cookies.
- Store OAuth refresh tokens only in encrypted server-side storage.
- Keep short-lived Drive access tokens in memory rather than persistent JavaScript storage.
- Use minimum practical Google scopes and one explicitly selected Drive folder per workspace.
- Apply CSRF, state, PKCE where applicable, redirect URI, and session-fixation protections to OAuth flows.
- Raw Markdown HTML is never executed.
- Preview URLs allow only approved schemes and resolved workspace assets.
- SVG is static and restricted; never inject untrusted SVG directly into the application DOM.
- Use a restrictive Content Security Policy compatible with the PWA, workers, WASM, and selected OAuth flow.
- Dependency updates, container images, and contributions require automated checks and maintainer review.
- Protected branches and required CI are mandatory; pull requests are never accepted automatically.

## 3. Data ownership and portability

- Local workspaces are ordinary directories controlled through the operating system.
- Drive workspaces are ordinary Drive folders controlled through Google Drive.
- OPFS/IndexedDB is supporting storage only, not a third workspace provider.
- No custom export is required in v1 because provider files already remain portable.
- A browser cache must be safe to rebuild without changing provider content, except for explicitly identified unsynchronized drafts/operations that require recovery.

## 4. Content standards

- Editable documents are UTF-8 `.md` files only.
- Preserve a valid UTF-8 BOM and original line-ending style where practical.
- Do not automatically convert unknown legacy encodings.
- Markdown dialect is GFM.
- Raw HTML is unsupported.
- YAML frontmatter receives no special parsing or preview treatment in v1.
- Math, Mermaid, wiki links, and custom block syntax are not part of v1.
- Supported images: PNG, JPEG/JPG, GIF, WebP, AVIF, and safe static SVG.
- Pasted or dropped images are written unchanged to the active provider; never silently compress or convert them.

## 5. UX and interaction

### Application layout

- Left sidebar: search field followed by file tree or active search results.
- Desktop sidebar: collapsible and resizable.
- Mobile sidebar: temporary drawer/overlay.
- Main area: tabs plus one Editor/Preview pane.
- Editor/Preview toggle remains available at the top right of the document view.
- Do not add a permanent split view in v1.

### Editor interaction

- No formatting toolbar.
- No command palette.
- Markdown actions live in the shared editor command registry.
- Provide default keybindings and configurable mappings per command.
- Show keybinding conflicts before saving configuration.
- No Vim or Emacs mode in v1.
- Browser-native spellchecking is available and globally configurable.
- Link autocomplete suggests documents, supported images, and heading anchors.

### Status and errors

- Saving and synchronization state must be visible and understandable: saving, saved, offline, queued, syncing, conflict, retrying, or blocked.
- Never use a success state before local durability is confirmed.
- Never hide a failed or conflicted provider write behind a generic “saved” label.
- Errors must explain whether work is safe locally and what the user can do next.

### Destructive actions

- Delete is recoverable by default.
- Permanent deletion requires an explicit separate action.
- Rename/move previews all workspace-wide reference changes before confirmation when the operation is nontrivial.
- Multi-file path transactions are atomic from the user's perspective and recoverable through history where feasible.

## 6. Accessibility

WCAG 2.2 AA is a v1 release requirement.

- Every interactive function is keyboard reachable.
- Focus order is logical and visible.
- File tree, tabs, dialogs, toggle controls, sync status, and conflict editor expose correct names, roles, states, and relationships.
- Color is never the sole status indicator.
- Light and dark themes meet contrast requirements.
- Respect reduced motion and reduced transparency preferences where relevant.
- Dynamic search, save, sync, and conflict updates use appropriate non-disruptive announcements.
- Mobile touch targets meet accessible sizing expectations.
- Automated checks do not replace keyboard and screen-reader review.

## 7. Responsive and mobile behavior

- Mobile is a full editing target, not preview-only.
- Avoid layouts that depend on hover.
- Tabs may scroll or compact without hiding the active document state.
- Conflict resolution uses a mobile-appropriate unified/switchable presentation rather than forcing desktop columns.
- Local directory access limitations must be communicated as capability limitations, not generic errors.

## 8. Theming and localization

- Support light, dark, and system theme modes.
- Use shared CSS custom properties/design tokens across shell, editor, preview, dialogs, and status UI.
- Use CSS Modules for component styling.
- Support Dutch and English in v1.
- Detect system language initially and allow a global manual override.
- No user-facing strings are embedded outside the localization system, including errors and accessibility labels.
- Formatting of dates, times, quantities, and relative times uses locale-aware APIs.

## 9. Performance

Performance budgets are hard release criteria, not aspirations.

### Initial budgets

- Render a representative 1 MB Markdown document to preview within 100 ms on target benchmark hardware.
- Render a representative 10 MB Markdown document within 750 ms on target benchmark hardware.
- Typing, selection, and scrolling stay responsive while rendering, indexing, and syncing occur.
- Rendering runs outside the UI thread.
- Measure WASM fetch, compile/instantiate, first render, repeat render, output transfer, memory, and total bundle cost.

Budgets must be calibrated against documented representative desktop and lower-end mobile hardware. Regressions require an explicit reviewed exception.

### Large workspace target

- Approximately 10,000 supported files.
- Up to approximately 10 MB per Markdown document.
- File trees and search results must be virtualized when needed.
- Scanning and indexing are incremental and worker-based.
- Syntax highlighters load only for languages present in rendered code blocks.

## 10. Reliability and local-first behavior

- Persist drafts before attempting provider writes.
- Provider operations are retry-safe and durable across reloads.
- Autosave is debounced; `Ctrl/Cmd+S` requests immediate processing.
- Reconnect synchronization is automatic only while the app is open.
- Do not promise closed-app background Drive synchronization.
- Detect changes made by other tools and never silently overwrite them.
- Store enough base revision data for deterministic three-way merge.
- Preserve both sides until a conflict is explicitly resolved.
- PWA updates never force-reload an active session; prompt after work is safe.
- All persistent browser schema changes require forward migrations and recovery tests.

## 11. History and retention

- Persisted history is bounded and tiered; it is not unlimited.
- Recent versions may be dense while older versions are thinned.
- Apply a configurable storage ceiling and react safely to quota pressure.
- Default trash retention is 30 days.
- Local workspace history is device-local and must not add hidden history directories to the real workspace.
- Drive provider revisions may supplement, not replace, local recovery history.

Exact snapshot cadence and quota thresholds are implementation parameters that require test data before final defaults.

## 12. Search and diagnostics

- Search file names and Markdown content locally.
- Search is case-insensitive and supports exact quoted phrases.
- Regex and fuzzy matching are outside v1.
- A non-empty search replaces the file tree with results; clearing it restores the tree.
- Search indexes never leave the device.
- Detect broken internal Markdown links and missing supported images.
- Diagnostics must remain usable at the target workspace size.

## 13. Settings

- V1 exposes only global user settings.
- Anonymous settings remain local.
- After sign-in, allowed preferences and keybindings synchronize through the API.
- The persistence model may include a future scope field, but v1 UI and behavior must not expose workspace overrides.
- `.notemarkdownignore` remains a workspace file and is not part of global settings.

## 14. Observability

Use provider-independent instrumentation based on OpenTelemetry where applicable.

### Always-on operational metrics

- CDN and API traffic volume.
- API latency and errors.
- Active/revoked session counts at an appropriate aggregate level.
- Database connections, latency, storage, and saturation.
- Drive API requests, errors, throttling, and quota pressure.
- Deployment version and health.

### Default minimal product analytics

- Aggregate app starts and coarse feature/provider usage.
- No content, file names, paths, directory shape, or permanent fingerprint.
- Publish exact event schemas and retention.

### Opt-in detailed diagnostics

- Client crashes.
- WASM and worker timings.
- Memory and storage-pressure indicators.
- Coarsely bucketed workspace scale.
- Sync duration and error category.

Analytics, crash reporting, and OTLP destinations remain replaceable adapters.

## 15. Browser support and progressive enhancement

- Official baseline: latest two stable major versions of Chrome, Edge, Firefox, and Safari plus current iOS/Android browsers.
- Use runtime capability detection.
- Real local-directory workspaces are offered only where required capabilities are safe enough.
- Drive workspaces remain the complete cross-browser path.
- Unsupported capability messages must state what alternative remains available.

## 16. Open-source and self-hosting standards

- Project license: AGPL-3.0.
- Contributions require DCO signoff.
- Official self-hosting path in v1: Docker Compose.
- Self-host documentation covers OAuth, PostgreSQL, migrations, backups, secrets, TLS/reverse proxy, upgrades, and telemetry controls.
- Kubernetes/Helm support is outside v1.
- The official hosted app and supported self-hosted stack use the same released application code.

## 17. Product-wide non-regression rules

A change cannot ship if it:

- sends document content to the API;
- introduces a browser-only canonical workspace;
- silently overwrites a conflicting revision;
- requires an account for local work;
- blocks typing with render/index/sync work;
- makes a destructive action unrecoverable without explicit consent;
- breaks persistent local data without a tested migration;
- bypasses runtime API validation;
- makes an accessibility-critical interaction pointer-only;
- introduces app-specific copies of shared editor commands.
