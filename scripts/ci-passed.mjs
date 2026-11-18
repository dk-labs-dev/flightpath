// Decides whether the workflow's jobs passed, for the required
// `CI passed` job, from the NEEDS environment variable: the JSON
// of every needed job's result that the workflow passes in. The
// rule is an allow-list: a job passes only when its result is
// `success` or `skipped`, and every other result fails, including
// ones GitHub adds later. A deny-list passes a result nobody has
// seen yet, which is how an `abandoned` test job once passed.

import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PASSING_RESULTS = new Set(["success", "skipped"]);

export function jobsThatDidNotPass(needs) {
  const failed = [];
  for (const [name, job] of Object.entries(needs)) {
    if (!PASSING_RESULTS.has(job.result)) {
      failed.push({ name, result: job.result });
    }
  }
  return failed;
}

// Run directly, prints each job that did not pass, exits 1 if any.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = process.env.NEEDS;
  if (raw === undefined) {
    console.error(
      "NEEDS is not set; the workflow passes the needed jobs' results there.",
    );
    process.exit(2);
  }
  const failed = jobsThatDidNotPass(JSON.parse(raw));
  for (const job of failed) {
    console.error(`${job.name}: ${job.result}`);
  }
  if (failed.length > 0) {
    process.exit(1);
  }
}
