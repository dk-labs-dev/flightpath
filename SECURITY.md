# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/dk-labs-dev/flightpath/security/advisories/new) for this repository. Please do not open a public issue for a security problem.

Include what you found, the Flightpath and Claude Code versions involved, and the steps to reproduce it. Reports are read by the maintainers; expect an acknowledgement, and please give us a reasonable time to fix the problem before disclosing it elsewhere.

## Scope

Flightpath runs entirely on the user's own machine, so the security-sensitive parts are the ones that handle session data and execute with the user's permissions:

- the local daemon: what it records, how recordings are stored on disk, and who can read them;
- the daemon's server: it listens only on 127.0.0.1 and answers only requests that carry the install's token; the token is kept in a `token` file in the Flightpath data folder, created readable only by the user on macOS and Linux; on Windows it takes the permissions of that folder, which is in the user's own profile;
- the hooks: the command Claude Code runs on each event Flightpath listens to (session start and end, prompts, tool calls, permission requests, compaction and others), and what it passes to the daemon;
- the telemetry setup: when the user turns telemetry on, the keys it adds to the `env` block of Claude Code's `settings.json`, the backup it takes of that file first, and the removal of those keys when telemetry is turned off.

A report that shows recordings, credentials or file contents leaving the machine, or being readable by someone other than the user, is in scope wherever in the plugin it originates. Vulnerabilities in Claude Code itself, or in Node.js, belong to their own projects; report those upstream.
