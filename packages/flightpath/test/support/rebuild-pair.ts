import type { DatabaseSync } from "../../src/storage/sqlite.js";
import { seedOneTurn, seedRequestExact } from "./seed.js";

export type PairSeed = Omit<
  Parameters<typeof seedRequestExact>[1],
  "id" | "sessionId"
>;

/** The stage for the cache rebuild tests: a first request that
 * read a warm cache, and a second that rewrote most of the
 * context it sent. Each test overrides what its rule needs. */
export function seedWarmPair(
  db: DatabaseSync,
  sessionId: string,
  first: PairSeed,
  second: PairSeed,
): void {
  seedOneTurn(db, sessionId);
  seedRequestExact(db, {
    id: 1,
    sessionId,
    startedAt: 1_000,
    input: 1_000,
    output: 500,
    cacheRead: 80_000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...first,
  });
  seedRequestExact(db, {
    id: 2,
    sessionId,
    startedAt: 61_000,
    input: 1_000,
    output: 500,
    cacheRead: 5_000,
    cacheWrite5m: 0,
    cacheWrite1h: 60_000,
    ...second,
  });
}
