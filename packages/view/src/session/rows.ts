// The tree as a flat list of rows: turns with their steps,
// subagent branches and human moments nested by depth, and
// the session's events interleaved by time. Pure — the store's
// maps and the screen's choices go in, the rows the
// virtualized tree renders come out — so the shape is testable
// without a browser.
//
// A build walks each turn's own rows: the store keeps steps
// indexed by turn and by branch, and moments by turn, so a
// build is one pass over the rows themselves, never a pass
// over every step for every turn — plus one pass over the
// branches to place each subagent under the turn that
// launched it.

import type {
  ContextPoint,
  SessionEvent,
} from "@flightpath/flightpath/api/payloads";

import { STEPPED_IN_KINDS, type SessionData } from "./types.js";
import type { HumanRow, StepRow, TurnShell } from "./types.js";

export type Row =
  | {
      kind: "turn";
      key: string;
      turnId: number;
      /** The turn ran no step: there is nothing under it to expand. */
      stepless: boolean;
      depth: 0;
      setSize: number;
      posInSet: number;
    }
  | {
      kind: "step";
      key: string;
      stepId: number;
      depth: number;
      setSize: number;
      posInSet: number;
    }
  | {
      kind: "human";
      key: string;
      humanId: number;
      depth: number;
      setSize: number;
      posInSet: number;
    }
  | {
      kind: "branch";
      key: string;
      branchId: number;
      /** The step that started the subagent, when this turn holds it. */
      spawningStepId: number | null;
      /** 1 at a turn's top level; a subagent started inside
       * another sits one deeper than its parent. */
      depth: number;
      setSize: number;
      posInSet: number;
    }
  | {
      kind: "event";
      key: string;
      eventKey: string;
      /** A compaction: the one event that opens something. */
      compaction: boolean;
      depth: 0;
      setSize: number;
      posInSet: number;
    }
  | {
      kind: "waiting";
      key: string;
      depth: 0;
      text: string;
      setSize: number;
      posInSet: number;
    };

/** What activating a row does: a step opens its details, a
 * compaction opens the snapshot at the request after it, a
 * turn with steps folds or unfolds them, a turn without any
 * opens the snapshot at its last request, a subagent opens
 * the details of the step that started it (folding is then
 * the chevron's and the arrow keys'), and the rest — a human
 * moment, a pause, the waiting line — open nothing. */
export function rowAction(row: Row): "open" | "toggle" | null {
  switch (row.kind) {
    case "step":
      return "open";
    case "event":
      return row.compaction ? "open" : null;
    case "branch":
      return row.spawningStepId === null ? "toggle" : "open";
    case "turn":
      return row.stepless ? "open" : "toggle";
    default:
      return null;
  }
}

export interface RowChoices {
  collapsedTurns: ReadonlySet<number>;
  collapsedBranches: ReadonlySet<number>;
  failuresOnly: boolean;
  steppedInOnly: boolean;
  search: string;
  waiting: string | null;
}

/** The key a session event is held under: kind and id together. */
export function eventKey(event: SessionEvent): string {
  return `${event.kind}:${event.id}`;
}

interface TurnItems {
  turn: TurnShell;
  stepless: boolean;
  topLevel: TopItem[];
  branchSteps: Map<number, StepRow[]>;
  /** Each subagent's starting step, which its row stands for. */
  startedBy: Map<number, StepRow>;
  /** Subagents started inside a subagent, by the parent's
   * branch id: their rows nest in the parent's step list. */
  childrenOf: Map<number, number[]>;
}

/** Where every branch's row is placed, worked out once for a
 * whole build: each subagent shows once, under one turn. */
interface BranchPlan {
  /** The turn each branch's row lives under, by branch id. */
  homes: Map<number, number>;
  /** Every branch's steps, by branch id, in time order. */
  stepsByBranch: Map<number, StepRow[]>;
  /**
   * The steps of branches with no home, grouped by the turn
   * their stamps name, then by branch: the only placement a
   * homeless branch's steps get. A step that starts a branch
   * is left out — the branch it starts speaks for it.
   */
  looseByTurn: Map<number, Map<number, StepRow[]>>;
  /** Subagents started inside a subagent, by parent branch id. */
  childrenOf: Map<number, number[]>;
}

type TopItem =
  | { at: number; order: number; step: StepRow }
  | { at: number; order: number; human: HumanRow }
  | { at: number; order: number; branchId: number };

function filtering(choices: RowChoices): boolean {
  return choices.failuresOnly || choices.steppedInOnly || choices.search !== "";
}

// Every filter that is on has to hold: the toggles and the
// search combine, none of them wins by being checked first.
// A step is never a stepped-in moment, and a moment is never
// a failure — under those toggles the other kind drops out,
// as it does with one filter on.
function matchesStep(step: StepRow, choices: RowChoices): boolean {
  if (choices.failuresOnly && step.outcome !== "failed") return false;
  if (choices.steppedInOnly) return false;
  if (choices.search !== "") return matchesSearch(step.sentence, choices);
  return true;
}

function matchesHuman(human: HumanRow, choices: RowChoices): boolean {
  if (choices.failuresOnly) return false;
  if (choices.steppedInOnly && !STEPPED_IN_KINDS.has(human.kind)) return false;
  if (choices.search !== "") return matchesSearch(human.sentence, choices);
  return true;
}

function matchesEvent(event: SessionEvent, choices: RowChoices): boolean {
  if (choices.failuresOnly || choices.steppedInOnly) return false;
  if (choices.search !== "") return matchesSearch(event.sentence, choices);
  return true;
}

// A row is searched on its sentence: that is what a row
// carries — a step's path and command live in its detail,
// not in the summary the tree is built from.
function matchesSearch(sentence: string, choices: RowChoices): boolean {
  return sentence.toLowerCase().includes(choices.search.toLowerCase());
}

/** The subagent each step started, by step id: one pass over
 * the branches, shared by every turn's build. */
function branchesStartedBy(data: SessionData): Map<number, number> {
  const started = new Map<number, number>();
  for (const branch of data.branches.values()) {
    if (branch.spawningStepId !== null) {
      started.set(branch.spawningStepId, branch.id);
    }
  }
  return started;
}

function earliestStep(steps: StepRow[]): StepRow | undefined {
  return steps.reduce<StepRow | undefined>(
    (min, step) =>
      min === undefined || (step.startedAt ?? 0) < (min.startedAt ?? 0)
        ? step
        : min,
    undefined,
  );
}

/**
 * Place every branch once: under the turn of the step that
 * started it, when that step is known, or the turn of its
 * first step when it is not. A branch's steps follow it to
 * that turn however their own stamps read — a recording can
 * carry one subagent's steps stamped across several turns,
 * and it still shows as one subagent, once.
 */
function planBranches(
  data: SessionData,
  startedBranch: Map<number, number>,
): BranchPlan {
  const stepsByBranch = data.stepsByBranch;
  const homes = new Map<number, number>();
  for (const branch of data.branches.values()) {
    const starter =
      branch.spawningStepId !== null
        ? data.steps.get(branch.spawningStepId)
        : undefined;
    const home =
      starter?.turnId ??
      earliestStep(stepsByBranch.get(branch.id) ?? [])?.turnId;
    if (home !== undefined && home !== null) homes.set(branch.id, home);
  }
  const looseByTurn = new Map<number, Map<number, StepRow[]>>();
  for (const branch of data.branches.values()) {
    if (homes.has(branch.id)) continue;
    for (const step of stepsByBranch.get(branch.id) ?? []) {
      if (step.turnId === null || startedBranch.has(step.id)) continue;
      const byBranch = looseByTurn.get(step.turnId) ?? new Map();
      const list = byBranch.get(branch.id) ?? [];
      list.push(step);
      byBranch.set(branch.id, list);
      looseByTurn.set(step.turnId, byBranch);
    }
  }
  const childrenOf = new Map<number, number[]>();
  for (const [stepId, branchId] of startedBranch) {
    const starter = data.steps.get(stepId);
    if (starter === undefined || starter.branchId === null) continue;
    const list = childrenOf.get(starter.branchId) ?? [];
    list.push(branchId);
    childrenOf.set(starter.branchId, list);
  }
  return { homes, stepsByBranch, looseByTurn, childrenOf };
}

function gatherBranchSteps(
  data: SessionData,
  turn: TurnShell,
  plan: BranchPlan,
  branchSteps: Map<number, StepRow[]>,
  startedBy: Map<number, StepRow>,
): void {
  // A step inside a subagent is placed by its branch's home
  // below, never by the turn its own stamp names — unless the
  // branch has no home at all (no starting step and no step
  // stamped with a turn), when this turn's own grouping is
  // all there is.
  for (const [branchId, list] of plan.looseByTurn.get(turn.id) ?? []) {
    const stepsHere = branchSteps.get(branchId) ?? [];
    stepsHere.push(...list);
    stepsHere.sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id,
    );
    branchSteps.set(branchId, stepsHere);
  }
  // The branches homed in this turn bring all their steps
  // with them, and their starting steps with them too.
  for (const [branchId, home] of plan.homes) {
    if (home !== turn.id) continue;
    branchSteps.set(branchId, plan.stepsByBranch.get(branchId) ?? []);
    if (!startedBy.has(branchId)) {
      const starterId = data.branches.get(branchId)?.spawningStepId;
      const starter =
        starterId !== null && starterId !== undefined
          ? data.steps.get(starterId)
          : undefined;
      if (starter !== undefined) startedBy.set(branchId, starter);
    }
  }
}

function turnItems(
  data: SessionData,
  turn: TurnShell,
  startedBranch: Map<number, number>,
  plan: BranchPlan,
): TurnItems {
  const topLevel: TopItem[] = [];
  const branchSteps = new Map<number, StepRow[]>();
  const startedBy = new Map<number, StepRow>();
  const steps = data.stepsByTurn.get(turn.id) ?? [];
  for (const step of steps) {
    const started = startedBranch.get(step.id);
    if (started !== undefined) {
      // The subagent's row takes this step's place: one row
      // for the one thing that happened.
      startedBy.set(started, step);
      if (!branchSteps.has(started)) branchSteps.set(started, []);
    } else if (step.branchId === null) {
      topLevel.push({ at: step.startedAt ?? 0, order: step.id, step });
    }
  }
  gatherBranchSteps(data, turn, plan, branchSteps, startedBy);
  const childrenOf = new Map<number, number[]>();
  const nested = new Set<number>();
  for (const [parentId, children] of plan.childrenOf) {
    if (plan.homes.get(parentId) !== turn.id) continue;
    const here = children.filter(
      (childId) => plan.homes.get(childId) === turn.id,
    );
    if (here.length === 0) continue;
    childrenOf.set(parentId, here);
    for (const childId of here) nested.add(childId);
  }
  for (const human of data.humansByTurn.get(turn.id) ?? []) {
    if (human.kind === "prompt") continue;
    topLevel.push({ at: human.occurredAt, order: human.id, human });
  }
  for (const [branchId, steps] of branchSteps) {
    if (nested.has(branchId)) continue;
    const branch = data.branches.get(branchId);
    const first = earliestStep(steps);
    topLevel.push({
      at:
        branch?.startedAt ??
        startedBy.get(branchId)?.startedAt ??
        first?.startedAt ??
        0,
      order: startedBy.get(branchId)?.id ?? first?.id ?? 0,
      branchId,
    });
  }
  topLevel.sort((a, b) => a.at - b.at || a.order - b.order);
  return {
    turn,
    stepless: steps.length === 0,
    topLevel,
    branchSteps,
    startedBy,
    childrenOf,
  };
}

/** Whether a subagent's row shows under the filters: any of
 * its own steps matches, the step that started it does, or
 * a subagent nested inside it matches. */
function branchMatches(
  items: TurnItems,
  branchId: number,
  choices: RowChoices,
): boolean {
  const starter = items.startedBy.get(branchId);
  if (starter !== undefined && matchesStep(starter, choices)) return true;
  const steps = items.branchSteps.get(branchId) ?? [];
  if (steps.some((step) => matchesStep(step, choices))) return true;
  const children = items.childrenOf.get(branchId) ?? [];
  return children.some((childId) => branchMatches(items, childId, choices));
}

function turnVisible(items: TurnItems, choices: RowChoices): boolean {
  if (!filtering(choices)) return true;
  for (const item of items.topLevel) {
    if ("step" in item && matchesStep(item.step, choices)) return true;
    if ("human" in item && matchesHuman(item.human, choices)) return true;
    if ("branchId" in item && branchMatches(items, item.branchId, choices)) {
      return true;
    }
  }
  return false;
}

/** Sibling counts for a screen reader, set once a row's
 * set is complete: a row counts among the rows at its own
 * level under the same parent, never the whole flat list. */
function assignSiblings(siblings: Row[]): void {
  siblings.forEach((row, index) => {
    row.setSize = siblings.length;
    row.posInSet = index + 1;
  });
}

function appendTurnRows(
  rows: Row[],
  items: TurnItems,
  choices: RowChoices,
): Row {
  const { turn } = items;
  const active = filtering(choices);
  const turnRow: Row = {
    kind: "turn",
    key: `turn-${turn.id}`,
    turnId: turn.id,
    stepless: items.stepless,
    depth: 0,
    setSize: 0,
    posInSet: 0,
  };
  rows.push(turnRow);
  if (!active && choices.collapsedTurns.has(turn.id)) return turnRow;
  const children: Row[] = [];
  for (const item of items.topLevel) {
    if ("step" in item) {
      if (matchesStep(item.step, choices)) {
        children.push({
          kind: "step",
          key: `step-${item.step.id}`,
          stepId: item.step.id,
          depth: 1,
          setSize: 0,
          posInSet: 0,
        });
      }
    } else if ("human" in item) {
      if (matchesHuman(item.human, choices)) {
        children.push({
          kind: "human",
          key: `human-${item.human.id}`,
          humanId: item.human.id,
          depth: 1,
          setSize: 0,
          posInSet: 0,
        });
      }
    } else {
      appendBranchRows(children, items, item.branchId, choices, 1);
    }
  }
  assignSiblings(children.filter((row) => row.depth === 1));
  rows.push(...children);
  return turnRow;
}

function appendBranchRows(
  rows: Row[],
  items: TurnItems,
  branchId: number,
  choices: RowChoices,
  depth: number,
): void {
  const steps = items.branchSteps.get(branchId) ?? [];
  if (filtering(choices) && !branchMatches(items, branchId, choices)) return;
  const starter = items.startedBy.get(branchId);
  rows.push({
    kind: "branch",
    // A subagent's row stands for the step that started it, so
    // it carries that step's key: whatever finds a step's row
    // (scrolling to it, restoring a place, returning focus)
    // finds the subagent's.
    key: starter === undefined ? `branch-${branchId}` : `step-${starter.id}`,
    branchId,
    spawningStepId: starter?.id ?? null,
    depth,
    setSize: 0,
    posInSet: 0,
  });
  if (!filtering(choices) && choices.collapsedBranches.has(branchId)) return;
  // The branch's own rows, one level deeper: its steps, with
  // a nested subagent's row standing in its starting step's
  // place, the way this branch's row stands in its own.
  const childOf = new Map<number, number>();
  for (const childId of items.childrenOf.get(branchId) ?? []) {
    const childStarter = items.startedBy.get(childId);
    if (childStarter !== undefined) childOf.set(childStarter.id, childId);
  }
  const level: Row[] = [];
  for (const step of steps) {
    const childId = childOf.get(step.id);
    if (childId !== undefined) {
      appendBranchRows(level, items, childId, choices, depth + 1);
    } else if (matchesStep(step, choices)) {
      level.push({
        kind: "step",
        key: `step-${step.id}`,
        stepId: step.id,
        depth: depth + 1,
        setSize: 0,
        posInSet: 0,
      });
    }
  }
  assignSiblings(level.filter((row) => row.depth === depth + 1));
  rows.push(...level);
}

/** The last context value at or before `at`, or null before the first sample. */
export function contextAt(
  samples: ContextPoint[],
  at: number | null,
): number | null {
  if (at === null) return null;
  let value: number | null = null;
  for (const sample of samples) {
    if (sample.at > at) break;
    value = sample.contextTokens;
  }
  return value;
}

/** A turn's context change: the value it started and ended at,
 * read from the turn's own steps. */
export function turnContextRange(
  turnSteps: readonly StepRow[],
  samples: ContextPoint[],
  turn: TurnShell,
): { before: number; after: number } | null {
  const steps = turnSteps.filter((step) => step.startedAt !== null);
  if (steps.length === 0 || samples.length === 0) return null;
  const firstAt = Math.min(...steps.map((step) => step.startedAt ?? 0));
  const before = contextAt(samples, firstAt - 1);
  const after = contextAt(samples, turn.endedAt ?? Number.MAX_VALUE);
  if (before === null || after === null) return null;
  return { before, after };
}

export function buildRows(data: SessionData, choices: RowChoices): Row[] {
  const rows: Row[] = [];
  const turns = [...data.turns.values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const events = [...data.events.values()]
    .filter((event) => matchesEvent(event, choices))
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const startedBranch = branchesStartedBy(data);
  const plan = planBranches(data, startedBranch);
  let eventIndex = 0;
  const level1: Row[] = [];
  const pushEvent = (event: SessionEvent): void => {
    const row: Row = {
      kind: "event",
      key: `event-${eventKey(event)}`,
      eventKey: eventKey(event),
      compaction: event.segmentKind === "compact",
      depth: 0,
      setSize: 0,
      posInSet: 0,
    };
    rows.push(row);
    level1.push(row);
  };
  for (const turn of turns) {
    const items = turnItems(data, turn, startedBranch, plan);
    if (!turnVisible(items, choices)) continue;
    const turnAt = turn.startedAt ?? items.topLevel[0]?.at ?? 0;
    while (eventIndex < events.length) {
      const event = events[eventIndex];
      if (event === undefined || event.at >= turnAt) break;
      pushEvent(event);
      eventIndex += 1;
    }
    level1.push(appendTurnRows(rows, items, choices));
  }
  while (eventIndex < events.length) {
    const event = events[eventIndex];
    if (event !== undefined) pushEvent(event);
    eventIndex += 1;
  }
  assignSiblings(level1);
  if (choices.waiting !== null) {
    // The waiting line stands out of the tree's roles, so
    // its counts are its own set of one.
    rows.push({
      kind: "waiting",
      key: "waiting",
      depth: 0,
      text: choices.waiting,
      setSize: 1,
      posInSet: 1,
    });
  }
  if (process.env.NODE_ENV !== "production") {
    refuseRepeatedRowKeys(rows);
  }
  return rows;
}

/**
 * The tree keys rows by their key: two rows under one key
 * open together and scroll together, which reads as one
 * subagent drawn over another. Outside production builds
 * the build refuses a repeated key outright, so a placement
 * bug fails loudly where it is written instead of quietly
 * in the tree.
 */
function refuseRepeatedRowKeys(rows: Row[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) {
      throw new Error(`two rows under one key: ${row.key}`);
    }
    seen.add(row.key);
  }
}

/** Items whose time is null are skipped. */
export function nearestInTime<T>(
  items: Iterable<T>,
  at: number,
  timeOf: (item: T) => number | null,
): T | null {
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const time = timeOf(item);
    if (time === null) continue;
    const gap = Math.abs(time - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = item;
    }
  }
  return best;
}

export function nearestStepId(
  steps: Map<number, StepRow>,
  at: number,
): number | null {
  return (
    nearestInTime(steps.values(), at, (step) => step.startedAt)?.id ?? null
  );
}
