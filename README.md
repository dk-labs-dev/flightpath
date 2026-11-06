# Flightpath

Flightpath records every Claude Code session live, draws the journey as a map you can explore while it happens, and coaches you on how to make your next session better. Prompts, tool calls, subagents and your own interventions become one timeline: what the agent did, what it knew at the time, where the tokens went, and where a session went wrong — each problem pinned to the moment it happened, with a concrete fix suggested for the next session.

**Status: (in development).** The recorder is built: live capture, the local store, the five commands and a settings screen in the view. The map view and coaching are next. Install instructions are in the [plugin README](packages/flightpath/README.md).

Flightpath is local-first: recordings live on your machine, file paths are recorded rather than file contents, and nothing is sent anywhere. The reasoning behind the design is recorded in [docs/adr](docs/adr/).

## Contributing

How to build Flightpath, the checks every change must pass, and how pull requests work are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
