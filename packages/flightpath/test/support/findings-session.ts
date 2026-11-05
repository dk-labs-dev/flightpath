import type { DatabaseSync } from "../../src/storage/sqlite.js";
import {
  seedConditions,
  seedMoment,
  seedRequestExact,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./seed.js";

export const FINDINGS_SESSION = "findings-session";
export const QUIET_SESSION = "findings-quiet";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The step ids the findings are pinned to, by what they report. */
export const pinned: { model: number; expired: number; habit: number } = {
  model: 0,
  expired: 0,
  habit: 0,
};

interface Req {
  id: number;
  turnId: number;
  at: number;
  model?: string;
  read: number;
  write: number;
}

function request(db: DatabaseSync, req: Req): void {
  seedRequestExact(db, {
    id: req.id,
    sessionId: FINDINGS_SESSION,
    turnId: req.turnId,
    startedAt: req.at,
    model: req.model ?? "claude-sonnet-5-5",
    input: 1_000,
    output: 500,
    cacheRead: req.read,
    cacheWrite5m: 0,
    cacheWrite1h: req.write,
  });
}

function turnAt(db: DatabaseSync, sequence: number, at: number): number {
  const turnId = seedTurn(db, {
    sessionId: FINDINGS_SESSION,
    sequence,
    startedAt: at,
    endedAt: at + 5 * MINUTE,
    promptText: `Turn ${sequence}`,
  });
  seedMoment(db, {
    sessionId: FINDINGS_SESSION,
    turnId,
    kind: "prompt",
    occurredAt: at,
    detail: `Turn ${sequence}`,
  });
  return turnId;
}

// The step carries the result the rebuilding request sent back, so
// it is seeded after the request it names.
function stepCarrying(
  db: DatabaseSync,
  turnId: number,
  sequence: number,
  at: number,
  resultRequestId: number,
): number {
  return seedStep(db, {
    sessionId: FINDINGS_SESSION,
    turnId,
    toolName: "Read",
    input: { file_path: `/home/user/app/src/file-${sequence}.ts` },
    startedAt: at + MINUTE,
    durationMs: 100,
    resultRequestId,
  });
}

/** A session whose recorded requests give three findings: a model
 * switch, and two lapses of the one-hour cache (the second is the
 * session's habit, so it is graded higher). Each is carried by the
 * one step of its own turn. */
export function seedFindingsSession(db: DatabaseSync, start: number): void {
  seedSession(db, {
    id: FINDINGS_SESSION,
    projectPath: "/home/user/app",
    firstSeenAt: start,
    lastSeenAt: start + 6 * HOUR,
  });
  seedConditions(db, FINDINGS_SESSION, {});
  seedSegment(db, {
    sessionId: FINDINGS_SESSION,
    startedAt: start,
    contextTokens: 9_000,
  });
  const first = turnAt(db, 1, start);
  request(db, {
    id: 1,
    turnId: first,
    at: start,
    read: 80_000,
    write: 5_000,
  });
  request(db, {
    id: 2,
    turnId: first,
    at: start + MINUTE,
    model: "claude-opus-5-5",
    read: 5_000,
    write: 60_000,
  });
  const second = turnAt(db, 2, start + HOUR);
  request(db, {
    id: 3,
    turnId: second,
    at: start + 2 * MINUTE,
    model: "claude-opus-5-5",
    read: 68_000,
    write: 0,
  });
  request(db, {
    id: 4,
    turnId: second,
    at: start + 2 * MINUTE + 71 * MINUTE,
    model: "claude-opus-5-5",
    read: 5_000,
    write: 62_000,
  });
  const third = turnAt(db, 3, start + 3 * HOUR);
  request(db, {
    id: 5,
    turnId: third,
    at: start + 3 * HOUR - MINUTE,
    model: "claude-opus-5-5",
    read: 68_000,
    write: 0,
  });
  request(db, {
    id: 6,
    turnId: third,
    at: start + 3 * HOUR - MINUTE + 71 * MINUTE,
    model: "claude-opus-5-5",
    read: 5_000,
    write: 62_000,
  });
  pinned.model = stepCarrying(db, first, 1, start, 2);
  pinned.expired = stepCarrying(db, second, 2, start + HOUR, 4);
  pinned.habit = stepCarrying(db, third, 3, start + 3 * HOUR, 6);
}

/** A session with nothing to report: the tree must start where it does today. */
export function seedQuietSession(db: DatabaseSync, start: number): void {
  seedSession(db, {
    id: QUIET_SESSION,
    projectPath: "/home/user/quiet",
    firstSeenAt: start,
    lastSeenAt: start + HOUR,
  });
  seedConditions(db, QUIET_SESSION, {});
  const turnId = seedTurn(db, {
    sessionId: QUIET_SESSION,
    sequence: 1,
    startedAt: start,
    endedAt: start + MINUTE,
    promptText: "Say hello",
  });
  seedStep(db, {
    sessionId: QUIET_SESSION,
    turnId,
    toolName: "Read",
    input: { file_path: "/home/user/quiet/a.ts" },
    startedAt: start + 1_000,
    durationMs: 100,
  });
}
