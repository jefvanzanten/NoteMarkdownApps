# NoteMarkdown Web App

Milestones 1–3 implement the local-first Markdown PWA, optional accounts, and Google Drive provider described in [`docs/local-first-web-app`](../../docs/local-first-web-app/).

## Included

- Real local-directory workspaces in Chrome/Edge and in Brave with its File System Access API flag enabled.
- Durable IndexedDB drafts, bounded tiered history, workspace handles, search sources, and full tab/session restoration.
- Revision-checked autosave and focus/periodic external-change reconciliation without silent overwrite.
- Incremental worker-based full-text search over names/content, including quoted exact phrases and snippets.
- Workspace diagnostics for broken relative links and missing images.
- Workspace-wide relative-link updates during rename/move with recovery checkpoints.
- Persistent provider trash with 30-day retention and restore support.
- Original-byte image insertion by paste, drag/drop, or file selection into the configured asset directory.
- Installable manifest, versioned offline service-worker shell, safe prompted updates, and cached WASM/worker assets.
- Light, dark, and system themes; Dutch/English UI; browser-native spelling control.
- Print-friendly preview and browser print-to-PDF.
- Responsive desktop/mobile shell and capability-based fallback for browsers without safe local-directory access.
- Shared CodeMirror editor command registry and Rust/WASM GFM preview in a dedicated worker.
- Optional Google sign-in with revocable server sessions and linked Drive folder recovery across devices.
- Google Picker folder selection and direct browser-to-Drive Markdown/image transfer with memory-only access tokens.
- Encrypted local Drive Markdown mirror plus global setting and keybinding synchronization.
- Provider disconnect, logout, and NoteMarkdown account deletion without deleting Drive files.

Browser storage remains supporting storage and is never a standalone/canonical workspace provider.

## Requirements

- Node.js 24+
- pnpm 10+
- Rust with the `wasm32-unknown-unknown` target
- Current Chrome/Edge, or current Brave with `brave://flags/#file-system-access-api` enabled, for the complete local-directory journey
- HTTPS or localhost (required by browser filesystem, service-worker, and installation APIs)
- For Drive: configured `apps/api`, Google OAuth web client, Picker API key/app ID, and PostgreSQL

Brave currently disables `showDirectoryPicker` by default (upstream Brave issue #29411). Enable **File System Access API** at `brave://flags/#file-system-access-api`, relaunch Brave, and then allow the site to access the selected directory. Shields can remain enabled; no third-party request or account is required.

Install the Rust target once:

```sh
rustup target add wasm32-unknown-unknown
```

## Development

Build the renderer before starting the user-managed Vite server:

```sh
pnpm --filter @note/markdown-wasm build
pnpm --filter @note/web-app dev
```

Production build:

```sh
pnpm --filter @note/web-app build
```

Tests and checks:

```sh
pnpm test
pnpm --filter @note/web-app typecheck
pnpm test:e2e:drive # protected and skipped unless explicitly enabled
```

The real-provider two-browser setup, authentication flow, mutation acknowledgement, rollback behavior, and metric options are documented in [`e2e/README.md`](../../e2e/README.md). Current measured evidence and remaining v1 gaps are recorded in [Google Drive Sync Qualification](../../docs/local-first-web-app/08-drive-sync-qualification.md).

Renderer performance budget:

```sh
pnpm --filter @note/markdown-wasm benchmark
```

## Local Google Drive setup

The local API and Vite proxy must agree on port `8787`. Configure `apps/api/.env` with at least:

```text
PUBLIC_ORIGIN=http://localhost:5173
PORT=8787
SYNC_DIAGNOSTICS_ENABLED=true
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
DATABASE_URL=...
TOKEN_ENCRYPTION_KEYS=...
```

Configure the browser-visible Picker values in `apps/web-app/.env`:

```text
VITE_GOOGLE_PICKER_API_KEY=...
VITE_GOOGLE_APP_ID=<numeric Google Cloud project number>
VITE_SYNC_DIAGNOSTICS_ENABLED=true
VITE_SYNC_SLOW_ACTIVATION_MS=30000
```

The Picker API key is browser-visible and must be restricted by HTTP referrer. Permit the exact local development origin, normally `http://localhost:5173/*`, and the production origin. Enable Google Picker/Drive APIs in the same Cloud project. Add this OAuth redirect URI to the web client:

```text
http://localhost:5173/api/v1/auth/google/callback
```

Google sign-in connects an account but does not enumerate the user's Drive. Use **Select existing folder** once per NoteMarkdown deployment/database to link the selected workspace reference. Production workspace references do not automatically appear in a separate local database. Local and production origins also use separate `HttpOnly` session cookies; signing in to one does not authenticate the other.

If Drive-token renewal receives an API 401, the app reports that the NoteMarkdown session expired/revoked, keeps the draft locally, queues the provider write, and asks for sign-in. Google reauthorization and direct Drive/network failures have separate messages. An unexpected API 500 includes a random diagnostic reference that can be matched to the reason-bearing API server log without exposing the internal exception in the browser.

Vite reads Picker environment variables at startup. Reload after an automatic Vite environment restart or restart the user-managed web process after changing `.env` when necessary.

## Production subpath deployment

The production Docker image is built for `/notes/`. Configure the Coolify web-app domain as `https://apps.jefvanzanten.dev/notes`, leave **Strip Prefixes** disabled, and redeploy after changing the route. Configure the API with:

```text
PUBLIC_ORIGIN=https://apps.jefvanzanten.dev/notes
SYNC_DIAGNOSTICS_ENABLED=true
```

For the temporary debugging build, also configure `VITE_SYNC_DIAGNOSTICS_ENABLED=true` and `VITE_SYNC_SLOW_ACTIVATION_MS=30000` on the web-app build. `VITE_*` values are compiled into the frontend, so Coolify must rebuild/redeploy the web app after changing them. API diagnostics are runtime-controlled and likewise require the API process to reload its environment.

The Google OAuth client's authorized redirect URI must be `https://apps.jefvanzanten.dev/notes/api/v1/auth/google/callback`. The Nginx runtime removes `/notes` only when forwarding API requests to the API container.

## Brave verification

1. Open the HTTPS/localhost app in a current Brave release.
2. Select a real directory and grant read/write access.
3. Edit a note, reload, and verify tabs/drafts restore.
4. Install the app from Brave's address-bar install action.
5. Load once online, switch offline in DevTools, and reload to verify the cached shell.
6. Edit the same file externally and refocus Brave; NoteMarkdown must reload a clean tab or preserve a dirty draft as a conflict.

Private windows intentionally provide less durable storage and are not a supported persistence test environment.

## Privacy boundary

Local directories never require an account or available API. For Drive, the API stores identity, encrypted refresh credentials, preferences, and selected folder IDs/display names only. Markdown, images, file names, paths, directory trees, rendered output, and search queries never reach the NoteMarkdown API; content requests go directly from the browser to Google Drive.

`VITE_SYNC_DIAGNOSTICS_ENABLED=true` temporarily keeps at most 300 content-free sync breadcrumbs in process memory and uploads them only after an error or operation exceeding `VITE_SYNC_SLOW_ACTIVATION_MS`. Nothing is persisted or shown as a client sync log. The matching API flag must also be enabled. Reports contain fixed state-machine categories, counts, durations, HTTP statuses, safe stack frames, and aggregate metrics—not content, names, paths, workspace/Drive IDs, request URLs/bodies, cookies, or tokens. Disable both flags after the debugging cycle.

The separate user-exported activity journal is a persistent, bounded 24-hour debugging snapshot. See [Diagnostics](docs/diagnostics.md) and the [activity journal specification](docs/specs/activity-journal.md).
