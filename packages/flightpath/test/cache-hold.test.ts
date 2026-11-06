import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon/server.js";
import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import { waitFor } from "./support/daemon.js";
import { seedRequestExact, seedSession } from "./support/seed.js";

// When the daemon exits, over a fake clock: its idle limit, and the
// caches of the live sessions it holds on for. The clock fakes only
// dates and intervals, so the daemon's sockets keep running.

const MIN = 60_000;
const START = Date.UTC(2026, 10, 5, 14, 0, 0);
const SESSION = "sess-hold";

afterEach(async () => {
  vi.useRealTimers();
  await runCleanups();
});

interface Write {
  cache: "1h" | "5m";
  endsAt: number;
}

/** A main request that finished at `endsAt` and wrote a cache. */
function seedWrite(db: DatabaseSync, id: number, write: Write): void {
  seedRequestExact(db, {
    id,
    sessionId: SESSION,
    startedAt: write.endsAt - 2_000,
    durationMs: 2_000,
    input: 100,
    cacheRead: 2_000,
    ...(write.cache === "1h"
      ? { cacheWrite1h: 7_900 }
      : { cacheWrite5m: 7_900 }),
  });
}

/** A data folder holding one session with the given writes; the
 * daemon starts at START, which is also its last event. */
async function startWith(
  status: "live" | "ended",
  writes: Write[],
  settings: { idleShutdownMinutes: number } | null = null,
): Promise<string> {
  const dataDir = makeTempRoot("flightpath-hold-");
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  seedSession(db, {
    id: SESSION,
    status,
    firstSeenAt: START - 60 * MIN,
    lastSeenAt: START,
    hostPid: process.pid,
  });
  writes.forEach((write, index) => seedWrite(db, index + 1, write));
  db.close();
  storage.close();
  if (settings !== null) {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(settings));
  }
  vi.useFakeTimers({
    now: START,
    toFake: ["Date", "setInterval", "clearInterval"],
  });
  const daemon = await startDaemon({ dataDir, version: "0.0.0" });
  if (daemon === null) throw new Error("the daemon did not start");
  registerCleanup(() => daemon.shutdown("signal"));
  return dataDir;
}

/** Move the clock to this many minutes after the daemon's start. */
function atMinute(minutes: number): void {
  vi.setSystemTime(START + minutes * MIN);
  vi.advanceTimersByTime(1_000);
}

function isRunning(dataDir: string): boolean {
  return existsSync(join(dataDir, "daemon.lock"));
}

async function stillUpAt(dataDir: string, minutes: number): Promise<boolean> {
  atMinute(minutes);
  // A shutdown begun by that tick has released the lock within this wait.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return isRunning(dataDir);
}

async function exitedBy(dataDir: string, minutes: number): Promise<void> {
  atMinute(minutes);
  await waitFor(() => !isRunning(dataDir));
}

describe("the daemon's idle deadline with a live session's cache", () => {
  it("stays up past the idle limit for a one-hour cache, then exits after it expires", async () => {
    const dataDir = await startWith("live", [{ cache: "1h", endsAt: START }]);

    expect(await stillUpAt(dataDir, 55)).toBe(true);
    await exitedBy(dataDir, 62);
  });

  it("exits at the idle limit when the cache lasts five minutes", async () => {
    const dataDir = await startWith("live", [{ cache: "5m", endsAt: START }]);

    expect(await stillUpAt(dataDir, 29)).toBe(true);
    await exitedBy(dataDir, 31);
  });

  it("is not held by a session that has ended", async () => {
    const dataDir = await startWith("ended", [{ cache: "1h", endsAt: START }]);

    expect(await stillUpAt(dataDir, 29)).toBe(true);
    await exitedBy(dataDir, 31);
  });

  it("is never held more than 65 minutes after the last event", async () => {
    const dataDir = await startWith("live", [
      { cache: "1h", endsAt: START + 10 * 60 * MIN },
    ]);

    expect(await stillUpAt(dataDir, 64)).toBe(true);
    await exitedBy(dataDir, 66);
  });

  it("follows the lifetime of the latest request when the user changed it", async () => {
    const dataDir = await startWith(
      "live",
      [
        { cache: "1h", endsAt: START - 10 * MIN },
        { cache: "5m", endsAt: START },
      ],
      { idleShutdownMinutes: 5 },
    );

    expect(await stillUpAt(dataDir, 6)).toBe(true);
    await exitedBy(dataDir, 9);
  });
});
