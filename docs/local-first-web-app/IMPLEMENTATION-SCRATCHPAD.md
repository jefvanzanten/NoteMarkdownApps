# Robustness implementation scratchpad

This file tracks the incremental implementation of the error-handling, server-state, and sync-engine improvements. It intentionally contains no credentials, provider IDs, paths, or document content.

## Constraints and decisions

- Keep React/Vite PWA + Hono/PostgreSQL; do not migrate to TanStack Start.
- Preserve direct browser-to-Drive content transfer and the existing privacy boundary.
- Use incremental, behavior-preserving changes; no big-bang sync rewrite.
- Drive documents, manifests, cursors, drafts, and pending writes remain outside TanStack Query.
- Every phase must typecheck and have focused tests before the next extraction.

## Baseline

- Git worktree was clean at start.
- `pnpm` and Corepack are unavailable in the current harness, although dependencies are installed. Validation will use binaries from the repository's `node_modules/.bin` where possible.
- Existing structural hotspots:
  - `apps/web-app/src/state/workspaceStore.ts`: 1,870 lines and owns UI state plus reconciliation/orchestration.
  - `apps/api/src/app.ts`: token refresh currently maps every provider failure to reauthorization.
  - `apps/web-app/src/account/apiClient.ts`: `loadMe` and `loadPreferences` swallow all failures.
  - browser and API Google requests have no explicit timeout.

## Work log

### Phase 0 — baseline

- [x] Inspect package boundaries, current retry policy, API client, provider error mapping, and existing qualification document.
- [x] Run focused tests and typechecks with local binaries.
- [x] Record any pre-existing failures: none in the focused suites; database integration tests remain opt-in/skipped.

### Phase 1 — shared error policy

- [x] Add machine-readable error classification without putting UI copy in the sync core (`@note/workspace-core/errors`).
- [x] Centralize bounded generic retry execution and tests (`@note/sync-core/retryOperation`).
- [x] Retain compatibility with existing `WorkspaceErrorCode` consumers.
- [x] Add explicit session-expiry, reauthorization, rate-limit, provider-temporary, conflict, scope, draft-preservation, and recovery-action facts.

### Phase 2 — HTTP and Google hardening

- [x] Add bounded API-side provider fetch helper with timeout, response-size limit, and validated responses.
- [x] Distinguish invalid grants from Google/network/429/5xx failures.
- [x] Prevent transient failures from marking an account as requiring reauthorization; covered by an API security regression test.
- [x] Add browser API timeout/cancellation, runtime response validation, and stop swallowing non-expected errors.
- [x] Add Drive request timeout while preserving one authentication retry.
- [x] Preserve `Retry-After` from Google through API client into pending-write retry policy.

### Phase 3 — TanStack Query for metadata

- [x] Add dependency and QueryClient provider.
- [x] Move account/workspace/preferences server state into queries and mutations; remove the obsolete account Zustand store.
- [x] Keep dirty-draft confirmation, access-token clearing, and repository locking behavior unchanged.
- [x] Disable automatic mutation retries and bound query retries to transport/429/5xx failures.

### Phases 4–6 — sync extraction and stores

- [x] Introduce framework-independent clock/event ports in `@note/sync-core`.
- [x] Extract Drive discovery from Zustand to `src/sync/driveChangeDiscovery.ts`.
- [x] Extract pending-write processing to `src/sync/pendingWriteProcessor.ts`, injecting the final leadership fence; add focused tests.
- [x] Move authoritative manifest comparison and generic bounded retry execution into `@note/sync-core` with tests.
- [ ] Extract the remaining open-document and workspace reconciliation orchestration.
- [ ] Reduce Zustand to focused UI/session adapters. The store dropped from 1,870 to about 1,570 lines, but still owns document sessions and several application operations.

### Phases 7–9 — UX, diagnostics, qualification

- [x] Add a top-level React error boundary that explicitly preserves durable drafts and offers reload recovery.
- [x] Correlate extracted pending-write operations with random operation IDs while preserving the content-free diagnostics boundary.
- [x] Run deterministic unit/type/build validation for all touched packages.
- [ ] Run protected real-provider regression matrices; credentials/provider tests are intentionally unavailable in this harness.
- [ ] Add finer editor/preview boundaries and localized recovery actions.

## Open issues

- `@tanstack/react-query` was installed with the repository-pinned pnpm version through `npx`; `package.json` and `pnpm-lock.yaml` were updated by pnpm, not by hand.
- Preserve compatibility with Node 24 even though the harness currently reports Node 26.
- Protected Google Drive E2E, PostgreSQL integration, browser matrix, and mobile qualification remain external release gates.

## Validation log

- Workspace core: 7 tests passed.
- Sync core: 9 tests passed.
- Drive provider: 13 tests passed.
- API: 15 tests passed; 3 database integration tests skipped by their existing opt-in gate.
- Web app: 41 tests passed after the local revision/rebase and conflict-UI pass.
- TypeScript: workspace-core, sync-core, workspace-drive, API, and web app passed.
- Toolchain installed: pnpm 10.33.0 plus stable Rust 1.98.0, Cargo 1.98.0, rustfmt, Clippy, and `wasm32-unknown-unknown`. User-local rustup shims are also exposed through `/usr/local/bin` for non-interactive build processes in this harness.
- Rust validation passed: `cargo fmt --check`, Clippy with warnings denied, 3 unit tests, doc tests, release WASM compilation, and renderer benchmark.
- Full root test chain passed, including the Rust renderer and all web/API/package suites; only the 3 existing opt-in PostgreSQL integration tests were skipped.
- Full recursive monorepo TypeScript typecheck passed. Two existing configuration issues were corrected: Electron dependency declaration checking is skipped while project source remains strict, and the type-only Markdown WASM package no longer loads conflicting DOM and WebWorker standard libraries.
- Full web/WASM production build passed. Existing warning remains: the main JavaScript chunk is larger than 500 kB.
- Renderer benchmark passed: 1 MiB in about 38 ms (100 ms budget), 10 MiB in about 354 ms (750 ms budget).

## Local-first Drive sync follow-up

This section tracks the implementation prompted by the activity-journal investigation. The implementation follows the existing architecture documents: Drive remains the canonical shared provider, while drafts, pending writes, conflicts, and recovery items are irreplaceable local state until resolved.

### Findings captured before changes

- [x] Confirmed that editor input can change a tab from `persisting-local` back to `dirty-local` while a Drive write is active.
- [x] Confirmed that the 520 ms provider debounce is shorter than observed 2–4.5 second Drive writes; increasing the debounce alone would not provide correctness.
- [x] Confirmed that the stable `document:<entryId>` pending ID could be replaced by a later save entering during the active write.
- [x] Confirmed that recent `in-flight` items are skipped for two minutes on activation, while the regular foreground retry loop previously considered only `retryable` items.
- [x] Confirmed that identical drafts can be persisted from editor debounce, save, reconciliation, close, and flush paths.
- [x] Confirmed that the activity viewer/export used the newest 1,000 in-memory events although IndexedDB retains up to 10,000/seven days.
- [x] Confirmed that routine successful reconciliation and Drive read requests dominate long-running activity capture.

### Completed in first hardening pass

- [x] Added a tested keyed serial task queue (`src/sync/keyedSerialTaskQueue.ts`).
- [x] Serialized direct provider writes by stable workspace and entry identity.
- [x] Kept different documents eligible for concurrent writes.
- [x] Made queued callbacks read fresh tab state when they start, so A -> B -> C coalesces naturally: the first follower writes the latest content and later followers become no-ops.
- [x] Routed resumed pending-write processing through the same per-document provider queue.
- [x] Prevented open-document reconciliation from entering while provider work is queued/active for that document.
- [x] Added serialized draft persistence and same-runtime duplicate suppression using content, cursor, format, and base revision.
- [x] Added best-effort draft flush on `pagehide` and transition to hidden visibility.
- [x] Extended foreground recovery checks to reconsider abandoned `in-flight` records through the existing resume policy instead of only checking retryable records.
- [x] Replaced timestamp/content-length draft revision markers for new provider writes with collision-safe UUIDs.
- [x] Changed activity export to read the retained IndexedDB window asynchronously and include count, range, and truncation facts.
- [x] Kept the visible activity list bounded to 1,000 events.
- [x] Aggregated routine successful document reconciliation and Drive metadata/list/change requests into compact five-minute activity summaries while preserving raw temporary in-memory sync diagnostics.
- [x] Removed the mistakenly created standalone plan document; this scratchpad is the implementation work log.

### Validation for first hardening pass

- [x] Web-app TypeScript check passed.
- [x] Full web-app unit suite passed after the second pass: 11 files, 40 tests.
- [x] Browser-storage suite passed: 7 tests.
- [x] Focused pending/recovery/merge tests passed: 14 tests.
- [x] Production Vite build passed after each hardening/UI pass; the existing main-chunk size warning remains.
- [ ] Oxlint was not run because no lint script or repository-local oxlint binary is currently available.
- [ ] Real delayed Drive qualification has not yet been rerun.

### Product decision — closed application sync

- [x] Selected option A: unfinished Drive work remains durable locally and resumes automatically the next time the workspace opens.
- [x] Synchronization after all application tabs are closed is not a correctness requirement.
- [x] Do not add Service Worker/Background Sync for provider writes in this implementation.
- [x] A worker may execute sync while the app is open, but leader-tab execution remains the recovery fallback.

### Second hardening pass

- [x] Bumped the pending-write payload format to version 2 while keeping version 1 resumable through its durable draft.
- [x] Stored immutable attempted content and source-format facts inside the protected pending-write record.
- [x] Added privacy-safe random operation revisions to protected-record envelopes for atomic conditional updates.
- [x] Added conditional claim/state transitions so an older attempt cannot replace a newer pending revision.
- [x] Made provider acknowledgement conditional on the exact attempted revision while still committing confirmed provider bytes.
- [x] Kept a newer draft/pending revision intact when an older provider response arrives.
- [x] Processed unresolved pending writes before open-document reconciliation during workspace activation.
- [x] Recognized response-loss recovery when Drive already contains the immutable attempted snapshot and acknowledged it without another mutation.
- [x] Added conservative line-based three-way merge for independent local/remote edits; overlapping or complex edits remain explicit conflicts.
- [x] Automatically persist and queue a non-conflicting merge against the newly observed remote revision.
- [x] Added repository regression coverage for an older completion racing a newer pending revision.
- [x] Loaded durable conflicts as first-class workspace state.
- [x] Added an accessible conflict dialog showing base, remote, and editable local/merged content.
- [x] Added explicit keep-remote, keep-local, and save-merged actions.
- [x] Re-read Drive and reject a resolution when the remote revision changed again.
- [x] Remove resolved conflict/pending records only after the chosen content path is made durable.
- [x] Added Dutch and English conflict-resolution labels.
- [x] Split the editor status into `saving locally`, `saved locally / waiting for provider`, provider sync, and fully synced states.
- [x] Kept provider autosave active across the local-durable status transition without introducing a retry loop.
- [x] Added an explicit retry synchronization action for blocking provider errors.

### Remaining implementation work

#### Durable local revisions and immutable attempts

- [x] Replace timestamp/content-length `draftRevision` with a collision-safe local revision ID for newly queued writes.
- [x] Separate the immutable active write snapshot from the latest desired draft in the protected pending-write/repository-draft records.
- [x] Add atomic storage operations to claim, mark in-flight, and acknowledge only the exact attempt.
- [x] Ensure an older completion cannot acknowledge or delete a newer pending revision.
- [x] Give the latest repository draft its own durable local revision ID.
- [x] Rebase a newer draft and superseding pending write onto the confirmed revision when an older attempt succeeds.
- [ ] Move successor acknowledgement and draft rebasing into one cross-record storage transaction to close the final narrow crash boundary.
- [x] Add a forward-compatible pending-write format transition: v2 snapshots are self-contained and v1 records remain resumable from their durable draft.

#### Recovery and uncertain provider outcomes

- [ ] Add deterministic fault tests for termination at every pending-write transaction boundary.
- [x] On resume, distinguish: remote still equals base, remote equals attempted bytes, and remote contains a different revision.
- [x] Acknowledge a write when Drive contains the exact attempted snapshot but the response/local commit was lost.
- [x] Retry only when Drive still represents the expected base.
- [ ] Replace polling-only abandoned-attempt recovery with an explicit wake-up scheduled for the retry/abandonment deadline.

#### Cross-device merge and conflict handling

- [x] Connect conservative three-way merge orchestration for base/local/remote content.
- [x] Automatically queue only non-overlapping merge results against the newly observed remote revision.
- [x] Preserve all three sides before entering conflict UI.
- [x] Recheck Drive revision before keep-local, keep-remote, or manual merge resolution.
- [x] Keep conflict state document-scoped so unrelated queued documents continue through the keyed provider queue.
- [ ] Add focused store/component tests for all three explicit conflict-resolution actions.

#### Sync-engine extraction and worker host

- [ ] Extract the remaining direct-write/open-document orchestration from Zustand into a framework-light sync engine.
- [ ] Expose domain events for Zustand rather than letting the engine own React state.
- [ ] Stabilize recovery semantics in the existing elected leader tab first.
- [ ] Add a worker adapter after the engine is independent of React/DOM state.
- [ ] Keep leader-tab execution as fallback; worker lifetime must never be required for durability.
- [x] Exclude Service Worker/Background Sync provider writes: automatic resume on the next workspace open is the selected guarantee.
- [ ] Evaluate a dedicated worker host against the supported browser matrix and token/repository-lock lifecycle.

#### UI semantics

- [x] Separate `saving locally`, `saved locally`, `waiting for Drive`, `syncing`, and `synced` in the document state model.
- [x] Ensure `synced` is emitted only after Drive acknowledgement matches the current editor content.
- [x] Add explicit retry/sync controls without bypassing revision checks.
- [x] Add Dutch/English conflict-resolution strings and an accessible modal/status action.
- [ ] Add finer local-durability versus Drive-sync announcements.

#### Qualification

- [ ] Add a delayed provider integration test proving active mutation count never exceeds one per document.
- [ ] Prove A -> B -> C writes the latest exact content with the revision returned by A.
- [ ] Test close/reopen before and after the two-minute in-flight deadline.
- [ ] Test response loss after Drive applied the mutation.
- [ ] Run two isolated browser contexts for non-overlapping and overlapping edits.
- [ ] Run the protected real-Drive regression and update `08-drive-sync-qualification.md` with measured evidence.
