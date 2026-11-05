// Shaping: turning one session's held rows into the stream's
// change messages. A pass describes only what its plan names
// — the turns that moved (their steps and moments ride with
// them), the steps, moments, branches, segments, pauses and
// samples that changed — and a shaped row is sent only when
// its JSON differs from the last shaping, so a pass that
// finds nothing new says nothing.

import {
  branchSummaryOf,
  pauseEventOf,
  segmentEventOf,
  snapshotSummary,
  stepSummaryOf,
  turnSummariesFor,
  type SessionData,
  type StepSummary,
  type TurnHead,
  type TurnSummary,
} from "../api/index.js";
import type { SessionCapture } from "./stream-capture.js";
import type { StreamMessage } from "./stream-messages.js";
import { pickerRowChange, type StreamHubState } from "./stream.js";

/** What one capture pass describes and considers sending. */
export interface CapturePlan {
  turnIds: Set<number>;
  stepIds: Set<number>;
  humanIds: Set<number>;
  branchIds: Set<number>;
  segmentIds: Set<number>;
  pauseIds: Set<number>;
  sampleIds: Set<number>;
  stepTurnIds: Map<number, number>;
  humanTurnIds: Map<number, number>;
}

/** Where a pass's messages go: the session's own stream, and
 * the picker's stream for its list row. */
export interface ShapeEmit {
  session: (message: StreamMessage) => void;
  picker: (message: StreamMessage) => void;
}

function sorted(ids: Set<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

export function shapeSessionChanges(
  hub: StreamHubState,
  capture: SessionCapture,
  data: SessionData,
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  const slice = turnSummariesFor(data, hub.settings(), plan.turnIds);
  emitTurns(capture, slice.turns, sessionId, emit);
  emitSteps(capture, data, slice.turns, plan, emit);
  emitHumans(capture, data, slice.turns, plan, emit);
  emitBranches(capture, data, plan, emit);
  emitSegmentsAndPauses(capture, data, plan, emit);
  emitSamples(data, plan, emit);
  emitSummary(hub, capture, data, slice, emit);
}

function emitTurns(
  capture: SessionCapture,
  turns: TurnSummary[],
  sessionId: string,
  emit: ShapeEmit,
): void {
  for (const turn of turns) {
    const head: TurnHead = {
      id: turn.id,
      sequence: turn.sequence,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      failures: turn.failures,
      steppedIn: turn.steppedIn,
      images: turn.images,
      files: turn.files,
    };
    const json = JSON.stringify(head);
    if (capture.turnJson.get(turn.id) === json) continue;
    capture.turnJson.set(turn.id, json);
    emit.session({ event: "turn", data: { sessionId, turn: head } });
  }
}

function emitSteps(
  capture: SessionCapture,
  data: SessionData,
  turns: TurnSummary[],
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  const described = new Map<number, StepSummary>();
  for (const turn of turns) {
    for (const step of turn.steps) {
      described.set(step.id, step);
    }
  }
  for (const id of sorted(plan.stepIds)) {
    let summary = described.get(id);
    if (summary === undefined) {
      const row = data.stepsById.get(id);
      if (row === undefined) continue;
      const turnId = plan.stepTurnIds.get(id);
      summary = stepSummaryOf(
        row,
        turnId === undefined ? undefined : data.turnsById.get(turnId),
        data,
      );
    }
    const json = JSON.stringify(summary);
    if (capture.stepJson.get(id) === json) continue;
    capture.stepJson.set(id, json);
    emit.session({
      event: "step",
      data: {
        sessionId,
        turnId: plan.stepTurnIds.get(id) ?? null,
        step: summary,
      },
    });
  }
  for (const id of capture.stepJson.keys()) {
    if (!capture.openSteps.has(id) && !capture.watchSteps.has(id)) {
      capture.stepJson.delete(id);
    }
  }
}

function emitHumans(
  capture: SessionCapture,
  data: SessionData,
  turns: TurnSummary[],
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  const described = new Map<
    number,
    { moment: TurnSummary["humanMoments"][number]; turnId: number }
  >();
  for (const turn of turns) {
    for (const moment of turn.humanMoments) {
      described.set(moment.id, { moment, turnId: turn.id });
    }
  }
  for (const id of sorted(plan.humanIds)) {
    const entry = described.get(id);
    if (entry === undefined) continue;
    const json = JSON.stringify(entry.moment);
    if (capture.humanJson.get(id) === json) continue;
    capture.humanJson.set(id, json);
    emit.session({
      event: "human",
      data: { sessionId, turnId: entry.turnId, human: entry.moment },
    });
  }
  for (const id of capture.humanJson.keys()) {
    if (plan.humanTurnIds.get(id) !== capture.openTurnId) {
      capture.humanJson.delete(id);
    }
  }
}

function emitBranches(
  capture: SessionCapture,
  data: SessionData,
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  for (const id of sorted(plan.branchIds)) {
    const row = data.branchesById.get(id);
    if (row === undefined) continue;
    const summary = branchSummaryOf(data, row);
    const json = JSON.stringify(summary);
    if (capture.branchJson.get(id) === json) continue;
    capture.branchJson.set(id, json);
    emit.session({ event: "branch", data: { sessionId, branch: summary } });
  }
}

function emitSegmentsAndPauses(
  capture: SessionCapture,
  data: SessionData,
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  const segmentsById = new Map(data.segments.map((s) => [s.id, s]));
  for (const id of sorted(plan.segmentIds)) {
    const row = segmentsById.get(id);
    if (row === undefined) continue;
    const event = segmentEventOf(data, row);
    emit.session({ event: "segment", data: { sessionId, event } });
  }
  const pausesById = new Map(data.pauses.map((p) => [p.id, p]));
  for (const id of sorted(plan.pauseIds)) {
    const row = pausesById.get(id);
    if (row === undefined) continue;
    const event = pauseEventOf(row);
    const json = JSON.stringify(event);
    if (capture.pauseJson.get(id) === json) continue;
    capture.pauseJson.set(id, json);
    emit.session({ event: "segment", data: { sessionId, event } });
  }
}

function emitSamples(
  data: SessionData,
  plan: CapturePlan,
  emit: ShapeEmit,
): void {
  if (plan.sampleIds.size === 0) return;
  const sessionId = data.session.id;
  // The strip is the main conversation's: the stream sends the
  // main thread's samples, the same split the snapshot uses,
  // so a subagent's sample never reaches it live.
  const mainSamples = data.samplesByBranch.get(null) ?? [];
  const samplesById = new Map(mainSamples.map((s) => [s.id, s]));
  for (const id of sorted(plan.sampleIds)) {
    const row = samplesById.get(id);
    if (row === undefined) continue;
    const point = {
      id: row.id,
      at: row.sampledAt,
      contextTokens: row.contextTokens,
    };
    emit.session({ event: "context", data: { sessionId, point } });
  }
}

function emitSummary(
  hub: StreamHubState,
  capture: SessionCapture,
  data: SessionData,
  totals: { failures: number; steppedIn: number },
  emit: ShapeEmit,
): void {
  const sessionId = data.session.id;
  const settings = hub.settings();
  const summary = snapshotSummary(data, hub.storage, settings, totals);
  const summaryJson = JSON.stringify(summary);
  if (summaryJson !== capture.summaryJson) {
    capture.summaryJson = summaryJson;
    emit.session({ event: "session", data: { sessionId, summary } });
  }
  const pickerState = hub.picker.get(sessionId);
  if (pickerState !== undefined) {
    const change = pickerRowChange(
      pickerState,
      data.session,
      settings,
      hub.storage,
    );
    if (change !== undefined) {
      emit.picker({ event: "session", data: change });
    }
  }
}
