# ADR-0019: Transcripts supply tokens and can record a whole session

**Status:** Accepted · 2026-10-23

## Context

Without telemetry, transcripts are the only source of per-request tokens (ADR-0012). In recorded sessions, transcript usage matched telemetry exactly for every main-thread and subagent request. Transcripts don't include Claude Code's background requests.

ADR-0013 requires Flightpath to degrade when hooks are unavailable rather than stop. But if hooks don't run, nothing starts the daemon and no command reaches it, so a session without hooks can't be recorded live. Its transcript can still be read later.

Transcript files are an internal format that changes between versions. They also contain the full conversation, including file contents and generated text (ADR-0004).

## Decision

- **For live sessions, the daemon follows the session's transcript** (the `transcript_path` from hook payloads, and each subagent's transcript) and reads request ids, models, token usage and timestamps from it. It joins them to turns by order and `prompt_id`.
- **Sessions without hooks are imported after the fact.** When the daemon starts, it looks for transcripts of sessions it has no recording of, started since Flightpath was installed, in projects where Flightpath was active. It records them as transcript-only, and the view says they weren't recorded live.
- **Forgotten and paused sessions are never imported.** `/flightpath forget` leaves a marker with the session id and no other data, so a forgotten session isn't brought back.
- **The reader extracts metadata only.** It never copies message text or tool output; what it takes goes through intake redaction (ADR-0017).
- **The reader is isolated and versioned.** It recognizes the formats of the Claude Code versions we test against, skips entries it doesn't understand, and records the session as partial rather than guessing.

## Consequences

- The Tokens lens works without telemetry for everything except background requests.
- A session where hooks were disabled appears after the fact, never live.
- The reader breaks when Claude Code changes its format, so it needs tests against synthetic transcripts for each supported version, and a format change shows up as a partial recording, not a wrong one.
- Reading files under `~/.claude/projects` means the import must stay limited to sessions Flightpath would have recorded anyway.
