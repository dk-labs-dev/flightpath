import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { recordHookEvent } from "./support/events.js";
import { onlyRow } from "./support/rows.js";
import { makeStorageWorld } from "./support/storage.js";

import {
  createSessionWatch,
  SESSION_QUIET_LIMIT_MS,
  type SessionWatchStorage,
} from "../src/daemon/session-watch.js";
import type { DatabaseSync } from "../src/storage/sqlite.js";

afterEach(async () => {
  await runCleanups();
});

// The session-end watch, with the process probes faked: the
// decision table is what is under test — a noted process gone
// or reused ends its session, a live one protects it however
// quiet it is, and no process at all falls back to ten quiet
// minutes. The start times come back in one batch query.

const T = 1_700_000_000_000;

type HostRow = ReturnType<SessionWatchStorage["liveSessionHosts"]>[number];

interface Probes {
  exists: (pid: number) => boolean;
  startedAts: (pids: number[]) => Promise<Map<number, number>>;
}

function batchAt(startedAt: number): Probes["startedAts"] {
  return (pids) =>
    Promise.resolve(new Map(pids.map((pid) => [pid, startedAt])));
}

/** A start-times read that stays open until the test releases
 *  it: passes that must interleave with other work. */
function heldRead(): {
  startedAts: Probes["startedAts"];
  release: (times: Map<number, number>) => void;
} {
  let release: (times: Map<number, number>) => void = () => undefined;
  const startedAts = (): Promise<Map<number, number>> =>
    new Promise((resolve) => {
      release = resolve;
    });
  return { startedAts, release: (times) => release(times) };
}

/** Run one watch pass over the given rows with the given
 *  probes; returns the ended ids and where they landed. */
async function runWatch(
  rows: HostRow[],
  probes: Probes,
  now: number,
): Promise<{ ended: { id: string; at: number }[]; returned: string[] }> {
  const ended: { id: string; at: number }[] = [];
  const storage: SessionWatchStorage = {
    liveSessionHosts: () => rows,
    endSessionUnseenIfUnchanged: (session) => {
      ended.push({ id: session.id, at: session.lastSeenAt });
      return true;
    },
  };
  const watch = createSessionWatch({ storage, ...probes });
  return { ended, returned: await watch.runOnce(now) };
}

function liveRow(overrides: Partial<HostRow>): HostRow {
  return {
    id: "s1",
    lastSeenAt: T,
    hostPid: null,
    hostStartedAt: null,
    ...overrides,
  };
}

const NOTED = { hostPid: 4321, hostStartedAt: T - 60_000 };

describe("session-end watch", () => {
  it("ends a session whose noted process is gone, at its last event", async () => {
    const { ended, returned } = await runWatch(
      [liveRow(NOTED)],
      { exists: () => false, startedAts: batchAt(T - 60_000) },
      T + 60_000,
    );
    expect(returned).toEqual(["s1"]);
    expect(ended).toEqual([{ id: "s1", at: T }]);
  });

  it("ends a session whose process id was reused", async () => {
    const { ended, returned } = await runWatch(
      [liveRow(NOTED)],
      { exists: () => true, startedAts: batchAt(T - 30_000) },
      T + 60_000,
    );
    expect(returned).toEqual(["s1"]);
    expect(ended).toEqual([{ id: "s1", at: T }]);
  });

  it("keeps a session whose start time drifted by a second", async () => {
    // The boot time a start time rests on can shift by a
    // second as the clock is adjusted; a read 1 s later is
    // still the same process, not a reused id.
    const { ended, returned } = await runWatch(
      [liveRow(NOTED)],
      { exists: () => true, startedAts: batchAt(T - 60_000 + 1_000) },
      T + 60 * SESSION_QUIET_LIMIT_MS,
    );
    expect(returned).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("keeps a session whose process is running, however quiet", async () => {
    const { ended, returned } = await runWatch(
      [liveRow(NOTED)],
      { exists: () => true, startedAts: batchAt(T - 60_000) },
      T + 60 * SESSION_QUIET_LIMIT_MS,
    );
    expect(returned).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("keeps a session whose running process cannot be re-read", async () => {
    const { ended, returned } = await runWatch(
      [liveRow(NOTED)],
      { exists: () => true, startedAts: () => Promise.resolve(new Map()) },
      T + 60 * SESSION_QUIET_LIMIT_MS,
    );
    expect(returned).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("reads every noted process in one batch query", async () => {
    const calls: number[][] = [];
    const startedAts = (pids: number[]): Promise<Map<number, number>> => {
      calls.push(pids);
      return Promise.resolve(new Map(pids.map((pid) => [pid, T - 60_000])));
    };
    const { returned } = await runWatch(
      [
        liveRow(NOTED),
        liveRow({ id: "s2", hostPid: 5555, hostStartedAt: T - 60_000 }),
        liveRow({ id: "s3" }),
      ],
      { exists: () => true, startedAts },
      T + 60_000,
    );
    expect(returned).toEqual([]);
    expect(calls).toEqual([[4321, 5555]]);
  });

  it("skips a pass asked for while one is still running", async () => {
    const held = heldRead();
    const ended: string[] = [];
    const storage: SessionWatchStorage = {
      liveSessionHosts: () => [liveRow(NOTED)],
      endSessionUnseenIfUnchanged: (session) => {
        ended.push(session.id);
        return true;
      },
    };
    const watch = createSessionWatch({
      storage,
      exists: () => false,
      startedAts: held.startedAts,
    });
    const first = watch.runOnce(T + 60_000);
    await expect(watch.runOnce(T + 60_000)).resolves.toEqual([]);
    held.release(new Map());
    await expect(first).resolves.toEqual(["s1"]);
    expect(ended).toEqual(["s1"]);
  });

  it("ends a session with no process noted after ten quiet minutes", async () => {
    const probes: Probes = {
      exists: () => true,
      startedAts: () => Promise.resolve(new Map()),
    };
    const before = await runWatch(
      [liveRow({})],
      probes,
      T + SESSION_QUIET_LIMIT_MS - 1,
    );
    expect(before.returned).toEqual([]);
    const at = await runWatch(
      [liveRow({})],
      probes,
      T + SESSION_QUIET_LIMIT_MS,
    );
    expect(at.returned).toEqual(["s1"]);
    expect(at.ended).toEqual([{ id: "s1", at: T }]);
  });
});

describe("the watch against stored sessions", () => {
  function one(read: DatabaseSync, sql: string): Record<string, unknown> {
    const found = read.prepare(sql).all() as Record<string, unknown>[];
    return onlyRow(found, "a row");
  }

  const QUIET_START = {
    hook_event_name: "SessionStart",
    session_id: "s-quiet",
    cwd: "/work/app",
  };

  it("leaves a session an event reached while the pass read process times", async () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-watch-"),
    );
    const now = Date.now();
    const longAgo = now - 20 * 60_000;
    recordHookEvent(storage, QUIET_START, longAgo);
    recordHookEvent(
      storage,
      {
        hook_event_name: "SessionStart",
        session_id: "s-host",
        cwd: "/work/app",
        host_pid: 999_999,
        host_started_at: 1,
      },
      longAgo,
    );
    // The process read holds the pass open; while it is open,
    // the quiet session gets a prompt and starts a step.
    const held = heldRead();
    const watch = createSessionWatch({
      storage,
      exists: () => false,
      startedAts: held.startedAts,
    });
    const pass = watch.runOnce(now);
    recordHookEvent(
      storage,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-quiet",
        prompt_id: "p1",
        prompt: "still here",
      },
      now,
    );
    recordHookEvent(
      storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "s-quiet",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "make" },
      },
      now + 1,
    );
    held.release(new Map());
    await expect(pass).resolves.toEqual(["s-host"]);
    const session = one(
      read,
      "SELECT status FROM sessions WHERE id = 's-quiet'",
    );
    expect(session.status).toBe("live");
    const step = one(
      read,
      "SELECT outcome FROM steps WHERE session_id = 's-quiet'",
    );
    expect(step.outcome).toBe("open");
  });

  it("keeps a session with no process live while its transcript grows", async () => {
    const { storage } = makeStorageWorld(makeTempRoot("flightpath-watch-"));
    const started = Date.now() - SESSION_QUIET_LIMIT_MS - 60_000;
    recordHookEvent(storage, QUIET_START, started);
    const watch = createSessionWatch({
      storage,
      exists: () => true,
      startedAts: () => Promise.resolve(new Map()),
    });
    // Transcript growth is recorded as a touch, the way the
    // follower records it: the session is still being written,
    // so it is still heard from.
    storage.touchSession("s-quiet", Date.now());
    await expect(watch.runOnce(Date.now())).resolves.toEqual([]);
    // Growth stops, and the fallback ends the session once it
    // has been quiet past the limit since the last growth.
    await expect(
      watch.runOnce(Date.now() + SESSION_QUIET_LIMIT_MS + 1),
    ).resolves.toEqual(["s-quiet"]);
  });
});
