# 08. Google Drive Sync Qualification

## Status and scope

This document records implementation evidence for the current Google Drive workspace path. It is a local desktop qualification, not a replacement for the required dedicated staging-account suite, mobile benchmark, browser matrix, conflict matrix, or release gates in [06. Test Strategy](06-test-strategy.md).

The protected test used an explicitly authorized selected Drive folder and one reversible Markdown target. Workspace IDs, Drive IDs, names, paths, credentials, and document content are intentionally omitted from this document and from attached metrics.

## Test environment

Qualification date: 2026-08-09.

- Ubuntu 24.04.4 LTS;
- AMD Ryzen 7 7700, 8 cores / 16 threads;
- 30 GiB RAM;
- Google Chrome 151.0.7922.108;
- local Vite/API/PostgreSQL deployment;
- two isolated Playwright browser contexts sharing only the authenticated API session;
- direct browser-to-Google Drive traffic;
- real Google OAuth and Drive provider;
- exact-content comparison followed by a confirmed rollback upload of the original editor content and source format.

Google blocks login in browsers launched with standard Playwright automation flags. The protected setup therefore performs interactive OAuth in a normally launched Chrome instance exposed over a localhost-only CDP endpoint. Playwright stores the resulting NoteMarkdown session state in the ignored `playwright/.auth/` directory; it does not automate Google credentials.

## Scenario

For every sample:

1. create two isolated, empty browser contexts;
2. open the same linked Drive workspace in both contexts;
3. open the same Markdown document and require identical starting content;
4. replace the writer buffer with the original plus one unique line;
5. save and wait for Google's successful upload response;
6. foreground the reader and require its complete content to equal the writer revision exactly;
7. append and save a second unique line from the reader;
8. foreground the original writer and require the complete return revision exactly;
9. restore the original content through the app and require a successful rollback upload;
10. retain only aggregate path-free timing/request metrics.

This tests separate browser storage and repository state rather than same-tab `BroadcastChannel` propagation. It is device-like isolation inside one Chromium process, not yet a cross-engine test. Both contexts currently start from the same saved NoteMarkdown API session cookie; session expiry is tested separately by deterministic interception, not by two independently issued live sessions.

## Measured baseline

### Cold and warm activation

| Implementation | Selected-folder cold activation | Notes |
| --- | ---: | --- |
| Original depth-first serial scan | more than 120 s | Still not interactive after roughly 255–261 folder listings per browser |
| Bounded breadth-first scan, concurrency 6 | 28.3–32.9 s | Five sequential protected samples |
| Bounded breadth-first scan, concurrency 10 | 19.8–20.4 s | One comparison sample |
| Bounded breadth-first scan, concurrency 14 | 14.8–18.4 s | Practical desktop limit retained after quota-safe real-provider runs |
| Warm cached reload | 128 ms | Zero Drive metadata requests and zero content downloads before the interactive tree |

The selected folder required approximately 334 folder-list calls. A complete cold activation produced 338–339 aggregate Drive metadata requests per browser after token/change checks. Raising concurrency changes wall-clock time, not request volume. Concurrency 14 is therefore a measured desktop implementation default, not a universal mobile/provider budget; adaptive tuning remains required.

### Foreground write and cross-browser visibility

Three confirmation samples at the retained scan concurrency, followed by a normal background-indexing run, produced:

| Metric | Observed range |
| --- | ---: |
| Google Drive write acknowledgement after explicit save | 2.2–2.6 s |
| Exact reader visibility from the writer edit | 4.2–4.6 s |
| Exact reader visibility after Google's write acknowledgement | 1.1–1.4 s |
| Writer mutations per edit | exactly 1 |
| Exact-content result | 100% for final qualification runs |
| Rollback upload of original content | passed for every final qualification run |

The reader was explicitly foregrounded after the write. Without a focus/visibility event, the current active-document polling default may delay observation by up to approximately 30 seconds. These numbers are foreground reconciliation measurements, not real-time collaboration claims.

A 2026-08-09 follow-up regression run extended the scenario to a complete A → B → A edit/save handoff. Both exact directions and the rollback upload passed. A separate non-mutating run forced a Drive 401 followed by an expired NoteMarkdown API session; the UI retained the local draft, queued the provider write, identified the expired/revoked session, requested sign-in, and issued zero Drive mutations. A later three-scenario run passed in 31.0 s, 18.0 s, and 18.0 s respectively; the third scenario terminated a warm leader page, restored the saved workspace, simulated its connected account being absent, observed one blocking token attempt, and observed zero direct Drive requests.

The normal-mode sample remained responsive while low-priority indexing started and observed 22–37 content downloads per browser during the short foreground scenario. Data-saver isolation runs disabled this background content work and produced comparable foreground sync timing.

## Defects found and resolved

### Serial cold traversal

The Drive provider previously awaited every nested folder recursively. A large selected folder remained blocked beyond two minutes. The provider now builds the same deterministic tree with bounded breadth-first folder-list batches. Duplicate names, stable IDs, parent mappings, and collision states retain their existing semantics.

### Provider version-only false conflicts

A real upload returned provider version 28. Metadata read a few seconds later returned version 29 while checksum, size, modified time, and bytes were unchanged. Treating the opaque provider version as the complete content identity produced a false external-change conflict and blocked the next safe write.

Drive content revisions now prefer SHA-256, fall back to MD5, and use provider version/modified-time/size only when no content checksum is available. Provider versions remain metadata, but version-only drift with identical strong content identity no longer creates a conflict. Pre-write metadata verification and conflict preservation remain mandatory.

### Duplicate explicit-save/autosave race

The store previously marked a write as in progress only after several asynchronous durability operations. The autosave timer could enter the same write while `Ctrl/Cmd+S` was already processing. Save state is now fenced synchronously as `persisting-local`, producing one mutation per final qualification sample.

### Opaque session/API failures

A NoteMarkdown API 401 during Drive-token renewal was previously flattened into a generic provider-reachability failure. API failures are now typed by HTTP status/code, session expiry and Google reauthorization are reported separately, and the banner states the concrete reason plus local-draft outcome. Unexpected API 500 responses include a random diagnostic reference also written to the reason-bearing server log; the client never receives the internal exception message.

### Stale connected account and inert follower

A new warm-restoration edge test exposed two interacting failures. API 404 for a removed connected account had been classified as temporary, making the default retry policy capable of accumulating roughly three minutes of backoff. Concurrent duplicate startup could also orphan a Web Lock handle, while a follower never promoted itself after its leader disappeared. Startup is now idempotent, followers promote after leader loss, the IndexedDB fallback uses short renewable fenced leases, and missing-account/reauthorization failures block without temporary-provider retries.

### Diagnostic-report loss edges

The temporary diagnostic sink now correlates concurrent Drive requests, deduplicates only the same error object rather than unrelated errors occurring within one second, and trims oldest breadcrumbs to remain under the API body limit. Broad background indexing catches now suppress only confirmed not-found races; authentication, network, and unexpected failures reach the diagnostic reporter and clear the indexing state.

### Misleading status language

Drive documents previously displayed local-provider wording such as “Saved to disk” and “local / direct.” The active provider now exposes Drive-specific user states:

- “Syncing to Google Drive…”;
- “Synced to Google Drive”;
- “Google Drive / online”.

Dirty, checking, queued, offline, conflict, blocking-error, and read-only lease states remain distinct.

## UX assessment

### Sufficient for MVP/private beta

- dirty, syncing, synchronized, queued, offline, and conflict states are represented;
- foreground edits remain usable during normal background indexing;
- exact bidirectional cross-browser reconciliation and confirmed rollback uploads pass;
- expired server sessions are distinguished from provider transfer failures without discarding or uploading the local draft;
- warm startup is effectively immediate and performs no provider I/O on the render path;
- the app does not silently overwrite the tested provider-version drift case.

### Remaining v1 gaps

1. **Cold activation:** 14.8–18.4 seconds and 338–339 metadata requests remain too expensive for a polished first-use experience.
2. **Loading feedback:** the blocking cold overlay is indeterminate and does not identify authentication, metadata scan, repository restore, or indexing phases.
3. **Progressive discovery:** root entries are not rendered before the complete selected-folder traversal. A root-first tree with background subtree discovery is the highest-value next performance change.
4. **Passive propagation:** foreground/refocus synchronization is about four to five seconds end to end, but an untouched visible reader may wait for the 30-second cadence.
5. **Remote-update feedback:** a clean tab can update correctly without a concise accessible “Updated from Google Drive” announcement.
6. **Index completeness:** “Indexing workspace…” is truthful but does not expose processed/remaining counts, pause state, or data-saver deferral.
7. **Qualification breadth:** Firefox/Safari, mobile/lower-end hardware, offline/reconnect, quota, revoked grants, token refresh, and true concurrent-edit conflicts still require protected coverage.
8. **Independent sessions/deployments:** the bidirectional handoff still needs two independently issued/revocable API sessions. Local-to-production coverage additionally needs separate auth states and workspace links because origins and databases do not share session cookies or references.

## Verdict

The current Drive path is suitable for an MVP/private beta focused on personal cross-device editing. It is not yet fully qualified for public v1.

The sync write itself has reached a stable local desktop plateau around 2.2–2.6 seconds, with foreground cross-browser visibility around 4.2–4.6 seconds from edit and exact reader content in final runs. Warm startup exceeds the current budget positively at 128 ms with zero provider I/O. Public-v1 work should focus on root-first progressive cold discovery, clearer phased progress, a measured active-reader cadence/manual sync action, and the required real-provider browser/device/conflict matrix rather than increasing raw folder-request concurrency further.

## Reproduction

See [`../../e2e/README.md`](../../e2e/README.md) for protected authentication and execution instructions. Keep real-provider tests opt-in, reversible, single-worker, path-free in metrics, and restricted to explicitly approved test data.
