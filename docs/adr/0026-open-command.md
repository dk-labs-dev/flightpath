# ADR-0026: A command that opens the live view

**Status:** Accepted · 2026-10-25

## Context

The live view is a page served by the daemon on this machine. Today the only way to reach it is the settings link in `/flightpath:status`'s output, which the user has to find and click. That's fine for settings, which are opened rarely. The live view is opened in most sessions, so it should take one step.

ADR-0024 left this open. It gave Flightpath five commands, each handled by a synchronous hook that answers locally and blocks the expansion, so no command reaches the model or costs a token.

## Decision

- **A sixth command, `/flightpath:open`,** opens the live view for the current session in the default browser, with the access token in the address. It's handled by the same command hook and blocked like the others, so it costs no request.
- The hook starts the daemon first if it isn't running, then opens the address with the platform's own opener (`start` on Windows, `open` on macOS, `xdg-open` on Linux), detached, so the hook returns at once.
- **It always prints the address too,** shown to the user only. If no browser can be opened (a remote shell, a container, a missing opener), the printed link is the way in, and the command says so.
- `/flightpath:status` keeps its settings link.
- The command hook's matcher and the shared list of command names gain `open`. The command file carries `disable-model-invocation: true`, like the other five.

## Consequences

- One step from a session to its live view, and still zero tokens.
- The command launches a process on the user's machine: only the fixed opener for the platform, with a `127.0.0.1` address Flightpath built itself, never text from the session.
- The real-install check is done again for the new name: blocked, shown to the user, no request.
