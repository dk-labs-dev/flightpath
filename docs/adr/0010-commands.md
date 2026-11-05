# ADR-0010: One command, plain subcommands

**Status:** Superseded by [ADR-0024](0024-plugin-commands-and-foreground-notice.md) · 2026-10-22

## Context

Users need to open the view and control recording from inside Claude Code. Short abbreviations are hard to discover, and themed verbs must be learned.

## Decision

A single slash command, `/flightpath`, with plain-English subcommands:

| Command | Effect |
|---|---|
| `/flightpath` | Open the live view; start recording if off |
| `/flightpath stop` | Pause recording for this session |
| `/flightpath start` | Resume recording for this session |
| `/flightpath off` | Shut down the daemon; stop recording everywhere |
| `/flightpath forget` | Delete this session's recording |

Autostart is a setting, on by default for a global install. When on, the user sees a one-line notice at session start (subject to ADR-0007).

## Consequences

- One name to remember, and Claude Code's command autocomplete makes the length painless.
- Product vocabulary (for example, "debrief" for coach findings) appears in the interface, not in commands.
