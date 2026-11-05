# Architecture decision records

The decisions that shape Flightpath, in the order they were made. An accepted decision is never edited; a change of direction is recorded as a new record that supersedes the old one.

| Record                                                    | Decision                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [ADR-0001](0001-local-first.md)                           | Local-first — all data stays on the user's machine                                            |
| [ADR-0002](0002-claude-code-plugin.md)                    | Distribute as a Claude Code plugin                                                            |
| [ADR-0003](0003-capture-sources.md)                       | Hooks and telemetry are primary; transcripts are a backstop (superseded by ADR-0012)          |
| [ADR-0004](0004-paths-not-contents.md)                    | Record file paths, never file contents                                                        |
| [ADR-0005](0005-tokens-not-dollars.md)                    | Show tokens, not dollars                                                                      |
| [ADR-0006](0006-typescript-node-sqlite.md)                | TypeScript, Node and SQLite                                                                   |
| [ADR-0007](0007-silent-async-hooks.md)                    | Hooks are asynchronous and silent (superseded by ADR-0016)                                    |
| [ADR-0008](0008-daemon-lifecycle.md)                      | Daemon lifecycle and local security                                                           |
| [ADR-0009](0009-live-updates-sse.md)                      | Snapshot plus Server-Sent Events for the live view                                            |
| [ADR-0010](0010-commands.md)                              | One command, plain subcommands (superseded by ADR-0024)                                       |
| [ADR-0011](0011-apache-2-license.md)                      | License under Apache 2.0                                                                      |
| [ADR-0012](0012-telemetry-opt-in.md)                      | Telemetry is opt-in; Flightpath works without it                                              |
| [ADR-0013](0013-any-user-setup.md)                        | Work with any user setup                                                                      |
| [ADR-0014](0014-data-location.md)                         | Keep recordings in Flightpath's own data folder                                               |
| [ADR-0015](0015-node-prerequisite.md)                     | Node 24 or later is a prerequisite                                                            |
| [ADR-0016](0016-no-added-token-cost.md)                   | Flightpath never adds token cost (superseded by ADR-0021)                                     |
| [ADR-0017](0017-intake-redaction.md)                      | Redact at intake, before anything touches disk                                                |
| [ADR-0018](0018-telemetry-setup.md)                       | Telemetry setup writes the user's Claude Code settings, with consent (superseded by ADR-0023) |
| [ADR-0019](0019-transcript-recording.md)                  | Transcripts supply tokens and can record a whole session                                      |
| [ADR-0020](0020-built-in-sqlite.md)                       | Use Node's built-in SQLite module                                                             |
| [ADR-0021](0021-small-measured-token-cost.md)             | Keep Flightpath's token cost small and measured                                               |
| [ADR-0022](0022-settings-in-the-browser.md)               | Settings live in the browser; the session keeps only the main commands                        |
| [ADR-0023](0023-telemetry-setup-on-the-settings-page.md)  | Telemetry is turned on from the settings page, with consent                                   |
| [ADR-0024](0024-plugin-commands-and-foreground-notice.md) | One command per action, and a foreground startup notice                                       |
| [ADR-0025](0025-data-retention.md)                        | Recordings are kept for a limited time and a limited size                                     |
| [ADR-0026](0026-open-command.md)                          | A command that opens the live view                                                            |
| [ADR-0027](0027-the-view-in-react.md)                     | The view is built in React, as its own package                                                |
