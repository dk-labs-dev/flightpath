import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { distPath } from "./support/daemon.js";
import { userPromptEvent } from "./support/events.js";
import { scratchHome } from "./support/process.js";
import { medianOf, onHostedRunner, percentileOf } from "./support/time.js";

// Claude Code waits for the submit entry before every prompt, so
// what it adds over a bare Node start is a budget of its own.

const distSubmitCommand = distPath("submit-command.js");
const RUNS = 50;
const MEDIAN_OVERHEAD_MS = process.platform === "win32" ? 40 : 15;

function timeRun(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { env });
    child.on("error", reject);
    child.on("close", () => resolvePromise(performance.now() - started));
    child.stdin.end(input);
  });
}

/** Per-run time over a bare Node start, measured back to back. */
async function overheadOf(
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<number[]> {
  const overhead: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const bare = await timeRun(["-e", ""], "", env);
    overhead.push((await timeRun([distSubmitCommand], input, env)) - bare);
  }
  return overhead;
}

describe("the submit entry's cost", () => {
  it.skipIf(onHostedRunner)(
    "adds almost nothing to a prompt that is not a command",
    async () => {
      const { env } = scratchHome("flightpath-submit-budget-");
      const overhead = await overheadOf(
        JSON.stringify(userPromptEvent("s1", "fix the parser today")),
        env,
      );
      console.log(
        `submit entry, plain prompt on ${process.platform}: overhead median ${medianOf(overhead).toFixed(1)} ms, p90 ${percentileOf(overhead, 0.9).toFixed(1)} ms over ${RUNS} runs`,
      );
      expect(medianOf(overhead)).toBeLessThan(MEDIAN_OVERHEAD_MS);
    },
    120_000,
  );
});
