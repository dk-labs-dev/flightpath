# Privacy

Flightpath records your Claude Code sessions so it can draw them as a map. This page says what it keeps, where, for how long, and how to remove it. Everything here describes the code in this repository.

## In short

- Everything Flightpath records stays in a folder on your computer. Its code opens network connections only to `127.0.0.1`, your own machine.
- The text of your prompts is kept by default. You can switch that off (see [Prompt text](#prompt-text)).
- File contents, tool output and Claude's replies are not recorded.
- Recordings are deleted after 15 days by default.
- Uninstalling the plugin leaves the recordings in place. [Removing your data](#removing-your-data) says how to delete them.

## What is recorded

Flightpath learns about a session from three places: the hooks Claude Code runs for each event, the session's transcript file that Claude Code writes, and, only if you turn it on, Claude Code's own telemetry.

**Kept:**

- Your prompts, unless you switch that off (see [Prompt text](#prompt-text)). For every prompt, its length and line count are kept either way.
- The name of every tool Claude calls.
- For tools Flightpath knows (`Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `NotebookRead`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`, `Task`, `Skill`, `TodoWrite`, `AskUserQuestion`), the text of these input fields: `file_path`, `notebook_path`, `path`, `command`, `description`, `pattern`, `glob`, `url`, `skill` and `subagent_type`.
- The questions Claude asked you with `AskUserQuestion`, and the option you chose.
- Slash-command names and their arguments, as typed (`command_name` and `command_args`; the first 2,000 characters of the arguments). These are kept whether or not prompt text is kept.
- The project folder (`cwd`), the transcript's path, the model, the permission mode, and the paths of instruction files Claude Code loaded.
- Names and sizes of images and attached files in a prompt. Image data is measured, never read out.
- Token counts, request timings, tool durations and outcomes.
- The size, in characters, of everything else.

**Never kept:**

- File contents: what `Read` returned, and what `Write` and `Edit` were given to write.
- Tool output of any kind: command output, search results, fetched pages.
- Claude's replies, summaries and notification messages.
- The inputs of tools Flightpath does not know, including every MCP tool. For these only the field names and sizes are kept.
- Email, account, user and organization identifiers in telemetry, and cost figures.

The rules are one allow-list: a text field is kept only if it is named in `packages/flightpath/src/redact/allowlist.ts`, and every other string is replaced by its length.

### Secrets

Every kept string is checked against a list of credential shapes, and a match is replaced by `[redacted:<kind>]` before anything is written. The list is in `packages/flightpath/src/redact/secrets.ts`. It covers private key blocks, AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Slack tokens, Google API keys, JWTs, passwords inside URLs, `Authorization` headers and bearer tokens, `--password`, `--token`, `--api-key`, `--secret` and `--auth` flags, MySQL-family `-p` passwords, and assignments to names ending in `_KEY`, `_TOKEN`, `_SECRET` or `PASSWORD`.

This is a list of known shapes, so a secret in any other shape is not caught. Commands and URLs are kept in full apart from these matches.

### Prompt text

Prompt text is stored only if the setting **Keep the text of my prompts** is on (`storePromptText` in `settings.json`). It is on by default, and there is no first-run question.

While it is on, Flightpath keeps at most the first 2,000 characters of each prompt, and only after replacing known secret shapes. A secret that runs across the 2,000th character is replaced whole before the text is cut. The text is stored in two places:

- The `turns` table of the database, which the session list and the map read.
- The raw record of the hook event, in the `raw_events` table. Flightpath's code reads this table back only to count its rows, but the text is on disk.

The prompt's full length and line count are kept as numbers beside the text.

When you switch it off:

- New prompts are recorded as their length only. The text never reaches the daemon or the event buffer.
- Text already kept is not deleted. It is hidden: the session list, the map and the token history leave it out. It stays in the database until retention removes it, or you delete it (see [Removing your data](#removing-your-data)).

## Where it is stored

Recordings live in Flightpath's own data folder, not in the plugin's folder:

| System  | Folder                                                      |
| ------- | ----------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Flightpath`                                 |
| macOS   | `~/Library/Application Support/Flightpath`                  |
| Linux   | `$XDG_DATA_HOME/flightpath`, or `~/.local/share/flightpath` |

On Linux, `XDG_DATA_HOME` is used only when it is an absolute path.

What is in it:

- `flightpath.db`, with its `-wal` and `-shm` files: the recordings.
- `settings.json`: your settings.
- `buffer/`: events waiting for the daemon, one file each. Events land here only when the daemon could not be reached, and the daemon empties the folder once it runs. It holds at most 20,000 events; a new one past that is dropped.
- `token` (created readable by you only, on systems that have file modes), `port`, `daemon.lock` and `daemon-start.lock`: how the hooks and commands find the daemon.
- `logs/`: `daemon.log` and `hook-errors.log`. The daemon log has one line for each start, drain, rejected request or error. Event bodies are not written to it, but an error message can quote what the daemon was working on, and that can include prompt text. The daemon log is rotated once at 256 KB, so at most two files remain. The hook error log starts over after 64 KB.
- `pause/` and `off`: markers for `/flightpath:stop` and `/flightpath:off`.
- `transcript-offsets.json`: how far into each transcript file Flightpath has read.
- `installed-at`, `buffer-dropped` and `last-error`: the time Flightpath was first used, a count of events dropped from a full buffer, and the last failure to start the daemon (one short line).
- `telemetry-setup.json` and `telemetry-settings-backup.json`, only if you turned on telemetry setup (see [Telemetry](#telemetry)).

Flightpath reads Claude Code's transcript files under `~/.claude/projects/` (or under `CLAUDE_CONFIG_DIR`, if set). It does not change them. Each line passes through the same allow-list before anything is stored. It also reads the auto-compact window from Claude Code's `settings.json` there.

When the daemon starts, it also imports transcripts of sessions the hooks did not record, but only for projects it has already recorded, only files changed since Flightpath was first used, and only those with activity inside your retention window. Folders you excluded are skipped.

## What leaves your computer

Nothing. Flightpath sends no analytics, crash reports or update checks, and it contacts no server of ours or anyone else's.

- The hook script reaches the daemon with a plain socket connection to `127.0.0.1`.
- The daemon listens on `127.0.0.1` only, on port 4747 or the next free port above it (up to 20 tries). The port is a setting.
- The daemon answers a request only if its `Host` header is `127.0.0.1`, `localhost` or `::1`. Everything except the view's pages and scripts also needs the install's token, sent in the `x-flightpath-token` header. The token is 32 random bytes, created on first run and stored in the `token` file, so any program that can read your data folder can read it.
- `/flightpath:off` asks the daemon to stop with one request to `127.0.0.1`. `/flightpath:open` asks your system to open the daemon's `127.0.0.1` address in your browser (`xdg-open`, `open`, or `start`).
- The view, served by the daemon, requests only addresses on the daemon itself. It has two plain links to Claude Code's documentation; the view makes no request to them.
- The plugin installs no packages. The libraries the view uses are bundled into it, and they make no requests either.

You can check this yourself. From the repository root, this search finds no use of `https`, `tls`, `dns`, `dgram`, `fetch(` or WebSocket in the plugin's source:

```
grep -rnE 'node:(https|http2|tls|dns|dgram)|fetch\(|WebSocket|XMLHttpRequest' packages/flightpath/src
```

and this one finds the only three places that open a connection (`hook.ts` with `node:net`; `daemon/server.ts` and `command-handler.ts` with `node:http`). Each connects to or listens on `127.0.0.1`:

```
grep -rnE 'import \{ (connect|createServer)\b|const \{ request \}' packages/flightpath/src
```

## How long it is kept

- **By age:** recordings are deleted when a session's last activity is older than **Keep recordings for**: 7, 15, 30, 60 or 90 days (`retentionDays`; default 15). A session still in progress is not deleted by age.
- **By size:** the database (`flightpath.db` and its `-wal` file) is held under 2 GiB. If it passes that, the oldest sessions that are not in progress are deleted until it is back under.

Both run when the daemon starts and every six hours while it runs. Deleting gives the disk space back. After a session is deleted this way, Flightpath keeps its id and the time it was deleted, so the session is not imported again from its transcript.

## Removing your data

- **One session:** run `/flightpath:forget` in it. It deletes everything stored for that session and pauses recording in it. The session's id and the time are kept so it is not imported again.
- **Everything recorded:** on the Settings screen (`/flightpath:status` prints its link while the daemon runs), choose **Delete all data…** and confirm. It deletes every stored session, sessions in progress included, with the same id-and-time markers.
- **Switching off prompt text** hides kept text but does not delete it. Use one of the two options above to remove it.
- **Uninstalling** removes the plugin and leaves the data folder. To delete everything, uninstall, then delete the data folder named above, including `telemetry-settings-backup.json` in it (see [Telemetry](#telemetry)).

```
/plugin uninstall flightpath@flightpath
/plugin marketplace remove flightpath
```

Uninstalling does not touch the data folder, so the buffer, the logs and the settings stay too.

## Turning recording off

- `/flightpath:stop` pauses recording in the current session. `/flightpath:start` resumes it.
- `/flightpath:off` turns recording off in every session and stops the daemon. `/flightpath:start` turns it back on.
- **Folders never recorded** (`excludedFolders`) lists folders whose sessions are not recorded at all.
- **Record new sessions automatically** (`autostart`) off makes every new session start paused.

## Telemetry

Telemetry setup is off until you turn it on, on the Settings screen under **Claude Code telemetry** (**Turn on…**, then confirm). It adds what the hooks and transcripts do not show: background requests such as titles and compaction, who approved each action, and exact timings.

It points Claude Code's own telemetry export at Flightpath on your computer. Flightpath does not send telemetry anywhere. This is what it writes, into the `env` block of `~/.claude/settings.json` (or `settings.json` in `CLAUDE_CONFIG_DIR`):

| Key                            | Value                        |
| ------------------------------ | ---------------------------- |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1`                          |
| `OTEL_LOGS_EXPORTER`           | `otlp`                       |
| `OTEL_METRICS_EXPORTER`        | `none`                       |
| `OTEL_EXPORTER_OTLP_PROTOCOL`  | `http/json`                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `http://127.0.0.1:<port>`    |
| `OTEL_EXPORTER_OTLP_HEADERS`   | `x-flightpath-token=<token>` |
| `OTEL_LOGS_EXPORT_INTERVAL`    | `1000`                       |
| `OTEL_LOG_ASSISTANT_RESPONSES` | `0`                          |

Because the token is one of these values, your Claude Code settings file then contains Flightpath's token.

Before it writes, it checks whether telemetry is already configured in managed settings, in your settings file, or in the environment. If it is, setup changes nothing. Otherwise it first copies your settings file to `telemetry-settings-backup.json` in the data folder, then rewrites the file with all your other keys kept, and records exactly what it wrote in `telemetry-setup.json`. If you change the port, the endpoint value moves with it. The change applies from your next session.

Telemetry records pass through the same allow-list as everything else. Strings other than a short list of names and identifiers become sizes, identity fields are dropped, and so is anything with `cost` in its name.

**To undo it:** choose **Turn off…** on the same screen. It removes the keys it added, restores any value of yours it replaced, and leaves alone any key you edited since (it tells you which). If it created the settings file and nothing else is in it, it removes the file. You can also remove those keys by hand. Remove `telemetry-settings-backup.json` yourself when you no longer need it, since it is a copy of your Claude Code settings.

## Contact

Questions about this page: open an issue at <https://github.com/dk-labs-dev/flightpath/issues>, or write to dklabsdev@outlook.com.
