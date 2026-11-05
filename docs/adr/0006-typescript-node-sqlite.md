# ADR-0006: TypeScript, Node and SQLite

**Status:** Accepted · 2026-10-22

## Context

The plugin needs hook scripts, a long-running local daemon, an embedded database and a browser front end. Claude Code users already have Node available. One language across all parts lowers the cost of contributing.

## Decision

- TypeScript everywhere: hook scripts, daemon and web view.
- Node (current LTS) runtime for scripts and the daemon.
- SQLite in WAL mode for storage.
- A lightweight front-end stack chosen in the first web-view ticket, favoring small bundles and no server-side rendering.

## Consequences

- Contributors need one toolchain.
- The SQLite binding must work across macOS, Linux and Windows; this is validated in CI.
- Hook scripts must start fast; their startup time is measured and kept minimal.
