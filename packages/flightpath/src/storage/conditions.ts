// The session_conditions statements every store module needs:
// the row's ensure-and-read pair, prepared once per module from
// this one copy of the SQL.

import type { DatabaseSync } from "./sqlite.js";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

export interface ConditionsStatements {
  getConditions: StatementSync;
  insertConditions: StatementSync;
}

export function prepareConditionsStatements(
  db: DatabaseSync,
): ConditionsStatements {
  return {
    getConditions: db.prepare(
      "SELECT * FROM session_conditions WHERE session_id = ?",
    ),
    insertConditions: db.prepare(
      "INSERT OR IGNORE INTO session_conditions (session_id, sources_seen, updated_at) VALUES (?, '[]', ?)",
    ),
  };
}
