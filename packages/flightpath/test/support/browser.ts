// The browser suites' shared start: plant a suite's sessions
// in a fresh store, start the daemon over them and open a
// browser. Each suite passes only what it seeds; the rest —
// the temp root, the daemon's idle limit (long, so a seeded
// session is never reaped mid-run), the address and the
// token — is the same for all of them, so it lives here once.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

import { openStorage } from "../../src/storage/index.js";
import { DatabaseSync } from "../../src/storage/sqlite.js";
import {
  makeRoot,
  readPort,
  readToken,
  startDaemon,
  startTestDaemon,
  waitForDaemonReady,
} from "./daemon.js";

export interface SeededBrowser {
  dataDir: string;
  base: string;
  port: number;
  token: string;
  browser: Browser;
}

export async function startSeededBrowser(
  prefix: string,
  seed: (db: DatabaseSync) => void,
): Promise<SeededBrowser> {
  const made = makeRoot(prefix);
  const storage = openStorage({ dataDir: made.dataDir });
  const db = new DatabaseSync(storage.dbPath);
  seed(db);
  db.close();
  storage.close();
  const child = startDaemon(made.root, {}, { idleMs: "900000" });
  await waitForDaemonReady(child, made.dataDir);
  return launchSeededBrowser(
    made.dataDir,
    readPort(made.dataDir),
    readToken(made.dataDir),
  );
}

/** Start a daemon whose Claude Code folder is a fresh temp
 *  folder and whose environment holds no telemetry setup
 *  from this machine, with a browser: the starting state for
 *  suites that drive the settings screen's telemetry group,
 *  whose answers depend on that folder and environment. */
export async function startScreenBrowser(
  prefix: string,
): Promise<SeededBrowser> {
  const made = makeRoot(prefix);
  mkdirSync(join(made.root, "claude"), { recursive: true });
  const extra: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: join(made.root, "claude"),
  };
  for (const key of Object.keys(process.env)) {
    if (isTelemetrySetupKey(key)) {
      extra[key] = undefined;
    }
  }
  const started = await startTestDaemon(made.root, { extra });
  return launchSeededBrowser(started.dataDir, started.port, started.token);
}

/** Start a daemon over an empty store, with the daemon's own idle limit. */
export async function bootBrowser(prefix: string): Promise<SeededBrowser> {
  const made = makeRoot(prefix);
  const child = startDaemon(made.root);
  await waitForDaemonReady(child, made.dataDir);
  return launchSeededBrowser(
    made.dataDir,
    readPort(made.dataDir),
    readToken(made.dataDir),
  );
}

/** The tail both starts share: launch Chromium and assemble
 *  the SeededBrowser from the daemon's data folder, port and
 *  token. */
async function launchSeededBrowser(
  dataDir: string,
  port: number,
  token: string,
): Promise<SeededBrowser> {
  const browser = await chromium.launch();
  return {
    dataDir,
    base: `http://127.0.0.1:${port}`,
    port,
    token,
    browser,
  };
}

/** The environment keys a machine's own telemetry setup
 *  arrives by; a screen suite's daemon inherits none of it. */
function isTelemetrySetupKey(key: string): boolean {
  return key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY";
}
