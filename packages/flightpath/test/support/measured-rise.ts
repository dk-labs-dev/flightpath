import type { DatabaseSync } from "../../src/storage/sqlite.js";
import {
  seedLoad,
  seedMoment,
  seedRequestExact,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./seed.js";

/** The id of the session `seedRiseRead` is called with. */
export const RISE_SESSION = "sess-rise";

/** What the read below measures to, and what its characters
 * estimate to, so a test states neither as a bare number. */
export const RISE_READ = {
  measuredTokens: 23_578,
  estimatedTokens: 12_693,
  path: "data/records.csv",
} as const;

/**
 * A numeric file read shaped like a real one: Claude's
 * 67-token reply asks for it, the result is 36,807 characters,
 * and the next request's context stands 23,645 tokens above
 * the one before it — a cache write, the cache read unchanged.
 * Returns the step's id.
 */
export function seedRiseRead(db: DatabaseSync, sessionId: string): number {
  seedSession(db, { id: sessionId });
  seedTurn(db, {
    id: 1,
    sessionId,
    sequence: 1,
    startedAt: 0,
    endedAt: 9_000,
    promptChars: 40,
  });
  seedRequestExact(db, {
    id: 1,
    sessionId,
    turnId: 1,
    startedAt: 1_000,
    input: 2,
    cacheRead: 46_696,
    output: 67,
  });
  seedRequestExact(db, {
    id: 2,
    sessionId,
    turnId: 1,
    startedAt: 5_000,
    input: 2,
    cacheRead: 46_696,
    cacheWrite5m: 23_645,
    output: 40,
  });
  return seedStep(db, {
    id: 1,
    sessionId,
    turnId: 1,
    toolName: "Read",
    input: { file_path: RISE_READ.path },
    startedAt: 2_000,
    endedAt: 4_000,
    resultSize: 36_807,
    resultRequestId: 2,
  });
}

/** A moment between the read's two requests, at 1,000 and 5,000. */
export const BETWEEN = 3_000;

function setSecondRequest(
  db: DatabaseSync,
  column: string,
  value: string | number | null,
): void {
  db.prepare(`UPDATE requests SET ${column} = ? WHERE id = 2`).run(value);
}

/** Rises too small for the reply and the result to share:
 * the token history lists no rise this small, so only the
 * snapshot reads them. */
export const RISE_TOO_SMALL: {
  name: string;
  change: (db: DatabaseSync) => void;
}[] = [
  {
    name: "a rise that leaves under 10 tokens after the reply",
    change: (db) => setSecondRequest(db, "cache_write_5m_tokens", 76),
  },
  {
    name: "a rise smaller than the reply",
    change: (db) => setSecondRequest(db, "cache_write_5m_tokens", 20),
  },
];

/** The kinds of moment that put text of its own into the
 * context, as opposed to answering a permission prompt. */
const CONTEXT_MOMENT_KINDS = ["command", "handback", "notice", "interrupt"];

/**
 * Each change to the read's world that leaves its rise
 * holding more than the result and the reply, or no reply
 * to take away: after it the read keeps its estimate.
 */
export const ESTIMATE_KEPT: {
  name: string;
  change: (db: DatabaseSync, sessionId: string) => void;
}[] = [
  {
    name: "a second tool result in the same request",
    change: (db, sessionId) => {
      seedStep(db, {
        id: 2,
        sessionId,
        turnId: 1,
        toolName: "Bash",
        startedAt: 2_500,
        endedAt: 4_200,
        resultSize: 900,
        resultRequestId: 2,
      });
    },
  },
  {
    name: "a compaction between the two requests",
    change: (db, sessionId) => {
      seedSegment(db, { sessionId, kind: "compact", startedAt: BETWEEN });
    },
  },
  {
    name: "a new prompt before the second request",
    change: (db, sessionId) => {
      seedTurn(db, {
        id: 2,
        sessionId,
        sequence: 2,
        startedAt: 4_500,
        promptChars: 30,
      });
      setSecondRequest(db, "turn_id", 2);
    },
  },
  {
    name: "a skill loaded in between",
    change: (db, sessionId) => {
      seedLoad(db, {
        sessionId,
        kind: "skill",
        name: "example-skill",
        occurredAt: BETWEEN,
      });
    },
  },
  {
    name: "a model switch",
    change: (db) => setSecondRequest(db, "model", "claude-opus-5-5"),
  },
  {
    name: "a cache rebuild",
    change: (db) => {
      setSecondRequest(db, "cache_read_tokens", 10_000);
      setSecondRequest(db, "cache_write_5m_tokens", 60_343);
    },
  },
  {
    name: "a reply whose output was not recorded",
    change: (db) => {
      db.prepare("UPDATE requests SET output_tokens = NULL WHERE id = 1").run();
    },
  },
  ...CONTEXT_MOMENT_KINDS.map((kind) => ({
    name: `a ${kind} moment in between`,
    change: (db: DatabaseSync, sessionId: string) => {
      seedMoment(db, { sessionId, turnId: 1, kind, occurredAt: BETWEEN });
    },
  })),
];
