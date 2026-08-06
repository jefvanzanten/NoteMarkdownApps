# ADR 0001 — Milestone 1 local editing foundation

- **Status:** Accepted for milestone 1
- **Date:** 2026-08-06

## Context

Milestone 1 must prove real local-directory editing, backward-compatible shared CodeMirror commands, and `pulldown-cmark` rendering outside the UI thread without introducing milestone-2 browser persistence.

## Decisions

1. `@note/workspace-core` owns provider-independent paths, entries, revisions, errors, and the `WorkspaceProvider` contract.
2. `@note/workspace-local` implements that contract with the File System Access API. Writes compare a SHA-256 content revision before overwrite.
3. Local recoverable deletion uses a hidden `.notemarkdown-trash/<token>/` directory inside the selected provider source. The restore token is session-scoped in milestone 1. Durable 30-day retention and browser metadata belong to milestone 2.
4. Documents are normalized to LF inside the editor while UTF-8 BOM presence and CRLF style are retained as write metadata.
5. `@note/editor` exposes a stable command registry and configurable keybinding map. Existing props and exports remain compatible.
6. The Rust renderer uses a coarse UTF-8/JSON C ABI rather than `wasm-bindgen`: one input transfer and one result transfer per render. One Web Worker owns the WASM instance.
7. Preview code highlighting is a separate dynamic browser module and currently supports lightweight keyword highlighting for JavaScript, TypeScript, Rust, and JSON. A broader highlighter selection remains benchmark-gated.
8. Local autosave uses a 520 ms debounce for normal documents and 900 ms above 1 MB. `Ctrl/Cmd+S` requests immediate revision-safe writing.

## Evidence

- Rust safety/GFM tests cover tables, tasks, heading anchors, raw HTML suppression, unsafe URI suppression, and code-language extraction.
- Provider tests cover create/read/write, stale revision conflict, move, trash/restore, UTF-8 BOM, and CRLF preservation.
- Shared editor tests cover stable IDs and keybinding conflict detection.
- Existing demo production build and tray-app typecheck pass after editor changes.
- On the implementation machine (Node 24.14.0, Linux x64), the production WASM renderer processed the synthetic mixed-GFM corpus in approximately 47 ms at 1 MiB and 464 ms at 10 MiB. The configured budgets are 100 ms and 750 ms respectively. Browser and lower-end mobile qualification remains required before release.

## Consequences

- This milestone intentionally does not claim durable drafts, complete session restoration, external-change polling, PWA offline installation, full-text search, or 30-day trash retention; those remain milestone 2.
- File System Access capability limits the complete milestone-1 local journey primarily to Chromium.
- Copy-then-remove moves cannot provide a provider-native atomic rename. Failures are surfaced and never presented as completed; broader recoverable path transactions remain milestone 2 work.
