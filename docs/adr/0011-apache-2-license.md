# ADR-0011: License under Apache 2.0

**Status:** Accepted · 2026-10-23

## Context

Flightpath is a free, local-first developer tool. Its success depends on adoption by individual developers and acceptance by their employers' legal teams. Nobody can run it as a hosted service against the project, so restrictive licenses offer little protection while adding friction. Future paid features remain possible because the copyright holder can license new work separately.

## Decision

- The code is licensed under the **Apache License, Version 2.0**.
- Copyright: **Copyright 2026 Naga Golla**.
- The repository root contains `LICENSE` (the unmodified Apache 2.0 text) and `NOTICE`:
  ```
  Flightpath
  Copyright 2026 Naga Golla
  ```
- The `license` field in every `package.json` is `Apache-2.0`.
- No per-file license headers; the root `LICENSE` and `NOTICE` cover the repository.

## Consequences

- Permissive like MIT, and widely approved by companies.
- Users and contributors get an explicit patent license, which terminates for anyone who brings a patent claim against the project.
- Modified versions must keep the `NOTICE` file and state that files were changed.
- Before external contributions are accepted, a `CONTRIBUTING.md` will require external contributors to sign off their commits under the Developer Certificate of Origin, keeping the provenance of contributions clear.

_Erratum, 2026-11-06: wording only, no change to the decision._
