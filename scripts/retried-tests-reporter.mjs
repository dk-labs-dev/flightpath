// Vitest reporter for CI: writes the full name of every test that
// passed only after a retry to the file named by the
// FLIGHTPATH_RETRIED_TESTS_FILE environment variable, one Markdown
// list item per test. The workflow appends that file to the job
// summary, so a flaky test is named in the open instead of hidden
// by its retry. With the variable unset the reporter writes nothing.

import { appendFileSync } from "node:fs";
import process from "node:process";

function collect(task, trail, lines) {
  const here = task.type === "test" ? trail : [...trail, task.name];
  if (
    task.type === "test" &&
    task.result?.state === "pass" &&
    (task.result?.retryCount ?? 0) > 0
  ) {
    lines.push(`- ${[...trail, task.name].join(" > ")}`);
  }
  for (const child of task.tasks ?? []) {
    collect(child, here, lines);
  }
}

export default class RetriedTestsReporter {
  onFinished(files) {
    const out = process.env.FLIGHTPATH_RETRIED_TESTS_FILE;
    if (!out) {
      return;
    }
    const lines = [];
    for (const file of files ?? []) {
      collect(file, [], lines);
    }
    if (lines.length > 0) {
      appendFileSync(out, `${lines.join("\n")}\n`);
    }
  }
}
