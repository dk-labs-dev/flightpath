# ADR-0012: Telemetry is opt-in; Flightpath works without it

**Status:** Accepted · 2026-10-23 · Supersedes ADR-0003

## Context

ADR-0003 made hooks and Claude Code's OpenTelemetry export the primary capture sources, with transcripts as a backstop, and assumed the plugin would turn telemetry on. Two things make that assumption wrong:

- A plugin can't set environment variables for the Claude Code session. Telemetry is enabled through environment variables, or through the `env` block in a settings file, so turning it on means changing the user's configuration.
- Many users already export telemetry somewhere else, often to an employer's collector. Pointing that export at Flightpath without asking would break their setup.

Telemetry is still the best source for exact per-request token counts, the `prompt.id` that groups a turn, and who made each permission decision. Hooks are available whenever the plugin is installed. Transcript files are always written, and their assistant messages carry token usage.

## Decision

- **Telemetry is opt-in.** Flightpath never enables it silently. A setup step explains what telemetry adds, asks for explicit consent, and only then writes the settings. If an OpenTelemetry export is already configured, setup leaves it alone and explains the trade-off instead.
- **Flightpath works without telemetry.** Hooks drive the live journey. Transcripts supply token usage and fill gaps. Turns are inferred from event order when `prompt.id` isn't available.
- **With telemetry, Flightpath is more precise:** exact per-request tokens, turns joined by `prompt.id`, and permission-decision sources.
- **The view always shows which mode a session was recorded in.** Any feature that needs telemetry says so instead of showing a guessed figure as fact.

## Consequences

- Transcripts become a primary source of token data when telemetry is off. Their format is internal and changes between versions, so the transcript reader stays isolated, versioned and tested against pinned Claude Code versions.
- The data model must allow request-level fields to be missing or approximate, and must record which source each value came from.
- Each coach detector declares the sources it needs. Detectors that need exact per-request tokens either run in an approximate form, labelled as such, or don't run at all.
- Setup has to detect existing telemetry configuration before offering to change it.
