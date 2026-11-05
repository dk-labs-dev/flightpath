// The branch-link statements every store module needs: one
// copy of the SQL, so the journey builder and the transcript
// ingest land the one link rule the same way.

import type { DatabaseSync } from "./sqlite.js";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

export interface BranchLinkStatements {
  setBranchSpawningStep: StatementSync;
  restampBranchSteps: StatementSync;
}

export function prepareBranchLinkStatements(
  db: DatabaseSync,
): BranchLinkStatements {
  return {
    setBranchSpawningStep: db.prepare(
      "UPDATE branches SET spawning_step_id = ? WHERE id = ?",
    ),
    restampBranchSteps: db.prepare(
      "UPDATE steps SET turn_id = ? WHERE branch_id = ?",
    ),
  };
}

/**
 * The one link rule, landed the same way however late the
 * link arrives: the subagent's work reads under the turn
 * that launched it.
 */
export function linkBranchToStep(
  st: BranchLinkStatements,
  branchId: number,
  stepId: number,
  stepTurnId: number | null,
): void {
  st.setBranchSpawningStep.run(stepId, branchId);
  if (typeof stepTurnId === "number") {
    st.restampBranchSteps.run(stepTurnId, branchId);
  }
}
