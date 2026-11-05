import type { DatabaseSync } from "../../src/storage/sqlite.js";
import { seedMoment, seedStep } from "./seed.js";

/** A launch notice is about this long, whichever subagent it announces. */
export const LAUNCH_NOTICE_CHARS = 1_132;

/**
 * An `Agent` step. A background launch (`asyncLaunch` 1)
 * returns only its notice; a synchronous one returns the
 * report.
 */
export function seedLaunch(
  db: DatabaseSync,
  launch: {
    id: number;
    sessionId: string;
    branchId?: number;
    subagentType: string;
    startedAt: number;
    asyncLaunch: number;
    resultRequestId?: number;
  },
): number {
  return seedStep(db, {
    id: launch.id,
    sessionId: launch.sessionId,
    turnId: 1,
    branchId: launch.branchId ?? null,
    toolName: "Agent",
    input: { subagent_type: launch.subagentType },
    startedAt: launch.startedAt,
    endedAt: launch.startedAt + 100,
    resultSize: LAUNCH_NOTICE_CHARS,
    resultRequestId: launch.resultRequestId ?? null,
    asyncLaunch: launch.asyncLaunch,
  });
}

/** The main thread receiving a subagent's report. */
export function seedHandback(
  db: DatabaseSync,
  handback: {
    sessionId: string;
    occurredAt: number;
    agentType: string;
    agentId: string;
    chars: number;
  },
): number {
  return seedMoment(db, {
    sessionId: handback.sessionId,
    turnId: 1,
    kind: "handback",
    occurredAt: handback.occurredAt,
    detail: JSON.stringify({
      agent_type: handback.agentType,
      agent_id: handback.agentId,
      chars: handback.chars,
    }),
  });
}
