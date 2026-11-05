// The Flightpath command hook's handler, shared by its two
// entries (command.ts, submit-command.ts). Claude Code runs it
// synchronously for a UserPromptExpansion of one of the six
// namespaced commands, and for a UserPromptSubmit
// (hooks/hooks.json), so each command is answered locally — by
// files, by the database, by the daemon's own state — and
// blocked before it can reach the model (ADR-0021, ADR-0024).
// The answer travels back in the block reason, which the user
// sees and the model never does. The action comes from the
// command name; any arguments are ignored. A submitted prompt
// is answered only in the expanded form, which has no expansion
// after it: the plain command is answered by the expansion
// that follows it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { bufferStats, droppedCount } from "./buffer.js";
import { actionOf, expandedAction } from "./commands.js";
import { pauseFileName, resolveDataDir } from "./data-dir.js";
import { nextStepFor, readLastError } from "./daemon/last-error.js";
import { daemonLive, pidAlive } from "./daemon/lock.js";
import { ensureDaemon } from "./daemon/spawn.js";
import { formatAge } from "./format.js";
import { openLiveView, waitForLiveViewUrl } from "./open.js";
import { loadSettings, settingsScreenUrl } from "./settings/index.js";
import { flightpathOverheadTokens } from "./storage/request-tokens.js";
import { DatabaseSync } from "./storage/sqlite.js";
import {
  readDaemonAddress,
  readDaemonPid,
  unlinkIfPresent,
} from "./util/fs.js";
import { parseStringArray } from "./util/json.js";

function daemonAddress(dataDir: string): string {
  if (!daemonLive(dataDir)) {
    return "not running";
  }
  try {
    const port = readFileSync(join(dataDir, "port"), "utf8").trim();
    return port.length > 0 ? `127.0.0.1:${port}` : "not running";
  } catch {
    // No port file, no daemon.
    return "not running";
  }
}

/** Capture sources and command overhead for one session, read-only. */
function sessionFacts(
  dataDir: string,
  sessionId: string,
): { sources: string[]; overheadTokens: number } {
  const facts = { sources: [] as string[], overheadTokens: 0 };
  const dbPath = join(dataDir, "flightpath.db");
  if (!existsSync(dbPath)) return facts;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const conditions = db
      .prepare(
        "SELECT sources_seen FROM session_conditions WHERE session_id = ?",
      )
      .get(sessionId) as { sources_seen: string | null } | undefined;
    facts.sources = parseStringArray(conditions?.sources_seen);
    facts.overheadTokens = flightpathOverheadTokens(db, sessionId);
  } catch {
    // An unreadable database reports the defaults, never an error.
  } finally {
    db?.close();
  }
  return facts;
}

/** The database's size on disk: the main file plus its WAL. */
function databaseSize(dataDir: string): number {
  let bytes = 0;
  for (const name of ["flightpath.db", "flightpath.db-wal"]) {
    try {
      bytes += statSync(join(dataDir, name)).size;
    } catch {
      // Not there yet: counts as nothing.
    }
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "3 minutes old", from the oldest buffered event's arrival. */
function ageText(oldestAt: number): string {
  return `${formatAge(oldestAt, Date.now())} old`;
}

/** The last start error's lines, with its next step when known. */
function lastErrorLines(dataDir: string): string[] {
  const lastError = readLastError(dataDir);
  if (lastError === null) {
    return [];
  }
  const lines = [
    `last start error: ${lastError.message} (${new Date(lastError.at).toISOString()})`,
  ];
  const step = nextStepFor(lastError, dataDir);
  if (step !== null) lines.push(`next step: ${step}`);
  return lines;
}

function status(dataDir: string, sessionId: string): string {
  const lines: string[] = [];
  // Status only reports: turning recording back on is
  // /flightpath:start's work (ADR-0024).
  const pausePath = join(dataDir, "pause", pauseFileName(sessionId));
  if (existsSync(join(dataDir, "off"))) {
    lines.push(
      "flightpath is off in all sessions — /flightpath:start turns it back on",
    );
  } else if (existsSync(pausePath)) {
    lines.push("flightpath is paused for this session");
  } else {
    lines.push("flightpath is recording");
  }
  const facts = sessionFacts(dataDir, sessionId);
  const address = daemonAddress(dataDir);
  lines.push(`daemon: ${address}`);
  lines.push(`data folder: ${dataDir}`);
  const buffer = bufferStats(dataDir);
  if (buffer.count > 0 && buffer.oldestAt !== null) {
    lines.push(
      `buffered events: ${buffer.count} waiting, oldest ${ageText(buffer.oldestAt)}`,
    );
  }
  const dropped = droppedCount(dataDir);
  if (dropped > 0) {
    lines.push(
      `dropped events: about ${dropped} (the buffer was full; their transcripts still cover those sessions)`,
    );
  }
  lines.push(...lastErrorLines(dataDir));
  lines.push(
    `recordings kept for: ${loadSettings(dataDir).retentionDays} days`,
  );
  lines.push(`database size: ${formatBytes(databaseSize(dataDir))}`);
  lines.push(
    `capture sources for this session: ${
      facts.sources.length > 0 ? facts.sources.join(", ") : "none yet"
    }`,
  );
  lines.push(
    `flightpath overhead in this session: ${facts.overheadTokens} tokens`,
  );
  // The link only opens while the daemon serves the view; with
  // the daemon down, naming the way to start it beats a dead link.
  const url = settingsScreenUrl(dataDir);
  lines.push(
    `settings: ${
      address !== "not running" && url !== null
        ? url
        : "run /flightpath:start to open the settings screen"
    }`,
  );
  lines.push("live view: /flightpath:open opens it in the browser");
  return lines.join("\n");
}

async function runStop(dataDir: string, sessionId: string): Promise<string> {
  const pausePath = join(dataDir, "pause", pauseFileName(sessionId));
  mkdirSync(join(dataDir, "pause"), { recursive: true });
  writeFileSync(pausePath, "");
  const { openStorage } = await import("./storage/index.js");
  const storage = openStorage({ dataDir });
  storage.recordPause(sessionId);
  storage.close();
  return "flightpath: recording paused for this session — /flightpath:start resumes";
}

async function runStart(dataDir: string, sessionId: string): Promise<string> {
  const pausePath = join(dataDir, "pause", pauseFileName(sessionId));
  const wasOff = existsSync(join(dataDir, "off"));
  unlinkIfPresent(join(dataDir, "off"));
  unlinkIfPresent(pausePath);
  unlinkIfPresent(`${pausePath}.auto`);
  const { openStorage } = await import("./storage/index.js");
  const storage = openStorage({ dataDir });
  storage.recordResume(sessionId);
  storage.close();
  if (wasOff) {
    // Off stopped the daemon; starting again brings it back.
    await ensureDaemon(dataDir);
    return "flightpath: recording on — it was off in all sessions";
  }
  return "flightpath: recording on for this session";
}

const STOP_REQUEST_MS = 2_000;

/** Whether the daemon accepted the request to stop. */
async function askDaemonToStop(dataDir: string): Promise<boolean> {
  const address = readDaemonAddress(dataDir);
  if (address === null) return false;
  // Loaded here only: no other command starts a client.
  const { request } = await import("node:http");
  return new Promise((resolvePromise) => {
    const asking = request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/stop",
        headers: { "x-flightpath-token": address.token },
        agent: false,
        timeout: STOP_REQUEST_MS,
      },
      (reply) => {
        reply.resume();
        resolvePromise(reply.statusCode === 204);
      },
    );
    asking.on("timeout", () => asking.destroy());
    asking.on("error", () => resolvePromise(false));
    asking.end();
  });
}

// A signal ends a Node process on Windows without running its
// handlers, so the daemon is asked over HTTP first and can tell
// its pages the recorder is off. A daemon that cannot be asked
// (an older build without the route, or one not answering) gets
// the signal.
async function stopDaemon(dataDir: string): Promise<void> {
  const pid = readDaemonPid(dataDir);
  if (pid === null || !pidAlive(pid)) return;
  if (await askDaemonToStop(dataDir)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The daemon exited between the check and the signal; the
    // flag alone turns recording off.
  }
}

async function runOff(dataDir: string): Promise<string> {
  writeFileSync(join(dataDir, "off"), "");
  await stopDaemon(dataDir);
  return "flightpath: off in all sessions — /flightpath:start turns it back on";
}

async function runOpen(dataDir: string, sessionId: string): Promise<string> {
  // The daemon serves the view: start it first if it is not
  // running, then wait for its port file (ADR-0026).
  if (!daemonLive(dataDir)) {
    await ensureDaemon(dataDir);
  }
  const url = await waitForLiveViewUrl(dataDir, sessionId);
  if (url === null) {
    return "flightpath: the live view could not be opened — the daemon did not start; /flightpath:status shows the last start error";
  }
  // The address is printed either way: when no browser can be
  // opened, the printed link is the way in (ADR-0026).
  return openLiveView(url)
    ? `flightpath: opened the live view · ${url}`
    : `flightpath: open this link to see the live view · ${url}`;
}

async function runForget(dataDir: string, sessionId: string): Promise<string> {
  const { openStorage } = await import("./storage/index.js");
  const storage = openStorage({ dataDir });
  storage.forgetSession(sessionId);
  storage.close();
  const pausePath = join(dataDir, "pause", pauseFileName(sessionId));
  mkdirSync(join(dataDir, "pause"), { recursive: true });
  writeFileSync(pausePath, "");
  return "flightpath: this session's recording is deleted, and recording is paused so nothing new is captured";
}

/** The action the payload names, or null when it names none. */
function actionIn(payload: Record<string, unknown>) {
  if (payload.hook_event_name === "UserPromptSubmit") {
    return typeof payload.prompt === "string"
      ? expandedAction(payload.prompt)
      : null;
  }
  const commandName =
    typeof payload.command_name === "string" ? payload.command_name : "";
  return actionOf(commandName);
}

async function run(raw: string): Promise<string> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const action = actionIn(payload);
  if (action === null) {
    return ""; // Not ours: stay silent and let it pass.
  }
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : "";
  switch (action) {
    case "status":
      return status(dataDir, sessionId);
    case "stop":
      return runStop(dataDir, sessionId);
    case "start":
      return runStart(dataDir, sessionId);
    case "off":
      return runOff(dataDir);
    case "forget":
      return runForget(dataDir, sessionId);
    case "open":
      return runOpen(dataDir, sessionId);
  }
}

/** Answer one command payload: print the block decision, or nothing. */
export async function answerCommand(raw: string): Promise<void> {
  let reply: string;
  try {
    reply = await run(raw);
  } catch {
    reply = "flightpath: something went wrong handling that command";
  }
  if (reply !== "") {
    process.stdout.write(
      `${JSON.stringify({ decision: "block", reason: reply })}\n`,
    );
  }
}
