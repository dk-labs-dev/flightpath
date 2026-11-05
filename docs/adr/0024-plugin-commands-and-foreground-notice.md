# ADR-0024: One command per action, and a foreground startup notice

**Status:** Accepted · 2026-10-24 · **Supersedes:** ADR-0010

## Context

ADR-0010 gave Flightpath one command, `/flightpath`, with subcommands. A command-cost check in a real install on Windows (Claude Code 2.1.310) showed two problems with how that lands in a real install.

1. **Plugin commands are namespaced.** A command file `commands/flightpath.md` in the `flightpath` plugin is `/flightpath:flightpath`. Plain `/flightpath stop` gives "Unknown command". The handler compared the command name with `flightpath`, so it let the namespaced command through, and the command file reached the model. Every hint we print (`/flightpath stop to pause`) named a command that doesn't exist.
2. **An async hook's `systemMessage` is not shown to the user.** Claude Code holds it until the next prompt and adds it to the model's system context. The user never saw the notice; the model did, along with the settings page's access token in the link. The earlier probe that found the notice user-only used a synchronous hook. The recording hook is async, and the notice was printed from it.

With the namespaced handler fixed, all eleven commands in the second session were handled locally and caused no request at all.

## Decision

- **One command per action,** as separate command files, each a namespaced plugin command:

  | Command | Effect |
  |---|---|
  | `/flightpath:status` | Recording state, daemon address, data folder, capture sources, token overhead, and the settings link |
  | `/flightpath:stop` | Pause recording for this session |
  | `/flightpath:start` | Resume recording for this session; turns Flightpath back on if it was off |
  | `/flightpath:off` | Shut down the daemon; stop recording everywhere until `/flightpath:start` |
  | `/flightpath:forget` | Delete this session's recording and pause it |

  Typing `/flightpath` in Claude Code lists all five. One synchronous `UserPromptExpansion` hook handles them, matched to exactly these names, and blocks the expansion. How the live view is opened is decided when the view is built.
- **The startup notice comes from its own synchronous `SessionStart` hook** that does nothing but read the settings and the pause and off flags, and print one `systemMessage`. Recording stays in the async hook. The notice hook doesn't touch the daemon or the network.
- **Nothing that can reach the model carries the access token.** The notice reads `● flightpath is recording · /flightpath:status for settings`. Only the status command's output, which is shown to the user and blocked from the model, carries the settings link with its token.
- **Accepted only after it's measured.** A manual check in a real install must show the notice to the user and find it in no API request. If a synchronous `systemMessage` also reaches the model, the notice is dropped and `/flightpath:status` is the way to check.

## Consequences

- Command names are longer, but each reads as what it does, and autocomplete shows the set.
- Session start runs two hooks instead of one. The notice hook is small and must stay fast; its run time is measured.
- ADR-0022's mention of `/flightpath` for status and the link now means `/flightpath:status`.
- Anything shown to users through a hook is verified in a real install, with the hook mode we ship, before we rely on it.

_Erratum, 2026-10-24: references to internal planning reworded without changing the decision._
