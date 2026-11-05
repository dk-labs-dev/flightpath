import type { Settings } from "../settings/index.js";
import type { Storage } from "../storage/index.js";
import { yieldToEventLoop } from "../util/event-loop.js";

// Retention (ADR-0025): recordings older than the period the
// user picked are deleted, the database never grows past a
// fixed size, and deleting gives the disk space back. The
// daemon runs this when it starts and every six hours after.
// Each session is deleted in its own transaction, yielding to
// the event loop between sessions, so a hook event is never
// held up by a cleanup.

export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DATABASE_SIZE_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The moment before which a session counts as no longer live:
 * a session silent for a day was killed before its end event
 * arrived, so it is not live any more, whatever its stored
 * status says. One definition, shared by the purge and the
 * settings screen's counts, so the two cannot drift apart.
 */
export function staleBefore(nowMs: number): number {
  return nowMs - DAY_MS;
}

interface RetentionRun {
  /** Sessions deleted for age. */
  aged: number;
  /** Sessions deleted to get under the size cap. */
  capped: number;
}

export interface Retention {
  runOnce(): Promise<RetentionRun>;
  /**
   * Delete every stored session, live ones included, marking
   * each one purged so the start-up import cannot bring it
   * back from its transcript.
   */
  deleteAllData(): Promise<number>;
}

export function createRetention(options: {
  storage: Storage;
  settings: () => Settings;
  /** An injected clock and cap, for tests. */
  now?: () => number;
  sizeCapBytes?: number;
}): Retention {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const cap = options.sizeCapBytes ?? DATABASE_SIZE_CAP_BYTES;

  // The vacuum's own changes go into the WAL, so the
  // checkpoint runs after it.
  const shrink = (): void => {
    storage.incrementalVacuum();
    storage.checkpointWal();
  };

  return {
    runOnce: async () => {
      const at = now();
      const cutoff = at - options.settings().retentionDays * DAY_MS;
      const staleCutoff = staleBefore(at);
      let aged = 0;
      for (const session of storage.sessionsToPurge(cutoff, staleCutoff)) {
        storage.purgeSession(session.id, at);
        aged += 1;
        await yieldToEventLoop();
      }
      let capped = 0;
      shrink();
      while (storage.databaseBytes() > cap) {
        const oldest = storage.oldestNonLiveSession(staleCutoff);
        if (oldest === null) break; // Only live sessions are left.
        storage.purgeSession(oldest.id, at);
        capped += 1;
        shrink();
        await yieldToEventLoop();
      }
      return { aged, capped };
    },
    deleteAllData: async () => {
      const at = now();
      const ids = storage.allSessionIds();
      for (const id of ids) {
        storage.purgeSession(id, at);
        await yieldToEventLoop();
      }
      shrink();
      return ids.length;
    },
  };
}
