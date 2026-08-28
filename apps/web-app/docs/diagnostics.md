# Diagnostics

NoteMarkdown has two distinct client diagnostic mechanisms:

- **Activity journal** — a persistent, user-exported rolling snapshot used to investigate application, workspace, document, storage, synchronization, and API behavior.
- **Temporary sync diagnostics** — an opt-in, content-free in-memory report uploaded only after sync failures or unusually slow operations when `VITE_SYNC_DIAGNOSTICS_ENABLED=true`.

This document describes the activity journal. Its normative retention and classification rules are in [the activity journal specification](specs/activity-journal.md).

## Activity journal behavior

The journal records continuously whenever development mode or `VITE_ACTIVITY_LOG_ENABLED=true` enables it. There is no recording start/stop control because context from before an unexpected failure is essential.

The journal is a rolling snapshot rather than a complete audit log:

- events are retained for no more than 24 hours;
- the 400 newest events are retained;
- up to 100 older warnings or errors within the same time window are additionally protected;
- routine successful operations are aggregated into at most 24 hourly metric buckets;
- registered low-value UI and lifecycle noise is not stored;
- an export is limited to 512 KiB.

Diagnostics persist in the isolated `notemarkdown-activity-journal` IndexedDB database across page reloads, browser restarts, sessions, and tabs. Clearing diagnostics affects only this database, never drafts, history, workspace caches, or user files.

## Debugging value

Individual events are reserved for failures, retries, conflicts, important state transitions, mutations such as moves and provider writes, and unusually slow successful operations. Routine successes remain useful as hourly counts, durations, cache ratios, and transfer totals without crowding out failure context.

The Diagnostics dialog shows retained events and a compact summary of the latest hour. JSON exports include all retained hourly metrics.

## Privacy and export

The activity journal must never receive note content, credentials, access or refresh tokens, cookies, request bodies, or passwords. It may contain paths, file names, workspace identifiers, document identifiers, and correlation identifiers because these are useful for investigating user-initiated file operations. Exports are created only after an explicit copy or export action.

String metadata is bounded to prevent malformed or unexpectedly large values from dominating the journal. Pretty-printed exports report active retention limits and any `age`, `count`, or `size` truncation reason detected during the current journal lifecycle.

## Maintenance

Event treatment is centralized in `src/diagnostics/activityPolicy.ts`:

- `retain` keeps the individual event;
- `aggregate` adds the event to an hourly metric bucket;
- `drop` discards registered noise.

New events should be added to the central registry or an explicitly classified dynamic event family. Unknown events are retained as a safety fallback so a missing registry update cannot silently remove potentially important diagnostics.
