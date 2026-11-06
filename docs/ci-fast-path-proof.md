# CI fast-path proof

This page exists to prove a point about the CI workflow: a pull
request whose only change is documentation runs the static and
hygiene checks and reports the build and the test jobs as skipped,
because there is no code in the change for them to run on.

It sits on a scratch branch behind a draft pull request and is not
meant to be merged.
