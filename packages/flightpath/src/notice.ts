// The startup notice hook: it decides from local files only; it never calls the daemon and never prints the token.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bufferStats } from "./buffer.js";
import { pauseFileName, resolveDataDir } from "./data-dir.js";
import { daemonLive } from "./daemon/lock.js";
import { isExcludedFolder, loadSettings } from "./settings/index.js";

const RECORDING = "● flightpath is recording · /flightpath:status for settings";
const EXCLUDED =
  "● flightpath isn't recording this folder · it's in Folders never recorded in Settings";
const PAUSED = "● flightpath is paused · /flightpath:start to record";
const OFF = "● flightpath is off · /flightpath:start to turn it on";
const WARNING =
  "● flightpath can't start its recorder · /flightpath:status for details";
// How old the oldest buffered event may get before an undrained
// buffer means the daemon can't start, not that it's restarting.
const BUFFER_STALE_MS = 120_000;

function main(): void {
  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  if (raw.trim().length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const event = payload as Record<string, unknown>;
  if (event.hook_event_name !== "SessionStart") return;
  // hooks.json already matches only these sources; the guard
  // keeps the entry honest if it is ever run another way. A
  // notice belongs to a fresh start, never to resume or compact.
  if (
    event.source !== "startup" &&
    event.source !== "clear" &&
    event.source !== "fork"
  ) {
    return;
  }

  const dataDir = resolveDataDir();
  // Off is its own state, not a kind of pause: it holds in every
  // session until /flightpath:start, while a pause is one
  // session's, or autostart being off. Off is checked first
  // because it also silences the warning below: events buffered
  // before /flightpath:off are waiting on purpose, and a recorder
  // that was turned off has not failed to start.
  const off = existsSync(join(dataDir, "off"));
  // A recorder that can't start is a failure, not a status: the
  // warning prints even when the startup notice is turned off.
  // Its sign is a buffer gone stale with no live daemon to drain
  // it; a restart still inside the bound never shows it. The
  // check reads file names and the lock alone — no daemon call.
  const stats = bufferStats(dataDir);
  if (
    !off &&
    stats.oldestAt !== null &&
    Date.now() - stats.oldestAt >= BUFFER_STALE_MS &&
    !daemonLive(dataDir)
  ) {
    process.stdout.write(`${JSON.stringify({ systemMessage: WARNING })}\n`);
    return;
  }
  const settings = loadSettings(dataDir);
  if (!settings.startupNotice) return;

  const sessionId =
    typeof event.session_id === "string" ? event.session_id : "";
  const cwd = typeof event.cwd === "string" ? event.cwd : "";
  // After off, before paused: the hook drops an excluded
  // folder's events whatever its pause state says.
  const excluded =
    cwd.length > 0 && isExcludedFolder(cwd, settings.excludedFolders);
  const paused =
    !settings.autostart ||
    (sessionId.length > 0 &&
      existsSync(join(dataDir, "pause", pauseFileName(sessionId))));
  let line = RECORDING;
  if (off) {
    line = OFF;
  } else if (excluded) {
    line = EXCLUDED;
  } else if (paused) {
    line = PAUSED;
  }
  process.stdout.write(`${JSON.stringify({ systemMessage: line })}\n`);
}

try {
  main();
} catch {
  // A notice must never surface as an error in the session.
}
