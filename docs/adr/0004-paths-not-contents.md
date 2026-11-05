# ADR-0004: Record file paths, never file contents

**Status:** Accepted · 2026-10-22

## Context

Hook payloads can include file contents (for example, the result of a read or the body of an edit). Storing them would make the database large and turn it into a copy of the user's codebase and secrets.

## Decision

Flightpath stores file paths, command lines, sizes and outcomes — never file contents. Tool inputs and results are summarized before storage. Known secret patterns are redacted from everything written to disk, including temporary buffers.

## Consequences

- The database stays small and far less sensitive.
- Some views cannot show "what the agent read", only "which files it read"; the drill-down links to the file on disk instead.
- Every new stored field must be justified against this rule in review.
