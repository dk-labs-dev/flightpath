// The recording hook. Claude Code runs this for every registered
// event (hooks/hooks.json, all async). It must never be seen: it
// prints nothing at all (the startup notice is a separate,
// synchronous hook — ADR-0024), always exits 0, and does as
// little as possible — read the event, redact it, hand it to
// the daemon, or buffer it and make sure the daemon is coming
// (ADR-0008, ADR-0021).

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { BUFFER_LIMIT, noteDropped } from "./buffer.js";
import { isRecordingOff, pauseFileName, resolveDataDir } from "./data-dir.js";
import type { Envelope } from "./daemon/ingest.js";
import { ensureDaemon } from "./daemon/spawn.js";
import { classifyPrompt } from "./prompt-kind.js";
import {
  isExcludedFolder,
  loadSettings,
  type Settings,
} from "./settings/index.js";
import { promptTextColumns } from "./storage/prompt-text.js";
import { errorMessage } from "./util/errors.js";
import { readDaemonAddress } from "./util/fs.js";
import { loopbackRequest } from "./util/loopback.js";
import { readStdinEvent } from "./util/stdin-event.js";
import { pluginVersion } from "./version.js";
// The redaction module is loaded dynamically, after the cheap
// exits in main(): a paused or switched-off session shouldn't pay
// for loading it.

const DELIVERY_TIMEOUT_MS = 300;
const ERROR_LOG_CAP_BYTES = 64 * 1024;

/** Errors are recorded, never shown: the session must not see them. */
function logError(dataDir: string, error: unknown): void {
  try {
    const logs = join(dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "hook-errors.log");
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    const line = `${new Date().toISOString()} ${errorMessage(error)}\n`;
    // Size-capped by starting over, not by rotating: the log is a
    // diagnostic, and the newest entries are the useful ones.
    appendFileSync(path, line, {
      flag: size > ERROR_LOG_CAP_BYTES ? "w" : "a",
    });
  } catch {
    // Nowhere to write is itself not a reason to surface anything.
  }
}

/** Delivered means a 2xx reply; anything else means the event is buffered. */
async function deliver(
  address: { port: number; token: string },
  envelope: Envelope,
): Promise<boolean> {
  const reply = await loopbackRequest(
    address,
    { method: "POST", path: "/events/hook", body: JSON.stringify(envelope) },
    DELIVERY_TIMEOUT_MS,
  );
  return reply !== null && reply.status >= 200 && reply.status < 300;
}

function bufferEvent(dataDir: string, envelope: Envelope): void {
  const buffer = join(dataDir, "buffer");
  mkdirSync(buffer, { recursive: true });
  // The buffer is bounded: past the limit a new event is dropped
  // and counted instead of written, so a daemon that can't start
  // can't fill the disk. A drop loses hook-only detail — the
  // transcript still covers the session itself.
  if (readdirSync(buffer).length >= BUFFER_LIMIT) {
    noteDropped(dataDir);
    return;
  }
  // One file per event, so concurrent hooks never interleave, on
  // any OS: the name is the arrival time plus the envelope's id.
  const name = `${envelope.received_at}-${envelope.id}.json`;
  writeFileSync(join(buffer, name), JSON.stringify(envelope), { flag: "wx" });
}

/**
 * With autostart off, a fresh session starts paused: its pause
 * flag and .auto marker are written here, so the pause check in
 * main drops this event like any other.
 */
function noteAutostartPause(
  dataDir: string,
  event: Record<string, unknown>,
): void {
  const sessionId = event.session_id;
  if (
    event.hook_event_name !== "SessionStart" ||
    typeof sessionId !== "string" ||
    sessionId.length === 0
  ) {
    return;
  }
  const settings = loadSettings(dataDir);
  if (!settings.autostart && event.source === "startup") {
    try {
      const pauseDir = join(dataDir, "pause");
      mkdirSync(pauseDir, { recursive: true });
      writeFileSync(join(pauseDir, pauseFileName(sessionId)), "");
      writeFileSync(join(pauseDir, `${pauseFileName(sessionId)}.auto`), "");
    } catch (error) {
      logError(dataDir, error);
    }
  }
}

/**
 * Note the Claude Code process this session runs in, on the
 * event that starts it: the daemon checks that process later
 * to learn whether the session is still there when no end
 * event arrives. Loaded dynamically and run only here, so no
 * other event pays for it. A failure records nothing — the
 * daemon's fallback covers a session with no process noted.
 */
async function noteHostProcess(event: Record<string, unknown>): Promise<void> {
  if (event.hook_event_name !== "SessionStart") {
    return;
  }
  try {
    const { captureHostProcess } = await import("./util/host-process.js");
    const host = captureHostProcess();
    if (host !== null) {
      event.host_pid = host.pid;
      event.host_started_at = host.startedAt;
    }
  } catch {
    // Noting the process is an extra: a failure records nothing.
  }
}

async function buildEnvelope(
  event: Record<string, unknown>,
  settings: Settings,
): Promise<Envelope> {
  // The prompt's true length, taken before redaction: with
  // prompt storage off, this number is all that is kept.
  const promptText = typeof event.prompt === "string" ? event.prompt : null;
  const { REDACTION_VERSION, redactHookEvent } =
    await import("./redact/index.js");
  const redacted = redactHookEvent(event);
  if (promptText !== null) {
    // The kind is decided here, while the text is still in
    // hand: once the text is dropped, nothing downstream can
    // tell a typed prompt from a hand-back or a notification.
    // The figures always ride along; the text only when kept.
    const columns = promptTextColumns(promptText);
    redacted.prompt_kind = classifyPrompt(promptText);
    redacted.prompt_chars = columns.chars;
    redacted.prompt_lines = columns.lines;
    if (!settings.storePromptText) {
      // Only the length is kept: the text itself never reaches the
      // daemon or the buffer.
      redacted.prompt = { chars: promptText.length };
    }
  }
  return {
    id: randomBytes(16).toString("hex"),
    received_at: Date.now(),
    redaction_version: REDACTION_VERSION,
    plugin_version: pluginVersion(),
    event: redacted,
  };
}

async function main(): Promise<void> {
  const event = readStdinEvent();
  if (event === null) {
    return;
  }
  const dataDir = resolveDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    logError(dataDir, error);
    return;
  }
  noteAutostartPause(dataDir, event);
  if (isRecordingOff(dataDir, event)) {
    return;
  }
  const settings = loadSettings(dataDir);
  // A session working in an excluded folder is dropped here,
  // before redaction — as if it were paused (ADR-0022).
  if (
    typeof event.cwd === "string" &&
    isExcludedFolder(event.cwd, settings.excludedFolders)
  ) {
    return;
  }
  await noteHostProcess(event);
  const envelope = await buildEnvelope(event, settings);
  const address = readDaemonAddress(dataDir);
  const delivered = address !== null && (await deliver(address, envelope));
  if (!delivered) {
    try {
      bufferEvent(dataDir, envelope);
    } catch (error) {
      logError(dataDir, error);
    }
    try {
      await ensureDaemon(dataDir);
    } catch (error) {
      logError(dataDir, error);
    }
  }
}

try {
  await main();
} catch {
  // Last resort: a hook error must never surface in the session.
}
