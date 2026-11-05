# ADR-0001: Local-first — all data stays on the user's machine

**Status:** Accepted · 2026-10-22

## Context

Flightpath records everything a coding agent does in a session: the user's prompts, the commands it runs, the files it touches. That is sensitive. Developers will only install a tool that watches their work if they trust where the data goes.

## Decision

All recording, storage, analysis and viewing happen on the user's machine. Flightpath makes no network calls beyond localhost. There are no accounts, no cloud sync and no telemetry about Flightpath's own usage.

## Consequences

- The daemon, database and web view all run locally; the view is served from localhost.
- Features that need a server (sharing, team views) are out of scope unless a later ADR introduces them as explicit opt-in.
- Users can audit the whole data path, which is a large part of why the project is open source.
