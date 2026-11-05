# ADR-0009: Snapshot plus Server-Sent Events for the live view

**Status:** Accepted · 2026-10-22

## Context

The view must show a session as it happens, open quickly even for long sessions, and recover from disconnects and sleep.

## Decision

- On load, the view fetches a turn-level snapshot of the session.
- It then subscribes to a Server-Sent Events stream of incremental updates, each with a monotonically increasing event ID.
- On reconnect, the browser sends the last event ID and the daemon replays anything newer.
- Step details are fetched on demand when the user drills in.

## Consequences

- One-way streaming covers every live need; no WebSocket protocol to maintain.
- Long sessions stay fast because the browser never holds the full detail of every step.
- Commands from the view (apply fix, pause) use ordinary HTTP requests.
