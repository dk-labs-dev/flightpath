import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { registerCleanup, runCleanups } from "./support/cleanup.js";
import {
  distPath,
  makeRoot,
  startTestDaemon,
  takeDaemonSurvived,
  waitForDaemonReady,
} from "./support/daemon.js";
import { scratchHome } from "./support/process.js";

describe("runCleanups", () => {
  it("runs every cleanup even when one throws, then rethrows", async () => {
    const ran: string[] = [];
    registerCleanup(() => {
      ran.push("first registered");
    });
    registerCleanup(() => {
      ran.push("throwing");
      throw new Error("cleanup failed");
    });
    registerCleanup(() => {
      ran.push("last registered");
    });

    await expect(runCleanups()).rejects.toThrow("cleanup failed");
    // Last in, first out — and the throw strands neither neighbour.
    expect(ran).toEqual(["last registered", "throwing", "first registered"]);
  });

  it("rethrows the first error thrown, not the last", async () => {
    registerCleanup(() => {
      throw new Error("registered first, runs last");
    });
    registerCleanup(() => {
      throw new Error("registered last, runs first");
    });

    await expect(runCleanups()).rejects.toThrow("registered last, runs first");
  });

  it("resolves when nothing is registered", async () => {
    await expect(runCleanups()).resolves.toBeUndefined();
  });

  it("kills a daemon a test left running and returns only once it has exited", async () => {
    const { child } = await startTestDaemon(makeRoot().root);

    await runCleanups();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(takeDaemonSurvived()).toBe(true);
  });

  // Relies on a child staying a zombie, and so reported as exited,
  // until kill(pid, 0) fails. Windows ends the process outright and
  // Node reports the exit a loop turn later.
  it.skipIf(process.platform === "win32")(
    "stops a daemon the test process started and left running, without calling it a survivor",
    async () => {
      const { env, dataDir } = scratchHome("flightpath-cleanup-", {
        stopDaemon: true,
      });
      const child = spawn(process.execPath, [distPath("daemon.js")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForDaemonReady(child, dataDir);
      const pid = Number.parseInt(
        readFileSync(join(dataDir, "daemon.lock"), "utf8"),
        10,
      );

      await expect(runCleanups()).resolves.toBeUndefined();

      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});
