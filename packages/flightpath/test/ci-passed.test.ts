import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// These tests cover the script the required `CI passed` job
// runs: scripts/ci-passed.mjs reads the results of the jobs it
// needs from the NEEDS environment variable and passes only on
// `success` or `skipped`. They run the script itself, the way
// the workflow does, so its exit code is part of what is checked.

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "ci-passed.mjs",
);

type JobResults = Record<string, { result: string }>;

function runCiPassed(needs: JobResults) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
    encoding: "utf8",
  });
}

describe("the CI passed check", () => {
  it("passes when every job succeeded, or jobs were skipped", () => {
    const allSucceeded = runCiPassed({
      prepare: { result: "success" },
      static: { result: "success" },
      "test-main": { result: "success" },
    });
    expect(allSucceeded.status).toBe(0);
    const someSkipped = runCiPassed({
      prepare: { result: "success" },
      build: { result: "skipped" },
      "test-main": { result: "skipped" },
    });
    expect(someSkipped.status).toBe(0);
  });

  it("fails on a failure and a cancellation, naming each with its result", () => {
    const run = runCiPassed({
      prepare: { result: "success" },
      "test-main": { result: "failure" },
      build: { result: "cancelled" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("test-main: failure");
    expect(run.stderr).toContain("build: cancelled");
  });

  it("fails when a job was abandoned", () => {
    const run = runCiPassed({
      prepare: { result: "success" },
      "test-main": { result: "abandoned" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("test-main: abandoned");
  });

  it("fails on a result it has never seen", () => {
    const run = runCiPassed({
      prepare: { result: "success" },
      "test-main": { result: "unexpected" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("test-main: unexpected");
  });
});
