# ADR-0025: Recordings are kept for a limited time and a limited size

**Status:** Accepted · 2026-10-24

## Context

Nothing Flightpath records is ever deleted unless the user forgets a session. A measurement of the current schema, with synthetic sessions driven through the real intake, gives about 3.8 KB per tool call from hooks and transcripts, and about 6.7 KB with telemetry on. About 80% of that is `raw_events`, the redacted events kept so a session can be rebuilt.

| Usage | Per day | 15 days | 90 days | 1 year |
|---|---|---|---|---|
| Light (300 tool calls a day) | 1 MB | 17 MB | 100 MB | 0.4 GB |
| Heavy (2,000 a day, telemetry on) | 13 MB | 0.2 GB | 1.2 GB | 5 GB |
| Extreme (10,000 a day, parallel agents) | 67 MB | 1 GB | 6 GB | 24 GB |

Speed isn't the problem: every lookup is per session and indexed. Disk is, and so is keeping months of prompts and file paths on the machine with no end date.

Deleting rows doesn't shrink the file. After forgetting a 19 MB session, the database stayed 19 MB, with 99% of its pages on the free list. The database is created with `auto_vacuum` off, so freed pages are reused but never returned to the disk.

Flightpath also imports transcripts of sessions it didn't record when the daemon starts (ADR-0019). Without a guard, a purged session would be imported again from Claude Code's own transcript.

## Decision

- **Sessions are purged a set number of days after their last activity.** The setting `retentionDays` takes 7, 15, 30, 60 or 90, and defaults to **15**. 90 is the maximum; longer retention isn't offered.
- **A fixed size cap of 2 GB.** Past it, the oldest sessions are purged first, whatever their age. It isn't a setting.
- **Whole sessions only.** A purge removes a session and everything derived from it, as `forget` does. A session that is still live is never purged.
- **When:** at daemon start and every 6 hours while it runs. A purge works in small transactions and yields between them, so recording isn't held up.
- **Freed space goes back to the disk.** The database moves to `auto_vacuum = INCREMENTAL` with a one-time `VACUUM`, and each purge ends with `PRAGMA incremental_vacuum`.
- **Purged sessions stay purged.** Transcript import skips any session whose last activity is older than the retention window, and any session that was purged.
- **Delete all data:** the settings page has a button that removes every recording, after a confirm step.

## Consequences

- A user can't keep a recording longer than 90 days.
- Lowering `retentionDays` purges the sessions now outside the window at the next purge, so the settings page says so before saving.
- The size cap bounds the worst case: an extreme user keeps about four weeks within 2 GB.
- `raw_events` is kept for the whole window, so any session still stored can be rebuilt after the journey code changes.
- The one-time `VACUUM` rewrites the database file once, on upgrade.
