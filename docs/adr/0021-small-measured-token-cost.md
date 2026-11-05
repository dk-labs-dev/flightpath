# ADR-0021: Keep Flightpath's token cost small and measured

**Status:** Accepted · 2026-10-23 · Supersedes ADR-0016

## Context

ADR-0016 said Flightpath never adds token cost: recording hooks are silent, and `/flightpath` commands are caught by a synchronous `UserPromptExpansion` hook and blocked before they reach the model. Whether a blocked command's result reaches the user, and only the user, is documented but not yet tested.

Making "zero" absolute would turn that untested detail into a blocker, and could rule out simple, reliable ways to run commands. What users need is that Flightpath's cost is negligible, never grows with use, and is known rather than guessed.

## Decision

- **Recording stays free.** Recording hooks are asynchronous and silent, print nothing that could enter the model's context, and never block or deny an action. Recorded sessions confirmed they add nothing to the context.
- **Commands are as cheap as we can make them.** The preferred route is the synchronous `UserPromptExpansion` hook, matched only to Flightpath's command, which does the work and blocks the expansion. If it can't do that reliably, a command may reach the model, as long as each use is a single small request whose cost doesn't depend on how often Flightpath is used.
- **Nothing Flightpath adds accumulates.** No instructions, reminders or context are added to every request or every turn. A cost, if any, is paid only when the user runs a command.
- **The cost is measured and visible.** Every request caused by a Flightpath command is tagged as Flightpath's own, and `/flightpath` reports the session's Flightpath overhead in tokens. Release testing reports the measured figures.
- **User-facing messages** use channels shown only to the user, such as `systemMessage`, and Flightpath never registers prompt or agent hooks.

## Consequences

- The command design can ship even if blocking an expansion behaves differently than documented, with the cost known.
- Users can check Flightpath's overhead for themselves, in tokens (ADR-0005).
- Any change that adds context to every request needs a new ADR.

_Erratum, 2026-10-23: two sentences reworded without changing the decision._
