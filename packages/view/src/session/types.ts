// The session screen's own shapes: the read API's payload
// types are imported, not repeated; these are what the
// screen derives — rows that know their turn, and the maps
// the store holds, the rows also indexed by turn.

import type {
  BranchSummary,
  ContextPoint,
  HumanMoment,
  SessionEvent,
  StepSummary,
  TurnSummary as WireTurnSummary,
} from "@flightpath/flightpath/api/payloads";

export type TurnShell = Omit<WireTurnSummary, "steps" | "humanMoments"> & {
  promptSentence: string | null;
};

/** A step as the screen holds it: its summary plus its turn. */
export interface StepRow extends StepSummary {
  turnId: number | null;
}

export interface HumanRow extends HumanMoment {
  turnId: number | null;
}

/** The snapshot's content as the store holds it, keyed by id. */
export interface SessionData {
  turns: Map<number, TurnShell>;
  steps: Map<number, StepRow>;
  humans: Map<number, HumanRow>;
  branches: Map<number, BranchSummary>;
  events: Map<string, SessionEvent>;
  samples: ContextPoint[];
  /** Each turn's own rows, in the order they were recorded. */
  stepsByTurn: Map<number, StepRow[]>;
  humansByTurn: Map<number, HumanRow[]>;
  /** Each branch's steps, in the order they started. */
  stepsByBranch: Map<number, StepRow[]>;
  /** The steps still running, kept current as changes land. */
  openStepIds: ReadonlySet<number>;
}

/** The human-moment kinds that count as the user stepping in. */
export const STEPPED_IN_KINDS: ReadonlySet<string> = new Set([
  "permission_decision",
  "rejection",
  "interrupt",
  "question_answered",
  "command",
]);
