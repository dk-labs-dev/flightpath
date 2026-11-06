// The end-of-turn hook. Claude Code runs it synchronously when a turn
// ends; it asks the daemon whether that turn has a suggestion worth a
// line and prints the daemon's answer, worded in api/terminal-line.ts, as
// a systemMessage, which reaches the person and never the model (ADR-0021,
// ADR-0024). It is silent on every failure: a missing line costs the
// person nothing, and a visible error would. It never reads Claude's
// last message (ADR-0004) and never starts the daemon.

import { isRecordingOff, resolveDataDir } from "./data-dir.js";
import { isExcludedFolder, loadSettings } from "./settings/index.js";
import { readDaemonAddress } from "./util/fs.js";
import { isPlainObject, textOf } from "./util/json.js";
import { loopbackRequest, type LoopbackReply } from "./util/loopback.js";
import { readStdinEvent } from "./util/stdin-event.js";

// A line that arrives late is a line nobody wants, so a slow daemon
// costs the line, never the person's time.
const LINE_WAIT_MS = 150;

function lineFrom(reply: LoopbackReply | null): string | null {
  if (reply === null || reply.status !== 200) return null;
  try {
    const answer: unknown = JSON.parse(reply.body);
    return isPlainObject(answer) && typeof answer.line === "string"
      ? answer.line
      : null;
  } catch {
    // A reply that isn't JSON came from something other than our daemon.
    return null;
  }
}

async function main(): Promise<void> {
  const event = readStdinEvent();
  if (event === null || event.hook_event_name !== "Stop") return;
  const dataDir = resolveDataDir();
  if (isRecordingOff(dataDir, event)) return;
  const settings = loadSettings(dataDir);
  if (!settings.terminalLine) return;
  if (
    typeof event.cwd === "string" &&
    isExcludedFolder(event.cwd, settings.excludedFolders)
  ) {
    return;
  }
  const sessionId = textOf(event.session_id);
  const promptId = textOf(event.prompt_id);
  const address = readDaemonAddress(dataDir);
  if (sessionId === undefined || promptId === undefined || address === null) {
    return;
  }
  const reply = await loopbackRequest(
    address,
    {
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/terminal-line?prompt=${encodeURIComponent(promptId)}`,
    },
    LINE_WAIT_MS,
  );
  const line = lineFrom(reply);
  if (line !== null) {
    process.stdout.write(`${JSON.stringify({ systemMessage: line })}\n`);
  }
}

try {
  await main();
} catch {
  // A hook error must never surface in the session.
}
