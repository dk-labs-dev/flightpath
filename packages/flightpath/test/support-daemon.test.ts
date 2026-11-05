import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { makeRoot, waitForDaemonReady } from "./support/daemon.js";

// No watcher event fires in this file, so a wait here settles
// only through its own checks, the child's exit or the timeout.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { EventEmitter } = await import("node:events");
  const watch = () => {
    const watcher = new EventEmitter();
    return Object.assign(watcher, { close: () => undefined });
  };
  return { ...actual, watch };
});

afterEach(async () => {
  await runCleanups();
});

function liveChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
}

describe("waitForDaemonReady", () => {
  it("resolves when the port and token appear after the wait starts, with no watcher event", async () => {
    const { dataDir } = makeRoot();
    const child = liveChild();
    try {
      const started = Date.now();
      const ready = waitForDaemonReady(child, dataDir, 5_000);
      // Staging, not an assertion wait: publish the files only
      // once the wait is armed, so no watcher event can be what
      // settles it — the stub above never fires one.
      await new Promise((resolve) => setTimeout(resolve, 100));
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "port"), "4799");
      writeFileSync(join(dataDir, "token"), "test-token");
      await ready;
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);

  it("rejects when the child exits before it is ready", async () => {
    const { dataDir } = makeRoot();
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], {
      stdio: "ignore",
    });
    await expect(waitForDaemonReady(child, dataDir, 5_000)).rejects.toThrow(
      "Daemon exited before it was ready",
    );
  });

  it("rejects at its timeout when the files never appear", async () => {
    const { dataDir } = makeRoot();
    const child = liveChild();
    try {
      await expect(waitForDaemonReady(child, dataDir, 300)).rejects.toThrow(
        "Timed out waiting for the daemon to be ready.",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});
