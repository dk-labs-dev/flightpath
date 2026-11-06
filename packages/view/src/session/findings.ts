// The findings panel's pure parts: the row each finding is
// pinned to, what a row's marker says, and the list's line. A
// finding's own sentences are the API's and are printed as sent;
// the only words written here are the controls' and the counts'.

import type {
  Finding,
  FindingGrade,
} from "@flightpath/flightpath/api/payloads";

import { countLine } from "../counts.js";
import type { SessionData, StepRow } from "./types.js";

/** The row a finding is pinned to: a step, or a turn that ran no
 * step the finding could name. */
export type Anchor = { step: number } | { turn: number };

/** Each finding's anchor by finding id; null when the store holds
 * nothing to pin it to, so it is in the list only. */
export type Anchors = ReadonlyMap<string, Anchor | null>;

export const NO_ANCHORS: Anchors = new Map();

const GRADE_RANK: Record<FindingGrade, number> = {
  "Worth fixing": 0,
  "Worth a look": 1,
  "Did you know": 2,
};

const GRADE_CLASS: Record<FindingGrade, string> = {
  "Worth fixing": "grade-fix",
  "Worth a look": "grade-look",
  "Did you know": "grade-know",
};

export function gradeClass(grade: FindingGrade): string {
  return GRADE_CLASS[grade];
}

interface MainStepIndex {
  /** The first main-thread step whose result a request carried. */
  byRequest: Map<number, number>;
  firstInTurn: Map<number, number>;
}

// One pass over the steps, in recorded order. A subagent's
// steps never anchor a finding: the panel is about the main thread.
function indexMainSteps(
  stepsByTurn: SessionData["stepsByTurn"],
): MainStepIndex {
  const byRequest = new Map<number, number>();
  const firstInTurn = new Map<number, number>();
  for (const [turnId, steps] of stepsByTurn) {
    for (const step of steps) {
      if (step.branchId !== null) continue;
      if (!firstInTurn.has(turnId)) firstInTurn.set(turnId, step.id);
      if (
        step.resultRequestId !== null &&
        !byRequest.has(step.resultRequestId)
      ) {
        byRequest.set(step.resultRequestId, step.id);
      }
    }
  }
  return { byRequest, firstInTurn };
}

function turnAnchor(
  turnId: number | null,
  index: MainStepIndex,
  turns: SessionData["turns"],
): Anchor | null {
  if (turnId === null || !turns.has(turnId)) return null;
  const first = index.firstInTurn.get(turnId);
  return first === undefined ? { turn: turnId } : { step: first };
}

function sessionAnchor(
  index: MainStepIndex,
  turns: SessionData["turns"],
): Anchor | null {
  for (const turnId of turns.keys()) {
    const first = index.firstInTurn.get(turnId);
    if (first !== undefined) return { step: first };
  }
  const firstTurn = turns.keys().next();
  return firstTurn.done ? null : { turn: firstTurn.value };
}

function anchorOf(
  finding: Finding,
  index: MainStepIndex,
  turns: SessionData["turns"],
): Anchor | null {
  if (finding.requestId === null) return sessionAnchor(index, turns);
  const carrier = index.byRequest.get(finding.requestId);
  return carrier === undefined
    ? turnAnchor(finding.turnId, index, turns)
    : { step: carrier };
}

/**
 * Pin each finding to a row. A finding about a request goes to
 * the step whose result that request carried, else to the first
 * step of the request's turn, else to the turn. A finding about
 * the session as a whole goes to its first step. A finding the
 * store has nothing for, because the list is a moment behind the
 * stream, is pinned to nothing.
 */
export function anchorFindings(
  findings: readonly Finding[],
  data: Pick<SessionData, "turns" | "stepsByTurn">,
): Anchors {
  if (findings.length === 0) return NO_ANCHORS;
  const index = indexMainSteps(data.stepsByTurn);
  return new Map(
    findings.map((finding) => [
      finding.id,
      anchorOf(finding, index, data.turns),
    ]),
  );
}

/** The step an anchor names, when it names one. */
export function anchoredStep(anchor: Anchor | null | undefined): number | null {
  return anchor !== null && anchor !== undefined && "step" in anchor
    ? anchor.step
    : null;
}

/** The findings pinned to one step, in the API's order. */
export function findingsOnStep(
  findings: readonly Finding[],
  anchors: Anchors,
  stepId: number,
): Finding[] {
  return findings.filter(
    (finding) => anchoredStep(anchors.get(finding.id)) === stepId,
  );
}

/** What a row's marker draws: the worst grade on the row, and
 * how many more findings share it. */
export interface RowMarker {
  grade: FindingGrade;
  more: number;
}

export function worstGrade(grades: readonly FindingGrade[]): FindingGrade {
  return grades.reduce((worst, grade) =>
    GRADE_RANK[grade] < GRADE_RANK[worst] ? grade : worst,
  );
}

// A folded turn stands for the steps under it, so their markers
// show on its row until it is unfolded.
function markerKey(
  anchor: Anchor,
  steps: ReadonlyMap<number, StepRow>,
  foldedTurns: ReadonlySet<number>,
): string {
  if ("turn" in anchor) return `turn-${anchor.turn}`;
  const turnId = steps.get(anchor.step)?.turnId ?? null;
  return turnId !== null && foldedTurns.has(turnId)
    ? `turn-${turnId}`
    : `step-${anchor.step}`;
}

/** The marker for each row key that has findings. A row the
 * tree does not draw, because a filter hides it, is simply never
 * looked up: its finding stays in the list. */
export function rowMarkers(
  findings: readonly Finding[],
  anchors: Anchors,
  steps: ReadonlyMap<number, StepRow>,
  foldedTurns: ReadonlySet<number>,
): Map<string, RowMarker> {
  const gradesByRow = new Map<string, FindingGrade[]>();
  for (const finding of findings) {
    const anchor = anchors.get(finding.id);
    if (anchor === null || anchor === undefined) continue;
    const key = markerKey(anchor, steps, foldedTurns);
    gradesByRow.set(key, [...(gradesByRow.get(key) ?? []), finding.grade]);
  }
  return new Map(
    [...gradesByRow].map(([key, grades]) => [
      key,
      { grade: worstGrade(grades), more: grades.length - 1 },
    ]),
  );
}

/** The marker's accessible name: the worst grade, then the rest. */
export function markerName({ grade, more }: RowMarker): string {
  if (more === 0) return grade;
  return `${grade}, and ${countLine(more, "more suggestion", "more suggestions")}`;
}

/** The session list's line, such as "3 suggestions · 1 worth fixing"
 * or "1 suggestion · Did you know". Only the worst grade is said, so
 * the line stays short. */
export function listLine(findings: readonly Finding[]): string {
  const line = countLine(findings.length, "suggestion", "suggestions");
  const worst = worstGrade(findings.map((finding) => finding.grade));
  if (worst !== "Worth fixing") return `${line} · ${worst}`;
  const worth = findings.filter(
    (finding) => finding.grade === "Worth fixing",
  ).length;
  return `${line} · ${worth} worth fixing`;
}
