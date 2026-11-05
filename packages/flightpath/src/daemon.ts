#!/usr/bin/env node
// The daemon entry point (see ./daemon/server.ts). The hook script
// starts it when delivery fails; it can also be run by hand.
// FLIGHTPATH_IDLE_MS and FLIGHTPATH_DRAIN_MS shorten the timers —
// the tests use them; nothing else needs to.

import { homedir } from "node:os";

import { resolveDataDir } from "./data-dir.js";
import { writeLastError } from "./daemon/last-error.js";
import { daemonLog } from "./daemon/log.js";
import { startDaemon } from "./daemon/server.js";
import { errorMessage } from "./util/errors.js";
import { pluginVersion } from "./version.js";

function positiveMs(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir(process.env, process.platform, homedir());
  const idleMs = positiveMs(process.env.FLIGHTPATH_IDLE_MS);
  const drainMs = positiveMs(process.env.FLIGHTPATH_DRAIN_MS);
  const daemon = await startDaemon({
    dataDir,
    version: pluginVersion(),
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(drainMs !== undefined ? { drainMs } : {}),
  });
  if (daemon === null) {
    return; // Another instance is running; exit quietly.
  }
  const stop = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  try {
    const dataDir = resolveDataDir(process.env, process.platform, homedir());
    // The failure is written down where the notice and
    // /flightpath:status can find it (see ./daemon/last-error.ts).
    writeLastError(dataDir, error);
    daemonLog(dataDir, `failed to start (${errorMessage(error)})`);
  } catch {
    // Nowhere to report to; the exit code carries it.
  }
  process.exit(1);
});
