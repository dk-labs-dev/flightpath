import { monitorEventLoopDelay } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { callDaemon } from "./support/daemon.js";
import { hookEvent } from "./support/events.js";
import { seedRealisticSession } from "./support/seed.js";
import {
  bootDaemon,
  envelope,
  makeDataDir,
  openStream,
  postPrompt,
  readToken,
  runLateUpdatePass,
  SESSION,
  type StreamClient,
} from "./support/stream.js";
import { medianOf, percentileOf } from "./support/time.js";

import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";

// The stream's wall-clock bounds, held in the budgets
// project with the others: the hook
// acknowledgment's p90 with ten pages open, one capture
// pass over a 5,000-request session, and the capture
// measurement's ack p90. The pass's functional half — it
// reads only the changed rows, and they land — sits with
// the stream tests and carries no timing bound.

afterEach(async () => {
  await runCleanups();
});

describe("the stream's timed bounds", () => {
  it("keeps hook acknowledgment within the bound with ten pages open", async () => {
    const { daemon, dataDir } = await bootDaemon();
    const token = readToken(dataDir);
    const measure = async (rounds: number): Promise<number> => {
      const durations: number[] = [];
      for (let i = 0; i < rounds; i += 1) {
        const started = performance.now();
        const status = await postPrompt(daemon.port, token, `timed ${i}`);
        expect(status).toBe(204);
        durations.push(performance.now() - started);
      }
      return percentileOf(durations, 0.9);
    };
    const baselineP90 = await measure(40);
    const clients: StreamClient[] = [];
    for (let i = 0; i < 10; i += 1) {
      clients.push(
        await openStream(daemon.port, token, `/api/stream?session=${SESSION}`),
      );
    }
    const openP90 = await measure(40);
    for (const client of clients) client.close();
    // The bound the retention and long-session suites hold
    // the acknowledgment to; both numbers are printed.
    console.info(
      `stream ack timing: p90 ${baselineP90.toFixed(1)} ms with no pages open, ${openP90.toFixed(1)} ms with 10 pages open (bound 250 ms)`,
    );
    expect(baselineP90).toBeLessThanOrEqual(250);
    expect(openP90).toBeLessThanOrEqual(250);
  }, 120_000);

  it("runs one pass over a 5,000-request session with three late updates inside 200 ms", () => {
    const pass = runLateUpdatePass(makeDataDir());
    console.log(
      `one pass over 5,000 held requests with three late updates: ${pass.passMs.toFixed(1)} ms, 3 rows re-read (a full load took ${pass.fullMs.toFixed(1)} ms)`,
    );
    expect(pass.passMs).toBeLessThan(200);
  });
});

// The timing measurement for incremental capture, opt-in
// like the read API's timing test: a 5,000-step session, ten
// pages open on it, a live hook every 100 ms. It prints the
// hook acknowledgment's p90 and the capture pass's cost
// per pass — the event-loop lag the pass leaves on the
// daemon's only thread (the daemon runs in this process).
// Run it on a quiet machine.
describe("the stream's capture measurement", () => {
  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "keeps a live hook's acknowledgment under 250 ms at p90 on a 5,000-step session with ten pages open",
    async () => {
      const dataDir = makeDataDir();
      const base = Date.now() - 30_600_000;
      const storage = openStorage({ dataDir });
      const db = new DatabaseSync(storage.dbPath);
      try {
        db.exec("BEGIN");
        seedRealisticSession(db, { base, status: "live", openTail: true });
        db.exec("COMMIT");
      } finally {
        db.close();
        storage.close();
      }
      const { daemon } = await bootDaemon(dataDir);
      const token = readToken(dataDir);
      const path = "/api/stream?session=sess-big";
      const clients: StreamClient[] = [];
      for (let page = 0; page < 10; page += 1) {
        const client = await openStream(daemon.port, token, path);
        await client.waitFor((m) => m.some((x) => x.event === "sync"));
        clients.push(client);
      }
      const watcher = clients[0];
      if (watcher === undefined) throw new Error("no stream client");
      const lag = monitorEventLoopDelay({ resolution: 20 });
      lag.enable();
      const acks: number[] = [];
      const passes: number[] = [];
      const rounds = 30;
      for (let round = 0; round < rounds; round += 1) {
        const stepsBefore = watcher.messages.filter(
          (m) => m.event === "step",
        ).length;
        lag.reset();
        const roundStart = Date.now();
        const reply = await callDaemon(daemon.port, {
          method: "POST",
          path: "/events/hook",
          token,
          body: envelope(
            hookEvent("PreToolUse", {
              session_id: "sess-big",
              tool_name: "Bash",
              tool_use_id: `ac5-${round}`,
              tool_input: { command: `echo ${round}` },
            }),
          ),
        });
        expect(reply.status).toBe(204);
        acks.push(reply.ms);
        await watcher.waitFor(
          (m) => m.filter((x) => x.event === "step").length > stepsBefore,
          15_000,
        );
        passes.push(lag.max / 1e6);
        const elapsed = Date.now() - roundStart;
        if (elapsed < 100) {
          await new Promise((r) => setTimeout(r, 100 - elapsed));
        }
      }
      lag.disable();
      for (const client of clients) client.close();
      const ackP90 = percentileOf(acks, 0.9);
      const passMedian = medianOf(passes);
      const passMax = Math.max(...passes);
      console.info(
        `capture measurement over ${rounds} hooks on 5,000 steps with 10 pages open: ack p90 ${ackP90.toFixed(1)} ms; capture block per pass median ${passMedian.toFixed(1)} ms, max ${passMax.toFixed(1)} ms`,
      );
      expect(ackP90).toBeLessThan(250);
    },
    180_000,
  );
});
