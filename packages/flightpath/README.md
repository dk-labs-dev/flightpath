# Flightpath

Flightpath records every Claude Code session, live, on your own
machine. A hook captures each event as it happens — prompts, tool
calls, subagent runs, permission requests, compactions — redacts
it, and hands it to a small local daemon, which stores the
session as a journey you can query: what the agent did, in what
order, what each request cost in tokens, and where you stepped
in.

What you get today is the recorder: the capture, the local
database, per-request token counts (read from the session's
transcript, and from Claude Code's own telemetry if you turn it
on), the six `/flightpath:` commands, and a settings screen in
the view. The map view and the coaching built on these
recordings come next.

A session shows as live only while it is really there. When a
session ends normally, its own end event says so. If the window
is closed without one — no end event ever arrives — the daemon
ends the session at its last event, labelled "(no exit seen)"
rather than pretending the exit was witnessed: within about a
minute when it can see that the session's Claude Code process
is gone, and otherwise after ten minutes without a word from
it. A newer session starting in the same process — /clear or
/resume — ends the one it replaced the same way. A session
that is merely idle stays live: its process is
still running, and its card says how long it has been quiet.
Anything arriving from a session after it was ended — a
resumed session, a laptop waking — makes it live again, the
same session, never a duplicate.

Flightpath is local-first. Recordings live on your machine, in
Flightpath's own data folder. Nothing is sent anywhere. File
contents are never stored: the recorder keeps paths, commands
and your prompts, reduces tool output and Claude's responses to
their sizes, and scrubs known credential shapes from everything
it keeps.

The Steps lens marks each step that has a suggestion with a small
shape in the suggestion's grade: a filled circle for worth fixing,
a ring for worth a look, a square for did you know. Opening a
marked step shows its suggestions on a second tab, and a heading above
the steps lists every suggestion for the session. The heading opens by
itself when any suggestion is worth fixing. A suggestion can be
dismissed, and it stays dismissed after a reload.

## Prerequisites

**Node 24 or later, on your `PATH`.** Claude Code itself doesn't
need Node, so it may not be installed; check with
`node --version`.

If Node is missing or too old, the easiest route is a version
manager: [nvm](https://github.com/nvm-sh/nvm) on macOS and Linux
(`nvm install 24`, then `nvm use 24`), or
[nvm-windows](https://github.com/coreybutler/nvm-windows) on
Windows. A direct install from [nodejs.org](https://nodejs.org)
works just as well.

One caveat: when Claude Code is started from a desktop app or an
IDE, the environment it inherits may not include a Node installed
through nvm, because no login shell ran to set up `PATH`.
Starting Claude Code from a terminal avoids that.

## Install

From a local folder — a release zip, unzipped, or a clone of
the repository — register the folder as a marketplace and install
the plugin.

A clone needs one step first: the repository doesn't carry the
built files the plugin runs, so build them before registering
the folder. From the repository root, with
[pnpm](https://pnpm.io) installed:

```
pnpm install
pnpm -r run build
```

Then, in Claude Code:

```
/plugin marketplace add <folder>
/plugin install flightpath@flightpath
```

Recording starts with your next session. A one-line notice at
session start confirms it: `● flightpath is recording ·
/flightpath:status for settings`. The notice carries no link
and no token; the settings link lives in `/flightpath:status`.

## The commands

Six commands, one per action. Each is handled by a local hook
before the prompt is expanded, so a command never reaches the
model — and the model can't invoke them either.

- `/flightpath:status` — report only: whether this session is
  recording, paused, or off everywhere; the daemon's address;
  the data folder; how many days of recordings are kept, and
  the database's size; what captured this session, and what the
  commands cost it in tokens. While the daemon is running it
  also shows the settings link — the one place that link
  appears. Status never changes anything.
- `/flightpath:stop` — pause recording for this session. A
  paused stretch is never filled in afterwards.
- `/flightpath:start` — resume a paused session. After
  `/flightpath:off` it turns recording back on everywhere, and
  starts the daemon again.
- `/flightpath:off` — turn recording off in all sessions, and
  stop the daemon.
- `/flightpath:forget` — delete this session's recording, and
  pause so nothing new is captured. A forgotten session is
  never re-imported from its transcript.
- `/flightpath:open` — open this session's live view in the
  browser, starting the daemon first if it isn't running. If
  no browser can be opened, the command prints the link
  instead.

## Settings

Settings are a screen in the view, served by the daemon on this
machine only; `/flightpath:status` links to it while the daemon
is running. It holds:

- **port** — the port the daemon listens on, on this machine
  only. Saving a new port restarts the daemon on it.
- **autostart** — record new sessions automatically. When off,
  each session starts paused, and `/flightpath:start` records
  it.
- **startupNotice** — show the one-line state notice when a
  session starts.
- **telemetry** — also record Claude Code's own telemetry. Off
  unless you turn it on; see below.
- **excludedFolders** — folders that are never recorded.
  Sessions working in them are dropped, as if paused. One folder
  per line.
- **storePromptText** — keep the text of your prompts. Only the
  first 2,000 characters of each prompt are kept, with its full
  length and line count. When off, only the length of each prompt
  is kept.
- **retentionDays** — how many days of recordings to keep (7,
  15, 30, 60 or 90; 15 by default). Older recordings are deleted
  automatically, and the space is given back. A session still in
  progress is never deleted. Lowering the period asks you to
  confirm first, since it deletes sessions.
- **idleShutdownMinutes** — how long the daemon waits with no
  events before it exits. It also stays up until a live session's
  cache has expired, at most about an hour. The next event starts
  it again.

## Telemetry

Without telemetry, Flightpath records the full journey and the
exact token counts for your own and your subagents' requests.
Telemetry adds the rest: background requests (a sizeable share
of all requests — prompt suggestions, session titles, compaction),
who approved each action, the compaction request's token count,
exact request durations, and hook timings.

Telemetry is opt-in. Turn it on from the Settings screen: it
explains first, asks you to confirm, and only then edits your
Claude Code settings — backing the file up first, and recording
exactly what it added, so turning it off removes exactly that
and nothing else. The data goes to the daemon on this machine
and nowhere else, and account identity (email, account and
organization ids) is dropped before anything is stored. Dollar
figures are never stored; Flightpath counts tokens, not money.
If telemetry is already configured in your environment, your
settings, or managed settings, the screen says so and changes
nothing. Changes take effect from the next session.

## Your data

Recordings live in Flightpath's own folder, not in the plugin's
data directory, so they survive updates and uninstalls:

- Windows: `%LOCALAPPDATA%\Flightpath`
- macOS: `~/Library/Application Support/Flightpath`
- Linux: `$XDG_DATA_HOME/flightpath`, or `~/.local/share/flightpath`

The folder holds the database (`flightpath.db`), a buffer of
events waiting for the daemon, the settings file, and the
daemon's port and token files.

The database is capped at 2 GB: if it grows past that, the
oldest finished sessions are deleted first to bring it back
under. To clear your recordings without uninstalling, use the
Settings screen's delete-all — it removes every recording and
keeps the plugin installed.

To delete everything: uninstall the plugin (below), then delete
that folder.

## Uninstall

```
/plugin uninstall flightpath@flightpath
/plugin marketplace remove flightpath
```

Uninstalling removes the plugin. Your recordings stay in the
data folder above until you delete it — reinstalling picks them
up again.

## License

Apache License 2.0 — see `LICENSE` and `NOTICE` at the top of
the repository.
