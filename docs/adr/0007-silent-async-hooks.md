# ADR-0007: Hooks are asynchronous and silent

**Status:** Superseded by ADR-0016 · 2026-10-23 (accepted 2026-10-22)

## Context

Claude Code runs hooks around agent activity. Synchronous hooks delay the agent. For some events, text a hook prints is added to the model's context, which costs the user tokens and can change the agent's behavior.

## Decision

- All Flightpath hooks run asynchronously and never block or deny an action.
- Hooks print nothing that could enter the model's context. User-facing notices use a channel shown only to the user, if one exists; otherwise there is no notice.
- Each hook does the minimum: check the pause flag, forward the payload to the daemon, buffer to a local file if the daemon is unreachable.

## Consequences

- Recording never costs tokens and never slows the agent.
- Flightpath cannot enforce anything (for example, block a command); it observes only.
- The session-start notice depends on confirming a user-only output channel.
