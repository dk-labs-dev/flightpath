# ADR-0023: Telemetry is turned on from the settings page, with consent

**Status:** Accepted · 2026-10-23 · Supersedes ADR-0018

## Context

Telemetry is opt-in (ADR-0012). Claude Code reads its OpenTelemetry settings from the shell environment, the `env` block of the user's `~/.claude/settings.json`, managed settings, or a `--settings` file. It deliberately ignores them in a project's settings, and a plugin can't set them. When content logging is off, response text still follows the prompt-logging setting unless `OTEL_LOG_ASSISTANT_RESPONSES` is set explicitly. Managed settings override user settings, and many users already export telemetry to a collector, often their employer's.

ADR-0018 put telemetry setup behind a two-step `/flightpath telemetry` command. ADR-0022 moves every setting to the settings page in the browser, and telemetry goes with them. What setup writes, and how carefully, doesn't change.

## Decision

- **Telemetry is a setting on the settings page.** The page shows whether telemetry is on for Flightpath, configured elsewhere, or off. It explains what turning it on adds, that the data stays on this machine, and that account identity is dropped. It applies the change only when the user confirms.
- **Setup changes nothing when telemetry is already configured.** If an exporter is set in the environment, in user settings or in managed settings, the page explains the trade-off and doesn't offer to turn telemetry on.
- **Otherwise it adds keys to the `env` block of `~/.claude/settings.json`.** It enables telemetry and sends logs only, over OTLP/HTTP JSON, to the daemon's configured port, with the access token as a header. It shortens the logs export interval to one second, turns metrics off, and sets `OTEL_LOG_ASSISTANT_RESPONSES=0`. It never enables prompt, response or tool-detail logging.
- **The edit is careful.** Setup backs up the file first, writes atomically and preserves every other key. It records the exact keys and values it wrote.
- **Turning telemetry off removes only those keys,** and only where they still hold the values setup wrote.
- **Changing the port updates the telemetry endpoint** that setup wrote, so telemetry keeps arriving.
- **If the configured port is taken,** sessions are recorded without telemetry, and the view says so.
- **Changes apply from the next session,** and the page says so.

## Consequences

- The user's consent is explicit and reversible, and other telemetry setups are never disturbed.
- Flightpath edits a file it doesn't own. The backup and the record of written keys make the change auditable and undoable.
- The user's Claude Code settings file holds the daemon's access token. It's a local, per-user file, and the token only grants access to the local daemon.
- A session started before setup keeps recording without telemetry until it ends.
