# ADR-0008: Daemon lifecycle and local security

**Status:** Accepted · 2026-10-22

## Context

A daemon must be running to receive events, but a process that runs forever on a developer's machine is unwelcome. The daemon also serves sensitive session data over HTTP, which other local processes or web pages could try to read.

## Decision

- The session-start hook starts the daemon if it isn't running.
- The daemon exits after an idle period with no active sessions.
- It listens on 127.0.0.1 only, default port 4747, falling back to the next free port.
- Every request must carry a random per-install access token, included in the URL that `/flightpath` opens.
- Hook events that arrive while the daemon is down are buffered to a local file and drained on start.

## Consequences

- No permanent background process, and recording survives daemon restarts.
- Browsers and other local apps can't read session data without the token.
- The actual port must be discoverable; `/flightpath` always reports it.
