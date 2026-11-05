// One step's detail: its panel facts in words, and the request
// that produced it — the latest request in the same turn and
// branch that started no later than the step did.

import { describeRequest, describeStep } from "../describe/index.js";
import type { RequestRow, Storage } from "../storage/index.js";
import { cacheWriteTokens } from "../storage/request-tokens.js";
import {
  loadSessionData,
  savedOutputSource,
  stepContext,
} from "./session-data.js";
import type { StepDetail, StepRequest } from "./payloads.js";

function stepRequest(request: RequestRow, telemetrySeen: boolean): StepRequest {
  return {
    id: request.id,
    model: request.model,
    startedAt: request.startedAt,
    durationMs: request.durationMs,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    cacheReadTokens: request.cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens(request),
    facts: describeRequest(request, { telemetrySeen }),
  };
}

/** GET /api/steps/:id — the panel facts in words, plus its request. */
export function stepDetail(
  storage: Storage,
  stepId: number,
): StepDetail | undefined {
  const step = storage.stepRowById(stepId);
  if (step === undefined) {
    return undefined;
  }
  const data = loadSessionData(storage, step.sessionId);
  if (data === undefined) {
    return undefined;
  }
  const turn =
    step.turnId === null ? undefined : data.turnsById.get(step.turnId);
  const described = describeStep(step, stepContext(step, turn, data));
  const producing = [...data.requests]
    .reverse()
    .find(
      (request) =>
        request.turnId === step.turnId &&
        request.branchId === step.branchId &&
        request.startedAt !== null &&
        step.startedAt !== null &&
        request.startedAt <= step.startedAt,
    );
  return {
    id: step.id,
    sessionId: step.sessionId,
    toolName: step.toolName,
    outcome: step.outcome,
    sentence: described.sentence,
    facts: described.facts,
    savedOutputStepId: savedOutputSource(step, data)?.id ?? null,
    requests:
      producing === undefined
        ? []
        : [stepRequest(producing, data.session.sources.includes("telemetry"))],
  };
}
