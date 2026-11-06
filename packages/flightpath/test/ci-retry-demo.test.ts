import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { expect, test } from "vitest";

// Demonstration for this change's first CI run, removed in the
// commit that follows it: under CI this fails on its first attempt and
// passes on the retry, so the run shows option A working — the job
// summary names this test as passed only on retry. Off CI it passes
// at once. The marker is per CI run, so each run demonstrates once.
test("ci retry demonstration fails on its first attempt under CI", () => {
  if (!process.env.CI) {
    return;
  }
  const marker = join(
    tmpdir(),
    `flightpath-ci-retry-demo-${process.env.GITHUB_RUN_ID ?? "local"}`,
  );
  if (!existsSync(marker)) {
    writeFileSync(marker, "attempted");
    expect("first attempt").toBe("the retry demonstration");
  }
});
