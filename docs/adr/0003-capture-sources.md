# ADR-0003: Hooks and telemetry are primary; transcripts are a backstop

**Status:** Superseded by ADR-0012 · 2026-10-23 (accepted 2026-10-22)

## Context

Claude Code exposes session activity three ways:

1. **Hooks** fire synchronously with events (prompts, tool calls, subagent start and stop, compaction, permission decisions) and are documented.
2. **OpenTelemetry export** emits documented events and metrics, including per-request token usage and a `prompt.id` that groups all events from one user prompt.
3. **Transcript files** on disk contain the full conversation, but their format is documented as internal and changes between versions, and they may lag the live session.

## Decision

- Hooks drive the live journey (what happened, when).
- Telemetry provides token usage and request-level detail, joined to turns by `prompt.id`.
- Transcripts are used only to fill gaps, such as events missed while the daemon was down.

## Consequences

- The live view depends only on documented interfaces.
- Users must enable Claude Code's telemetry export to local endpoints; the plugin configures this.
- The transcript parser is isolated, versioned and tested against pinned Claude Code versions, and the product degrades gracefully if it breaks.
