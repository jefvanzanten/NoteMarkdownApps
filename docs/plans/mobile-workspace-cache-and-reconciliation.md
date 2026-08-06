# Mobile workspace cache and reconciliation implementation plan

## Status

Implemented through phase B in source. Drive warm reconciliation now uses durable `changes.list` cursors, atomic page/cursor commits, selected-folder fallback scans, and a 24-hour visible-online safety scan. Real-device performance, long-lived Google staging, and the full browser rollout matrix remain validation gates rather than implementation blockers.

## Decision source

- [ADR 0004 — Local-first workspace cache and priority reconciliation](../local-first-web-app/decisions/0004-local-first-workspace-cache-and-priority-reconciliation.md)
- [Original handoff analysis](../local-first-web-app/HANDOFF-mobile-workspace-cache.md)

## Problem statement

`apps/web-app` currently performs provider reads while restoring tabs and indexing the workspace. `DriveWorkspaceProvider.readDocument()` always requests `alt=media` while online. External-change polling also reads complete documents to compare revisions. Existing drafts, search sources, sessions, history, and the encrypted Drive mirror are separate stores and do not form a revisioned warm-start read model.

The implementation must make a cached workspace interactive before provider I/O and must not download unchanged Markdown. It must preserve the provider as canonical, retain unsynchronized work, and remain safe when cache, permission, authentication, migration, quota, or network state is degraded.

## Target outcomes

### Phase A — central cache and priority reconciliation

- Restore manifest, tree, tabs, active cached document, and warm search state locally.
- Do not wait for a Drive scan before rendering or editing.
- Check revisions through metadata and stable entry identity.
- Download only new or changed Markdown content.
- Process active/open documents before general background work.
- Persist explicit pending writes and destroyed-draft recovery items.
- Coordinate one sync leader per workspace and one editing lease per document.
- Support a valid cold-provider fallback while the feature flag exists.

### Phase B — Drive delta discovery

- Replace normal recursive Drive startup scans with `changes.list` from a durable cursor.
- Reconcile moves, deletes, and content changes incrementally.
- Fall back safely after token invalidation or ambiguous ancestry.
- Retain a periodic selected-folder metadata safety scan.

## Non-goals

- Completing automatic three-way merge or the visual merge editor.
- Mirroring every image binary in this cache change; image metadata is included and image content remains lazy until the separate image-mirroring work.
- Closed-PWA background synchronization.
- A browser-only canonical workspace.
- Permanent provider-owned and repository-owned caches in parallel.
- Breaking current shared-package consumers to introduce the new contract.
- Wrapped-key re-unlock after explicit logout.

## Current implementation map

| Concern | Current location | Planned direction |
| --- | --- | --- |
| Provider domain contract | `packages/workspace-core/src/types.ts` | Add stable identity, metadata and incremental scan/change capabilities without breaking existing consumers |
| Drive scanning/reads | `packages/workspace-drive/src/driveWorkspaceProvider.ts` | Provider I/O only; stable-ID metadata lookup and later Changes API |
| Local revisions/reads | `packages/workspace-local/src/localWorkspaceProvider.ts` | Metadata fingerprints plus existing strong pre-write hashes |
| IndexedDB | `apps/web-app/src/storage/browserStorage.ts` | Migrate storage ownership to `packages/browser-storage` |
| Drive mirror encryption | `apps/web-app/src/drive/driveMirror.ts` | Migrate validated content into the central encrypted repository, then retire provider mirror injection |
| Activation/indexing/external checks | `apps/web-app/src/state/workspaceStore.ts` | Application service/reconciler orchestration instead of direct provider scan/read loops |
| Lifecycle polling/autosave | `apps/web-app/src/App.tsx` | Priority scheduler, deduplicated cadence, pending-write and recovery UI |
| Search worker/client | `apps/web-app/src/search/*` | Warm load plus revisioned incremental updates |
| Deleted-item feedback | `apps/web-app/src/components/RecoveryToast.tsx`, tabs | Accessible destroyed transition plus persistent recovery view |

## Target package boundaries

### `@note/browser-storage`

Create `packages/browser-storage` with no React dependency.

Responsibilities:

- versioned IndexedDB schema and forward migrations;
- opaque unencrypted envelopes and encrypted Drive payloads;
- workspace manifest and document repository;
- drafts, pending writes, base/remote versions, conflicts and recovery items;
- sessions, history, search sources/index metadata and sync cursors;
- atomic per-document commits;
- migration quarantine and corruption isolation;
- quota estimation, persistence request and retention policy;
- storage events consumed by the app and sync coordinator.

### `@note/sync-core`

Create `packages/sync-core` with no React or browser DOM dependency in its state machine.

Responsibilities:

- priority work model and bounded scheduler;
- request deduplication and cancellation generations;
- retry/backoff policy;
- revision reconciliation transitions;
- durable pending-write processing;
- sync-leader/editing-lease coordination interfaces;
- provider-change page application;
- conflict and destroyed-draft recovery transitions.

Browser-specific Web Locks/BroadcastChannel/visibility/network adapters may live in `apps/web-app` or a small browser adapter module, but the state rules remain testable outside React.

### `@note/workspace-core`

Remain cache-neutral. Define provider identities, metadata/change contracts and shared states. Do not import browser storage or sync packages.

## Proposed domain records

Names can change during implementation, but the represented facts and ordering cannot.

```ts
interface ManifestEntry {
  workspaceId: string;
  entryId: string; // provider stable ID; normalized path fallback
  path: string;
  kind: "directory" | "document" | "image";
  parentEntryId?: string;
  observedProviderRevision?: WorkspaceRevision;
  metadataFingerprint?: WorkspaceMetadataFingerprint;
  state: "live" | "possibly-removed" | "removed" | "path-collision";
  updatedAt: number;
}

interface CachedDocument {
  workspaceId: string;
  entryId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  cachedContentRevision: WorkspaceRevision;
  indexRevision?: string;
  diagnosticsGeneration?: string;
  lastAccessedAt: number;
}

interface PendingDocumentWrite {
  id: string;
  workspaceId: string;
  entryId: string;
  targetPath: string;
  expectedBaseRevision: WorkspaceRevision;
  draftRevision: string;
  state: "pending" | "in-flight" | "retryable" | "conflicted" | "applied";
  attempt: number;
  retryAt?: number;
}

interface RecoveryItem {
  id: string;
  workspaceId: string;
  formerEntryId: string;
  formerPath: string;
  content: string;
  format: DocumentFormat;
  baseRevision: WorkspaceRevision;
  reason: "provider-removed";
  createdAt: number;
}

interface WorkspaceSyncState {
  workspaceId: string;
  providerType: "local" | "drive";
  driveChangeToken?: string;
  lastFullScanAt?: number;
  lastReconciledAt?: number;
}
```

For encrypted Drive workspaces, names, paths, parent relationships and all content-bearing records are inside ciphertext. An unencrypted envelope contains only schema/key/account/workspace lookup material required to locate and unlock records.

## Required transaction invariants

1. Observing remote `R2` may update `observedProviderRevision`, but not `cachedContentRevision` or index generation.
2. Downloaded content is accepted only if it still matches the requested observed revision/generation.
3. Content and its `cachedContentRevision` commit together.
4. Search/index generation advances only after the corresponding content is durable and the worker acknowledges processing.
5. A pending write is durable before a provider mutation starts.
6. A pending write is acknowledged only after the provider result and new base/cached revision are durable.
7. A Drive change cursor advances only in the same transaction as all changes from that page.
8. A dirty deleted tab becomes a durable recovery item before UI removal.
9. A path move updates manifest mapping, session, pending-write target and path-derived state atomically or enters recoverable partial-transaction state.
10. Late async results carry workspace and generation identity and cannot update a newly selected workspace.

## Warm startup flow

```text
open IndexedDB
  -> unlock repository when policy permits
  -> load manifest/session/drafts/pending writes/recovery
  -> load active document and open tabs from local repository
  -> load warm search state
  -> render interactive workspace
  -> elect sync leader
  -> enqueue active document metadata check
  -> enqueue remaining open tabs
  -> enqueue pending writes/conflicts
  -> reconcile general manifest in bounded batches
  -> download/index only new or changed documents
```

Rules:

- Drive cache access does not require a fresh network token when the device key is already unlocked.
- Drive writes remain queued while reauthentication is required.
- Local cached content remains unavailable until filesystem permission is confirmed.
- Opening cached content does not wait for metadata. Show `checking` and permit durable local edits.
- A clean remote update replaces content only after durable commit.
- A dirty remote update preserves base/local/remote and enters conflict state.

## Priority and lifecycle policy

Initial priorities:

| Priority | Work |
| --- | --- |
| P0 | User-requested save/retry after required revision verification |
| P1 | Active document metadata/content |
| P2 | Other open tabs |
| P3 | Pending writes, conflicts and recovery-related checks |
| P4 | General manifest metadata reconciliation |
| P5 | New/changed unopened content, search and diagnostics completeness |
| P6 | Periodic strong local verification and safety scans |

Initial cadence:

- check on document open/activation;
- check active document on focus/visibility return and at most every 30 seconds while visible/online;
- check other open tabs at most every 60 seconds;
- always verify immediately before provider write;
- deduplicate focus and visibility events;
- pause periodic and low-priority work while hidden/offline;
- pause P5/P6 content work under `saveData` or a very slow connection signal;
- respect `Retry-After`; otherwise use bounded exponential backoff and jitter;
- determine final concurrency from mobile and fake-provider benchmarks.

## Confirmed deletion and recovery UX

- Direct stable-ID metadata lookup gives open tabs priority over a full scan.
- A provider `not-found` or explicit deleted/trashed change is authoritative for that entry.
- Clean tab: run the short “go up in smoke” transition and close it.
- Dirty tab: transactionally create a recovery item, then run the same transition and close it.
- Announce the removal through an accessible status message.
- Respect `prefers-reduced-motion` by replacing smoke motion with an immediate or subtle non-motion state change.
- Show an immediate restore action and a persistent recovery view.
- Restoring creates a new provider file at the former path when available; otherwise require an explicit collision-safe path.
- Recovery data remains until restored or explicitly deleted with confirmation.

## Multi-tab behavior

- Acquire one workspace sync-leader lock, preferably through Web Locks.
- Broadcast committed repository generations to followers through `BroadcastChannel`.
- Use an expiring IndexedDB lease with owner token and heartbeat when Web Locks are unavailable.
- Never let two leaders process the same provider queue after a suspended tab resumes; lease fencing tokens are required.
- Acquire one document editing lease before enabling CodeMirror edits.
- A follower opens the document read-only and can request takeover.
- Takeover first persists the current owner's draft, advances the lease fencing token and notifies both tabs.
- A blocked IndexedDB version upgrade asks old tabs to close/update; it never clears storage.

## Encryption and migration strategy

### Legacy classification

| Existing data | Treatment |
| --- | --- |
| Plaintext Drive search source/cache | Rebuildable: delete during migration |
| Plaintext dirty Drive draft | Encrypt and verify before deleting original |
| Relevant plaintext Drive history | Encrypt and verify before deleting original |
| Existing encrypted `driveMirror` document | Import only after path and remote revision match |
| Unmatched/corrupt clean mirror | Quarantine/ignore, then remove as rebuildable |
| Local workspace records | Migrate to central schema; content access remains permission-gated |
| Sessions/layout | Migrate while preserving workspace scope |

### Migration requirements

- Bump schema through a forward-only migration.
- Preserve realistic previous-version fixtures in tests.
- Make migration resumable and idempotent.
- Record per-workspace migration state; never infer completion from store existence alone.
- Delete plaintext originals only after encrypted destination validation.
- Isolate an invalid record and continue unrelated migration work.
- Do not require the user to clear site data.
- Keep a cold-provider path when rebuildable records cannot migrate.
- Warn and require confirmation before explicit logout with dirty/pending work; ciphertext remains locked afterward.

## Quota and persistence policy

- Request `navigator.storage.persist()` after the user establishes durable workspace use, without repeated prompts.
- Report refusal as degraded durability, not a blocker.
- Use `navigator.storage.estimate()` where available.
- Cleanup order:
  1. obsolete derived index generations;
  2. stale rendered/diagnostics artefacts;
  3. least-recently-used clean unopened document content;
  4. other explicitly rebuildable clean cache.
- Never automatically remove drafts, pending writes, conflicts, required base versions, open document content, or recovery items.
- Cache eviction and missing records route to progressive cold loading without mutating provider content.

## Delivery plan

## PR 0 — Baseline network and startup instrumentation

### Goal

Make the current defect measurable before behavior changes.

### Work

- Add a test fetch recorder around Drive provider fixtures.
- Classify Drive requests as metadata, list/change, or `alt=media` content.
- Add local counters/timings behind the diagnostics adapter:
  - `workspace_activate_ms`;
  - `manifest_load_ms`;
  - `remote_reconcile_ms`;
  - `drive_metadata_request_count`;
  - `drive_content_download_count`;
  - `drive_content_download_bytes`;
  - `cache_hit_count` / `cache_miss_count`;
  - `priority_queue_wait_ms`;
  - `index_documents_processed`.
- Create synthetic 500-entry and 10,000-entry workspace fixtures.
- Record current cold/warm behavior for comparison.

### Tests

- Metrics reject paths, names, IDs and content.
- Existing warm startup test demonstrates the current repeated-download baseline without becoming the final acceptance assertion.

### Definition of done

- CI can count content downloads deterministically.
- Benchmark hardware/browser/profile are documented.

## PR 1 — Additive provider identity and metadata contracts

### Goal

Expose enough provider metadata to reconcile without content reads while preserving existing package consumers.

### Work

- Extend `packages/workspace-core/src/types.ts` with optional stable entry identity, metadata fingerprint/revision and parent/collision state.
- Add optional semantic methods for:
  - stable-ID/path metadata lookup;
  - incremental scan batches;
  - later opaque change discovery.
- Keep `listEntries()` and path reads as compatibility fallbacks.
- Extend the workspace provider contract suite.
- In Drive:
  - retain ID/path/parent maps from metadata;
  - implement direct `files.get` metadata lookup by stable ID;
  - return `trashed`, parents, version, checksum, modified time and size;
  - report duplicate path collisions instead of overwriting a map entry.
- In local provider:
  - expose normalized path fallback identity;
  - add `lastModified + size` metadata fingerprint;
  - preserve strong SHA-256 pre-write verification;
  - support scan batches where practical.

### Tests

- Metadata lookup makes no content request/read.
- Drive rename/move preserves entry identity.
- Duplicate names enter explicit collision state.
- Local same-metadata and changed-metadata paths are covered; pre-write strong hash remains mandatory.
- Existing app/package typechecks remain green.

### Definition of done

- Active/open entries can be checked without `readDocument()`.
- No existing consumer requires a breaking migration.

## PR 2 — Create browser-storage repository and migrate legacy data

### Goal

Establish one durable read repository and remove storage semantics from the Zustand store.

### Work

- Create `packages/browser-storage` package and test setup.
- Move generic IndexedDB transaction/migration helpers out of `apps/web-app/src/storage/browserStorage.ts` behind repository APIs.
- Add manifest, document, draft, pending-write, conflict, recovery, session, history, index metadata and sync-state stores/records.
- Implement encrypted Drive payload/envelope handling.
- Implement atomic document/revision commits and corruption quarantine.
- Add migration state and legacy adapters.
- Purge rebuildable plaintext Drive search/cache records.
- Encrypt and validate dirty drafts/relevant history before deleting originals.
- Add an importer for revision-matched records from `apps/web-app/src/drive/driveMirror.ts`.
- Keep current provider flow operational while the warm-start flag is disabled.

### Tests

- Upgrade realistic database-version fixtures.
- Interrupt migration between destination write and source cleanup.
- Retry migration idempotently.
- Import matching encrypted mirror and reject mismatched/corrupt records.
- Verify no rebuildable sensitive Drive plaintext remains after completion.
- Verify logout lock, persistence refusal, quota failure and one-record corruption.

### Definition of done

- Repository APIs are framework-independent.
- Cold provider behavior and existing drafts remain functional.
- Clearing site data is never a recovery instruction.

## PR 3 — Create sync-core scheduler and reconciliation state machine

### Goal

Centralize priority, revision, retry and generation correctness before wiring UI activation.

### Work

- Create `packages/sync-core`.
- Define work identity, priority, fencing generation, cancellation and retry state.
- Implement bounded scheduling, deduplication, backoff/jitter and `Retry-After`.
- Implement reconciliation transitions for:
  - unchanged metadata/cache hit;
  - observed revision newer than cached content;
  - new entry;
  - possible versus confirmed delete;
  - clean external update;
  - dirty conflict;
  - rename/move;
  - path collision;
  - pending write verification/application.
- Provide adapters/interfaces for storage and providers; do not depend on React.

### Tests

- Model/state-machine tests for every transition.
- Active/open work preempts queued background work without starving it forever.
- Duplicate requests collapse to one content read.
- Late generations are discarded.
- Throttle/retry/offline/visibility cancellation never acknowledges unknown mutations.
- Observed `R2` cannot advance cached/index `R1`.

### Definition of done

- Reconciliation behavior is deterministic under fake clock and provider faults.
- No React component or Zustand store is needed to test it.

## PR 4 — Warm workspace activation and incremental search/diagnostics

### Goal

Enable the user-visible fix behind the temporary feature flag.

### Work

- Replace direct scan-first activation in `apps/web-app/src/state/workspaceStore.ts` with repository-first activation.
- Render cached manifest/session/active document/open tabs/search immediately.
- Gate local cache content on filesystem permission.
- Allow unlocked Drive cache editing while authentication is unavailable; queue writes.
- Start the leader reconciler after local render.
- Replace full-document external polling with metadata checks.
- Implement initial cadence: active 30 seconds, other open tabs 60 seconds, focus/visibility deduplication, pre-write check.
- Stop `indexWorkspace()` from reading every unchanged document.
- Update search and diagnostics only for changed/new/deleted/path-moved documents.
- Mark warm search/diagnostics as updating until generations converge.
- Pause P5/P6 work for hidden/data-saver/very-slow conditions.
- Cancel old-workspace generations on switch.

### Tests

- Warm cache renders before a deliberately blocked provider promise resolves.
- Warm unchanged Drive workspace makes zero `alt=media` requests.
- One remote change makes one content request and one index update.
- Active document checks before a 10,000-entry background batch.
- Offline restart restores cached content and dirty drafts.
- Authentication-required Drive cache remains editable/queued.
- Local permission denial exposes no cached local content.
- Search remains usable and correctly marked during reconciliation.

### Definition of done

- Phase-A core acceptance criteria pass behind the feature flag.
- Cold fallback still preserves all non-rebuildable records.

## PR 5 — Pending writes, deletion recovery and multi-tab coordination

### Goal

Complete correctness and UX needed before enabling warm activation by default.

### Work

- Persist one idempotent pending-write record per dirty document intended for sync.
- Process writes only after revision verification.
- Preserve base/local/remote and enter conflict state on mismatch; do not add automatic merge here.
- Implement workspace sync leadership with Web Locks/BroadcastChannel and fenced IndexedDB lease fallback.
- Implement per-document editing leases and explicit takeover.
- Handle direct confirmed deletion for active/open tabs.
- Add accessible “go up in smoke” transition and reduced-motion fallback.
- Create persistent recovery view and restore-as-new/delete actions.
- Transactionally migrate open state and pending writes across stable-ID rename/move.
- Add duplicate-path collision UI/state.
- Coordinate blocked IndexedDB upgrades with older tabs.

### Tests

- Reload between draft persistence, pending-write creation, provider request and acknowledgement.
- Two app tabs do not duplicate scans or provider writes.
- Suspended former leader cannot write after a fenced lease takeover.
- Editing takeover preserves the previous buffer.
- Clean deletion closes; dirty deletion creates recovery before closing.
- Recovery survives reload and handles destination collisions.
- Motion and announcements pass reduced-motion/accessibility checks.
- Remote rename preserves tab and draft without content download when revision is unchanged.

### Definition of done

- No dirty or in-flight work can be silently lost.
- Multi-tab races are deterministic and test-covered.

## PR 6 — Phase-A performance, rollout and legacy mirror retirement

### Goal

Meet budgets, enable the new path by default and remove the old competing cache path.

### Work

- Benchmark encrypted manifest layouts at 10,000 entries; record the selected snapshot/per-record/journal format in a follow-up ADR note if needed.
- Tune bounded concurrency without changing priority semantics.
- Add adaptive LRU cleanup and persistent-storage UX.
- Run browser/device matrix and failure injection.
- Enable warm activation by default after gates pass.
- Remove `DriveMirror` injection from the provider and retire `apps/web-app/src/drive/driveMirror.ts` only after migration coverage proves imports are complete.
- Remove obsolete search-document source duplication after its repository replacement is established.
- Retain a tested cold-provider fallback for absent/evicted clean cache, not as a permanent second cache implementation.

### Tests and gates

- Cached 10,000-entry workspace interactive within one second on defined lower-end mobile hardware.
- Zero unchanged Markdown content downloads.
- One changed Markdown document produces at most one required content download.
- UI remains responsive during reconciliation/index work.
- Quota cleanup obeys protected-record policy.
- Chrome/Edge/Firefox/Safari plus current iOS/Android Drive workflows pass according to the project matrix.

### Definition of done

- Phase A is production-default.
- Old provider-owned mirror/search cache is no longer a competing source.

## PR 7 — Drive Changes API initialization and cursor processing

### Goal

Remove the routine recursive Drive metadata scan from warm starts.

### Work

- Add Drive start-page-token and `changes.list` provider adapter.
- Initial sync sequence:
  1. acquire start page token;
  2. scan selected folder into manifest;
  3. replay changes from initial token;
  4. atomically persist resulting cursor.
- Process pages transactionally with next-page cursor.
- Map changed file metadata, trash/removal and parents to stable manifest IDs.
- Filter known workspace IDs and known parent IDs.
- For unknown entries, resolve ancestry only as needed; scan a newly moved-in folder subtree when required.
- Treat moves out of the workspace as removals only after authoritative ancestry resolution.
- Invalidate/fallback on expired tokens and ambiguous state.

### Tests

- Mutation during initial scan is observed by replay.
- Crash before page commit replays safely; crash after commit starts at next cursor.
- Move into/out of workspace, nested folder move, rename, delete and content update.
- Changes unrelated to selected workspace are ignored.
- Invalid token triggers selected-folder rescan without content redownload for unchanged revisions.
- Real Google staging smoke validates scope and response assumptions.

### Definition of done

- Normal warm starts use changes instead of a recursive selected-folder scan.
- Cursor loss cannot cause silent missed changes.

## PR 8 — Safety scans, final metrics and phase-B rollout

### Goal

Harden delta discovery and prove long-running correctness.

### Work

- Schedule full selected-folder metadata safety scan initially every 24 hours only while visible, online and not in data-saver mode.
- Trigger immediate safety scans for token invalidation and ambiguous ancestry.
- Reconcile scan results without content downloads when revisions match.
- Add manual sync/retry visibility for incomplete or throttled state.
- Run long-lived fault tests and Drive quota simulations.
- Make Changes path default and retain full-scan recovery.

### Tests and gates

- No routine recursive scan on normal warm restart.
- Safety scan produces zero content downloads when unchanged.
- One conflicted file does not block unrelated changes.
- 429/5xx backoff remains bounded and visible.
- Metrics contain no sensitive identifiers.

### Definition of done

- Phase B is production-default with a tested token/full-scan recovery path.

## Acceptance matrix

| Scenario | Expected result after phase A | Expected result after phase B |
| --- | --- | --- |
| Warm start, no changes | Cached UI immediately; background metadata scan allowed; zero content downloads | Cached UI immediately; Changes request, no recursive scan, zero content downloads |
| One remote Markdown change | One metadata difference, one content download, one index/diagnostics update | One change event, one content download, one index/diagnostics update |
| Active tab remote-deleted | Direct high-priority confirmation; clean tab destroyed/closed | Same, usually discovered through direct check or Changes |
| Dirty active tab remote-deleted | Recovery item durable before destroyed/closed | Same |
| Remote rename/move | Stable-ID path transaction; no content download if revision unchanged | Change event drives same transaction |
| Offline restart | Cached Drive content/drafts usable if key unlocked; pending writes retained | Same |
| Drive reauthentication required | Cache editable; writes queued; clear status | Same |
| Local permission unavailable | No local cached content exposed; reauthorization action | Same |
| Data saver | Priority work only; background completeness visibly deferred | Same |
| Duplicate Drive path | Explicit collision; affected path blocked, others usable | Same |
| Cache record corrupt | Isolate/refetch clean data; preserve recovery state | Same |
| Cache evicted | Progressive valid cold start | Full scan/token reinitialization as required |
| Two browser tabs | One sync leader and one editor lease per document | Same |

## Required test fixtures

- 500 Markdown files, 50 directories, 5 open tabs.
- 10,000 mixed supported entries with realistic nesting.
- Unchanged, one-change, rename, move, trash and permanent-removal Drive fixtures.
- Duplicate names in one Drive parent.
- Local files with unchanged metadata, changed metadata and strong-hash mismatch.
- Legacy IndexedDB versions containing plaintext Drive search data, dirty drafts, history and encrypted mirror records.
- Corrupt ciphertext, missing key, quota exception and interrupted transaction fixtures.
- Two-tab leader/editor lease fixtures with suspension and stale fencing tokens.

## Observability and privacy

Always available locally/testing:

- activation and manifest timing;
- reconciliation timing;
- metadata and content request counts;
- content bytes;
- cache hit/miss counts;
- priority queue wait and retry counts;
- index documents processed;
- coarse storage/quota state.

External behavior:

- aggregate operational metrics follow the existing policy;
- detailed client performance diagnostics require consent;
- never emit workspace IDs, Drive file/folder IDs, connected-account IDs, names, paths, content, search queries or directory shape.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cached revision mislabeled current | Separate observed, cached-content and index revisions with transaction tests |
| Local metadata misses same-size/timestamp edit | Strong hash before every write plus periodic strong verification |
| Migration loses dirty work | Destination-first verified encryption, idempotent resume, realistic fixtures |
| Existing encrypted mirror causes one-time redownload | Import only revision-matched records |
| Multiple browser tabs duplicate work | Fenced leader lease and editing leases |
| Changes cursor skips a page | Atomic page application/cursor commit |
| Drive changes include unrelated account files | Stable-ID/parent filtering and scoped ancestry resolution |
| Remote delete loses active edits | Recovery commit before destroyed-tab transition |
| Mobile quota evicts clean cache | Persistent-storage request, adaptive LRU and valid cold fallback |
| Encryption of 10,000-entry manifest misses startup budget | Benchmark storage layout before rollout; avoid per-entry crypto calls if evidence rejects them |
| Feature rollout regresses startup | Temporary flag, deterministic network assertions and cold fallback |
| Search/diagnostics appear complete while stale | Explicit generations and visible updating/incomplete state |

## Completion criteria

The plan is complete when:

- all PR definitions of done pass;
- phase A and B acceptance matrices are automated where practical;
- migration fixtures preserve every non-rebuildable record;
- provider contract compatibility is proven across existing packages/apps;
- mobile performance and Drive network budgets pass;
- security review accepts the encrypted record envelope and logout behavior;
- accessibility review accepts checking/incomplete/collision/recovery states and destroyed motion;
- canonical docs and ADR remain synchronized with implementation evidence;
- the temporary warm-start feature flag is removed or has a separately approved reason to remain.
