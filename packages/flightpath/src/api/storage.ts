// The storage summary: the session picker's retention line reads it.

import type { Storage } from "../storage/index.js";

interface StorageSummary {
  sessions: number;
  databaseBytes: number;
}

/** GET /api/storage — sessions stored and database size. */
export function storageSummary(storage: Storage): StorageSummary {
  return {
    sessions: storage.countSessions(),
    databaseBytes: storage.databaseBytes(),
  };
}
