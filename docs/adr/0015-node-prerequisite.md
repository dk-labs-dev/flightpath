# ADR-0015: Node 24 or later is a prerequisite

**Status:** Accepted · 2026-10-23

## Context

ADR-0006 chose Node for the hook scripts and the daemon on the assumption that Claude Code users already have Node installed. That is no longer true. Claude Code's recommended installer ships a native binary, and its other install methods (Homebrew, WinGet, apt, dnf, apk) don't need Node either. Even the npm package installs the same native binary, which doesn't use Node at runtime.

So some users won't have Node. For them, every Flightpath hook would fail to start, and Claude Code shows a hook error notice for each failure.

Shipping a self-contained runtime for each platform would remove the dependency, but it makes the plugin much larger and adds a per-platform build and release step before the product has proved itself.

## Decision

- **Node 24 or later on the user's `PATH` is a prerequisite.** The README and the install guide say so before the install steps. They also point to a version manager such as nvm for users who don't have Node or need a second version.
- The hook scripts and the daemon target the Node versions we test in CI and no older ones.
- A self-contained runtime is out of scope for now. We'll revisit it if user feedback shows the prerequisite is costing installs.

## Consequences

- One toolchain stays enough for contributors and users (ADR-0006).
- Users without Node see hook errors until they install it, so the prerequisite has to be impossible to miss in the docs.
- Moving to a bundled runtime later needs a new ADR and only changes packaging, not the code.
