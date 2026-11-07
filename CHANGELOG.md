# Changelog

What each release of Flightpath does, newest first.

## 1.0.1

- The plugin has an icon, the paper-plane mark, for the places
  that list plugins.
- The plugin folder no longer carries the development scripts;
  they stay in the repository.

## 1.0.0

- Records every Claude Code session live, on your own machine:
  prompts, tool calls, subagent runs, permission requests and
  compactions, as one timeline of what the agent did and in what
  order.
- Three views of each session:
  - Steps: every turn, tool call and subagent as it happens.
    Select a step to see the command Claude ran, how long it
    took and how much it added to the context.
  - Tokens: the context size over the session, the largest
    increases and the steps behind them, and the headroom left
    before auto-compact. What each request cost in tokens is
    read from the session's transcript.
  - Snapshot: the full contents of the context at any step —
    system prompt, tools, CLAUDE.md files and skills, each with
    its size.
- Coaching while you work: the session is reviewed as it runs,
  and graded suggestions surface as they are found, each linked
  to the step that prompted it and saying why it matters; where
  there is a change to make, the suggestion gives the text to
  copy.
- Opening the view before a session has recorded shows one
  plain line saying how a session gets there, with a link to
  the user guide.
- Six commands — `/flightpath:start`, `/flightpath:stop`,
  `/flightpath:status`, `/flightpath:open`, `/flightpath:off` and
  `/flightpath:forget` — handled locally, before the prompt is
  expanded, so they never reach the model. Nothing is added to
  Claude's context, and each session shows Flightpath's own
  token overhead.
- A settings screen served by the local daemon: port,
  autostart, excluded folders, how many days of recordings to
  keep, and whether prompt text is kept.
- Local-first: recordings stay in Flightpath's own data folder
  on your machine. File contents are never stored, and known
  credential shapes are scrubbed from everything that is kept.
- Telemetry is opt-in and off unless you turn it on; account
  identity is dropped before anything is stored.
- Requires Node 24 or later.
