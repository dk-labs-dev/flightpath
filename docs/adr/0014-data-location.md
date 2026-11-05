# ADR-0014: Keep recordings in Flightpath's own data folder

**Status:** Accepted · 2026-10-23

## Context

Flightpath stores recordings in a SQLite database (ADR-0006). The obvious place for it is the plugin data directory, `${CLAUDE_PLUGIN_DATA}`, which survives plugin updates. However, Claude Code deletes that directory by default when the plugin is uninstalled. Reinstalling, or switching to a different install scope, would silently erase a user's history.

## Decision

- **Recordings live in Flightpath's own folder,** in the platform's standard per-user data location:
  - Windows: `%LOCALAPPDATA%\Flightpath`
  - macOS: `~/Library/Application Support/Flightpath`
  - Linux: `$XDG_DATA_HOME/flightpath`, or `~/.local/share/flightpath` when that's unset
- **The folder holds** the database, the hook buffer, and the daemon's port and token files (ADR-0008).
- **Users can always find and remove their data.** `/flightpath` shows the folder's path. `/flightpath forget` deletes one session, and a documented option deletes everything.
- **Uninstalling the plugin leaves the folder in place.** The install and uninstall docs say so, and say how to remove it.

## Consequences

- History survives plugin updates, reinstalls and scope changes.
- Deleting data is always an explicit user action, never a side effect.
- Nothing is written to `${CLAUDE_PLUGIN_DATA}` except, if ever needed, disposable cache.
- The data stays on the user's machine (ADR-0001).
