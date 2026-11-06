import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bufferStats } from "../src/buffer.js";
import {
  clearLastError,
  readLastError,
  writeLastError,
} from "../src/daemon/last-error.js";
import { startLockPath } from "../src/daemon/lock.js";
import { writeBufferEvent as writeBufferFile } from "./support/buffer.js";
import { runCleanups } from "./support/cleanup.js";
import {
  distPath,
  envForDataRoot,
  holdPorts,
  makeRoot,
  readToken,
  startDaemon,
  stopDaemon,
  takeDaemonSurvived,
  waitFor,
  waitForChildExit,
  waitForDaemonReady,
} from "./support/daemon.js";
import {
  daemonPromptEnvelope,
  hookEvent,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";
import { runDistJson } from "./support/process.js";
import { writeSettings } from "./support/settings.js";
import { percentileOf } from "./support/time.js";

// Recorder health, exercised on the built dist the way
// Claude Code and the shell run it: a daemon that can't start
// writes down why, the notice warns from the buffer's age, the
// status command explains, and the buffer is bounded.

const distHook = distPath("hook.js");
const distNotice = distPath("notice.js");
const distCommand = distPath("command.js");

const WARNING =
  "● flightpath can't start its recorder · /flightpath:status for details";
const RECORDING = "● flightpath is recording";
const OFF = "● flightpath is off · /flightpath:start to turn it on";

// Removing the 20,000-file buffers takes longer than the default hook
// timeout on a Windows runner's disk.
afterEach(async () => {
  await runCleanups();
  if (takeDaemonSurvived()) {
    throw new Error("a daemon started by a test survived its test");
  }
}, 120_000);

function noticeLine(env: NodeJS.ProcessEnv): string {
  const { status, stdout } = runDistJson(
    distNotice,
    sessionStartEvent("startup", "s-health"),
    env,
  );
  expect(status).toBe(0);
  if (stdout.trim().length === 0) return "";
  return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
}

function statusLines(env: NodeJS.ProcessEnv): string {
  const { status, stdout } = runDistJson(
    distCommand,
    hookEvent("UserPromptExpansion", {
      session_id: "s-health",
      command_name: "flightpath:status",
    }),
    env,
  );
  expect(status).toBe(0);
  const parsed = JSON.parse(stdout) as { decision: string; reason: string };
  expect(parsed.decision).toBe("block");
  return parsed.reason;
}

function bufferCount(dataDir: string): number {
  try {
    return readdirSync(join(dataDir, "buffer")).length;
  } catch {
    return 0;
  }
}

function fillBuffer(dataDir: string, count: number, at: number): void {
  const buffer = join(dataDir, "buffer");
  mkdirSync(buffer, { recursive: true });
  const body = daemonPromptEnvelope("x", at, "0.0.0", "s-health");
  for (let i = 0; i < count; i++) {
    writeFileSync(join(buffer, `${at + i}-fill${i}.json`), body);
  }
}

/** Keep ensureDaemon from spawning: a fresh start lock. */
function holdStartLock(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(startLockPath(dataDir), "");
}

const promptEvent = userPromptEvent("s-health", "hello");

/** Start a daemon that cannot come up; return its recorded error. */
async function startFailingDaemon(
  root: string,
  dataDir: string,
): Promise<NonNullable<ReturnType<typeof readLastError>>> {
  const child = startDaemon(root);
  try {
    const code = await waitForChildExit(child, 20_000);
    expect(code).toBe(1);
    const error = readLastError(dataDir);
    if (error === null) throw new Error("the daemon recorded no error");
    return error;
  } finally {
    await stopDaemon(child);
  }
}

describe("recorder health", () => {
  it("writes last-error and exits when every port it would try is held", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const port = await holdPorts(21);
    writeSettings(dataDir, { port });
    const error = await startFailingDaemon(root, dataDir);
    expect(error.message).toContain("EADDRINUSE");
    // One line, and it never carries the token.
    const raw = readFileSync(join(dataDir, "last-error"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    const token = readToken(dataDir);
    expect(token.length).toBeGreaterThan(0);
    expect(raw).not.toContain(token);
  }, 60_000);

  it("writes last-error when the database cannot be opened", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    mkdirSync(join(dataDir, "flightpath.db"), { recursive: true });
    const error = await startFailingDaemon(root, dataDir);
    expect(error.message.length).toBeGreaterThan(0);
  }, 60_000);

  it("clears last-error on the next start that succeeds", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "last-error"),
      `${JSON.stringify({ at: Date.now(), message: "listen EADDRINUSE" })}\n`,
    );
    const child = startDaemon(root);
    try {
      await waitForDaemonReady(child, dataDir);
      expect(readLastError(dataDir)).toBeNull();
    } finally {
      await stopDaemon(child);
    }
  }, 60_000);

  it("warns from the notice when the buffer is stale and no daemon is live", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    writeBufferFile(dataDir, Date.now() - 10 * 60_000, "old1");
    expect(noticeLine(env)).toBe(WARNING);
  });

  it("warns even when the startup notice is turned off", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    writeSettings(dataDir, { startupNotice: false });
    writeBufferFile(dataDir, Date.now() - 10 * 60_000, "old1");
    expect(noticeLine(env)).toBe(WARNING);
  });

  it("does not warn when flightpath is off — the off line prints instead", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    // Events buffered before /flightpath:off are waiting on
    // purpose; a stale buffer under the off flag is not a
    // recorder that can't start.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "off"), "");
    writeBufferFile(dataDir, Date.now() - 10 * 60_000, "old1");
    expect(noticeLine(env)).toBe(OFF);
  });

  it("does not warn while a live daemon holds the lock", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    const child = startDaemon(root, { FLIGHTPATH_DRAIN_MS: "60000" });
    try {
      await waitForDaemonReady(child, dataDir);
      writeBufferFile(dataDir, Date.now() - 10 * 60_000, "old1");
      expect(noticeLine(env)).toContain(RECORDING);
      expect(noticeLine(env)).not.toBe(WARNING);
    } finally {
      await stopDaemon(child);
    }
  }, 60_000);

  it("does not warn on a fresh buffer, or after a normal idle shutdown", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    writeBufferFile(dataDir, Date.now() - 30_000, "fresh1");
    expect(noticeLine(env)).toContain(RECORDING);
    // A daemon that starts, drains and idles out leaves the
    // usual line behind it, never the warning.
    const child = startDaemon(root, { FLIGHTPATH_IDLE_MS: "800" });
    try {
      await waitForChildExit(child, 30_000);
      expect(bufferCount(dataDir)).toBe(0);
      expect(noticeLine(env)).toContain(RECORDING);
    } finally {
      await stopDaemon(child);
    }
  }, 90_000);

  it("buffers a hook event, goes stale, and the next start warns", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    holdStartLock(dataDir);
    const { status } = runDistJson(distHook, promptEvent, env);
    expect(status).toBe(0);
    expect(bufferCount(dataDir)).toBe(1);
    // Age the buffered event past the bound, the way two
    // minutes of a dead recorder would.
    const buffer = join(dataDir, "buffer");
    const [name] = readdirSync(buffer);
    const id = name?.split("-")[1] ?? "aged";
    renameSync(
      join(buffer, name ?? ""),
      join(buffer, `${Date.now() - 10 * 60_000}-${id}`),
    );
    expect(noticeLine(env)).toBe(WARNING);
  });

  it("status shows the buffer, the drops, the last error and its next step", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    const now = Date.now();
    writeBufferFile(dataDir, now - 12 * 60_000, "b1");
    writeBufferFile(dataDir, now - 60_000, "b2");
    writeBufferFile(dataDir, now - 30_000, "b3");
    writeFileSync(join(dataDir, "buffer-dropped"), "2\n");
    writeFileSync(
      join(dataDir, "last-error"),
      `${JSON.stringify({ at: now, message: "listen EADDRINUSE: address already in use 127.0.0.1:4747" })}\n`,
    );
    const reason = statusLines(env);
    expect(reason).toContain("buffered events: 3 waiting");
    expect(reason).toContain("oldest 12 minutes old");
    expect(reason).toContain("dropped events: about 2");
    expect(reason).toContain("last start error: listen EADDRINUSE");
    expect(reason).toContain("next step: change the daemon's port in settings");
  });

  it("status names the database file as the next step for a database error", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "last-error"),
      `${JSON.stringify({ at: Date.now(), message: "unable to open database file" })}\n`,
    );
    const reason = statusLines(env);
    expect(reason).toContain("last start error: unable to open database");
    expect(reason).toContain(
      `next step: the database file is ${join(dataDir, "flightpath.db")}`,
    );
  });

  it("drops and counts past 20,000 buffered events, and writes nothing more", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    fillBuffer(dataDir, 20_000, Date.now() - 60_000);
    holdStartLock(dataDir);
    expect(bufferCount(dataDir)).toBe(20_000);
    const first = runDistJson(distHook, promptEvent, env);
    expect(first.status).toBe(0);
    expect(bufferCount(dataDir)).toBe(20_000);
    expect(readFileSync(join(dataDir, "buffer-dropped"), "utf8").trim()).toBe(
      "1",
    );
    runDistJson(distHook, promptEvent, env);
    expect(bufferCount(dataDir)).toBe(20_000);
    expect(readFileSync(join(dataDir, "buffer-dropped"), "utf8").trim()).toBe(
      "2",
    );
    expect(statusLines(env)).toContain("dropped events: about 2");
  }, 120_000);

  it("resets the drop counter when a drain leaves the buffer empty", async () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const now = Date.now();
    writeBufferFile(dataDir, now - 1000, "d1");
    writeBufferFile(dataDir, now - 900, "d2");
    writeFileSync(join(dataDir, "buffer-dropped"), "7\n");
    const child = startDaemon(root);
    try {
      await waitFor(() => bufferCount(dataDir) === 0, 20_000);
      await waitFor(() => !existsSync(join(dataDir, "buffer-dropped")), 20_000);
    } finally {
      await stopDaemon(child);
    }
  }, 60_000);

  it("warns with 20,000 files in the buffer, and scans them within 150 ms at p90", () => {
    const { root, dataDir } = makeRoot("flightpath-health-");
    const env = envForDataRoot(root);
    fillBuffer(dataDir, 20_000, Date.now() - 10 * 60_000);
    holdStartLock(dataDir);
    const durations: number[] = [];
    const overhead: number[] = [];
    for (let i = 0; i < 25; i++) {
      const bareStarted = performance.now();
      spawnSync(process.execPath, ["-e", ""], { env });
      const bareMs = performance.now() - bareStarted;
      const started = performance.now();
      const line = noticeLine(env);
      const noticeMs = performance.now() - started;
      expect(line).toBe(WARNING);
      durations.push(noticeMs);
      overhead.push(noticeMs - bareMs);
    }
    const p90 = percentileOf(durations, 0.9);
    const overheadP90 = percentileOf(overhead, 0.9);
    console.log(
      `notice timing with 20,000 buffered files: p90 ${p90.toFixed(1)} ms, overhead p90 ${overheadP90.toFixed(1)} ms over ${durations.length} runs`,
    );
    // The bound sits on the scan, which grows with the buffer; the spawn
    // difference is printed, not bounded, because it measures the scheduler.
    const scans: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      expect(bufferStats(dataDir).count).toBe(20_000);
      scans.push(performance.now() - started);
    }
    const scanP90 = percentileOf(scans, 0.9);
    console.log(
      `buffer scan with 20,000 buffered files: p90 ${scanP90.toFixed(1)} ms over ${scans.length} runs`,
    );
    expect(scanP90).toBeLessThan(150);
    // The recording hook's drop path at a full buffer is timed
    // and printed, not bounded.
    const hookDurations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      runDistJson(distHook, promptEvent, env);
      hookDurations.push(performance.now() - started);
    }
    const hookP90 = percentileOf(hookDurations, 0.9);
    console.log(
      `recording hook timing at a full buffer: p90 ${hookP90.toFixed(1)} ms over ${hookDurations.length} runs`,
    );
  }, 180_000);

  it("keeps the first line of a nameable start error, and reads it back", () => {
    const { dataDir } = makeRoot("flightpath-health-");
    mkdirSync(dataDir, { recursive: true });
    const thrown = new Error(
      "unable to open database file\nprompt text that must not land",
    ) as Error & { code: string };
    thrown.code = "ERR_SQLITE_ERROR";
    writeLastError(dataDir, thrown);
    const raw = readFileSync(join(dataDir, "last-error"), "utf8");
    expect(raw).not.toContain("prompt text");
    const error = readLastError(dataDir);
    expect(error?.message).toBe("unable to open database file");
    expect(error?.code).toBe("ERR_SQLITE_ERROR");
    clearLastError(dataDir);
    expect(readLastError(dataDir)).toBeNull();
  });

  it("keeps a bind error's message and code", () => {
    const { dataDir } = makeRoot("flightpath-health-");
    mkdirSync(dataDir, { recursive: true });
    const thrown = new Error(
      "listen EADDRINUSE: address already in use 127.0.0.1:4747",
    ) as Error & { code: string };
    thrown.code = "EADDRINUSE";
    writeLastError(dataDir, thrown);
    const error = readLastError(dataDir);
    expect(error?.message).toContain("EADDRINUSE");
    expect(error?.code).toBe("EADDRINUSE");
  });

  it("replaces an unnameable error's message with the fixed line", () => {
    const { dataDir } = makeRoot("flightpath-health-");
    mkdirSync(dataDir, { recursive: true });
    // An error that quotes its input: its words are prompt text,
    // not an explanation, and never reach the last-error file.
    writeLastError(
      dataDir,
      new Error('could not parse: the user asked "what is a monad"'),
    );
    const raw = readFileSync(join(dataDir, "last-error"), "utf8");
    expect(raw).not.toContain("monad");
    const error = readLastError(dataDir);
    expect(error?.message).toBe("unexpected error (details in daemon.log)");
  });
});
