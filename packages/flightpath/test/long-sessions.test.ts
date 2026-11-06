import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  expectAcksWithinBudget,
  makeRoot,
  measureAcks,
  readPort,
  readToken,
  requiredPid,
  startDaemon,
  waitFor,
  waitForChildExit,
} from "./support/daemon.js";
import {
  sequencedHookEnvelope,
  transcriptAssistantLine,
  transcriptUserLine,
} from "./support/events.js";
import { countWhere, trackStorage } from "./support/storage.js";
import { medianOf } from "./support/time.js";

import { createTranscriptFollower } from "../src/transcripts/index.js";
import { defaultSettings, type Settings } from "../src/settings/index.js";
import { openStorage, type Storage } from "../src/storage/index.js";

// Long sessions, measured: a transcript in the hundreds of
// megabytes is read in chunks (the daemon's memory stays
// bounded, hook events are acknowledged while it reads), a
// kill mid-read costs nothing, applying an event costs the
// same at step 5,000 as at step 50, and the start-time import
// never delays the first event. Daemon tests run the built
// dist; fixtures are generated here from small hand-written
// entry templates and deleted afterwards. Roots for the big
// tests live under FLIGHTPATH_BIG_TEST_DIR when it is set
// (some sandboxes give /tmp only a small tmpfs).

const T0 = Date.parse("2026-10-24T10:00:00.000Z");

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 50,
  cache_creation: {
    ephemeral_5m_input_tokens: 40,
    ephemeral_1h_input_tokens: 10,
  },
};

afterEach(async () => {
  await runCleanups();
});

function rssMb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Write a transcript of `pairs` prompt/request pairs for one
 * session, from the two entry templates below, in blocks.
 * Each pair is about 2 KB, so 100,000 pairs is about 200 MB.
 */
function generateTranscript(
  path: string,
  sessionId: string,
  pairs: number,
): void {
  const pad = "x".repeat(1700);
  const blockPairs = 1000;
  let written = 0;
  while (written < pairs) {
    const inBlock = Math.min(blockPairs, pairs - written);
    const lines: string[] = [];
    for (let i = 0; i < inBlock; i += 1) {
      const n = written + i;
      const at = T0 + n * 2000;
      lines.push(
        transcriptUserLine(at, {
          sessionId,
          uuid: `u-${n}`,
          promptId: `p-${n}`,
          content: `prompt ${n}`,
        }),
      );
      lines.push(
        transcriptAssistantLine(at + 1000, `req-${n}`, USAGE, {
          sessionId,
          uuid: `a-${n}`,
          content: [{ type: "text", text: `working ${n} ${pad}` }],
        }),
      );
    }
    appendFileSync(path, lines.join("\n") + "\n");
    written += inBlock;
  }
}

describe("long sessions", () => {
  // One memory-and-acknowledgment read at two sizes: a small
  // one runs in the default suite; the 200 MB measurement runs
  // only when FLIGHTPATH_LONG_TESTS=1, and prints its numbers.
  async function memoryRead(pairs: number, boundMb: number): Promise<void> {
    const { root, dataDir } = makeRoot("flightpath-long-", { big: true });
    const sessionId = "sess-big";
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    generateTranscript(transcriptPath, sessionId, pairs);

    const child = startDaemon(root, {}, { idleMs: "600000" });
    await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
    const port = readPort(dataDir);
    const token = readToken(dataDir);
    await new Promise((r) => setTimeout(r, 300));
    const baseline = rssMb(requiredPid(child));

    // The first event starts the follow; its acknowledgment
    // must not wait for the read.
    const trigger = await callDaemon(port, {
      method: "POST",
      path: "/events/hook",
      token: token,
      body: sequencedHookEnvelope("long", {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: "/work/app",
        prompt_id: "p-0",
        prompt: "prompt 0",
        transcript_path: transcriptPath,
      }),
    });
    expect(trigger.status).toBe(204);
    let peak = baseline;
    const sampler = setInterval(() => {
      const rss = rssMb(requiredPid(child));
      if (rss !== null && (peak === null || rss > peak)) peak = rss;
    }, 100);

    // While the read runs, other events are acknowledged
    // within 250 ms, and the first one's step is written
    // before the read finishes.
    const ackBodies = [0, 1, 2, 3, 4].map((i) =>
      sequencedHookEnvelope("long", {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        cwd: "/work/app",
        prompt_id: "p-0",
        tool_name: "Read",
        tool_use_id: i === 0 ? "toolu_mid" : `toolu_probe_${i}`,
        tool_input: { file_path: "/work/app/a.ts" },
        transcript_path: transcriptPath,
      }),
    );
    const ackLabel = `ack while a ${pairs}-pair read runs`;
    const ackSamples = await measureAcks(
      port,
      { method: "POST", path: "/events/hook", token: token },
      ackBodies,
      ackLabel,
    );
    expectAcksWithinBudget(ackSamples, ackLabel);
    await waitFor(
      () =>
        countWhere(
          dataDir,
          "SELECT COUNT(*) AS n FROM steps WHERE session_id = 'sess-big' AND tool_use_id = 'toolu_mid'",
        ) === 1,
      10_000,
    );
    const requestsSoFar = countWhere(
      dataDir,
      "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'sess-big'",
    );
    expect(requestsSoFar).toBeLessThan(pairs);

    // The read completes, with the daemon's resident memory
    // staying under the bound above its idle baseline.
    try {
      await waitFor(
        () =>
          countWhere(
            dataDir,
            "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'sess-big'",
          ) === pairs,
        600_000,
      );
    } finally {
      clearInterval(sampler);
    }
    expect(
      countWhere(
        dataDir,
        "SELECT COUNT(*) AS n FROM context_samples WHERE session_id = 'sess-big'",
      ),
    ).toBe(pairs);
    if (baseline !== null && peak !== null) {
      console.log(
        `${pairs} pairs read: idle RSS ${baseline.toFixed(1)} MB, peak ${peak.toFixed(1)} MB`,
      );
      expect(peak - baseline).toBeLessThan(boundMb);
    }
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }

  it("reads a 12 MB transcript with bounded memory, acknowledging events while it reads", async () => {
    await memoryRead(6_000, 75);
  }, 300_000);

  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "reads a 200 MB transcript with bounded memory, acknowledging events while it reads",
    async () => {
      await memoryRead(100_000, 150);
    },
    900_000,
  );

  it("a daemon killed mid-read restarts to exactly the clean read's rows", async () => {
    const pairs = 30_000;
    async function run(killMidRead: boolean): Promise<{
      requests: number;
      samples: number;
      raw: number;
    }> {
      const { root, dataDir } = makeRoot("flightpath-long-", { big: true });
      const sessionId = "sess-kill";
      const transcriptPath = join(root, `${sessionId}.jsonl`);
      generateTranscript(transcriptPath, sessionId, pairs);
      const trigger = (): Promise<{ status: number; ms: number }> =>
        callDaemon(readPort(dataDir), {
          method: "POST",
          path: "/events/hook",
          token: readToken(dataDir),
          body: sequencedHookEnvelope("long", {
            hook_event_name: "UserPromptSubmit",
            session_id: sessionId,
            cwd: "/work/app",
            prompt_id: "p-0",
            prompt: "prompt 0",
            transcript_path: transcriptPath,
          }),
        });
      let child = startDaemon(root, {}, { idleMs: "600000" });
      await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
      await trigger();
      if (killMidRead) {
        // The mid-read point is a condition, and its deadline
        // is sized to the read it waits on: 4,000 of 30,000
        // pairs arrived inside two minutes on a quiet machine.
        await waitFor(
          () =>
            countWhere(
              dataDir,
              "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'sess-kill'",
            ) >= 4000,
          600_000,
        );
        child.kill("SIGKILL");
        await waitForChildExit(child);
        // The port file outlives the killed daemon; remove it
        // so waiting for it means the new daemon is listening.
        rmSync(join(dataDir, "port"), { force: true });
        child = startDaemon(root, {}, { idleMs: "600000" });
        await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
        await trigger();
      }
      // The deadline is sized to the read, not to a speed
      // claim: 30,000 pairs took ~100 s a run on a quiet
      // machine, and no assertion here reads the duration —
      // the wait still fails the test if the rows never arrive.
      await waitFor(
        () =>
          countWhere(
            dataDir,
            "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'sess-kill'",
          ) === pairs,
        1_200_000,
      );
      const result = {
        requests: countWhere(
          dataDir,
          "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'sess-kill'",
        ),
        samples: countWhere(
          dataDir,
          "SELECT COUNT(*) AS n FROM context_samples WHERE session_id = 'sess-kill'",
        ),
        raw: countWhere(
          dataDir,
          "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = 'sess-kill' AND source = 'transcript'",
        ),
      };
      child.kill("SIGTERM");
      await waitForChildExit(child);
      // Each run's root is the largest thing on disk in this
      // suite (a 60 MB transcript and its database); removing
      // it here keeps one run's worth on disk at a time
      // instead of two until the file's cleanup runs.
      rmSync(root, { recursive: true, force: true });
      return result;
    }

    const killed = await run(true);
    const clean = await run(false);
    expect(killed).toEqual(clean);
    expect(clean.requests).toBe(pairs);
    // The timeout is a container for the two runs: every
    // wait inside waits for its read to land and is sized
    // to that read, so a wait always expires before this does.
  }, 3_900_000);

  // The pending-tool chunk the next three tests share: req-1's
  // tool id is pushed onto the pending list, then req-2's commit
  // fails, so the chunk rolls back and the next follow reads it
  // again from the same offset.
  interface PendingWorld {
    follower: ReturnType<typeof createTranscriptFollower>;
    mainPath: string;
    closeCalls: () => number;
  }

  function makePendingWorld(): PendingWorld {
    const root = makeTempRoot("flightpath-pending-");
    const dataDir = join(root, "data");
    const configDir = join(root, "claude");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const storage = trackStorage(openStorage({ dataDir }));
    let closeCalls = 0;
    let failures = 1;
    const flaky: Storage = {
      ...storage,
      upsertRequest: (input) => {
        if (input.requestId === "req-2" && failures > 0) {
          failures -= 1;
          throw new Error("storage is down");
        }
        return storage.upsertRequest(input);
      },
      closeStepInterrupted: (sessionId, toolUseId, at) => {
        closeCalls += 1;
        return storage.closeStepInterrupted(sessionId, toolUseId, at);
      },
    };
    const settings: Settings = { ...defaultSettings() };
    const follower = createTranscriptFollower(flaky, {
      dataDir,
      configDir,
      settings: () => settings,
    });
    // The session exists, as a hook-recorded session would.
    storage.insertEnvelopeJourney(
      {
        source: "hook",
        sessionId: "sess-live",
        receivedAt: T0,
        redactionVersion: 1,
        envelopeId: "env-pending-seed",
        body: "{}",
      },
      {
        hook_event_name: "SessionStart",
        session_id: "sess-live",
        source: "startup",
        cwd: "/work/app",
      },
    );
    const mainPath = join(root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      [
        transcriptUserLine(T0 + 1000, {
          sessionId: "sess-live",
          uuid: "u-1",
          promptId: "p-1",
          content: "go",
        }),
        transcriptAssistantLine(T0 + 2000, "req-1", USAGE, {
          sessionId: "sess-live",
          uuid: "a-1",
          content: [
            { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
          ],
        }),
        transcriptAssistantLine(T0 + 3000, "req-2", USAGE, {
          sessionId: "sess-live",
          uuid: "a-2",
          content: [{ type: "text", text: "done" }],
        }),
      ].join("\n") + "\n",
    );
    return { follower, mainPath, closeCalls: () => closeCalls };
  }

  async function failFirstFollow(world: PendingWorld): Promise<void> {
    await expect(
      world.follower.follow("sess-live", world.mainPath),
    ).rejects.toThrow("storage is down");
  }

  it("a failed commit rejects the follow with the storage error", async () => {
    const world = makePendingWorld();
    await expect(
      world.follower.follow("sess-live", world.mainPath),
    ).rejects.toThrow("storage is down");
  });

  it("re-reading a chunk after a failed commit stores both requests", async () => {
    const world = makePendingWorld();
    // The first follow fails on req-2, after req-1's tool id was
    // pushed onto the pending list; the chunk rolls back and is
    // read again by the next follow.
    await failFirstFollow(world);
    const second = await world.follower.follow("sess-live", world.mainPath);
    expect(second.requests).toBe(2);
  });

  it("re-reading a chunk after a failed commit closes a pending tool exactly once", async () => {
    const world = makePendingWorld();
    await failFirstFollow(world);
    await world.follower.follow("sess-live", world.mainPath);
    // The interrupt marker now closes the pending tool: exactly
    // one close call for toolu_a, not two — a re-read that kept
    // the first read's pending entry would close it twice.
    appendFileSync(
      world.mainPath,
      transcriptUserLine(T0 + 4000, {
        sessionId: "sess-live",
        uuid: "u-2",
        content: "[Request interrupted by user]",
      }) + "\n",
    );
    await world.follower.follow("sess-live", world.mainPath);
    expect(world.closeCalls()).toBe(1);
  });

  it("applies a turn-end event at 5,000 steps as fast as at the start", async () => {
    const root = makeTempRoot("flightpath-flat-");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const storage = openStorage({ dataDir });
    const apply = (event: Record<string, unknown>, at: number): number => {
      const started = performance.now();
      storage.insertEnvelopeJourney(
        {
          source: "hook",
          sessionId: event.session_id as string,
          receivedAt: at,
          redactionVersion: 1,
          envelopeId: `env-flat-${event.session_id as string}-${at}`,
          body: JSON.stringify({ event }),
        },
        event,
      );
      return performance.now() - started;
    };
    apply(
      {
        hook_event_name: "SessionStart",
        session_id: "sess-flat",
        source: "startup",
        cwd: "/work/app",
      },
      T0,
    );
    apply(
      {
        hook_event_name: "SessionStart",
        session_id: "sess-warm",
        source: "startup",
        cwd: "/work/app",
      },
      T0 - 20_000_000,
    );
    const early: number[] = [];
    const late: number[] = [];
    const turns = 500;
    const stepsPerTurn = 10;
    // One full session as a warmup, so the measured session runs
    // on warm code and a settled allocator; the envelopes of the
    // warmup are stamped well before the measured session, so
    // they never interleave with its rows.
    for (let turn = 0; turn < turns; turn += 1) {
      const base = T0 - 10_000_000 + turn * (stepsPerTurn + 2) * 1000;
      apply(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-warm",
          prompt_id: `w-${turn}`,
          prompt: `warm ${turn}`,
        },
        base,
      );
      for (let step = 0; step < stepsPerTurn; step += 1) {
        apply(
          {
            hook_event_name: "PreToolUse",
            session_id: "sess-warm",
            prompt_id: `w-${turn}`,
            tool_name: "Read",
            tool_use_id: `warm_${turn}_${step}`,
            tool_input: { file_path: "/work/app/a.ts" },
          },
          base + (step + 1) * 1000,
        );
      }
    }
    for (let turn = 0; turn < turns; turn += 1) {
      const base = T0 + 1000 + turn * (stepsPerTurn + 2) * 1000;
      // The prompt that ends the previous turn (closing its ten
      // open steps) is the turn-end cost this measures.
      const ms = apply(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-flat",
          prompt_id: `p-${turn}`,
          prompt: `prompt ${turn}`,
        },
        base,
      );
      if (turn >= 10 && turn < 30) early.push(ms);
      if (turn >= turns - 20) late.push(ms);
      for (let step = 0; step < stepsPerTurn; step += 1) {
        apply(
          {
            hook_event_name: "PreToolUse",
            session_id: "sess-flat",
            prompt_id: `p-${turn}`,
            tool_name: "Read",
            tool_use_id: `toolu_${turn}_${step}`,
            tool_input: { file_path: "/work/app/a.ts" },
          },
          base + (step + 1) * 1000,
        );
      }
    }
    const stepCount = countWhere(
      dataDir,
      "SELECT COUNT(*) AS n FROM steps WHERE session_id = 'sess-flat'",
    );
    expect(stepCount).toBe(turns * stepsPerTurn);
    const earlyMedian = medianOf(early);
    const lateMedian = medianOf(late);
    console.log(
      `turn-end apply: early median ${earlyMedian.toFixed(2)} ms, at 5,000 steps ${lateMedian.toFixed(2)} ms`,
    );
    // +0.5 ms: at sub-millisecond medians a bare 2x sits inside scheduling noise.
    expect(lateMedian).toBeLessThanOrEqual(earlyMedian * 2 + 0.5);
    storage.close();
  }, 180_000); // building the 5,000-step fixture, and its warmup, takes over a minute on a Windows runner's disk

  it("the start-time import does not delay the first acknowledged event", async () => {
    const { root, dataDir } = makeRoot("flightpath-long-", { big: true });
    const configDir = join(root, "claude");
    const projectDir = join(configDir, "projects", "-work-app");
    mkdirSync(projectDir, { recursive: true });

    // A recorded session first, in /work/app, so the
    // project is one Flightpath has recorded in before.
    let child = startDaemon(
      root,
      { CLAUDE_CONFIG_DIR: configDir },
      { idleMs: "600000" },
    );
    await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
    const first = await callDaemon(readPort(dataDir), {
      method: "POST",
      path: "/events/hook",
      token: readToken(dataDir),
      body: sequencedHookEnvelope("long", {
        hook_event_name: "SessionStart",
        session_id: "live-1",
        source: "startup",
        cwd: "/work/app",
      }),
    });
    expect(first.status).toBe(204);
    child.kill("SIGTERM");
    await waitForChildExit(child);

    // A transcript-only session appears in that project,
    // modified after Flightpath was installed.
    generateTranscript(
      join(projectDir, "imported-1.jsonl"),
      "imported-1",
      10_000,
    );

    // Then the daemon starts with the import pending; the
    // first events are still acknowledged within 250 ms,
    // with the import still running when they return — and
    // the import completes in the background. (The port
    // file from the first run is removed first, so waiting
    // for it means this daemon is listening.)
    rmSync(join(dataDir, "port"), { force: true });
    child = startDaemon(
      root,
      { CLAUDE_CONFIG_DIR: configDir },
      { idleMs: "600000" },
    );
    await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
    const ackBodies = [0, 1, 2, 3, 4].map((i) =>
      sequencedHookEnvelope("long", {
        hook_event_name: "UserPromptSubmit",
        session_id: "live-1",
        cwd: "/work/app",
        prompt_id: `p-x${i}`,
        prompt: "hello again",
      }),
    );
    const ackSamples = await measureAcks(
      readPort(dataDir),
      {
        method: "POST",
        path: "/events/hook",
        token: readToken(dataDir),
      },
      ackBodies,
      "ack while the start-time import runs",
    );
    expectAcksWithinBudget(ackSamples, "ack while the start-time import runs");
    expect(
      countWhere(
        dataDir,
        "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'imported-1'",
      ),
    ).toBeLessThan(10_000);
    // The import's own wait is sized to its work: 10,000
    // pairs took ~35 s a run on a quiet machine; no
    // duration is asserted.
    await waitFor(
      () =>
        countWhere(
          dataDir,
          "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'imported-1'",
        ) === 10_000,
      600_000,
    );
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }, 900_000);
});
