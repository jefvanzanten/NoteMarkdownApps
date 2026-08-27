# Protected Google Drive E2E

This suite verifies a reversible bidirectional edit handoff through the real Google Drive provider with two isolated browser contexts. It checks the complete A → B and B → A document revisions, records path-free request/latency metrics, and restores the original document in a cleanup step. A second non-mutating scenario simulates an expired NoteMarkdown server session and requires an actionable local-draft diagnostic without a Drive mutation. A third seeds a warm workspace, simulates its connected account having been removed, and verifies that automatic restoration fails once and promptly rather than entering minutes of retry backoff.

Use only a dedicated staging Google account/folder with synthetic, test-safe content. Do not target personal or production documents.

## 1. Save an authenticated session

The user-managed web and API servers must already be running. Google blocks browsers launched with Playwright automation flags, so authentication connects to a separately launched normal Chrome instance:

```bash
/usr/bin/google-chrome \
  --remote-debugging-port=9223 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.cache/notemarkdown-e2e-auth" \
  --no-first-run \
  --no-default-browser-check \
  http://localhost:5173/
```

Keep that Chrome instance open and run in another terminal:

```bash
E2E_BASE_URL=http://localhost:5173/ \
E2E_AUTH_CDP_URL=http://127.0.0.1:9223 \
pnpm test:e2e:drive:auth
```

Complete Google login manually in normal Chrome. Playwright attaches only after Chrome has launched without automation flags. The ignored `playwright/.auth/drive-user.json` file stores the resulting NoteMarkdown session cookie locally.

Both isolated contexts currently start from this one saved API session while retaining separate browser storage, caches, drafts, and sync state. The suite therefore validates provider/repository handoff and a deterministically simulated expired session, but not yet two independently issued live server sessions. Local and production origins also require separate authentication states and linked workspace references.

## 2. Run the reversible sync test

The acknowledgement must exactly match the selected workspace and document:

```bash
E2E_BASE_URL=http://localhost:5173/ \
E2E_REAL_DRIVE=true \
E2E_DRIVE_WORKSPACE=notemarkdown-e2e \
E2E_DRIVE_DOCUMENT=sync-target.md \
E2E_DRIVE_MUTATION_ACK=notemarkdown-e2e/sync-target.md \
E2E_SYNC_RUNS=1 \
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome \
pnpm test:e2e:drive
```

Set `E2E_HEADED=true` to watch both pages. `E2E_SYNC_TIMEOUT_MS` defaults to 45 seconds. Increase `E2E_SYNC_RUNS` (maximum 20) for sequential samples after the single-run flow is stable. Set `E2E_DEFER_BACKGROUND_CONTENT=true` only for a diagnostic run that isolates foreground synchronization from background content indexing; normal qualification runs must omit it.

Each successful run attaches `drive-sync-metrics.json` with:

- exact-content result;
- cold writer/reader activation latency;
- writer mutation latency;
- second-browser visibility latency from edit and after write acknowledgement;
- aggregate metadata, content-download, and mutation counts.

Playwright HTML output is written to `playwright-report/`; traces, screenshots, video, and attachments go to `test-results/e2e/`. These directories and authentication state are ignored by Git. Delete failed-run traces after diagnosis because browser snapshots may contain synthetic test content. Current anonymized baseline evidence is recorded in [`docs/local-first-web-app/08-drive-sync-qualification.md`](../docs/local-first-web-app/08-drive-sync-qualification.md).

## 3. Record the workspace-opening flow as screenshots

After saving the authenticated session, record the read-only journey from a blank browser to a loaded linked Drive workspace:

```bash
E2E_BASE_URL=http://localhost:5173/ \
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome \
pnpm test:e2e:drive:visual
```

The recorder opens the first linked workspace. Set `E2E_DRIVE_WORKSPACE` to require one exact workspace when the account has multiple linked folders. It samples at approximately 5 frames per second by default and discards consecutive screenshots with identical pixels. Set `E2E_VISUAL_FRAME_INTERVAL_MS=500` for 2 frames per second, for example. The numbered JPEG files and `manifest.json` are written below `test-results/e2e-visual/` in the test's `drive-visual-flow/` artifact directory. The manifest records each frame's elapsed time and flow phase.

Use `E2E_HEADED=true` to watch the journey. This flow does not edit Drive files, but its screenshots can contain the signed-in account identity, workspace name, and file names. Review them before sharing with another agent.

## Safety behavior

- The test refuses to run without `E2E_REAL_DRIVE=true` and an exact mutation acknowledgement.
- Both browsers must initially read identical content.
- The test replaces the writer content with the original plus one unique line.
- The reader must receive the entire exact revision, not merely find the marker.
- The reader then saves a second exact revision and the original writer must receive it before cleanup.
- The session-failure scenario forces a provider 401 followed by an API 401, verifies that the draft remains local/queued, and requires zero Drive mutations.
- The removed-account scenario verifies idempotent startup, follower-to-leader promotion, one blocking token request, zero direct Drive requests, and no exponential retry loop.
- Cleanup writes the original content back even when the assertion fails.
- If cleanup fails, the run fails explicitly; inspect the target immediately before retrying.
