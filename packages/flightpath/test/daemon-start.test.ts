import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLastError } from "../src/daemon/last-error.js";
import { daemonLive, pidAlive, startLockPath } from "../src/daemon/lock.js";
import { readDaemonPid } from "../src/util/fs.js";
import { runCleanups } from "./support/cleanup.js";
import { distPath, holdPorts, sleeperPid, waitFor } from "./support/daemon.js";
import { expansion, userPromptEvent } from "./support/events.js";
import { runDistJson, scratchHome } from "./support/process.js";
import { writeSettings } from "./support/settings.js";
import { countWhere } from "./support/storage.js";

// The daemon start lock's lifecycle, exercised on the built
// dist: the lock passes between separate processes, so the
// tests run the same built output those processes run.

const distHook = distPath("hook.js");
const distCommand = distPath("command.js");

afterEach(async () => {
  await runCleanups();
});

/** Run a command hook expansion; return the reason it prints. */
function commandReason(env: NodeJS.ProcessEnv, name: string): string {
  const result = runDistJson(distCommand, expansion("s1", name), env);
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { reason: string }).reason;
}

/** Hook events the daemon has stored; zero until its store exists. */
function storedCount(dataDir: string): number {
  try {
    return countWhere(dataDir, "SELECT COUNT(*) AS n FROM raw_events");
  } catch {
    return 0;
  }
}

/** A live daemon in the lock, other than the given pid. */
function otherDaemonLive(dataDir: string, otherThan: number | null): boolean {
  return daemonLive(dataDir) && readDaemonPid(dataDir) !== otherThan;
}

describe("the daemon start lock", () => {
  it("off, then start, inside the start window leaves a daemon running", async () => {
    const { env, dataDir } = scratchHome("flightpath-start-", {
      idleMs: "600000",
      stopDaemon: true,
    });
    expect(
      runDistJson(distHook, userPromptEvent("s1", "first"), env).status,
    ).toBe(0);
    await waitFor(
      () => existsSync(join(dataDir, "port")) && daemonLive(dataDir),
      15_000,
    );
    const firstPid = readDaemonPid(dataDir);

    const off = commandReason(env, "flightpath:off");
    expect(off).toContain("off in all sessions");
    await waitFor(() => firstPid === null || !pidAlive(firstPid), 15_000);

    const on = commandReason(env, "flightpath:start");
    expect(on).toContain("recording on");
    await waitFor(
      () =>
        existsSync(join(dataDir, "port")) && otherDaemonLive(dataDir, firstPid),
      15_000,
    );
  }, 60_000);

  it("delivers an event sent after an early idle exit", async () => {
    const { env, dataDir } = scratchHome("flightpath-start-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    expect(
      runDistJson(distHook, userPromptEvent("s1", "first"), env).status,
    ).toBe(0);
    await waitFor(() => storedCount(dataDir) >= 1, 15_000);
    const firstPid = readDaemonPid(dataDir);
    await waitFor(() => firstPid === null || !pidAlive(firstPid), 15_000);

    expect(
      runDistJson(distHook, userPromptEvent("s1", "second"), env).status,
    ).toBe(0);
    await waitFor(() => storedCount(dataDir) >= 2, 20_000);
  }, 60_000);

  it("never starts a second daemon while a live one holds the lock", () => {
    const { env, dataDir } = scratchHome("flightpath-start-");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "daemon.lock"), String(sleeperPid()));

    expect(
      runDistJson(distHook, userPromptEvent("s1", "held"), env).status,
    ).toBe(0);
    expect(existsSync(startLockPath(dataDir))).toBe(false);
    expect(readdirSync(join(dataDir, "buffer"))).toHaveLength(1);
  }, 30_000);

  it("keeps the start lock when the start fails", async () => {
    const { env, dataDir } = scratchHome("flightpath-start-", {
      stopDaemon: true,
    });
    const port = await holdPorts(21);
    writeSettings(dataDir, { port });

    expect(
      runDistJson(distHook, userPromptEvent("s1", "first"), env).status,
    ).toBe(0);
    await waitFor(() => readLastError(dataDir) !== null, 20_000);
    expect(existsSync(startLockPath(dataDir))).toBe(true);
  }, 60_000);
});
