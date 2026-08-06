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
```

Renderer performance budget:

```sh
pnpm --filter @note/markdown-wasm benchmark
```

## Production subpath deployment

The production Docker image is built for `/notes/`. Configure the Coolify web-app domain as `https://apps.jefvanzanten.dev/notes`, leave **Strip Prefixes** disabled, and redeploy after changing the route. Configure the API with:

```text
PUBLIC_ORIGIN=https://apps.jefvanzanten.dev/notes
```

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

Local directories never require an account or available API. For Drive, the API stores identity, encrypted refresh credentials, preferences, and selected folder IDs/display names only. Markdown, images, file names, paths, directory trees, rendered output, diagnostics, and search queries never reach the NoteMarkdown API; content requests go directly from the browser to Google Drive.
