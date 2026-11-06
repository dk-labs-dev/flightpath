import { mkdirSync } from "node:fs";

import { openStorage } from "../../src/storage/index.js";
import { DatabaseSync } from "../../src/storage/sqlite.js";
import {
  makeRoot,
  startTestDaemon,
  stopDaemon,
  type StartedDaemon,
} from "./daemon.js";
import { registerCleanup } from "./cleanup.js";
import { seedRequestExact, seedSession, seedTurn } from "./seed.js";

// Sessions whose turns end with a known number of findings, for the
// tests of the end-of-turn line. Findings come from the same chain of
// requests everywhere: a warm cache, an expiry after a gap of 71
// minutes (the first expiry is worth a look), a read, and a second
// expiry (worth fixing).
const CHAIN = [
  { startedAt: 1_000, cacheRead: 80_000, cacheWrite1h: 5_000 },
  { startedAt: 4_289_800, cacheRead: 5_000, cacheWrite1h: 62_380 },
  { startedAt: 4_349_800, cacheRead: 68_000, cacheWrite1h: 0 },
  { startedAt: 8_609_800, cacheRead: 5_000, cacheWrite1h: 62_000 },
  { startedAt: 8_669_800, cacheRead: 67_000, cacheWrite1h: 0 },
];

/** The sessions and the prompt ids of their turns. */
export const LINE_WORLD = {
  // Turn 1 ends with one finding worth a look, turn 2 with one worth
  // fixing, turn 3 with none.
  mixed: {
    id: "sess-line",
    lookPrompt: "prompt-look",
    fixPrompt: "prompt-fix",
    cleanPrompt: "prompt-clean",
    fixFinding: "rebuild-4",
  },
  // One turn with both findings: two suggestions, one worth fixing.
  several: { id: "sess-several", prompt: "prompt-several" },
  // A finding on a request that ran outside any turn.
  outsideTurn: { id: "sess-outside", prompt: "prompt-outside" },
} as const;

function seedChain(
  db: DatabaseSync,
  sessionId: string,
  firstRequestId: number,
  turnIds: (number | null)[],
): void {
  turnIds.forEach((turnId, index) => {
    const step = CHAIN[index];
    if (step === undefined) throw new Error("the chain has five requests");
    seedRequestExact(db, {
      id: firstRequestId + index,
      sessionId,
      turnId,
      input: 1_000,
      cacheWrite5m: 0,
      ...step,
    });
  });
}

function seedTurns(
  db: DatabaseSync,
  sessionId: string,
  turns: { id: number; promptId: string }[],
): void {
  turns.forEach(({ id, promptId }, index) => {
    seedTurn(db, { id, sessionId, promptId, sequence: index + 1 });
  });
}

function seedLineWorld(db: DatabaseSync): void {
  // Retention would purge a session last seen at the epoch.
  const seen = Date.now() - 7_200_000;
  const { mixed, several, outsideTurn } = LINE_WORLD;
  for (const id of [mixed.id, several.id, outsideTurn.id]) {
    seedSession(db, { id, firstSeenAt: seen, lastSeenAt: seen });
  }
  seedTurns(db, mixed.id, [
    { id: 9011, promptId: mixed.lookPrompt },
    { id: 9012, promptId: mixed.fixPrompt },
    { id: 9013, promptId: mixed.cleanPrompt },
  ]);
  seedChain(db, mixed.id, 1, [9011, 9011, 9012, 9012, 9013]);
  seedTurns(db, several.id, [{ id: 9021, promptId: several.prompt }]);
  seedChain(db, several.id, 21, [9021, 9021, 9021, 9021]);
  seedTurns(db, outsideTurn.id, [{ id: 9031, promptId: outsideTurn.prompt }]);
  seedChain(db, outsideTurn.id, 31, [null, null]);
}

/** A running daemon over the sessions above, and over whatever `seedMore` adds. */
export async function startLineDaemon(
  seedMore?: (db: DatabaseSync) => void,
): Promise<StartedDaemon> {
  const { root, dataDir } = makeRoot("flightpath-line-");
  mkdirSync(dataDir, { recursive: true });
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    seedLineWorld(db);
    seedMore?.(db);
  } finally {
    db.close();
    storage.close();
  }
  const daemon = await startTestDaemon(root, {
    startOptions: { idleMs: "600000" },
  });
  registerCleanup(() => stopDaemon(daemon.child));
  return daemon;
}
