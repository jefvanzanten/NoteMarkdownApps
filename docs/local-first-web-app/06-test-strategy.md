# 06. Test Strategy

## 1. Quality goals

Testing protects the product's highest-risk promises:

- no document-content leakage to the backend;
- no silent data loss or conflict overwrite;
- reliable offline and migration behavior;
- responsive editing and rendering at target scale;
- consistent provider semantics;
- accessible keyboard, screen-reader, and mobile workflows;
- secure multi-user isolation;
- reproducible official and self-hosted upgrades.

Passing unit tests alone is not sufficient for v1.

## 2. Test levels

### Unit tests

Fast deterministic tests for:

- path normalization and relative-link resolution;
- supported file and image filtering;
- `.notemarkdownignore` behavior;
- command registry and keybinding conflict rules;
- settings merge/sync rules;
- revision comparisons and independent observed-provider/cached-content/index-generation transitions;
- priority-queue ordering, request deduplication, cancellation generations, retry timing, and starvation prevention;
- workspace sync-leader and document editing-lease state transitions;
- operation state transitions and retry timing;
- history thinning and trash expiry;
- query parsing and exact phrases;
- link/asset extraction and diagnostics;
- telemetry allowlists and forbidden fields;
- API authorization predicates and error mapping.

### Rust/WASM tests

Run native Rust tests where possible and WASM/browser tests where boundary behavior differs.

Cover:

- CommonMark/GFM conformance fixtures for enabled features;
- tables, task lists, strikethrough, autolinks, fenced code, and heading anchors;
- raw HTML suppression;
- unsafe URI handling;
- source offset/render mapping;
- heading/link/image/code-language extraction;
- Unicode and UTF-8 edge cases;
- very deep or adversarial Markdown;
- large documents and memory behavior;
- deterministic output across native and WASM targets where expected.

### Component tests

Test React behavior with realistic state boundaries:

- file tree keyboard navigation and virtualization;
- sidebar collapse, resize, and mobile drawer;
- search replacing/restoring the tree;
- tab behavior and active-document restoration;
- Editor/Preview toggle and source-position restoration;
- save/sync/error status semantics;
- keybinding settings and conflicts;
- permission, quota, offline, and conflict prompts;
- conflict editor desktop/mobile modes;
- update-available prompt;
- localized Dutch and English UI.

### Integration tests

Exercise real boundaries where practical:

- Zustand stores with domain services;
- editor events through durable draft persistence;
- worker message protocols and stale-generation cancellation;
- WASM initialization/rendering through the actual wrapper;
- IndexedDB/OPFS transactions, encryption, corruption isolation, and migrations;
- central repository commit ordering across manifest, content revision, pending writes, recovery, and derived-index generations;
- multi-tab leader/follower propagation through Web Locks/BroadcastChannel and the IndexedDB lease fallback;
- search indexing after file lifecycle events;
- API runtime schemas through Hono routes;
- Drizzle repositories against PostgreSQL;
- OAuth/session components with provider HTTP mocks;
- service worker install/update behavior.

### End-to-end tests

Required critical journeys:

1. Open local directory, edit, autosave, close, and reopen.
2. Crash/reload before provider save and recover the durable draft.
3. Create/move/rename/trash/restore files and verify reference updates.
4. Search content, open results in tabs, clear query, restore tree.
5. Add images by paste/drop and verify actual provider destination.
6. Switch Editor/Preview and preserve document context.
7. Install/update PWA without losing active work.
8. Work offline, reload, continue, reconnect, and synchronize.
9. Detect an external local edit before overwrite.
10. Sign in, select/create Drive folder, mirror, edit, and sync.
11. Revoke permission/session and recover through reauthorization.
12. Produce and resolve a Drive conflict without losing either side.
13. Explicitly logout and verify Drive repository lock.
14. Delete account and verify NoteMarkdown data removal without Drive-file deletion.
15. Restore app state and linked Drive workspace on another simulated device.
16. Warm-start a cached workspace without waiting for provider I/O and assert zero unchanged Drive content downloads.
17. Prioritize active/open document checks over a large background batch and apply one remote change with exactly one content download.
18. Confirm remote deletion of a clean and dirty open document; verify accessible destroyed-tab motion and persistent dirty-draft recovery.
19. Open the same workspace/document in two app tabs and verify one sync leader plus explicit editing takeover.
20. Resume from a Drive Changes cursor; handle move/delete, token invalidation, ambiguous ancestry, and full-scan fallback.

## 3. Workspace provider contract suite

Every `WorkspaceProvider` implementation must pass the same behavioral suite.

### Read behavior

- stable workspace identity;
- deterministic supported-entry listing;
- file read with revision;
- missing/permission/unsupported error mapping;
- path normalization and traversal rejection.

### Write behavior

- create and collision semantics;
- write with expected revision;
- conflict on stale revision;
- no silent overwrite;
- UTF-8 and line-ending preservation;
- retry/idempotency behavior where applicable.

### Structure behavior

- create folder;
- rename/move file and folder;
- nested paths;
- transaction failure behavior;
- trash, restore, and permanent deletion;
- capability reporting.

### Change behavior

- external/remote create, update, move, and delete discovery;
- permission loss;
- offline and reconnection;
- throttling/quota errors;
- revision stability and hash behavior;
- stable provider entry identity and rename/move mapping;
- metadata-only lookup without content reads;
- incremental scan batches where supported;
- duplicate-path collision reporting;
- local weak metadata fingerprint versus strong pre-write hash behavior.

The suite may use provider-specific fixtures but must assert shared outcomes.

## 4. Synchronization and conflict testing

The sync engine uses deterministic model tests and fault injection.

### Required scenarios

- local-only edit;
- remote-only edit;
- non-overlapping concurrent edits;
- overlapping concurrent edits;
- remote change during conflict resolution;
- repeated/transient failed write;
- process/reload between enqueue and write;
- response loss after provider applied a mutation;
- rename combined with content edit;
- delete versus edit;
- folder move with referenced assets;
- multiple queued operations on one document;
- one conflicted document alongside independent queued files;
- Drive throttling and bounded retry;
- local quota exhaustion during queue persistence.

### Properties

- applying the same acknowledged operation twice does not duplicate effects;
- no resolved state loses an unacknowledged revision;
- base revision advances only after confirmed reconciliation;
- queue order and compaction preserve user intent;
- every conflict remains recoverable until explicit resolution/removal.

State-machine or property-based testing is strongly preferred for the queue and reconciliation logic.

## 5. Browser persistence and migration tests

For every released schema version:

- retain representative fixtures containing drafts, queue operations, conflicts, history, indexes, settings, and session state;
- migrate to every supported target path;
- verify content hashes and semantic state before/after;
- inject transaction interruption and quota failure;
- verify the original data remains recoverable;
- verify logout lock and relogin unlock behavior;
- verify “remove local data” deletes intended stores only;
- verify cache rebuild cannot delete provider content;
- migrate legacy plaintext Drive search/cache records without retaining rebuildable plaintext;
- preserve and encrypt legacy dirty drafts/history before deleting originals;
- import a legacy encrypted Drive mirror only when path and revision match;
- isolate one corrupt record without clearing unrelated or irreplaceable data;
- verify quota cleanup order and persistent-storage refusal behavior;
- verify a blocked upgrade coordinates with an older app tab without clearing data.

A release is blocked if it requires users to clear site data to recover from a normal upgrade.

## 6. API and database tests

### Contract tests

- Every route validates requests at runtime.
- Responses match the derived OpenAPI contract.
- Error envelopes are stable and documented.
- API contract tests run against official and Docker Compose configurations.

### Multi-user isolation

For each user-owned repository/endpoint:

- user A cannot read, update, delete, or infer user B's resource;
- connected-account identity is scoped to internal user;
- Drive folder references cannot be reassigned through guessed IDs;
- session revocation applies immediately according to contract;
- account deletion is complete and idempotent.

### Database migrations

- Apply from a clean database.
- Upgrade from each supported released schema.
- Test backup/restore around destructive migrations.
- Verify constraints and indexes under concurrent requests.
- Verify token ciphertext key-version migration/rotation.

## 7. OAuth and Drive testing

Use three layers:

1. **Pure mocks** for errors, revisions, throttling, and deterministic sync tests.
2. **HTTP fake provider** matching relevant Google response contracts for integration tests.
3. **Dedicated Google staging project/account** for a small protected suite validating real scopes, Picker behavior, token refresh, folder operations, and revisions.

Real-provider tests must never use personal production Drive data and must clean up isolated test folders.

Required security cases include state/PKCE validation, redirect URI checks, denied consent, revoked grant, expired access token, refresh failure, and cross-user token mix-up prevention.

Drive cache/change tests additionally assert:

- a revision-equal warm read makes no `alt=media` request;
- one changed document makes one required content request;
- the initial start-token/full-scan/change replay boundary loses no mutation;
- a changes cursor advances only atomically with applied pages;
- invalid/expired tokens and ambiguous ancestry trigger a scoped full scan;
- trashed/permanently removed entries, moves, and duplicate names map to explicit domain states;
- the protected staging smoke suite uses a synthetic selected folder and validates the actual `drive.file`/Picker behavior.

## 8. Browser and device matrix

### Official browsers

Test the latest two stable major versions where CI infrastructure permits:

- Chrome;
- Edge;
- Firefox;
- Safari;
- current iOS browser;
- current Android Chrome.

### Capability matrix

- Full real-directory E2E: browsers with supported File System Access behavior, primarily Chromium.
- Drive workspace E2E: all official browser families.
- PWA install/update: supported install environments plus graceful non-install behavior.
- OPFS/IndexedDB, WebCrypto, workers, and WASM: all official browser families.

Use representative desktop, tablet, and phone viewports. At least one lower-end physical or realistically throttled mobile profile is part of performance qualification.

## 9. Accessibility testing

### Automated

- semantic/ARIA rule scanning;
- color contrast;
- focusable-control checks;
- no inaccessible nested interactive controls;
- localization overflow snapshots where useful.

### Manual

- complete primary journey using keyboard only;
- file tree navigation with expected tree semantics;
- tab and drawer focus management;
- save/sync/conflict announcements;
- editor and preview operation with major screen-reader/browser combinations;
- 200% zoom and reflow;
- reduced motion;
- touch target and mobile screen-reader checks;
- visual conflict resolution without relying only on color.

WCAG 2.2 AA issues on primary flows block v1.

## 10. Performance strategy

### Benchmarks

Maintain representative corpora:

- small normal notes;
- 1 MB mixed GFM document;
- 10 MB mixed GFM document;
- code-heavy document across multiple languages;
- link/image-heavy document;
- pathological nesting/long-line cases;
- 10,000-entry workspace with realistic directory depth;
- large search corpus and update bursts.

### Measurements

- WASM download, compile/instantiate, and memory;
- Markdown-to-HTML worker duration;
- message serialization/transfer;
- syntax highlighting load and execution;
- editor input latency during render;
- file-tree mount, scroll, expand, and update;
- index build, incremental update, query latency, and storage size;
- workspace startup from cold scan and warm cache, including time to cached interactivity;
- Drive metadata request count, content download count/bytes, cache hit/miss count, and priority-queue latency;
- encrypted 10,000-entry manifest load/decrypt/parse cost and candidate record layouts;
- sync reconciliation and queue throughput;
- browser storage usage and history thinning.

### Initial hard budgets

- Representative 1 MB render: at most 100 ms on defined target hardware.
- Representative 10 MB render: at most 750 ms on defined target hardware.
- UI interactions must remain responsive because expensive work is off the main thread.
- On defined lower-end mobile benchmark hardware, a cached 10,000-entry workspace reaches an interactive tree, tabs, active document, and warm search state within one second.
- Warm Drive startup with no changes performs zero Markdown content downloads.
- One changed remote Markdown document requires at most one content download.

Record hardware/browser/version with benchmark results. CI trend detection may use stable benchmark runners; mobile release checks may be scheduled/manual if CI variance is too high.

## 11. Security testing

- Threat model local, Drive, API, OAuth, PWA update, self-host, and contribution paths.
- XSS corpus for Markdown, links, code output, and SVG.
- CSP validation.
- Path traversal and provider-root escape tests.
- CSRF/session fixation/cookie policy tests.
- OAuth mix-up and state tests.
- Refresh-token encryption, key rotation, and logging redaction tests.
- Dependency, license, container, and secret scanning.
- Rate-limit and resource-exhaustion tests for API endpoints.
- Verify forbidden content fields cannot enter telemetry.
- Verify API body limits prevent accidental content proxying.

Security-through-obscurity is not accepted; public source must remain safe with secrets externalized.

## 12. Observability tests

- Operational metrics exist for request volume, latency, errors, DB saturation, and Drive throttling/quota.
- Trace/log correlation works without sensitive identifiers.
- Product event payloads validate against allowlists.
- Detailed diagnostics are not sent without consent.
- Consent changes take effect immediately.
- Self-host telemetry disablement is verified in an integration deployment.
- Alert tests or synthetic failures verify that sudden traffic/error growth is visible.

## 13. Self-hosting and release tests

For every release candidate:

- start a clean Docker Compose deployment;
- validate required secret/config failures are actionable;
- complete Google OAuth setup against documented configuration;
- run database migration and rollback/recovery procedure where supported;
- restore a database backup;
- upgrade from each supported prior release;
- verify web/API version compatibility behavior;
- verify health/readiness endpoints;
- verify telemetry configuration and opt-outs;
- run a smoke workspace flow.

Do not publish an image tag as stable until the corresponding compose and upgrade tests pass.

## 14. Test data rules

- Never use real personal documents in automated tests or fixtures.
- Generate representative synthetic Markdown, images, trees, and revisions.
- Security/adversarial fixtures are clearly labeled and never rendered outside isolated test contexts.
- Google staging accounts and folders are dedicated and least-privileged.
- Performance corpora are versioned so regressions are comparable.

## 15. Release gates

V1 is blocked by any of the following:

- document content reaches backend/logging/analytics;
- provider contract failure;
- silent overwrite or unrecoverable conflict path;
- migration data loss;
- warm startup downloading unchanged Drive Markdown;
- cached 10,000-entry mobile startup exceeding the one-second budget without an approved recorded exception;
- critical/high unresolved security finding;
- primary-flow WCAG 2.2 AA failure;
- hard performance-budget regression without an approved recorded decision;
- unsupported browser behavior presented as supported;
- failing Docker Compose clean-install or upgrade test;
- existing app breakage caused by shared editor changes;
- incomplete Dutch/English primary flow;
- PWA update capable of discarding active work.

## 16. CI organization

Recommended logical pipelines:

1. formatting/static analysis/type checking;
2. TypeScript unit and component tests;
3. Rust native and WASM tests;
4. package/provider contract tests;
5. API/PostgreSQL integration tests;
6. browser E2E matrix;
7. accessibility checks;
8. security/license/secret/container scans;
9. bundle and stable-runner performance budgets;
10. Docker Compose install/upgrade smoke tests.

Exact tools are selected during implementation and recorded in Architecture & Decisions. The required outcomes in this strategy are tool-independent.
