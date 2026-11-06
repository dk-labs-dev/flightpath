import process from "node:process";

import { defineConfig } from "vitest/config";

// Option A: on CI a failed test is retried once, and the
// workflow's job summary names every test that passed only on that
// retry, so a flaky test stays visible instead of being absorbed
// silently. Local runs never retry — a red test stays red in front
// of the person who can fix it. A test that fails twice still fails.
const retry = process.env.CI ? 1 : 0;

// The files whose tests hold wall-clock product budgets —
// acknowledgment times, turn-end medians, the health-notice
// p90, the submit entry's overhead, the steps-lens open and
// scroll times, the tokens lens's open and scroll times, the
// end-of-turn line's run time, the settings port move's
// restart-and-reload time, the stream's acknowledgment p90 and
// capture-pass times. They run in their own project,
// serially, and `pnpm test` runs that project last: a budget
// measured while other suites run measures those suites, so
// budgets are only ever measured with the machine to
// themselves.
const budgetFiles = [
  "test/long-sessions.test.ts",
  "test/recorder-health.test.ts",
  "test/retention.test.ts",
  "test/settings-screen-budget.test.ts",
  "test/steps-lens-browser.test.ts",
  "test/submit-command-budget.test.ts",
  "test/stream-budget.test.ts",
  "test/terminal-line-budget.test.ts",
  "test/tokens-lens-budget.test.ts",
];

// The files that exercise node:sqlite directly, or the warning
// filter that keeps its ExperimentalWarning from the user. The
// storage module's behavior follows the Node release line, so
// these also run on the oldest supported line and on the newest.
// retention.test.ts opens node:sqlite too but holds wall-clock
// budgets, so it stays in `budgets` and runs on the pinned line.
const nodeLineFiles = [
  "test/schema.test.ts",
  "test/storage-warning.test.ts",
  "test/storage.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "main",
          include: ["test/**/*.test.ts"],
          exclude: budgetFiles,
          retry,
        },
      },
      {
        test: {
          name: "budgets",
          include: budgetFiles,
          fileParallelism: false,
          retry,
        },
      },
      {
        test: {
          name: "node-lines",
          include: nodeLineFiles,
          retry,
        },
      },
    ],
  },
});
