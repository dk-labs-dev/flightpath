# ADR-0002: Distribute as a Claude Code plugin

**Status:** Accepted · 2026-10-22

## Context

Flightpath needs hooks registered in Claude Code, slash commands, a background daemon and a web view. Asking users to edit settings files, run a separate installer and keep versions in sync would hurt adoption and cause drift between components.

## Decision

Flightpath ships as a single Claude Code plugin. The plugin declares its hooks and commands and bundles the hook scripts, the daemon and the built web view. Persistent data lives in the plugin's data folder (`${CLAUDE_PLUGIN_DATA}`), which survives plugin updates.

The first release supports Claude Code only.

## Consequences

- Install and update are one command each, and all components always match versions.
- We depend on Claude Code's plugin system; changes to it are a maintenance cost we accept.
- Support for other agents would need a different distribution path and is deferred.
