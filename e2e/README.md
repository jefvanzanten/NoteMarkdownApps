# Protected Google Drive E2E

This suite verifies a reversible edit through the real Google Drive provider with two isolated browser contexts. It checks the complete document revision, records path-free request/latency metrics, and restores the original document in a cleanup step.

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

## 2. Run the reversible sync test

The acknowledgement must exactly match the selected workspace and document:

```bash
E2E_BASE_URL=https://apps.jefvanzanten.dev/notes/ \
E2E_REAL_DRIVE=true \
E2E_DRIVE_WORKSPACE=vault \
E2E_DRIVE_DOCUMENT=working-memory.md \
E2E_DRIVE_MUTATION_ACK=vault/working-memory.md \
E2E_SYNC_RUNS=1 \
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/brave-browser \
pnpm test:e2e:drive
```

Set `E2E_HEADED=true` to watch both pages. `E2E_SYNC_TIMEOUT_MS` defaults to 45 seconds. Increase `E2E_SYNC_RUNS` (maximum 20) for sequential samples after the single-run flow is stable. Set `E2E_DEFER_BACKGROUND_CONTENT=true` only for a diagnostic run that isolates foreground synchronization from background content indexing; normal qualification runs must omit it.

Each successful run attaches `drive-sync-metrics.json` with:

- exact-content result;
- writer mutation latency;
- second-browser visibility latency;
- aggregate metadata, content-download, and mutation counts.

Playwright HTML output is written to `playwright-report/`; traces, screenshots, video, and attachments go to `test-results/e2e/`. These directories and authentication state are ignored by Git.

## Safety behavior

- The test refuses to run without `E2E_REAL_DRIVE=true` and an exact mutation acknowledgement.
- Both browsers must initially read identical content.
- The test replaces the writer content with the original plus one unique line.
- The reader must receive the entire exact revision, not merely find the marker.
- Cleanup writes the original content back even when the assertion fails.
- If cleanup fails, the run fails explicitly; inspect the target immediately before retrying.
