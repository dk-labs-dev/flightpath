# Changelog

What each release of Flightpath does, newest first.

## 1.0.0

- Records every Claude Code session live, on your own machine:
  prompts, tool calls, subagent runs, permission requests and
  compactions, as one timeline of what the agent did and in what
  order.
- Shows what each request cost in tokens, read from the session's
  transcript.
- Six commands — `/flightpath:start`, `/flightpath:stop`,
  `/flightpath:status`, `/flightpath:open`, `/flightpath:off` and
  `/flightpath:forget` — handled locally, before the prompt is
  expanded, so they never reach the model.
- A Steps lens that marks steps with graded suggestions for the
  session, and a settings screen served by the local daemon:
  port, autostart, excluded folders, how many days of recordings
  to keep.
- Local-first: recordings stay in Flightpath's own data folder on
  your machine. File contents are never stored, and known
  credential shapes are scrubbed from everything that is kept.
- Telemetry is opt-in and off unless you turn it on; account
  identity is dropped before anything is stored.
- Requires Node 24 or later.
