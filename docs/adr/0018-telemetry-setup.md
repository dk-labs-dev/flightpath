# ADR-0018: Telemetry setup writes the user's Claude Code settings, with consent

**Status:** Superseded by ADR-0023 · 2026-10-23 (accepted 2026-10-23)

## Context

Telemetry is opt-in (ADR-0012). Claude Code reads its OpenTelemetry settings from the shell environment, the `env` block of the user's `~/.claude/settings.json`, managed settings, or a `--settings` file. It deliberately ignores them in a project's settings, and a plugin can't set them.

When content logging is off, response text still follows the prompt-logging setting unless `OTEL_LOG_ASSISTANT_RESPONSES` is set explicitly. Managed settings override user settings. Many users already export telemetry to a collector, often their employer's.

## Decision

- **Setup is a two-step `/flightpath telemetry` command.** The first step explains what telemetry adds and what it costs, and changes nothing. The second step, `/flightpath telemetry on`, which the user types themselves, applies the change. Both run without reaching the model (ADR-0016).
- **Setup changes nothing when telemetry is already configured.** If an exporter is set in the environment, in user settings or in managed settings, it explains the trade-off and stops.
- **Otherwise it adds keys to the `env` block of `~/.claude/settings.json`.** It enables telemetry and sends logs only, over OTLP/HTTP JSON, to the daemon's address with its access token as a header. It shortens the logs export interval to one second, turns metrics off, and sets `OTEL_LOG_ASSISTANT_RESPONSES=0`. It never enables prompt, response or tool-detail logging.
- **The edit is careful.** Setup backs up the file first, writes atomically and preserves every other key. It records the exact keys and values it wrote.
- **`/flightpath telemetry off` removes only those keys,** and only where they still hold the values setup wrote.
- **The daemon keeps the port written into the settings.** If that port is taken, sessions are recorded without telemetry and the view says so.
- **Changes apply from the next session,** and setup says so.

## Consequences

- The user's consent is explicit and reversible, and other telemetry setups are never disturbed.
- Flightpath edits a file it doesn't own. The backup and the record of written keys make the change auditable and undoable.
- The settings file holds the daemon's access token. It's a local, per-user file, and the token only grants access to the local daemon.
- A session started before setup keeps recording without telemetry until it ends.
