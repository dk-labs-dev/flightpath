// Gap check: compare one recorded session against its
// transcript, and print any differences.
//
//   node scripts/gap-check.mjs <session-id> [transcript-path] [--data-dir <dir>]
//
// Run after a build. The transcript path can be omitted: the
// path the session's own hook events carried is read from the
// stored events. Counts only — turns, tool steps and requests
// on both sides. A session the recorder saw whole matches its
// transcript exactly; a difference names what drifted. Exit
// code is 0 when there are no differences, 1 when there are,
// and 2 when the check itself could not run.
//
// Counting follows the transcript reader's own rules — the
// parser is imported from the build, not re-derived here, so
// the two can never drift apart. One response is written as
// several transcript entries sharing a request id, so requests
// count distinct ids. Subagents write their own transcripts
// beside the session's; their entries add steps and requests,
// never turns.
//
// Turns on the transcript side are the entries the recorder
// turns into turns: real prompts, plus a housekeeping entry
// that starts a model request (a subagent's result coming
// back is one — the recorder counts the turn it opens). Not
// turns: tool results, interrupt markers, compaction
// summaries, a local command's own entries, housekeeping
// that starts nothing, and any prompt inside a recorded
// pause — while recording was off the prompt happened, but
// it is correctly absent from the recording.
//
// The transcript is the weaker source for one of the counts by
// design: background requests never appear in it (they are
// telemetry-only), so a session recorded with telemetry shows
// more requests than its transcript holds. Read a requests
// difference with that in mind before calling it a gap.

import console from "node:console";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import process from "node:process";

import { resolveDataDir } from "../dist/data-dir.js";
import { parseTranscriptLine } from "../dist/transcripts/parse.js";

function usage() {
  console.error(
    "usage: node scripts/gap-check.mjs <session-id> [transcript-path] [--data-dir <dir>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let sessionId;
let transcriptPath;
let dataDir;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--data-dir") {
    dataDir = args[i + 1];
    i += 1;
  } else if (sessionId === undefined) {
    sessionId = arg;
  } else if (transcriptPath === undefined) {
    transcriptPath = arg;
  } else {
    usage();
  }
}
if (sessionId === undefined) usage();
dataDir ??= resolveDataDir();

const dbPath = join(dataDir, "flightpath.db");
if (!existsSync(dbPath)) {
  console.error(`gap check: no database at ${dbPath}`);
  process.exit(2);
}
const db = new DatabaseSync(dbPath);

function count(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? 0 : Number(row.n);
}

const recorded = {
  turns: count(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ?",
    sessionId,
  ),
  steps: count(
    "SELECT COUNT(*) AS n FROM steps WHERE session_id = ?",
    sessionId,
  ),
  requests: count(
    "SELECT COUNT(*) AS n FROM requests WHERE session_id = ?",
    sessionId,
  ),
};

const pauses = db
  .prepare("SELECT paused_at, resumed_at FROM pauses WHERE session_id = ?")
  .all(sessionId);

if (transcriptPath === undefined) {
  // The stored hook events carry the transcript path the
  // session itself reported; the first one that names it wins.
  const rows = db
    .prepare(
      "SELECT body FROM raw_events WHERE session_id = ? AND source = 'hook' ORDER BY id",
    )
    .all(sessionId);
  for (const row of rows) {
    try {
      const event = JSON.parse(row.body)?.event;
      if (typeof event?.transcript_path === "string") {
        transcriptPath = event.transcript_path;
        break;
      }
    } catch {
      // A body that will not parse names no path; keep looking.
    }
  }
}
db.close();

if (transcriptPath === undefined || !existsSync(transcriptPath)) {
  console.error(
    `gap check: no transcript found for session ${sessionId}` +
      (transcriptPath === undefined ? "" : ` at ${transcriptPath}`),
  );
  process.exit(2);
}

// Count the transcripts with the reader's parser. The main
// file's prompt entries are the turns; subagent files add
// steps and requests only.
const turnCandidates = [];
let steps = 0;
const requestIds = new Set();
let anonymousRequests = 0;

function countFile(path, countTurns) {
  // A housekeeping entry counts as a turn only when the very
  // next entry is the request it starts.
  let pendingMeta = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseTranscriptLine(line, { keepPromptText: false });
    if (entry.kind === "request") {
      if (countTurns && pendingMeta !== null) {
        turnCandidates.push(pendingMeta);
        pendingMeta = null;
      }
      steps += entry.toolUses.length;
      if (entry.requestId !== null) requestIds.add(entry.requestId);
      else anonymousRequests += 1;
      continue;
    }
    pendingMeta = null;
    if (
      countTurns &&
      entry.kind === "user" &&
      entry.toolResultSizes.size === 0 &&
      !entry.isInterrupt &&
      !entry.isCompactSummary &&
      !entry.isCommandEntry
    ) {
      const candidate = {
        promptId: entry.promptId,
        timestampMs: entry.timestampMs,
      };
      if (entry.isMeta) pendingMeta = candidate;
      else turnCandidates.push(candidate);
    }
  }
}

countFile(transcriptPath, true);
const subagentsDir = join(
  dirname(transcriptPath),
  basename(transcriptPath).replace(/\.jsonl$/, ""),
  "subagents",
);
if (existsSync(subagentsDir)) {
  for (const name of readdirSync(subagentsDir).sort()) {
    if (name.endsWith(".jsonl")) {
      countFile(join(subagentsDir, name), false);
    }
  }
}
const inPause = (timestampMs) =>
  timestampMs !== null &&
  pauses.some(
    (pause) =>
      timestampMs >= pause.paused_at &&
      (pause.resumed_at === null || timestampMs < pause.resumed_at),
  );
const keptTurns = turnCandidates.filter(
  (candidate) => !inPause(candidate.timestampMs),
);
const fromTranscript = {
  turns:
    new Set(
      keptTurns
        .map((candidate) => candidate.promptId)
        .filter((promptId) => promptId !== null),
    ).size +
    keptTurns.filter((candidate) => candidate.promptId === null).length,
  steps,
  requests: requestIds.size + anonymousRequests,
};

console.log(`gap check for session ${sessionId}`);
console.log(`  transcript: ${transcriptPath}`);
let differences = 0;
for (const key of ["turns", "steps", "requests"]) {
  const a = recorded[key];
  const b = fromTranscript[key];
  const mark = a === b ? "" : "  <-- difference";
  if (a !== b) differences += 1;
  console.log(`  ${key}: recorded ${a} · transcript ${b}${mark}`);
}
if (differences === 0) {
  console.log("gap check: no differences");
} else {
  console.log(`gap check: ${differences} difference(s) found`);
  process.exit(1);
}
