# Contributing

Thanks for helping improve Flightpath. This page covers setting up the build, the checks every change must pass, and how pull requests work.

## Build

You need Node.js 24 (the repository's `.nvmrc` pins the line) and pnpm.

```
pnpm install --frozen-lockfile
pnpm --filter @flightpath/flightpath run build
```

## Checks

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

## Pull requests

- Branch from `main`, keep the change to one subject, and open the pull request against `main` using the template.
- Run the five checks above first; the pull request should arrive green.
- Sign off every commit (see below).
- A pull request needs the CI checks and the sign-off check to pass and one approval from a maintainer. It then merges through the merge queue as a single squashed commit, so the history on `main` stays linear.

## Sign-off

Sign off every commit with `git commit -s`: the sign-off is your statement, under the Developer Certificate of Origin, that you wrote the change or have the right to submit it under the project's licence, Apache-2.0.

This adds a line `Signed-off-by: Your Name <you@example.com>` to the commit message. The name and email must match the commit's author. A check on the pull request blocks the merge until every commit carries one. To add a missing sign-off, run `git rebase --signoff main` and force-push your branch. The certificate's full text is at https://developercertificate.org.
