import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  distPath,
  envForDataRoot,
  type StartedDaemon,
} from "./support/daemon.js";
import { stopEvent } from "./support/events.js";
import { LINE_WORLD, startLineDaemon } from "./support/line-world.js";
import { seedRealisticSession } from "./support/seed.js";
import { medianOf, percentileOf } from "./support/time.js";

// The end-of-turn hook runs synchronously after every reply, so its
// start-up time is the person's wait. Its overhead is measured against
// a bare node start, round by round, on the path that prints and the
// path that stays silent; the route that answers it is measured on the
// long recorded session (ADR-0021).

const distLine = distPath("line.js");
const RUNS = 25;
// Node's own start-up is the floor; Windows pays more for each file it opens.
const OVERHEAD_P90_BOUND_MS = process.platform === "win32" ? 80 : 40;
const ROUTE_P90_BOUND_MS = 100;
const BIG_SESSION = "sess-big";
const BIG_PROMPT = "prompt-big";

const { mixed } = LINE_WORLD;

let daemon: StartedDaemon;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  daemon = await startLineDaemon((db) => {
    seedRealisticSession(db, { id: BIG_SESSION, base: Date.now() - 7_200_000 });
    db.prepare("UPDATE turns SET prompt_id = ? WHERE id = 250").run(BIG_PROMPT);
  });
  env = envForDataRoot(daemon.root);
}, 60_000);

afterAll(async () => {
  await runCleanups();
});

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** The hook's time over a bare node start, one pair per round. */
function overheadOf(promptId: string, prints: boolean): number[] {
  const input = JSON.stringify(stopEvent(mixed.id, promptId));
  const overhead: number[] = [];
  for (let round = 0; round < RUNS; round++) {
    const bare = timed(() => {
      spawnSync(process.execPath, ["-e", ""], { env });
    });
    let stdout = "";
    const hook = timed(() => {
      stdout = spawnSync(process.execPath, [distLine], {
        input,
        env,
        encoding: "utf8",
      }).stdout;
    });
    expect(stdout !== "").toBe(prints);
    overhead.push(hook - bare);
  }
  return overhead;
}

function report(label: string, values: number[]): void {
  console.log(
    `${label} on ${process.platform}: overhead median ${medianOf(values).toFixed(1)} ms, p90 ${percentileOf(values, 0.9).toFixed(1)} ms over ${values.length} runs`,
  );
}

describe("the end-of-turn hook's run time", () => {
  it("adds under the bound to a bare node start when it prints a line", () => {
    const overhead = overheadOf(mixed.fixPrompt, true);
    report("end-of-turn line, printing", overhead);
    expect(percentileOf(overhead, 0.9)).toBeLessThan(OVERHEAD_P90_BOUND_MS);
  }, 60_000);

  it("adds under the bound to a bare node start when it stays silent", () => {
    const overhead = overheadOf(mixed.cleanPrompt, false);
    report("end-of-turn line, silent", overhead);
    expect(percentileOf(overhead, 0.9)).toBeLessThan(OVERHEAD_P90_BOUND_MS);
  }, 60_000);
});

describe("the end-of-turn route's run time", () => {
  it("answers in under the bound on the 5,000-request session", async () => {
    const times: number[] = [];
    for (let round = 0; round < RUNS; round++) {
      const reply = await callDaemon(daemon.port, {
        method: "GET",
        path: `/api/sessions/${BIG_SESSION}/terminal-line?prompt=${BIG_PROMPT}`,
        token: daemon.token,
      });
      expect(JSON.parse(reply.body)).toEqual({ line: null });
      times.push(reply.ms);
    }
    console.log(
      `end-of-turn route on 5,000 requests: median ${medianOf(times).toFixed(1)} ms, p90 ${percentileOf(times, 0.9).toFixed(1)} ms over ${times.length} runs`,
    );
    expect(percentileOf(times, 0.9)).toBeLessThan(ROUTE_P90_BOUND_MS);
  }, 60_000);
});
