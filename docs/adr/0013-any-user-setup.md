# ADR-0013: Work with any user setup

**Status:** Accepted · 2026-10-23

## Context

Claude Code users customize heavily: other plugins with their own hooks, skills and MCP servers, personal `CLAUDE.md` instructions, auto mode and other permission modes, output styles, and company-managed settings. Recorded sessions show that these change what the agent does and what it costs. For example, a personal instruction made the agent pause for approval between steps, and auto mode approved commands with no prompt.

Some settings can also limit what Flightpath can capture. Hooks can be turned off, or an organization can allow only managed hooks. Telemetry may already be sent elsewhere (ADR-0012).

A recording tool that asks people to change their setup adds friction, and it records sessions that aren't the ones they actually run.

## Decision

- **Flightpath never requires a user to change their setup.** No disabling plugins, no changing permission modes, no editing instructions. Setup offers only what Flightpath adds (ADR-0012), and only with consent.
- **It records the session as it really ran.** Other plugins' hooks, skills, MCP tools and injected context are recorded like everything else, and their cost is attributed to them where the data allows.
- **It records the session's conditions:** permission mode, instruction files loaded, enabled plugins, and which capture sources were available. The coach takes these into account, and doesn't flag behavior the user configured.
- **It degrades instead of failing.** If hooks are unavailable, Flightpath records from transcripts, and from telemetry if enabled. The view states which sources a session was recorded from.
- **Its hooks never interfere with anyone else's.** They are asynchronous and silent (ADR-0007), so they can't block, delay or alter another plugin's hooks. If another hook blocks a tool, Flightpath records the step as blocked.

## Consequences

- The data model stores per-session conditions and capture sources.
- The transcript reader must be able to record a whole session on its own, not just fill gaps. It isn't live in that mode.
- Coach detectors read the session's conditions before raising a finding.
- Milestone exit tests run on a real, customized setup, not a clean one.
