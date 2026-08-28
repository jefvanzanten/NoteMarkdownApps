# Activity journal specification

**Status:** accepted

## Purpose

The activity journal provides a compact local snapshot for debugging NoteMarkdown behavior. It is not an audit log and does not attempt to preserve every successful call or UI transition.

## Enablement and lifecycle

1. Recording MUST be continuous while the journal is enabled.
2. The journal is enabled in development builds or when `VITE_ACTIVITY_LOG_ENABLED=true`.
3. The UI MUST NOT offer a start/stop recording control.
4. The UI MUST retain explicit copy, JSON export, and clear actions.
5. Events and metrics MUST persist across reloads, browser restarts, sessions, and tabs.
6. Clearing the journal MUST NOT clear drafts, document history, workspace caches, or user files.

## Event retention

1. An event MUST NOT be retained beyond 24 hours.
2. The journal MUST retain the 400 newest eligible events.
3. The journal MUST additionally retain up to 100 older `warning` or `error` events from the same 24-hour window.
4. The total retained event count MUST NOT exceed 500 after pruning.
5. Retained events MUST remain in deterministic chronological order.
6. Session and tab identifiers MUST remain available for diagnosing cross-session and multi-tab behavior.

This policy protects failure history without sacrificing the newest chronological context. Warnings and errors already present in the newest 400 events do not consume the additional protected allowance.

## Classification

Every known event or dynamic event family SHOULD have a central policy in `src/diagnostics/activityPolicy.ts`:

- **retain** — store an individual timeline event;
- **aggregate** — update hourly metrics without storing an individual event;
- **drop** — store neither an event nor a metric.

Warnings and errors MUST be retained individually regardless of their normal event policy. Unknown events MUST default to `retain` so an omitted policy cannot silently destroy diagnostics. Tests SHOULD detect accidental changes to registered classifications.

### Retain individually

The journal retains:

- errors and warnings;
- failures, retries, timeouts, conflicts, and authentication/token failures;
- important workspace and document lifecycle changes;
- rename, move, provider-write, and other mutation activity;
- unusually slow successful operations.

### Aggregate

The journal aggregates routine successful:

- API requests;
- Drive reads;
- token requests;
- reconciliation operations;
- document and manifest cache hits and misses.

A network, API, Drive, or token success taking at least 5 seconds MUST be retained individually instead of aggregated. Workspace or document reconciliation taking at least 30 seconds MUST be retained individually.

### Drop

Registered low-value activity includes:

- window focus and blur;
- document visibility changes;
- document activation/deactivation;
- view-mode changes;
- workspace entry-count changes;
- individual draft persistence and history-checkpoint events;
- routine request `started` events where the corresponding result is aggregated.

## Hourly metrics

1. Aggregates MUST use UTC-aligned hourly buckets.
2. No more than 24 hourly buckets may be exposed or exported.
3. Metrics from separate tabs MUST be combinable by hour.
4. The Diagnostics UI MUST show a compact summary for the newest available hour.
5. JSON exports MUST include the retained buckets under `hourlyMetrics`.
6. Hourly metrics include API success counts/durations, token success counts/durations, Drive read counts/durations/bytes, cache hits/misses, and reconciliation counts/durations.
7. Routine metrics MUST NOT appear as synthetic timeline summary events.

## Export bounds

1. Exports MUST be readable, pretty-printed JSON.
2. Exports MUST declare retention limits.
3. Exports MUST NOT exceed 512 KiB encoded as UTF-8.
4. When size trimming is necessary, the oldest non-warning/error event MUST be removed first; the oldest warning/error may be removed only when no normal event remains.
5. The export MUST expose `truncated` and applicable `truncatedReasons` values from `age`, `count`, and `size`.
6. Individual metadata strings MUST be bounded; the current maximum is 2,000 characters.

## Data boundary

The journal MUST NOT record note content, credentials, tokens, passwords, cookies, or HTTP request bodies. Paths, file names, workspace/document identifiers, and correlation identifiers MAY be retained because the export is user initiated and those values are required to debug file operations.

## Migration

Database version 2 intentionally starts with a clean activity journal. Upgrading the isolated version-1 journal MUST delete old diagnostic events and create the hourly metric store. No non-diagnostic application storage may be modified.
