# 0002 — Milestone 2 browser persistence, search, PWA, and Brave

- Status: Accepted
- Date: 2026-08-06

## Context

Milestone 2 requires durable local drafts, session restoration, bounded history, local full-text search, an offline PWA shell, and external-change safety. Browser storage must remain supporting storage rather than become a canonical workspace provider.

Brave is Chromium-based but currently disables the File System Access API behind `brave://flags/#file-system-access-api` (Brave issue #29411). No standards-based fallback can silently write an ordinary selected directory when this capability is disabled.

## Decision

- Use versioned native IndexedDB for structured-cloneable directory handles, drafts, history, sessions, and persisted search sources.
- Retain a dense recent history tier, then hourly/daily snapshots, with a hard per-document bound.
- Keep the selected real directory canonical; browser records are drafts, recovery evidence, and rebuildable indexes only.
- Run query parsing, matching, ranking, and snippets in a dedicated search worker. Index documents incrementally and yield between provider reads.
- Use a manually controlled service worker. Cache the generated Vite shell, workers, manifest, icons, and WASM; never force activation/reload while work may be unsafe.
- Detect external changes on focus and periodically. Reload only clean buffers; preserve dirty buffers as conflicts.
- Use provider revision checks for all writes and bounded provider trash with a 30-day default.
- Support Brave through the same provider contract when its File System Access API flag is enabled. Detect default-disabled Brave and show exact enablement instructions rather than presenting a broken picker or pretending a read-only upload is a real workspace.

## Consequences

- Chrome and Edge provide the local-directory flow by default. Brave provides it after a one-time browser flag and relaunch until Brave changes its default.
- Firefox/Safari receive an honest capability fallback; Drive becomes their complete provider path in milestone 3.
- IndexedDB migrations are forward-only and must preserve old stores on failure.
- Search data and history remain device-local and never cross the API privacy boundary.
- A future OPFS optimization may move large blobs out of IndexedDB without changing workspace identity or provider semantics.
