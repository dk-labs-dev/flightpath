# ADR-0022: Settings live in the browser; the session keeps only the main commands

**Status:** Accepted · 2026-10-23

## Context

Flightpath needs user settings, and the list will grow: a port, autostart, the startup notice, telemetry, folders never to record, whether prompt text is kept, how long the daemon idles. Later milestones will add retention, view and coach options.

ADR-0010 gave Flightpath one command, `/flightpath`, with plain subcommands. Putting every setting behind more subcommands would make the command long, hard to discover, and awkward for anything with a list or an explanation, such as telemetry consent or excluded folders. People will use Flightpath mostly through its browser view.

## Decision

- **The session keeps only the main commands:** `/flightpath` (status and the link to the browser view), `stop`, `start`, `off` and `forget`. Each one is a single action that makes sense mid-session.
- **Every setting lives on a settings page in the browser,** served by the daemon on the same address and with the same access token as the view (ADR-0008). A later terminal view, if one is built, gets the same settings.
- **Settings are stored in one file** in Flightpath's data folder (ADR-0014). Every setting has a safe default, so the file can be missing. The hook script, the daemon and the commands read the same file, through one module that validates each value.
- **The page explains, then applies.** Each setting says what it does in a sentence. Changes that touch something outside Flightpath, such as enabling telemetry, say exactly what will change and ask for confirmation first.
- **The startup notice points to the page,** so people find it without reading the docs.
- **The page changes settings only through requests that carry the access token in a header.** A request from another web page can't carry it, so other sites can't change settings.
- **The first settings:**
  - port (default 4747);
  - autostart (on);
  - startup notice (on);
  - telemetry (off; see ADR-0023);
  - excluded folders (none);
  - store prompt text (on);
  - daemon idle shutdown (30 minutes).

## Consequences

- The command stays short, and settings have room to grow without new commands.
- Settings need the daemon running to be changed. The startup notice and `/flightpath` both give the link, and the daemon starts with the session.
- Until the full view arrives, the settings page is a plain form. It's restyled with the view later.
- Every new setting needs a default, a validation rule and one sentence of explanation, and anything privacy-related is reviewed against ADR-0004.
