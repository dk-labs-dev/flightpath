# ADR-0020: Use Node's built-in SQLite module

**Status:** Accepted · 2026-10-23

## Context

Flightpath stores recordings in SQLite (ADR-0006). The common Node bindings, such as `better-sqlite3`, are native modules: they need a compiled binary for each operating system, architecture and Node version. A Claude Code plugin is copied into place from its marketplace with no install step, so it has to ship working native binaries for every platform or ask users to build them.

Node has a built-in `node:sqlite` module with a synchronous API. It needs no compiled dependency and supports WAL mode. It's still marked experimental, and Node 22 prints a warning when it's loaded.

## Decision

- **The daemon uses `node:sqlite`.** No native database dependency.
- **One small storage module wraps it.** Nothing else imports `node:sqlite`, so a change to its API, or a move to another binding, touches one place.
- **The experimental warning never reaches the user.** The daemon runs detached with its output redirected, and it filters that one warning so it doesn't fill the log.
- **CI runs the storage tests on every Node version we support,** on all three operating systems.

## Consequences

- The plugin ships as plain JavaScript, with nothing to compile or download.
- We depend on an API that can still change. The wrapper limits the cost, and CI catches breakage when we add a Node version.
- Only the daemon touches the database; hook scripts never load it, so their start-up stays fast.
