import type { ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeLastError } from "../src/daemon/last-error.js";
import { runCleanups } from "./support/cleanup.js";
import {
  DAEMON_SUITE,
  callDaemonJson,
  makeRoot,
  readPort,
  readToken,
  startDaemon,
  stopDaemon,
  takeDaemonSurvived,
  waitFor,
  waitForDaemonReady,
} from "./support/daemon.js";
import { writeBufferEvent } from "./support/buffer.js";

// GET /api/health and the stream's health message report the
// same reading: the daemon's state, what is waiting, what was
// dropped, and the last start error with its class. The
// readings come from the data folder's files — the last-error
// file a failed start writes is the contract, so the test
// writes it with the daemon's own writer.

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    await stopDaemon(child);
  }
  await runCleanups();
  if (takeDaemonSurvived()) {
    throw new Error("a daemon started by a test survived its test");
  }
});

function bindError(): Error {
  return Object.assign(
    new Error("listen EADDRINUSE: address already in use 127.0.0.1:4747"),
    { code: "EADDRINUSE" },
  );
}

async function startQuietDaemon(root: string, dataDir: string) {
  // A slow drain and a long idle: what the test seeds into the
  // buffer stays seeded until the test has read it back.
  const child = startDaemon(root, {
    FLIGHTPATH_DRAIN_MS: "3600000",
    FLIGHTPATH_IDLE_MS: "3600000",
  });
  children.push(child);
  await waitForDaemonReady(child, dataDir);
  return { port: readPort(dataDir), token: readToken(dataDir) };
}

/** Seed the buffer until the seeding survives: the daemon's
 * one start-up drain runs after the port file appears, so a
 * file written in that window is drained before the test can
 * read it back. Seed, check the files are still there after
 * a beat, and seed again — what persists is past the drain. */
async function seedBufferUntilStable(
  dataDir: string,
  seeds: { receivedAt: number; id: string }[],
): Promise<void> {
  const buffer = join(dataDir, "buffer");
  await waitFor(
    async () => {
      for (const seed of seeds) {
        writeBufferEvent(dataDir, seed.receivedAt, seed.id, "s-health-api");
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return seeds.every((seed) =>
        existsSync(join(buffer, `${seed.receivedAt}-${seed.id}.json`)),
      );
    },
    20_000,
    100,
  );
}

async function firstHealthFrame(
  port: number,
  token: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    headers: { "x-flightpath-token": token },
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("the stream has no body");
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } finally {
    controller.abort();
  }
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) throw new Error("no health frame arrived");
  return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
}

// A cold start's ready wait is 30 s, so the harness timeout must not be shorter.
describe("recorder health over HTTP", DAEMON_SUITE, () => {
  it("needs the token, and reports a clean daemon clean", async () => {
    const made = makeRoot("flightpath-health-api-");
    const { port, token } = await startQuietDaemon(made.root, made.dataDir);

    const rejected = await callDaemonJson(port, "GET", "/api/health", null);
    expect(rejected.status).toBe(401);

    const { status, json } = await callDaemonJson(
      port,
      "GET",
      "/api/health",
      token,
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      state: "running",
      buffered: 0,
      oldestAt: null,
      dropped: 0,
      lastError: null,
      problem: null,
    });
  });

  it("reports the waiting, the dropped and the last error, classed", async () => {
    const made = makeRoot("flightpath-health-api-");
    const { port, token } = await startQuietDaemon(made.root, made.dataDir);
    const now = Date.now();
    await seedBufferUntilStable(made.dataDir, [
      { receivedAt: now - 9 * 60_000, id: "older" },
      { receivedAt: now - 60_000, id: "newer" },
    ]);
    writeFileSync(join(made.dataDir, "buffer-dropped"), "5\n");
    writeLastError(made.dataDir, bindError());

    const { status, json } = await callDaemonJson(
      port,
      "GET",
      "/api/health",
      token,
    );
    expect(status).toBe(200);
    expect(json.buffered).toBe(2);
    expect(json.oldestAt).toBe(now - 9 * 60_000);
    expect(json.dropped).toBe(5);
    expect(json.lastError).toMatchObject({
      message: "listen EADDRINUSE: address already in use 127.0.0.1:4747",
      code: "EADDRINUSE",
    });
    expect(json.problem).toEqual({
      kind: "port",
      port: 4747,
      reason: "in-use",
    });
  });

  it("classes a port that isn't allowed as not-allowed, not in use", async () => {
    const made = makeRoot("flightpath-health-api-");
    const { port, token } = await startQuietDaemon(made.root, made.dataDir);
    writeLastError(
      made.dataDir,
      Object.assign(
        new Error("listen EACCES: permission denied 127.0.0.1:80"),
        { code: "EACCES" },
      ),
    );

    const { status, json } = await callDaemonJson(
      port,
      "GET",
      "/api/health",
      token,
    );
    expect(status).toBe(200);
    expect(json.problem).toEqual({
      kind: "port",
      port: 80,
      reason: "not-allowed",
    });
  });

  it("classes a database failure as a database problem", async () => {
    const made = makeRoot("flightpath-health-api-");
    const { port, token } = await startQuietDaemon(made.root, made.dataDir);
    writeLastError(
      made.dataDir,
      Object.assign(new Error("database disk image is malformed"), {
        code: "ERR_SQLITE_ERROR",
      }),
    );

    const { status, json } = await callDaemonJson(
      port,
      "GET",
      "/api/health",
      token,
    );
    expect(status).toBe(200);
    expect(json.problem).toEqual({
      kind: "database",
      path: join(made.dataDir, "flightpath.db"),
    });
  });

  it("opens the stream with the same reading, class included", async () => {
    const made = makeRoot("flightpath-health-api-");
    const { port, token } = await startQuietDaemon(made.root, made.dataDir);
    writeLastError(made.dataDir, bindError());

    const frame = await firstHealthFrame(port, token);
    expect(frame.lastError).toMatchObject({ code: "EADDRINUSE" });
    expect(frame.problem).toEqual({
      kind: "port",
      port: 4747,
      reason: "in-use",
    });
  });
});
