# 05. Architecture & Decisions

## 1. Architecture goals

- Keep document content on the user's device and selected provider.
- Keep the frontend static, offline-capable, and independently deployable.
- Keep the API small, stateless at the process level, and horizontally scalable.
- Make local and Drive behavior conform to one domain model.
- Keep rendering, indexing, and sync work away from the UI thread.
- Reuse packages across NoteMarkdown apps without forcing immediate migrations.
- Support the official hosted service and Docker Compose self-hosting from the same codebase.

## 2. System context

```text
Local directory <---- File System Access ----> React/Vite PWA
                                                  |
Google Drive <----- Drive API + short token ------+
                                                  |
                                                  +---- Hono API ---- PostgreSQL
                                                        |                |
                                                        +-- Google OAuth  +-- users/sessions/
                                                                           tokens/preferences/
                                                                           Drive folder refs
```

Document and image data use only the horizontal provider paths. The Hono API must not expose a content upload or render endpoint.

## 3. Deployable applications

### `apps/web-app`

Static React/Vite PWA.

Responsibilities:

- application shell and routing;
- workspace UI, tabs, file tree, search, editor, preview, history, and conflicts;
- browser persistence and migrations;
- local workspace provider;
- Drive content client and local document repository orchestration;
- workers and WASM orchestration;
- global preferences and API client;
- service worker and update lifecycle.

It is deployed as immutable static assets on a CDN or static web server.

### `apps/api`

Independent TypeScript/Hono service.

Responsibilities:

- Google OAuth initiation/callback and connected accounts;
- encrypted refresh-token lifecycle;
- opaque session lifecycle;
- short-lived Drive access-token delivery under an authenticated session;
- linked Drive folder IDs/display names;
- global preferences and keybindings;
- account deletion;
- health, readiness, OpenAPI, and operational instrumentation.

It is deployed as a stateless container. PostgreSQL provides durable shared state.

### Existing apps

`apps/demo`, `apps/web-tray-app`, and `apps/desktop-app` remain separate during web v1. Shared-package changes must remain compatible. Their migration is post-v1 roadmap work.

## 4. Proposed shared package boundaries

Names are proposed and may be adjusted during implementation, but responsibilities must remain separated.

### Existing `@note/editor`

- CodeMirror lifecycle.
- Markdown editor commands.
- Command registry.
- Default and custom keybindings.
- Link-completion extension points.
- Merge-view integration primitives where generally reusable.

The editor package must not know Google Drive, Hono, React application routes, or browser database schemas.

### `@note/workspace-core`

- Workspace IDs and path semantics.
- `WorkspaceProvider` contract.
- File tree/domain entities.
- Provider capability model.
- File operations and path-transaction orchestration.
- Revision and conflict primitives.
- Provider contract test suite.

### `@note/workspace-local`

- File System Access implementation.
- Permission lifecycle.
- Local metadata/hash revision strategy.
- External-change discovery.
- Local trash adapter.

### `@note/workspace-drive`

- Google Drive API client.
- Selected-folder scoping.
- Drive revision/change mapping.
- Drive trash and folder operations.
- Direct browser content transfers.

It receives short-lived access tokens through an interface; it does not own API session logic.

### `@note/sync-core`

- Durable operation model, including per-document pending writes.
- Bounded priority queue, request deduplication, retries, backoff, and cancellation generations.
- Reconciliation state machine with separate observed-provider, cached-content, and index generations.
- Workspace sync-leader and document editing-lease coordination contracts.
- Three-way merge orchestration.
- Conflict and destroyed-draft recovery lifecycle.

### `@note/browser-storage`

- Versioned IndexedDB/OPFS schemas and forward-only migrations.
- The single local document repository and encrypted workspace manifests.
- Drafts, observed/cached/base revisions, pending writes, conflicts, recovery items, history, indexes, sessions, sync cursors, and migration quarantine.
- Atomic per-document commit APIs and corruption isolation.
- Adaptive quota and least-recently-used retention primitives.
- Encryption boundary for all sensitive retained Drive-derived data.

### `@note/markdown-wasm`

Rust crate/build output plus TypeScript wrapper contract.

- GFM parsing with `pulldown-cmark`.
- Safe HTML generation.
- raw HTML suppression;
- source-offset/render mapping;
- extraction of headings, links, images, and code-language metadata where efficient.

The WASM interface should exchange coarse payloads rather than calling across the JS/WASM boundary per token.

### `@note/search`

- Local incremental indexing.
- Query parser for case-insensitive terms and quoted phrases.
- Search worker protocol.
- Snippet generation.

The exact index implementation remains an implementation decision gated by benchmarks.

### `@note/api-contracts`

- Runtime request/response schemas.
- Derived TypeScript types.
- Versioned OpenAPI generation inputs.
- Forbidden-field/privacy tests where practical.

### `@note/ui` (optional)

Only introduce this package when genuinely shared accessible primitives emerge. Do not create it merely to centralize one-off web-app components.

## 5. Frontend layers

### Presentation

React components with CSS Modules and centralized CSS custom-property tokens. Components consume selectors and domain services; they do not call Drive or IndexedDB directly.

### Client state

Zustand stores separated by domain, for example:

- workspace lifecycle and capabilities;
- file tree and selection;
- tabs and document session state;
- save/sync status;
- search query/results;
- global UI/preferences.

Avoid one megastore. Use selectors so changes to one document or sync item do not rerender the entire tree/editor.

### Server state

TanStack Query is limited to API data such as current account, connected accounts, linked Drive workspaces, and synchronized global preferences. Provider file content is not “server state” in TanStack Query.

### Domain/application services

Framework-light services coordinate providers, persistence, sync, indexing, and history. The sync engine must be runnable/testable outside React.

## 6. Worker and WASM model

### Render worker

- One worker owns the single-threaded Rust/WASM renderer.
- Requests carry document ID, revision/generation ID, Markdown, and render options.
- Responses carry safe HTML, source mapping, headings/links/assets, code-block language metadata, timings, and generation ID.
- Stale responses are discarded using generation IDs.
- Adaptive debounce limits large-document churn.

### Search/index worker

- Receives incremental file changes.
- Owns or coordinates the local index.
- Returns compact result IDs/snippets.

### Other background work

Content hashing, workspace scans, link diagnostics, and large merge work may use workers after measurement. Do not introduce `SharedArrayBuffer` or cross-origin isolation for v1.

### Syntax highlighting

A separate lazy-loaded browser highlighter processes only code languages present in the render result. The selected library remains replaceable and is measured independently from core WASM.

## 7. Workspace provider contract

The contract exposes semantic operations rather than raw provider APIs. Cache lookup does not live in a provider: providers perform provider I/O, while the document repository and reconciler decide when I/O is necessary.

The existing contract is extended additively so current consumers keep working. Entries may expose a stable provider entry ID, revision/fingerprint, parent identity, and deletion/collision metadata. Providers may additionally expose metadata-only lookup by stable identity and an incremental scan-batch API; `listEntries()` remains the compatibility fallback.

Illustrative capabilities include:

```text
identify workspace
list/read supported entry
create/write with expected revision
create directory
rename/move with expected source revision
trash/restore/permanently delete
read provider revision metadata by stable identity
stream metadata scan batches
scan/discover changes with an opaque cursor
request/recheck permission
resolve provider asset URL/blob
report capability flags
```

Every mutating method returns a new revision or a typed conflict/error. Provider errors map to shared categories such as permission, offline, throttled, quota, conflict, unsupported, not found, and fatal.

The core never implements “last write wins.” Drive IDs provide stable identity across rename/move. Local providers fall back to normalized paths and preserve identity for app-initiated path transactions where possible. Duplicate Drive names remain separate IDs but enter an explicit path-collision state until the user resolves them.

## 8. Local-first write path

```text
CodeMirror change
  -> update document session state
  -> persist draft locally
  -> append/update history checkpoint as policy requires
  -> update diagnostics/search incrementally
  -> debounce provider action
     -> local provider: revision-check and write actual file
     -> Drive provider: append durable sync operation
  -> update visible save/sync state
```

`Ctrl/Cmd+S` skips the provider debounce but not local persistence, revision checks, or queue durability.

## 9. Workspace activation and synchronization flow

### Warm activation

1. Open browser storage and unlock the workspace repository where policy permits.
2. Load the workspace manifest, session, active cached document, open tabs, warm search state, drafts, recovery items, and pending writes.
3. Render immediately. Local-directory content remains gated by current filesystem permission; an unlocked Drive cache may remain editable while provider reauthentication is pending.
4. Elect one workspace sync leader. Other browser tabs consume repository updates.
5. Queue metadata checks in order: active document, other open tabs, pending writes/conflicts, then remaining manifest reconciliation.
6. Compare observed-provider revisions with cached-content revisions. Unchanged content is read from the repository and never downloaded.
7. Download each new or changed Markdown document at most once, commit its matching content revision, then update search and diagnostics generations incrementally.

A cached document can be edited while its check runs. The draft and pending-write record become durable immediately, but provider mutation waits for revision verification.

### Drive delta synchronization

1. Load the encrypted repository, manifest, pending operations, and last durable Drive change cursor.
2. If online and authenticated, obtain a short-lived access token from the API.
3. On initial setup, acquire a start page token, perform a full selected-folder scan, and process changes since the initial token so the scan/change boundary cannot lose a mutation.
4. On normal starts, process `changes.list` pages and commit each applied page together with its next cursor. Never advance a cursor past uncommitted changes.
5. Filter account-wide visible changes to known workspace IDs/parents and resolve unknown or ambiguous ancestry without indexing the entire Drive.
6. Fall back to a full selected-folder scan after token invalidation, ambiguous move/ancestry state, or a periodic visible-online safety interval (initially 24 hours, subject to measurement).
7. For local queued changes, recheck provider revision and write with expected-revision semantics.
8. If both sides changed, preserve base, local, and remote. The cache phase may expose conflict state before the separate three-way merge work is complete.
9. Update base, cached content, index/history, and operation acknowledgement only through transactionally ordered persistence.
10. Retry throttled or transient failures through the bounded scheduler using `Retry-After`, exponential backoff, and jitter.

Operations require stable IDs and idempotency logic so reloads/retries do not duplicate creates or moves. Hidden app tabs pause low-priority work; current mutations are either safely completed or reconciled on resume.

## 10. Conflict architecture

A conflict record contains at minimum:

- workspace and document identity;
- base revision identity/content reference;
- local revision identity/content reference;
- remote revision identity/content reference;
- merge attempt output;
- provider revision observed;
- state and timestamps.

Conflict resolution must recheck the current provider revision before committing. If remote changed again, the resolution becomes input to a new reconciliation rather than overwriting the unseen revision.

The merge algorithm/library is an implementation detail, but behavior is defined by deterministic fixtures and must preserve line endings/encoding semantics.

## 11. Browser persistence

Browser persistence is the one local read repository, not a second provider. Provider content remains canonical, except that unsynchronized drafts, pending operations, conflicts, and recovery items are irreplaceable local state until resolved.

A manifest entry keeps provider identity/path separately from revision progress. At minimum, `observedProviderRevision`, `cachedContentRevision`, and `indexRevision` are distinct. Seeing remote revision `R2` never relabels cached `R1` content as current.

Persistent stores need explicit versioning for:

- workspace references and permissions metadata;
- document drafts;
- Drive repository manifests and document records;
- base revisions;
- sync operations;
- conflicts;
- local history;
- trash metadata where applicable;
- search index/index metadata;
- tabs and session state;
- workspace manifests and provider identity/path mappings;
- observed metadata, cached-content revisions, and processing generations;
- recovery items, sync-leader leases, and document editing leases;
- Drive change tokens and safety-scan timestamps;
- anonymous settings and keybindings;
- encryption key references and lock state.

Migrations are forward-only per released schema version and tested against realistic prior fixtures. A migration failure must preserve original data for retry/recovery; clearing storage is not an acceptable fallback. Rebuildable plaintext Drive search/cache records are purged, irreplaceable drafts/history are encrypted before their originals are removed, and the existing encrypted Drive mirror is imported only when provider path/revision validation succeeds.

Corrupt records are isolated rather than causing a database reset. Under quota pressure, retention removes derived index artefacts and least-recently-used clean unopened content before other rebuildable data. It never automatically removes drafts, pending writes, conflicts, required bases, open documents, or recovery items. Persistent-storage refusal is a supported degraded mode and cache eviction always leads to a valid cold start.

## 12. Encryption boundaries

### Drive repository

- Encrypt retained Drive document data and sensitive derived metadata, including file names, paths, parent relationships, manifests, indexes containing content, drafts, history, conflicts, recovery items, and pending operations at rest in browser storage.
- Use Web Crypto and a per-account/device key strategy.
- Explicit logout removes active key access and leaves retained content locked.
- Provide an explicit “remove local data” action.
- Keep only the minimum opaque unencrypted envelope required to locate schema/account/workspace ciphertext.
- If explicit logout occurs while dirty or queued work exists, require clear confirmation. Retained ciphertext remains locked; wrapped-key re-unlock is a separate security design.
- Offline restart while not explicitly logged out must remain possible; the exact non-extractable key/wrapping design requires threat modeling and browser testing.

### Backend tokens

- Envelope-encrypt refresh tokens using deployment-managed keys.
- Store key version with ciphertext.
- Support key rotation without invalidating all connected accounts.
- Never log token material.

Encryption does not replace XSS prevention, CSP, secure dependency practices, or operating-system security.

## 13. Authentication and API

### Identity model

- `User`: internal stable ID.
- `ConnectedAccount`: provider, provider subject, token metadata, status.
- `Session`: opaque ID/hash, user, expiry, revocation, metadata.
- `DriveWorkspaceReference`: user, connected account, folder ID, display name.
- `Preference`: global user settings and keybindings.

Every row and query that is user-owned includes and enforces user scope.

### Session model

- Opaque session cookie, secure and HTTP-only.
- Server-side revocation and expiry.
- API process holds no durable in-memory session state.
- Same-origin deployment through reverse proxy is preferred to simplify cookie/CORS policy.

### API contract

Runtime schemas are authoritative. Types and OpenAPI are derived, not maintained separately. Request validation, response validation in tests, error envelopes, and API versioning are consistent across official and self-hosted deployments.

## 14. Database

PostgreSQL is used from the beginning. Drizzle owns typed schema declarations, migrations, and database access.

Content tables are forbidden. Expected domains are:

- users;
- connected accounts and encrypted credentials;
- sessions;
- linked Drive workspace references;
- global preferences/keybindings;
- consent/diagnostic settings as needed;
- migration and operational metadata.

Database backups and restores are part of the supported self-hosting contract.

## 15. PWA and update architecture

- Version static app shell, workers, and WASM coherently.
- Avoid mixing incompatible worker/WASM/API contracts across an update.
- A waiting service worker prompts the user.
- Before activation/reload, confirm drafts and operation queues are durable.
- Persistent schema migration runs with recovery state and observable progress where needed.
- API compatibility must support the currently deployed frontend during rolling/self-host upgrades according to documented version policy.

## 16. Observability architecture

- Instrument the API with OpenTelemetry-compatible metrics/traces.
- Measure cache hits/misses, metadata requests, content downloads/bytes, activation time, manifest load, reconciliation time, queue latency, and indexed-document count locally. External transmission follows the existing aggregate/opt-in consent boundary.
- Keep OTLP backend configuration deployment-specific.
- Keep product analytics and crash reporting behind separate adapters.
- Validate analytics payloads against allowlisted schemas.
- Never attach workspace IDs, Drive folder IDs, file names, paths, contents, search queries, or rendered output to telemetry.
- Client performance uses opt-in detailed diagnostics and coarse buckets.

## 17. Deployment

### Official

- PWA static assets on CDN/static hosting.
- API container behind TLS/reverse proxy or load balancer.
- Managed PostgreSQL.
- Same public origin where practical, for example static routes plus `/api` reverse proxy.

### Self-hosted v1

- Docker Compose.
- Versioned frontend and API images.
- PostgreSQL service or documented external PostgreSQL configuration.
- Required environment/secrets validation at startup.
- Migration job/command and documented backup gate.
- Health and readiness probes.
- No official Kubernetes/Helm contract in v1.

## 18. Key confirmed decisions

| Area | Decision | Status |
| --- | --- | --- |
| Product | Personal-first, multi-user-ready | Confirmed |
| Workspace providers | Real local directory and selected Drive folder only | Confirmed |
| Browser storage | Supporting storage, never standalone workspace | Confirmed |
| Frontend | React + Vite static PWA | Confirmed |
| Editor | Existing CodeMirror 6 `@note/editor` | Confirmed |
| Client state | Zustand domain stores | Confirmed |
| API state | TanStack Query only for API/server data | Confirmed |
| Renderer | Rust/WASM `pulldown-cmark` in one render worker | Confirmed |
| WASM threading | No SharedArrayBuffer/multithreaded WASM in v1 | Confirmed |
| Highlighting | Separate lazy browser highlighter | Confirmed |
| Markdown | GFM; no raw HTML | Confirmed |
| API | Separate TypeScript/Hono service | Confirmed |
| Database | PostgreSQL + Drizzle | Confirmed |
| Contracts | Runtime schemas deriving types and OpenAPI | Confirmed |
| Drive traffic | Browser direct; API manages OAuth/session only | Confirmed |
| Sessions | Opaque server-side sessions in secure cookies | Confirmed |
| Deployment | Static CDN + API container + PostgreSQL | Confirmed |
| Self-hosting | Official Docker Compose | Confirmed |
| License | AGPL-3.0 with DCO | Confirmed |
| Existing apps | Migrate after web v1 | Confirmed |
| Warm workspace startup | Local manifest/repository renders before remote reconciliation | Confirmed |
| Cache ownership | One provider-independent local document repository; providers perform I/O only | Confirmed |
| Reconciliation | Metadata-first bounded priority queue; active/open documents first | Confirmed |
| Drive discovery | Changes API after initial scan, with cursor recovery and periodic safety scan | Confirmed |
| Browser-tab coordination | One sync leader per workspace and one editing lease per document | Confirmed |

## 19. Implementation choices still requiring evidence

These do not reopen product decisions, but must be selected through spikes, benchmarks, or security review:

- exact runtime-schema/OpenAPI library;
- exact browser syntax highlighter;
- search index implementation and persistence format;
- diff/three-way merge implementation;
- browser database wrapper and OPFS layout;
- encryption key wrapping/unlock design;
- exact Google scopes and Picker flow accepted by Google policy;
- local trash implementation under File System Access limitations;
- final adaptive queue concurrency after mobile/provider benchmarks;
- final external-change polling/hash cadence after validating the initial active-document 30-second, open-tabs 60-second, and safety-scan 24-hour defaults;
- encrypted manifest record layout (snapshot, per-record, or snapshot-plus-journal) after a 10,000-entry mobile benchmark;
- autosave and adaptive render debounce values;
- history thinning and quota defaults;
- specific OpenTelemetry, analytics, and crash backends;
- final package names and boundaries;
- API version compatibility window.

Each selection should be recorded as an ADR or added to the confirmed decision table with evidence.
