import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writePortFile } from "../src/daemon/server.js";
import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { runCleanups } from "./support/cleanup.js";
import {
  DAEMON_SUITE,
  callDaemon,
  distPath,
  envForDataRoot,
  makeRoot,
  readPort,
  readToken,
  requestCleanStop,
  requiredPid,
  startDaemon,
  startTestDaemon,
  stopCleanly,
  waitFor,
  waitForChildExit,
  waitForDaemonReady,
} from "./support/daemon.js";
import { daemonPromptEnvelope } from "./support/events.js";
import { firstRow } from "./support/rows.js";

// The daemon, exercised as the built child process it ships as,
// against a temporary data folder (ADR-0014 path rules via env).
const distHook = distPath("hook.js");

/** Deliver one prompt through the hook script, as Claude Code runs it. */
async function runHookPrompt(
  root: string,
  prompt: string,
  env: Record<string, string> = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const hook = spawn(process.execPath, [distHook], {
      env: envForDataRoot(root, env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    hook.on("error", reject);
    hook.on("close", () => resolvePromise());
    hook.stdin.end(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "daemon-session",
        cwd: "/work/app",
        prompt,
      }),
    );
  });
}

/** Write a daemon lock naming a process that has already
 *  exited; returns that process's pid. */
async function writeStaleLock(dataDir: string): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitForChildExit(gone);
  const pid = requiredPid(gone);
  writeFileSync(join(dataDir, "daemon.lock"), String(pid));
  return pid;
}

function countStored(dataDir: string): number {
  const storage = openStorage({ dataDir });
  try {
    return storage.countRawEvents();
  } finally {
    storage.close();
  }
}

afterEach(async () => {
  await runCleanups();
});

describe("the daemon", DAEMON_SUITE, () => {
  it("serves health with the token, and the token file is owner-only", async () => {
    const { dataDir, child, port, token } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    const health = await callDaemon(port, {
      method: "GET",
      path: "/health",
      token,
    });
    expect(health.status).toBe(200);
    const parsed = JSON.parse(health.body) as {
      version: string;
      uptime_seconds: number;
    };
    expect(parsed.version).toBe("0.0.0");
    expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);
    }
    await expect(stopCleanly(child, dataDir)).resolves.toBe(0);
  });

  it("retries the port file's rename when the file is momentarily held", () => {
    const { dataDir } = makeRoot("flightpath-daemon-test-");
    mkdirSync(dataDir, { recursive: true });
    // A rename stub that fails twice with EPERM, as a rename
    // over a file another process has open can on Windows:
    // the third try succeeds and the number lands whole.
    let calls = 0;
    const flaky = (
      from: Parameters<typeof renameSync>[0],
      to: Parameters<typeof renameSync>[1],
    ): void => {
      calls += 1;
      if (calls <= 2) {
        throw Object.assign(new Error("held"), { code: "EPERM" });
      }
      renameSync(from, to);
    };
    writePortFile(dataDir, 4799, flaky);
    expect(calls).toBe(3);
    expect(readFileSync(join(dataDir, "port"), "utf8")).toBe("4799");
    // A rename that never clears gives up after five tries.
    let tries = 0;
    const stuck = (): void => {
      tries += 1;
      throw Object.assign(new Error("held"), { code: "EBUSY" });
    };
    expect(() => writePortFile(dataDir, 4807, stuck)).toThrow("held");
    expect(tries).toBe(5);
  });

  it("sends the old settings address to the view and serves its API with no-store", async () => {
    const { child, port, token } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    const page = await callDaemon(port, { method: "GET", path: "/settings" });
    expect(page.status).toBe(200);
    expect(page.body).toContain("location.replace");
    expect(page.body).toContain("/#settings");
    expect(page.headers["cache-control"]).toBe("no-store");
    const api = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      token,
    });
    expect(api.status).toBe(200);
    expect(api.headers["cache-control"]).toBe("no-store");
    child.kill("SIGTERM");
    await waitForChildExit(child);
  });

  it("hands over when an event arrives stamped with another build's version", async () => {
    const { dataDir, child, port, token } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    // An event from its own build changes nothing.
    expect(
      (
        await callDaemon(port, {
          method: "POST",
          path: "/events/hook",
          token,
          body: daemonPromptEnvelope("same-1", Date.now()),
        })
      ).status,
    ).toBe(204);
    expect(child.exitCode).toBeNull();
    // An event from an OLDER build changes nothing either: two
    // builds can be active at once, and the older one's hook
    // keeps delivering to this daemon.
    expect(
      (
        await callDaemon(port, {
          method: "POST",
          path: "/events/hook",
          token,
          body: daemonPromptEnvelope("old-1", Date.now(), "0.0.0-alpha"),
        })
      ).status,
    ).toBe(204);
    // A handover, if one fired, is scheduled just after the
    // answer; give it its moment before reading the exit code.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(child.exitCode).toBeNull();
    // An event stamped by the next build is stored like any
    // other — and then this daemon steps aside, so the next
    // hook run starts a daemon from the new code.
    expect(
      (
        await callDaemon(port, {
          method: "POST",
          path: "/events/hook",
          token,
          body: daemonPromptEnvelope("next-1", Date.now(), "0.1.0"),
        })
      ).status,
    ).toBe(204);
    await expect(waitForChildExit(child)).resolves.toBe(0);
    expect(countStored(dataDir)).toBe(3);
  });

  it("a second start exits quietly and the first keeps serving", async () => {
    const {
      root,
      child: first,
      port,
      token,
    } = await startTestDaemon(makeRoot("flightpath-daemon-test-").root);
    const second = startDaemon(root);
    await expect(waitForChildExit(second)).resolves.toBe(0);
    const health = await callDaemon(port, {
      method: "GET",
      path: "/health",
      token,
    });
    expect(health.status).toBe(200);
    first.kill("SIGTERM");
    await waitForChildExit(first);
  });

  it("rejects requests without the token or with a foreign Host, storing nothing", async () => {
    const { dataDir, child, port, token } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    const body = daemonPromptEnvelope("rejected-1", Date.now());
    expect(
      (await callDaemon(port, { method: "POST", path: "/events/hook", body }))
        .status,
    ).toBe(401);
    expect(
      (
        await callDaemon(port, {
          method: "POST",
          path: "/events/hook",
          token: "wrong",
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await callDaemon(port, {
          method: "POST",
          path: "/events/hook",
          token,
          host: "evil.example.com",
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await callDaemon(port, { method: "GET", path: "/health" })).status,
    ).toBe(401);
    child.kill("SIGTERM");
    await waitForChildExit(child);
    expect(countStored(dataDir)).toBe(0);
  });

  it("listens on loopback only", async () => {
    const { child, port } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    const external = Object.values(networkInterfaces())
      .flat()
      .find(
        (entry) =>
          entry !== undefined && !entry.internal && entry.family === "IPv4",
      );
    if (external === undefined) {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      return; // No external interface to test against.
    }
    // Nothing may answer on the external address: a refusal, an
    // error, or silence all prove the point; an answer fails.
    const answered = await new Promise<boolean>((resolvePromise) => {
      const req = request(
        { hostname: external.address, port, method: "GET", path: "/health" },
        () => resolvePromise(true),
      );
      req.on("error", () => resolvePromise(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolvePromise(false);
      });
      req.end();
    });
    expect(answered).toBe(false);
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }, 20_000);

  it("drains buffered envelopes once each, in order, and removes the files", async () => {
    const { root, dataDir } = makeRoot("flightpath-daemon-test-");
    const buffer = join(dataDir, "buffer");
    mkdirSync(buffer, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(buffer, `${now}-first.json`),
      daemonPromptEnvelope("first", now),
    );
    writeFileSync(
      join(buffer, `${now + 1}-second.json`),
      daemonPromptEnvelope("second", now + 1),
    );
    const child = startDaemon(root);
    // Counting opens the database, and opening a database nobody
    // has created yet races the daemon's own first open, which
    // can then fail to start. Count once the daemon is serving.
    await waitForDaemonReady(child, dataDir);
    // Each 30 s wait gives a cold start or a drain pass room under load.
    await waitFor(() => countStored(dataDir) === 2, 30_000);
    await waitFor(() => !existsSync(join(buffer, `${now}-first.json`)), 30_000);
    // A file the crash window leaves behind — stored already, so
    // the next drain must not store it again.
    writeFileSync(
      join(buffer, `${now}-first.json`),
      daemonPromptEnvelope("first", now),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(countStored(dataDir)).toBe(2);
    await waitFor(() => !existsSync(join(buffer, `${now}-first.json`)), 30_000);
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }, 120_000);

  it("takes the next port when 4747 is occupied, and the hook finds it", async () => {
    const { createServer } = await import("node:http");
    // Hold 4747 if it is free. If something else already holds
    // it — a daemon of the user's own, say — that serves the same
    // purpose: the daemon must not take it either way.
    const squatter = createServer((_req, res) => res.end());
    const squatted = await new Promise<boolean>((resolvePromise) => {
      squatter.once("error", () => resolvePromise(false));
      squatter.listen(4747, "127.0.0.1", () => resolvePromise(true));
    });
    try {
      const { root, dataDir } = makeRoot("flightpath-daemon-test-");
      const child = startDaemon(root);
      await waitFor(() => existsSync(join(dataDir, "port")));
      const port = readPort(dataDir);
      expect(port).toBeGreaterThan(4747);
      // The port file names the port the daemon actually answers
      // on.
      const health = await callDaemon(port, {
        method: "GET",
        path: "/health",
        token: readToken(dataDir),
      });
      expect(health.status).toBe(200);
      // The hook script delivers through the port file.
      await runHookPrompt(root, "via the port file");
      await waitFor(() => countStored(dataDir) === 1);
      child.kill("SIGTERM");
      await waitForChildExit(child);
    } finally {
      if (squatted) squatter.close();
    }
  });

  it("leaves exactly one daemon standing when many start over a stale lock", async () => {
    const { root, dataDir } = makeRoot("flightpath-daemon-test-");
    mkdirSync(dataDir, { recursive: true });
    // A lock left behind by a process that has already exited.
    await writeStaleLock(dataDir);

    const starters = Array.from({ length: 8 }, () => startDaemon(root));
    await waitFor(
      () => starters.filter((c) => c.exitCode !== null).length === 7,
      30_000,
    );
    const running = starters.filter((c) => c.exitCode === null);
    expect(running).toHaveLength(1);
    const winner = firstRow(running, "the surviving daemon");
    // The losers leave as soon as they see the lock held; the
    // winner is still binding its port, so wait until it has
    // published the port and token before reading them.
    await waitForDaemonReady(winner, dataDir);
    expect(
      Number.parseInt(readFileSync(join(dataDir, "daemon.lock"), "utf8"), 10),
    ).toBe(winner.pid);
    const health = await callDaemon(readPort(dataDir), {
      method: "GET",
      path: "/health",
      token: readToken(dataDir),
    });
    expect(health.status).toBe(200);
    await expect(stopCleanly(winner, dataDir)).resolves.toBe(0);
  }, 60_000);

  it("starts even when a crashed takeover left its marker behind", async () => {
    const { root, dataDir } = makeRoot("flightpath-daemon-test-");
    mkdirSync(dataDir, { recursive: true });
    // A stale lock, and the takeover marker of a starter that
    // died mid-takeover ten seconds ago. Neither may block this
    // start: a leftover marker is removed, not obeyed forever.
    const stalePid = await writeStaleLock(dataDir);
    const marker = join(dataDir, "daemon.lock.takeover");
    writeFileSync(marker, String(stalePid));
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(marker, tenSecondsAgo, tenSecondsAgo);

    const child = startDaemon(root);
    await waitFor(() => existsSync(join(dataDir, "port")));
    const health = await callDaemon(readPort(dataDir), {
      method: "GET",
      path: "/health",
      token: readToken(dataDir),
    });
    expect(health.status).toBe(200);
    await expect(stopCleanly(child, dataDir)).resolves.toBe(0);
  });

  it("answers 500 and keeps serving when storing an event fails", async () => {
    const { root, dataDir } = makeRoot("flightpath-daemon-test-");
    // A database whose inserts fail: a trigger that aborts every
    // raw_events insert, standing in for a disk that errors.
    const prepared = openStorage({ dataDir });
    prepared.close();
    const db = new DatabaseSync(join(dataDir, "flightpath.db"));
    db.exec(
      "CREATE TRIGGER fail_raw_insert BEFORE INSERT ON raw_events BEGIN SELECT RAISE(ABORT, 'insert blocked'); END",
    );
    db.close();

    const child = startDaemon(root);
    await waitFor(() => existsSync(join(dataDir, "port")));
    const port = readPort(dataDir);
    const token = readToken(dataDir);
    const reply = await callDaemon(port, {
      method: "POST",
      path: "/events/hook",
      token,
      body: daemonPromptEnvelope("will-fail", Date.now()),
    });
    expect(reply.status).toBe(500);
    const health = await callDaemon(port, {
      method: "GET",
      path: "/health",
      token,
    });
    expect(health.status).toBe(200);
    await expect(stopCleanly(child, dataDir)).resolves.toBe(0);
  });

  it("stops on a request to the stop route only with the token, exiting cleanly and releasing the lock", async () => {
    const { dataDir, child, port, token } = await startTestDaemon(
      makeRoot("flightpath-daemon-test-").root,
    );
    const refused = await callDaemon(port, {
      method: "POST",
      path: "/api/stop",
    });
    expect(refused.status).toBe(401);
    expect(child.exitCode).toBeNull();
    const accepted = await callDaemon(port, {
      method: "POST",
      path: "/api/stop",
      token,
    });
    expect(accepted.status).toBe(204);
    await expect(waitForChildExit(child)).resolves.toBe(0);
    expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
  });

  it("exits when idle, releases the lock, and the next event restarts it through the hook", async () => {
    const { root, dataDir } = makeRoot("flightpath-daemon-test-");
    const child = startDaemon(root, { FLIGHTPATH_IDLE_MS: "700" });
    await waitFor(() => existsSync(join(dataDir, "port")));
    await expect(waitForChildExit(child)).resolves.toBe(0);
    expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);

    // Nothing is listening now: the hook buffers and starts a
    // daemon, which drains the buffer.
    await runHookPrompt(root, "restart me", {
      FLIGHTPATH_DRAIN_MS: "150",
      FLIGHTPATH_IDLE_MS: "5000",
    });
    await waitFor(() => countStored(dataDir) === 1, 20_000);
    // The restarted daemon is this test's responsibility: stop it
    // by the pid in its lock rather than leaving it to idle out.
    const restartedPid = Number.parseInt(
      readFileSync(join(dataDir, "daemon.lock"), "utf8"),
      10,
    );
    await requestCleanStop(restartedPid, dataDir);
    await waitFor(() => !existsSync(join(dataDir, "daemon.lock")), 10_000);
  }, 30_000);
});
