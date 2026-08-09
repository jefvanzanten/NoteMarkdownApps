# ADR 0004 — Local-first workspace cache and priority reconciliation

## Status

Accepted.

## Context

The mobile web app currently activates a workspace by scanning provider entries, restoring tabs through provider reads, and indexing every Markdown document through `readDocument()`. The Drive provider downloads content with `alt=media` even when its encrypted mirror already holds the same revision. Focus/visibility polling also reads full documents merely to compare revisions.

Consequently, a warm restart repeatedly downloads unchanged Markdown, delays interactivity, consumes mobile data and CPU, and increases Drive quota pressure. Existing drafts, search sources, sessions, history, and encrypted mirror records are separate stores rather than one revisioned local read model.

The provider source must remain canonical. Browser storage is supporting storage and may be evicted, but dirty drafts, pending operations, conflicts, required base versions, and recovery items can contain irreplaceable unsynchronized work.

## Decision

### One local document repository

Introduce `@note/browser-storage` as the single provider-independent local document repository. Providers perform provider I/O only; they do not own a competing cache.

The repository contains:

- an encrypted workspace manifest for Drive;
- stable provider entry identity and current path mapping;
- clean cached Markdown content and source format;
- separate observed-provider, cached-content, base, and index/diagnostics revisions;
- durable drafts and idempotent pending-write records;
- conflicts and destroyed-draft recovery items;
- bounded history, sessions, search state, sync cursors, and migration state.

The real directory or selected Drive folder remains the provider source. Dirty drafts, pending writes, conflicts, and recovery records take precedence over clean cached provider content.

### Warm startup before remote I/O

A cached workspace restores its manifest, tree, tabs, active document, and warm search state before remote reconciliation. Remote network/filesystem scanning is not on the warm Drive render path.

A cached document opens immediately with a checking state. Editing is allowed and is made locally durable, but a provider write waits until the expected provider revision has been verified.

Local-directory cached content is not exposed until current filesystem permission is confirmed. An unlocked Drive cache may remain editable when provider reauthentication is required; writes remain queued.

### Priority reconciliation

Introduce a framework-independent reconciler and bounded scheduler in `@note/sync-core`. Work is ordered as follows:

1. active document;
2. other open tabs;
3. pending writes and conflicts;
4. remaining new or changed documents needed for complete search and diagnostics.

The queue deduplicates in-flight work by workspace, stable entry identity, and target revision. It uses bounded adaptive concurrency, `Retry-After`, exponential backoff, and jitter. Low-priority work pauses while hidden and under data-saver or very-slow-network signals. Exact concurrency remains benchmark-driven.

The active document is checked immediately when opened/activated/focused and initially every 30 seconds while visible and online. Other open tabs are initially checked every 60 seconds. Checks are deduplicated, pause while hidden/offline, and always run before a provider write. These cadences are implementation defaults subject to measurement. Real-provider qualification confirms approximately 1.1–1.4-second propagation after a foreground reader begins reconciliation, but an untouched reader may still wait for the active-document cadence; this is not a real-time collaboration guarantee.

### Revision model

Metadata observation and content processing advance independently:

- `observedProviderRevision` is the newest provider revision seen;
- `cachedContentRevision` identifies the provider revision represented by cached bytes;
- `baseRevision` identifies the last synchronized common version;
- `indexRevision`/diagnostics generation identifies the content processed by derived state.

Observing remote `R2` while cached content is `R1` never relabels `R1` as current. A matching content download is committed before cached/index revisions advance.

Drive metadata is used for metadata-first comparison, but opaque provider `version` is not treated as content identity when a strong checksum exists. Drive content revisions prefer SHA-256, fall back to MD5, and use `version + modifiedTime + size` only when no content checksum is available. This prevents a Google version-only increment with identical bytes from producing a false conflict while retaining expected-revision checks for real content changes. Local workspaces use `lastModified + size` as a weak startup fingerprint, retain strong content hashes as revisions, perform strong pre-write checks, and run periodic strong verification.

### Provider contract

Extend `WorkspaceProvider` additively to preserve existing consumers. Entries may expose:

- stable provider entry ID;
- revision or metadata fingerprint;
- parent identity;
- deletion and path-collision state.

Providers may expose metadata-only lookup by stable identity and incremental scan batches. Existing `listEntries()` remains a fallback.

Drive file IDs are stable across rename/move. Local entries fall back to normalized paths, with transactional identity migration for app-initiated path changes where possible. Duplicate Drive names remain distinct IDs but produce an explicit blocked path-collision state; NoteMarkdown never selects or renames one silently.

### Changed and deleted entries

Unchanged Markdown is served from the repository and is not downloaded. New or changed unopened Markdown is downloaded and indexed at low priority so search and diagnostics become complete. Under data-saver/very-slow-network conditions, metadata may reconcile while low-priority content waits and the UI reports incomplete derived state.

An entry is removed from the general manifest only after an authoritative full scan or explicit provider change. Open tabs do not wait for that scan: direct stable-ID metadata lookup can authoritatively confirm their deletion.

A confirmed deleted clean tab closes with a short accessible “go up in smoke” transition. If it is dirty, its content is first committed as a persistent recovery item, then the tab closes. Recovery is available through both immediate feedback and a persistent recovery view until the user restores the content as a new file or explicitly removes it. Motion respects `prefers-reduced-motion`.

A remote rename/move with stable identity keeps the existing tab. Path mapping, session, pending-write target, search, diagnostics, and other path-dependent state update transactionally. A simultaneous content change follows normal conflict rules.

### Conflict scope

This cache work does not implement an incomplete automatic three-way merge. If local content based on `R1` encounters remote `R2`, base, local, and remote inputs are durably retained and provider writes enter conflict state. The planned three-way merge engine remains separate milestone-4 work.

### Session and provider failure boundary

Drive-token acquisition is control-plane work through the NoteMarkdown API, not direct provider transfer. Preserve that distinction through typed failures: API 401 means the NoteMarkdown session expired/revoked, API 404 means the saved workspace's connected account no longer exists, reauthorization-required means the Google grant must be renewed, and other API failures remain separate from direct Drive/network/quota failures. Missing-account and reauthorization failures block immediately instead of entering the temporary-provider exponential retry path. Every blocked write already has a durable draft/outbox record; session failure performs no Drive mutation and leaves the write queued. Outbox records carry a format version plus creation/attempt times. Legacy, unsupported, or older-than-30-day records are blocked rather than blindly replayed; a fresh explicit save replaces them. A crash-abandoned `in-flight` item is eligible for retry only after a two-minute safety interval and fresh provider-revision verification. Workspace-generation fences prevent an old workspace operation from updating the newly active workspace UI. Unexpected API exceptions expose only an opaque random correlation reference matching a protected reason-bearing server log.

### Drive Changes API

Deliver change discovery as a second independently reviewable phase.

Initial synchronization obtains a start page token before the full selected-folder scan, then replays changes from that token so the scan boundary loses no mutation. The cold fallback traverses selected-folder metadata in deterministic bounded breadth-first batches rather than serial recursion; current desktop concurrency is benchmark-derived and remains subject to mobile/quota evidence. Normal starts use `changes.list`. Each applied page and its next cursor commit atomically.

Changes can be account-wide among entries visible under the granted scope. The reconciler filters known IDs/parents to the selected workspace and resolves unknown or ambiguous ancestry without indexing the entire Drive. Token invalidation, ambiguous ancestry/moves, and an initial 24-hour visible-online safety interval trigger a selected-folder full metadata scan. The interval remains configurable and evidence-driven.

### Browser-tab coordination

Only one browser tab is sync leader for a workspace. Followers read durable updates and receive notifications. Prefer Web Locks and `BroadcastChannel`, with a safe IndexedDB lease fallback. Startup activation is idempotent so duplicate React lifecycle invocation cannot orphan a leadership lock. A follower periodically promotes itself after the leader disappears; the fallback lease uses short renewable fencing so an abruptly closed leader cannot leave synchronization inert.

Only one browser tab holds an editing lease for a document. Another tab opens it read-only and may explicitly take over after the current buffer is made durable and the previous owner is notified.

Workspace switching cancels new old-workspace work, safely finishes or later reconciles mutations already in flight, and uses workspace/generation IDs to discard late UI responses.

### Encryption and migration

Encrypt all sensitive Drive-derived browser data at rest, including content, names, paths, parent relationships, manifest metadata, drafts, history, search sources/indexes, conflicts, recovery items, and pending operations. Retain only the minimum opaque envelope required to locate and unlock ciphertext.

For existing browser data:

- purge rebuildable plaintext Drive search/cache records;
- transactionally encrypt irreplaceable drafts and relevant history before deleting originals;
- import existing encrypted mirror content only after path and remote revision match;
- quarantine failures rather than clearing storage.

Explicit logout removes active key access and leaves retained ciphertext locked. Logout with dirty or queued work requires clear confirmation. Wrapped-key re-unlock remains a separate security design.

### Quota, corruption, and fallback

Request persistent browser storage where supported. Refusal is a valid degraded mode and does not block a workspace.

Under quota pressure, evict rebuildable index artefacts first, then least-recently-used clean unopened content. Never automatically remove drafts, pending operations, conflicts, required base versions, open documents, or recovery items.

Isolate corrupt records. Rebuild clean data from the provider where possible, preserve irreplaceable data for recovery, and never require clearing all site data. Cache absence or eviction always leads to a valid cold start.

### Rollout

Introduce the warm activation/reconciler behind a temporary feature flag with a cold-provider fallback. The fallback may ignore rebuildable cache but must still understand and preserve drafts, pending writes, conflicts, and recovery items. Remove the flag after migration, browser, performance, and provider tests pass.

### Performance and observability

On defined lower-end mobile benchmark hardware, a cached workspace with 10,000 entries must restore an interactive tree, tabs, active cached document, and warm search state within one second, without waiting for provider I/O.

Required network outcomes:

- warm Drive start without changes: zero Markdown content downloads;
- one changed remote Markdown document: at most one required content download.

Measure activation, manifest load, reconciliation, cache hits/misses, metadata requests, content downloads/bytes, queue latency, and indexing locally. External reporting follows existing aggregate and opt-in detailed-diagnostics consent rules and never includes workspace IDs, provider file IDs, names, paths, or content.

The 2026-08-09 desktop real-provider qualification measured a 128 ms warm cached tree with zero Drive requests, compared with a 14.8–18.4-second cold selected-folder activation and 338–339 metadata requests per isolated browser. Exact foreground cross-browser visibility was 4.2–4.6 seconds from edit. These results validate the warm path and bounded scan improvement, but they do not satisfy the remaining mobile, browser-matrix, progressive-cold-tree, or passive-polling evidence requirements. See [Google Drive Sync Qualification](../08-drive-sync-qualification.md).

## Consequences

### Positive

- Warm mobile startup no longer redownloads unchanged Markdown.
- Cached UI and editing do not wait for Drive or a full scan.
- Search and diagnostics remain fast initially and converge incrementally.
- Stable IDs preserve Drive renames/moves.
- Storage, sync, React state, and provider responsibilities become testable in isolation.
- Changes API later removes routine recursive directory scans without coupling that optimization to the first fix.

### Costs

- New packages, schema migrations, encryption work, and multi-tab coordination are required.
- UI must represent checking, incomplete, queued, locked, collision, destroyed/recovery, and conflict states.
- A central repository requires strict transaction ordering and corruption recovery.
- Drive Changes filtering, token recovery, and ambiguous ancestry handling add phase-B complexity.

### Explicitly rejected

- Skipping indexing without revision reconciliation.
- Keeping provider-owned and central document caches permanently in parallel.
- Blocking the warm UI on a remote scan.
- Last-write-wins or automatic provider overwrite.
- Treating all remote absence during a partial scan as deletion.
- Implementing the cache and complete three-way merge as one rewrite.
- Permanently rescanning the selected Drive folder on every startup after Changes initialization.

## References

- [Original Dutch handoff analysis](../HANDOFF-mobile-workspace-cache.md)
- [Implementation plan](../../plans/mobile-workspace-cache-and-reconciliation.md)
- [Architecture and decisions](../05-architecture-and-decisions.md)
- [Feature specifications](../04-feature-specs.md)
- [Test strategy](../06-test-strategy.md)
