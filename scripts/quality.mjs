// The quality gate: every check a machine can run, in one command.
// Prints one line per check with its result; a failing check also
// prints what the tool reported, so the fix starts from the output,
// not from a guess. All checks run even when an earlier one fails.
//
// Run it before asking for a review; CI runs it on every change.

import { spawnSync } from "node:child_process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import process from "node:process";

const checks = [
  ["eslint", "eslint ."],
  ["baseline count", "node scripts/baseline-count.mjs"],
  ["knip", "knip"],
  ["jscpd", "jscpd"],
  ["comment ratio", "node scripts/comment-ratio.mjs"],
  ["test length", "node scripts/test-length.mjs"],
  // report: the check's own line is part of the gate's output.
  ["colour literals", "node scripts/colour-literals.mjs", { report: true }],
  ["bundle size", "node scripts/bundle-size.mjs", { report: true }],
];

let failed = 0;
for (const [name, command, options] of checks) {
  const started = performance.now();
  // shell: the .bin shims are .cmd files on Windows. The command
  // strings are fixed above — nothing external reaches them.
  const run = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (run.status === 0) {
    console.log(`${name}: ok (${seconds}s)`);
    if (options?.report) {
      process.stdout.write(run.stdout ?? "");
    }
  } else {
    failed += 1;
    console.log(`${name}: FAILED (${seconds}s)`);
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
  }
}
if (failed > 0) process.exit(1);
