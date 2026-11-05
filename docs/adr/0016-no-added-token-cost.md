# ADR-0016: Flightpath never adds token cost

**Status:** Superseded by ADR-0021 · 2026-10-23 (accepted 2026-10-23) · Supersedes ADR-0007

## Context

ADR-0007 made every Flightpath hook asynchronous and silent, so recording never costs tokens or slows the agent. It didn't cover the `/flightpath` commands (ADR-0010).

A plugin slash command is normally a prompt: Claude Code expands it and sends it to the model, which then runs whatever the command describes. Every `/flightpath stop` or `/flightpath forget` would cost the user a model request, and it would let the agent misread or change a simple action.

Claude Code's `UserPromptExpansion` hook fires when a slash command is expanded, can be matched to one command name, and can block the expansion so it never reaches the model. A hook can only block if it runs synchronously, which ADR-0007 rules out.

## Decision

**Flightpath never adds token cost to the user's sessions.** Nothing it does is sent to the model: not recording, not commands, not notices.

- **Recording hooks** are asynchronous and silent, as before. They print nothing that could enter the model's context, never block or deny an action, and only check the pause flag, forward the payload to the daemon, and buffer to a local file when the daemon is unreachable.
- **Commands** are handled by one synchronous `UserPromptExpansion` hook, matched only to Flightpath's own command. It carries out the command, then blocks the expansion, so the prompt never reaches the model. The result is shown to the user only.
- **User-facing messages** use only channels shown to the user and not sent to the model, such as `systemMessage`. Plain stdout is never used on events where Claude Code adds it to the context.
- **Flightpath never registers prompt or agent hooks,** because those call a model.
- The synchronous hook does no work for any other prompt or command, and it has to finish quickly, because the user is waiting for it.

## Consequences

- Recording and commands are free in tokens, and the agent never sees or acts on Flightpath.
- Flightpath can't enforce anything in the user's session. It only observes, as under ADR-0007.
- Command handling depends on how Claude Code handles a blocked expansion. Before it ships, a test has to confirm that the result reaches the user and not the model.
- A slow command delays the user's next prompt, so commands that take real work (such as opening the view) hand it to the daemon and return at once.
