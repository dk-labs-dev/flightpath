import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { resetDropped } from "../buffer.js";
import {
  loadSettings,
  saveSettings,
  type Settings,
} from "../settings/index.js";
import { openStorage, type Storage } from "../storage/index.js";
import { createTelemetryIntake } from "../telemetry/index.js";
import {
  createTranscriptFollower,
  resolveClaudeConfigDir,
} from "../transcripts/index.js";
import { errorMessage } from "../util/errors.js";
import { unlinkIfPresent } from "../util/fs.js";
import { cacheHold } from "./cache-hold.js";
import { clearLastError } from "./last-error.js";
import { ingestEnvelope, isEnvelope, type Envelope } from "./ingest.js";
import { acquireDaemonLock, startLockPath, type DaemonLock } from "./lock.js";
import { daemonLog } from "./log.js";
import { createRetention, RETENTION_INTERVAL_MS } from "./retention.js";
import {
  createSessionWatch,
  SESSION_WATCH_INTERVAL_MS,
} from "./session-watch.js";
import type { DaemonRuntime } from "./routes/context.js";
import { handleRequest } from "./routes/router.js";
import { createStreamHub } from "./stream.js";
import type { ShutdownReason } from "./stream-messages.js";

// The daemon: loopback HTTP, one instance, fed by the hook script
// (ADR-0008). It stores redacted envelopes, drains whatever the
// hook buffered while it was down, and exits when idle.

export interface DaemonOptions {
  dataDir: string;
  version: string;
  /** Exit after this long with no events. Default 30 minutes. */
  idleMs?: number;
  /** Buffer drain interval. Default 30 seconds. */
  drainMs?: number;
}

export interface RunningDaemon {
  port: number;
  shutdown(reason: ShutdownReason): Promise<void>;
  /** Stop because a signal or the stop route asked. */
  stop(): Promise<void>;
}

const DEFAULT_DRAIN_MS = 30 * 1000;
const PORT_TRIES = 20;

/**
 * Is `theirs` a newer build than `ours`? Versions are dotted
 * numbers with an optional "-suffix"; a suffix marks a
 * pre-release, older than the plain release of the same
 * numbers. A version that does not parse is unorderable, and
 * unorderable never counts as newer: with two builds active
 * at once, only the older daemon steps aside, so the pair
 * cannot keep restarting each other.
 */
function isNewerVersion(theirs: string, ours: string): boolean {
  const parse = (
    value: string,
  ): { numbers: number[]; suffix: string } | null => {
    const dash = value.indexOf("-");
    const core = dash === -1 ? value : value.slice(0, dash);
    const parts = core.split(".");
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    return {
      numbers: parts.map(Number),
      suffix: dash === -1 ? "" : value.slice(dash + 1),
    };
  };
  const incoming = parse(theirs);
  const own = parse(ours);
  if (incoming === null || own === null) return false;
  const length = Math.max(incoming.numbers.length, own.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (incoming.numbers[i] ?? 0) - (own.numbers[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (incoming.suffix === own.suffix) return false;
  if (incoming.suffix === "") return true;
  if (own.suffix === "") return false;
  return incoming.suffix > own.suffix;
}

// Readers open this file at any moment: write it whole, then
// rename it into place, so no reader sees it empty.
export function writePortFile(
  dataDir: string,
  port: number,
  rename: typeof renameSync = renameSync,
): void {
  const temporary = join(dataDir, "port.tmp");
  writeFileSync(temporary, String(port));
  // On Windows, renaming over a file another process has open
  // can fail for a moment (EPERM, EACCES, EBUSY); retry those
  // codes a few times before giving up.
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(temporary, join(dataDir, "port"));
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        attempt >= 5 ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 20);
    }
  }
}

/** The install's token: created on first run, then read back. */
function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, "token");
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  try {
    // Mode 600: readable only by the user, on the OSes that have
    // file modes.
    writeFileSync(path, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch {
    return readFileSync(path, "utf8").trim();
  }
}

function openDaemonStorage(dataDir: string, lock: DaemonLock): Storage {
  try {
    const storage = openStorage({ dataDir });
    // No capture survives a restart, and a capture's first
    // act is a full load: the change entries the last run
    // left unconsumed go now, before they can pile up.
    storage.clearAllChanges();
    return storage;
  } catch (error) {
    lock.release();
    // Tag where the failure came from: the last-error writer
    // keeps a start error's own words only for errors it can
    // name, and failing to open the database is one of them
    // (see ./last-error.ts).
    if (typeof error === "object" && error !== null) {
      (error as { databaseOpen?: boolean }).databaseOpen = true;
    }
    throw error;
  }
}

// Background work that writes to storage is tracked, so
// shutdown waits for whatever is in flight — bounded — before
// it closes storage, and an exit never logs writes to a closed
// database.
function track<T>(runtime: DaemonRuntime, work: Promise<T>): Promise<T> {
  runtime.inFlight.add(work);
  void work.then(
    () => runtime.inFlight.delete(work),
    () => runtime.inFlight.delete(work),
  );
  return work;
}

function runRetention(runtime: DaemonRuntime): void {
  void track(runtime, runtime.retention.runOnce())
    .then((run) => {
      if (run.aged + run.capped > 0) {
        daemonLog(
          runtime.dataDir,
          `retention deleted ${run.aged + run.capped} session(s) (${run.aged} by age, ${run.capped} by size)`,
        );
        runtime.stream.noteAllSessions();
      }
    })
    .catch((error: unknown) => {
      daemonLog(runtime.dataDir, `retention failed (${errorMessage(error)})`);
    });
}

function followTranscripts(runtime: DaemonRuntime, envelope: Envelope): void {
  const event = envelope.event;
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : undefined;
  const transcriptPath =
    typeof event.transcript_path === "string"
      ? event.transcript_path
      : undefined;
  if (sessionId === undefined) return;
  // This hook event admits the session: any telemetry held
  // for it can land now.
  try {
    runtime.telemetry.flushSession(runtime.storage, sessionId, {
      settings: runtime.settings,
    });
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `transcript follow failed for session ${sessionId} (${errorMessage(error)})`,
    );
    return;
  }
  if (transcriptPath === undefined) return;
  // The follow runs in the background: a long transcript read
  // never delays this event's acknowledgment, and a transcript
  // problem never fails the event that caused the follow —
  // the recording of the event itself is done.
  void track(
    runtime,
    runtime.transcripts.follow(
      sessionId,
      transcriptPath,
      typeof event.cwd === "string" ? event.cwd : undefined,
      event.hook_event_name === "SessionEnd",
    ),
  )
    .then(() => runtime.stream.noteSession(sessionId))
    .catch((error: unknown) => {
      daemonLog(
        runtime.dataDir,
        `transcript follow failed for session ${sessionId} (${errorMessage(error)})`,
      );
    });
}

// A newer build's hook is running: finish, exit, and let it
// start its own daemon (unknown versions never count).
function noteVersion(runtime: DaemonRuntime, envelope: Envelope): void {
  if (runtime.handoverVersion !== null) return;
  const theirs = envelope.plugin_version;
  if (
    typeof theirs === "string" &&
    theirs.length > 0 &&
    theirs !== "unknown" &&
    runtime.version !== "unknown" &&
    isNewerVersion(theirs, runtime.version)
  ) {
    runtime.handoverVersion = theirs;
    daemonLog(
      runtime.dataDir,
      `plugin version ${theirs} arrived; this build (${runtime.version}) hands over once its current work is done`,
    );
  }
}

// The one place settings change: the values merge in, the
// file is saved, and the idle limit follows the setting —
// until a test overrides it.
function applySettings(
  runtime: DaemonRuntime,
  values: Partial<Settings>,
): void {
  runtime.settings = { ...runtime.settings, ...values };
  saveSettings(runtime.dataDir, runtime.settings);
  if (runtime.idleOptionMs === undefined) {
    runtime.idleMs = runtime.settings.idleShutdownMinutes * 60_000;
  }
  // Titles and sentences rest on the settings: the stream
  // re-shapes what it has already sent (ADR-0009).
  runtime.stream.noteSettingsChanged();
}

function drainOneBufferFile(
  runtime: DaemonRuntime,
  bufferDir: string,
  name: string,
): boolean {
  const path = join(bufferDir, name);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isEnvelope(parsed)) {
      if (!runtime.loggedBadFiles.has(name)) {
        runtime.loggedBadFiles.add(name);
        daemonLog(
          runtime.dataDir,
          `buffer file ${name} is not an envelope; left in place`,
        );
      }
      return false;
    }
    noteVersion(runtime, parsed);
    let stored = false;
    if (ingestEnvelope(runtime.storage, parsed) === "stored") {
      stored = true;
      followTranscripts(runtime, parsed);
    }
    runtime.lastActivity = Math.max(runtime.lastActivity, parsed.received_at);
    unlinkSync(path);
    return stored;
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `buffer file ${name} could not be stored (${errorMessage(error)}); left in place`,
    );
    return false;
  }
}

function drainBuffer(runtime: DaemonRuntime): void {
  const bufferDir = join(runtime.dataDir, "buffer");
  let names: string[];
  try {
    names = readdirSync(bufferDir).sort();
  } catch {
    return; // No buffer folder yet.
  }
  let stored = 0;
  for (const name of names) {
    if (drainOneBufferFile(runtime, bufferDir, name)) {
      stored += 1;
    }
  }
  if (stored > 0) {
    daemonLog(runtime.dataDir, `drained ${stored}`);
    runtime.stream.noteAllSessions();
  }
  if (names.length > 0) {
    // The buffer's shape changed either way: its counts are
    // part of the stream's health line.
    runtime.stream.noteHealth();
  }
  // A drain that leaves nothing behind closes the drop
  // count's story too: the counter starts over.
  try {
    if (readdirSync(bufferDir).length === 0) {
      resetDropped(runtime.dataDir);
    }
  } catch {
    // The folder is gone; there is nothing to reset.
  }
  // A drained envelope can carry the handover too (the new
  // build buffered while this daemon was down): the pass
  // above was the current work, and it is done.
  if (runtime.handoverVersion !== null) {
    void runtime.shutdown("handover");
  }
}

// Listen on the wanted port, or the next free one above it:
// a taken port is a fallback, never a failure.
async function listenFrom(server: Server, wanted: number): Promise<number> {
  let candidate = wanted;
  for (;;) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(candidate, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolvePromise();
        });
      });
      return candidate;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
        candidate < wanted + PORT_TRIES
      ) {
        candidate += 1;
        continue;
      }
      throw error;
    }
  }
}

// /flightpath:off writes the flag file before it asks for the
// stop: its stop is the off switch, any other request is a plain
// stop, and the pages are told which one it was.
function requestedStopReason(dataDir: string): ShutdownReason {
  return existsSync(join(dataDir, "off")) ? "off" : "signal";
}

async function shutdownDaemon(
  runtime: DaemonRuntime,
  server: Server,
  lock: DaemonLock,
  reason: ShutdownReason,
): Promise<void> {
  if (runtime.closed) return;
  runtime.closed = true;
  // Stream connections would hold the listener open; the hub
  // ends them first so the close below can complete — but
  // first it tells every open page why, in one last frame
  // that is never buffered or replayed.
  runtime.stream.stop({
    event: "stopping",
    data:
      reason === "idle"
        ? { reason, idleMinutes: Math.round(runtime.idleMs / 60_000) }
        : { reason },
  });
  clearInterval(runtime.timers.drain);
  clearInterval(runtime.timers.idle);
  clearInterval(runtime.timers.refollow);
  clearInterval(runtime.timers.retention);
  clearInterval(runtime.timers.sessionWatch);
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  // Background writes land before storage closes; the bound
  // keeps a stuck read from holding the exit open.
  if (runtime.inFlight.size > 0) {
    await Promise.race([
      Promise.allSettled([...runtime.inFlight]),
      new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 5_000);
      }),
    ]);
  }
  runtime.storage.close();
  lock.release();
  daemonLog(runtime.dataDir, "exited");
}

// A port change restarts the server in place: same process,
// same storage and lock — only the listener moves.
async function restartDaemon(
  runtime: DaemonRuntime,
  server: Server,
  lock: DaemonLock,
): Promise<void> {
  if (runtime.closed) return;
  // The listener moves; stream connections end with it and
  // their pages reconnect to the new port's stream. While it
  // moves, the hub turns new stream connections away, so a
  // reconnect cannot pin the old listener open.
  runtime.stream.beginRestart();
  runtime.stream.endConnections();
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    // Every connection goes, not just the idle ones: a socket
    // busy now idles a moment later, and nothing else would
    // close it.
    server.closeAllConnections();
  });
  try {
    runtime.boundPort = await listenFrom(server, runtime.settings.port);
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `could not listen on port ${runtime.settings.port} (${errorMessage(error)}); exiting`,
    );
    await shutdownDaemon(runtime, server, lock, "listen-failed");
    return;
  }
  runtime.stream.endRestart();
  writePortFile(runtime.dataDir, runtime.boundPort);
  daemonLog(runtime.dataDir, `listening on 127.0.0.1:${runtime.boundPort}`);
  runtime.lastActivity = Date.now();
}

function startTimers(runtime: DaemonRuntime, drainMs: number): void {
  runtime.stream.start();
  runtime.timers.drain = setInterval(() => {
    drainBuffer(runtime);
    runtime.telemetry.dropStale(Date.now());
  }, drainMs);
  // The idle limit is checked on its own short timer, not on
  // the drain tick: the drain interval is 30 s, so a shorter
  // idle limit (a test override, or a small setting) would
  // otherwise take effect up to a full tick late.
  runtime.timers.idle = setInterval(() => {
    const now = Date.now();
    if (now - runtime.lastActivity < runtime.idleMs) return;
    runtime.cacheHold = cacheHold(
      runtime.storage,
      runtime.lastActivity,
      runtime.cacheHold,
    );
    if (now >= runtime.cacheHold.until) void runtime.shutdown("idle");
  }, 1000);
  runtime.timers.idle.unref();
  // A transcript entry written after a session's latest hook
  // event would otherwise wait for the next hook event; sessions
  // active in the last minute are re-followed every second, so
  // new entries land within about two seconds.
  runtime.timers.refollow = setInterval(() => {
    void track(runtime, runtime.transcripts.refollowActive())
      .then(() => runtime.stream.noteAllSessions())
      .catch((error: unknown) => {
        daemonLog(
          runtime.dataDir,
          `transcript re-follow failed (${errorMessage(error)})`,
        );
      });
  }, 1000);
  runtime.timers.refollow.unref();
  // Retention runs once the daemon is listening, and every six
  // hours while it runs (ADR-0025). It deletes one session per
  // transaction and yields between them, so it never delays an
  // event's acknowledgment.
  runtime.timers.retention = setInterval(
    () => runRetention(runtime),
    RETENTION_INTERVAL_MS,
  );
  runtime.timers.retention.unref();
  // The session-end watch: once at startup, then every minute.
  runtime.timers.sessionWatch = setInterval(
    () => runSessionWatch(runtime),
    SESSION_WATCH_INTERVAL_MS,
  );
  runtime.timers.sessionWatch.unref();
  runSessionWatch(runtime);
  runRetention(runtime);
  drainBuffer(runtime);
  startImport(runtime);
}

function runSessionWatch(runtime: DaemonRuntime): void {
  void runtime.sessionWatch
    .runOnce()
    .then((ended) => {
      if (ended.length > 0) {
        daemonLog(
          runtime.dataDir,
          `session-end watch ended ${ended.length} session(s) with no end event`,
        );
        runtime.stream.noteAllSessions();
      }
    })
    .catch((error: unknown) => {
      daemonLog(
        runtime.dataDir,
        `session-end watch failed (${errorMessage(error)})`,
      );
    });
}

// Import runs after the first drain, so a session the hooks
// did record is never mistaken for an unrecorded one — and in
// the background, one file at a time through the chunked
// reader, so it never delays the daemon's first
// acknowledgments.
function startImport(runtime: DaemonRuntime): void {
  void track(runtime, runtime.transcripts.importAll())
    .then((imported) => {
      if (imported.importedSessions > 0) {
        daemonLog(
          runtime.dataDir,
          `imported ${imported.importedSessions} transcript-only session(s)`,
        );
        runtime.stream.noteAllSessions();
      }
    })
    .catch((error: unknown) => {
      daemonLog(
        runtime.dataDir,
        `transcript import failed (${errorMessage(error)})`,
      );
    });
}

function createRuntime(parts: {
  dataDir: string;
  version: string;
  storage: Storage;
  idleOptionMs: number | undefined;
}): DaemonRuntime {
  const { dataDir, version, storage } = parts;
  const settings: Settings = loadSettings(dataDir, (message) =>
    daemonLog(dataDir, message),
  );
  const startedAt = Date.now();
  // The shutdown verb is a placeholder until startDaemon
  // replaces it, once the server it closes exists.
  const shutdownPlaceholder: DaemonRuntime["shutdown"] = () =>
    Promise.resolve();
  // The follower, intake and retention are assigned just below:
  // their settings callbacks read this object, so they are
  // built after it exists.
  const runtime = {
    dataDir,
    version,
    idleOptionMs: parts.idleOptionMs,
    storage,
    token: loadOrCreateToken(dataDir),
    startedAt,
    settings,
    idleMs: parts.idleOptionMs ?? settings.idleShutdownMinutes * 60_000,
    boundPort: 0,
    lastActivity: startedAt,
    cacheHold: null,
    handoverVersion: null,
    closed: false,
    inFlight: new Set<Promise<unknown>>(),
    loggedBadFiles: new Set<string>(),
    timers: {},
    noteVersion: (envelope: Envelope) => noteVersion(runtime, envelope),
    followTranscripts: (envelope: Envelope) =>
      followTranscripts(runtime, envelope),
    shutdown: shutdownPlaceholder,
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    touch: () => {
      runtime.lastActivity = Date.now();
    },
    applySettings: (values: Partial<Settings>) =>
      applySettings(runtime, values),
  } as DaemonRuntime;
  // The transcript reader (ADR-0019): follows live sessions'
  // transcripts as their hook events arrive, and imports
  // sessions hooks never captured when the daemon starts.
  runtime.transcripts = createTranscriptFollower(storage, {
    dataDir,
    configDir: resolveClaudeConfigDir(),
    settings: () => runtime.settings,
  });
  // Telemetry intake: one instance, because records for a
  // session the hooks have not admitted yet are held in memory
  // until the hook event that admits it (or the hold expires).
  runtime.telemetry = createTelemetryIntake();
  // Retention (ADR-0025): old recordings are deleted on a
  // schedule, and the settings screen's delete-all runs through
  // the same code.
  runtime.retention = createRetention({
    storage,
    settings: () => runtime.settings,
  });
  runtime.sessionWatch = createSessionWatch({ storage });
  // The live stream's hub (ADR-0009): it watches storage the
  // way the read API reads it, and starts with the timers.
  runtime.stream = createStreamHub({
    storage,
    settings: () => runtime.settings,
    dataDir,
  });
  return runtime;
}

export async function startDaemon(
  options: DaemonOptions,
): Promise<RunningDaemon | null> {
  const { dataDir, version } = options;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  mkdirSync(dataDir, { recursive: true });

  const lock: DaemonLock | null = acquireDaemonLock(dataDir);
  if (lock === null) {
    daemonLog(dataDir, "another daemon holds the lock; exiting");
    return null;
  }

  const storage = openDaemonStorage(dataDir, lock);
  const runtime = createRuntime({
    dataDir,
    version,
    storage,
    idleOptionMs: options.idleMs,
  });
  const server = createServer((request, response) =>
    handleRequest(runtime, request, response),
  );
  runtime.shutdown = (reason) => shutdownDaemon(runtime, server, lock, reason);
  runtime.stop = () => runtime.shutdown(requestedStopReason(dataDir));
  runtime.restart = () => restartDaemon(runtime, server, lock);

  try {
    runtime.boundPort = await listenFrom(server, runtime.settings.port);
  } catch (error) {
    storage.close();
    lock.release();
    throw error;
  }
  // Clear the previous start's error before the port file appears, so a
  // reader never sees a live daemon alongside a stale failure.
  clearLastError(dataDir);
  writePortFile(dataDir, runtime.boundPort);
  // The start is finished: release the start lock, so a caller
  // inside the window no longer mistakes it for a start still
  // in progress. A start that fails before this point leaves
  // the lock, and is not retried until the window passes.
  unlinkIfPresent(startLockPath(dataDir));
  daemonLog(dataDir, `listening on 127.0.0.1:${runtime.boundPort}`);

  startTimers(runtime, drainMs);
  return {
    port: runtime.boundPort,
    shutdown: runtime.shutdown,
    stop: runtime.stop,
  };
}
