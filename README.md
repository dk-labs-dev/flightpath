# Flightpath

Flightpath records every Claude Code session live, draws the journey as a map you can explore while it happens, and coaches you on how to make your next session better. Prompts, tool calls, subagents and your own interventions become one timeline: what the agent did, what it knew at the time, where the tokens went, and where a session went wrong — each problem pinned to the moment it happened, with a concrete fix suggested for the next session.

**Status: (in development).** The recorder is built: live capture, the local store, the five commands and a settings screen in the view. The map view and coaching are next. Install instructions are in the [plugin README](packages/flightpath/README.md).

Flightpath is local-first: recordings live on your machine, file paths are recorded rather than file contents, and nothing is sent anywhere. The reasoning behind the design is recorded in [docs/adr](docs/adr/).

## Contributing

Run the checks before asking for a review:

```
pnpm format:check && pnpm lint && pnpm typecheck && pnpm quality && pnpm test
```

`pnpm quality` is the structural gate. It runs six checks and prints one line per check:

- **eslint** — no function over 60 lines, no nesting deeper than 3, no nested ternaries, no `any`, no non-null assertions in `src/`, and no `as unknown as`. An exception is written `// eslint-disable-next-line <rule> -- <reason>`; a disable without the reason fails. The rules have no per-file exceptions: a pre-existing violation is carried by a baseline disable on the violating line itself (see below).
- **baseline count** — the tree holds exactly the number of `-- baseline` eslint disables that `scripts/baseline-count.json` records.
- **knip** — no unused exports, files or dependencies.
- **jscpd** — no duplicated block of 50 tokens or more across `src/`, `scripts/` and `test/`.
- **comment ratio** — no file over 20% comment lines, unless it is listed in `scripts/comment-ratio-allowlist.json` with a reason.
- **test length** — no `it` body over 80 lines; `describe` blocks are exempt.

Violations that predate the gate are carried as baselines, and a baseline can only shrink: new code gets no entries, and the change that empties a list deletes it. ESLint's baselines are the `// eslint-disable-next-line <rule> -- baseline: <detail>; to be split` (or `to be removed`) comments on the violating lines — each names the rule and carries the measured detail. `scripts/baseline-count.json` records how many baseline disables exist, and the gate fails if the tree's count differs from it in either direction: more means a violation was baselined instead of fixed, and fewer means a cleanup worked, so lower the recorded number in the same change. The other baselines live in the tool configs: `ignoreIssues` in `knip.jsonc`, `.jscpd-baseline.json`, the `baseline` entries in the comment-ratio allow-list (an entry with `"baseline": false` is a file that stays comment-heavy by design, not a cleanup target) and `scripts/test-length-baseline.json`. To refresh the jscpd baseline after removing a duplication, run `pnpm exec jscpd --update-baseline`.

To measure the daemon's memory while it ingests 100,000 events, build first, then run `pnpm measure-ingest` from `packages/flightpath`.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
