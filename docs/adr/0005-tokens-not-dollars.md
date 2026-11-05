# ADR-0005: Show tokens, not dollars

**Status:** Accepted · 2026-10-22

## Context

Claude Code reports an estimated cost per request at list API prices. For users on subscription plans, that figure is not what they pay and can be alarming or misleading.

## Decision

Flightpath displays token counts (in context, added, processed, cache read and write) and relative comparisons. It does not display dollar amounts.

## Consequences

- One unit for every user, regardless of plan.
- Cost data received from telemetry may be stored for future use but is not shown.
- A dollar view for API-key users can be added later behind a setting, through a new ADR.
