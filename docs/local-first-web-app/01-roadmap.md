# 01. Roadmap

## Roadmap principles

- Build vertical slices that can be exercised end to end.
- Validate high-risk browser and storage behavior early.
- Keep existing tray and desktop apps working during web-app development.
- Put reusable behavior in shared packages, but avoid premature migration work.
- Treat data safety, performance, accessibility, and migrations as release work rather than post-release cleanup.

## Release naming

- Milestone builds may be called prototype, alpha, or beta.
- Only completion of milestones 1–4 qualifies as `v1.0`.
- Each milestone must have a demonstrable user journey and explicit exit criteria.

## Milestone 1 — Local editing foundation

### Objective

Deliver a useful Chromium-first local Markdown editor while proving the shared editor and Rust/WASM rendering boundary.

### Scope

- Bootstrap `apps/web-app` with React and Vite.
- Establish shared design tokens and responsive application shell.
- Reuse and extend `@note/editor` with a command registry and configurable keybinding model.
- Implement actual local-directory workspaces through a provider abstraction.
- Add file tree, tabs, session state, and Editor/Preview toggle.
- Compile `pulldown-cmark` to WASM and run rendering outside the UI thread.
- Render GFM with raw HTML disabled.
- Add lazy preview syntax highlighting.
- Implement basic create, rename, move, recoverable delete, and save operations.
- Preserve UTF-8 BOM and line endings where possible.
- Support relative links and safe supported images.

### Exit criteria

- A user can open a real local directory, edit `.md` files, preview them, and see changes written to disk.
- Rendering never blocks editor input.
- Existing consumers of `@note/editor` remain functional.
- Core editor and workspace-provider contract tests pass.
- Initial performance budgets pass on representative desktop and mobile hardware.

## Milestone 2 — Local-first PWA

### Objective

Make the local experience durable, searchable, recoverable, and installable.

### Scope

- PWA manifest, service worker, offline app shell, and safe update prompt.
- IndexedDB/OPFS support for drafts, cache, history, indexes, and session restoration.
- Full-text search over file names and Markdown content.
- Search results in the sidebar in place of the file tree.
- Incremental indexing in background workers.
- Bounded, tiered version history.
- Provider-specific trash with 30-day default retention.
- External file change detection and reconciliation.
- Workspace diagnostics for broken links and missing images.
- Workspace-wide link updates during rename/move transactions.
- Image paste, drag/drop, and file selection into the real workspace asset directory.
- Browser-native spelling control.
- Print-friendly preview and browser print-to-PDF.
- Full session restoration.
- Light/dark/system themes and Dutch/English localization.
- Cross-browser capability fallbacks and mobile hardening.

### Exit criteria

- The app reopens offline with cached application assets and safely retained work.
- Supported browsers pass the required local or Drive workflow matrix.
- Search remains responsive at the target workspace size.
- Browser data migrations preserve drafts, history, indexes, and session state.
- External edits are never silently overwritten.
- Accessibility checks cover primary local workflows.

## Milestone 3 — Accounts and Google Drive

### Objective

Add a multi-user-safe API and Google Drive as the first remote workspace provider without crossing the document-content privacy boundary.

### Scope

- Bootstrap `apps/api` with Hono.
- PostgreSQL schema and Drizzle migrations.
- Runtime-validated API contracts and generated OpenAPI specification.
- Google sign-in and connected-account model.
- Opaque, revocable server-side sessions in secure cookies.
- Encrypted refresh-token storage and key-rotation design.
- Google Picker/folder selection with minimum practical scopes.
- Open existing and create new Drive workspace folders.
- Store only Drive folder IDs and display names on the backend.
- Direct browser-to-Drive content transfer using short-lived access tokens.
- Local encrypted Drive mirror.
- Global preference and keybinding synchronization.
- Account deletion and provider disconnect flows.

### Exit criteria

- Local work remains usable without an account.
- Different users and connected accounts are isolated at every backend boundary.
- The API never handles Markdown or image content.
- A user can reconnect on another device and recover the list of linked Drive workspaces.
- OAuth, session revocation, token encryption, and account deletion pass security tests.

## Milestone 4 — Synchronization and public v1

### Objective

Complete the local-first Drive experience and harden the entire product for public and self-hosted use.

### Scope

- Mirror all Markdown plus referenced images; support optional offline pinning for other images.
- Debounced autosave and automatic foreground synchronization.
- Resume synchronization when the open app regains connectivity.
- Drive revision checks and incremental change discovery.
- Three-way merge based on the last synchronized base.
- Responsive visual conflict editor.
- Foreground sync queue, progress, retry, and conflict status.
- Encrypted/locked Drive mirrors after explicit logout.
- WCAG 2.2 AA completion.
- Performance, memory, and large-workspace hardening.
- OpenTelemetry integration and privacy-safe analytics layers.
- AGPL-3.0 project governance, DCO checks, contribution policy, and protected release process.
- Official Docker Compose deployment, upgrades, migrations, backups, OAuth setup, TLS guidance, and telemetry controls.

### Exit criteria

- All v1 feature specifications and release gates pass.
- Drive conflicts cannot cause silent data loss.
- A documented Docker Compose installation can be installed and upgraded without content loss.
- Operational dashboards reveal traffic, errors, latency, database pressure, and Drive quota pressure.
- Public release documentation accurately states capabilities and browser limits.

## Post-v1 roadmap

### Existing app migration

Migrate demo, tray, and desktop apps to the shared editor, renderer, command, and workspace architecture. This is explicitly on the roadmap but must not delay web v1.

### Candidate product extensions

- Additional storage providers.
- Optional workspace-scoped settings.
- Advanced search operators, fuzzy matching, and regex.
- Math and Mermaid renderer extensions.
- Vim/Emacs editor extensions.
- Optional explicit image optimization.
- Realtime collaboration using a deliberately selected collaborative model.
- Billing and hosted quotas if operational demand requires them.
- Kubernetes/Helm deployment if self-hosting demand justifies official support.
- More languages.

## Cross-cutting work in every milestone

- Threat modeling and dependency review.
- Unit, contract, integration, and relevant end-to-end tests.
- Browser-storage schema versioning and migration fixtures.
- Performance measurements against representative documents and workspaces.
- Accessibility review for every new interactive control.
- Documentation updates and decision-log maintenance.
- No regression to the backend document-content privacy boundary.

## Main delivery risks

| Risk | Mitigation |
| --- | --- |
| Browser directory APIs vary | Capability-based provider behavior; Drive is the full cross-browser path |
| Drive scopes and OAuth verification | Validate scopes and Picker behavior during milestone 3, not at release time |
| Offline conflict complexity | Durable base revisions, operation queue, deterministic three-way merge, exhaustive tests |
| Browser quota pressure | Selective image mirroring, bounded history, quota monitoring, clear recovery UX |
| Large workspace UI cost | Virtualized tree/results, workers, incremental indexing, hard budgets |
| WASM startup/bundle cost | Small single-threaded renderer module; lazy highlighters; automated bundle budgets |
| PWA update data loss | Prompted updates only after local persistence is safe |
| Self-host upgrade failures | Versioned migrations, backups, upgrade tests, pinned image versions |
| Existing-app regressions | Backward-compatible shared editor changes and deferred app migrations |
