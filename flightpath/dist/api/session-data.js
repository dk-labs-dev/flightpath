// One session's stored rows, loaded once and shared by the
// snapshot and the step detail, plus the surroundings a step's
// description is told about: its turn, its branch, what the
// context held around it, and who approved it.
import { describeBranch, describeStep, savedOutputToolUseId, } from "../describe/index.js";
import { cacheWriteTokens } from "../storage/request-tokens.js";
import { num, parseRecord, str } from "../util/json.js";
function groupSamplesByBranch(requests, samples) {
    const branchOfRequest = new Map(requests.map((request) => [request.id, request.branchId]));
    const grouped = new Map();
    for (const sample of samples) {
        const branchId = sample.requestId === null
            ? null
            : (branchOfRequest.get(sample.requestId) ?? null);
        const own = grouped.get(branchId) ?? [];
        own.push(sample);
        grouped.set(branchId, own);
    }
    return grouped;
}
function firstHandbackByAgent(humans) {
    const byAgent = new Map();
    for (const event of humans) {
        if (event.kind !== "handback")
            continue;
        const detail = parseRecord(event.detail);
        const agentId = str(detail, "agent_id");
        const chars = num(detail, "chars");
        if (agentId === undefined || chars === undefined || byAgent.has(agentId)) {
            continue;
        }
        byAgent.set(agentId, {
            occurredAt: event.occurredAt,
            agentType: str(detail, "agent_type"),
            chars,
        });
    }
    return byAgent;
}
function buildSessionData(session, rows) {
    const { turns, steps, humans, branches } = rows;
    const decisionByStep = new Map();
    for (const event of humans) {
        if (event.kind === "permission_decision" &&
            event.stepId !== null &&
            !decisionByStep.has(event.stepId)) {
            decisionByStep.set(event.stepId, event);
        }
    }
    const stepsByResult = new Map();
    for (const step of steps) {
        if (step.resultRequestId === null)
            continue;
        const own = stepsByResult.get(step.resultRequestId) ?? [];
        own.push(step);
        stepsByResult.set(step.resultRequestId, own);
    }
    const skillFilesByLoad = new Map();
    for (const load of rows.loads) {
        if (load.kind !== "skill-file" || load.parentLoadId === null)
            continue;
        const own = skillFilesByLoad.get(load.parentLoadId) ?? [];
        own.push(load);
        skillFilesByLoad.set(load.parentLoadId, own);
    }
    return {
        session,
        ...rows,
        stepsById: new Map(steps.map((step) => [step.id, step])),
        turnsById: new Map(turns.map((turn) => [turn.id, turn])),
        branchesById: new Map(branches.map((branch) => [branch.id, branch])),
        branchBySpawningStep: new Map(branches.flatMap((branch) => branch.spawningStepId === null
            ? []
            : [[branch.spawningStepId, branch]])),
        decisionByStep,
        samplesByBranch: groupSamplesByBranch(rows.requests, rows.samples),
        handbackByAgent: firstHandbackByAgent(humans),
        stepsByResult,
        stepsByToolUse: new Map(steps.flatMap((step) => step.toolUseId === null ? [] : [[step.toolUseId, step]])),
        skillFilesByLoad,
    };
}
/** A branch's hand-back, matched by agent id alone. */
export function handbackOf(data, branch) {
    return branch.agentId === null
        ? undefined
        : data.handbackByAgent.get(branch.agentId);
}
/** Whether the step's result only announced a subagent that
 * runs in the background: its report comes later, as a
 * hand-back. */
export function launchedInBackground(step) {
    return step.asyncLaunch === 1;
}
/** The reports of the background subagents launched from one
 * thread; a subagent started by another subagent reports to
 * that subagent's thread, not to the main one. */
export function backgroundReports(data, branchId) {
    const reports = [];
    for (const branch of data.branches) {
        const handback = handbackOf(data, branch);
        const spawning = branch.spawningStepId === null
            ? undefined
            : data.stepsById.get(branch.spawningStepId);
        if (handback === undefined || spawning === undefined)
            continue;
        if (spawning.branchId !== branchId || !launchedInBackground(spawning)) {
            continue;
        }
        reports.push({ branch, spawning, handback });
    }
    return reports;
}
export function loadSessionData(storage, sessionId) {
    const session = storage.sessionRow(sessionId);
    if (session === undefined) {
        return undefined;
    }
    return buildSessionData(session, {
        turns: storage.turnRows(sessionId),
        steps: storage.stepRows(sessionId),
        humans: storage.humanRows(sessionId),
        branches: storage.branchRows(sessionId),
        requests: storage.requestRows(sessionId),
        samples: storage.contextSampleRows(sessionId),
        contextReports: storage.contextReportsFor(sessionId),
        segments: storage.segmentRows(sessionId),
        pauses: storage.pauseRows(sessionId),
        loads: storage.loadRows(sessionId),
        promptAttachments: storage.promptAttachmentRows(sessionId),
        compactionFiles: storage.compactionFileRows(sessionId),
        requestShapes: storage.requestShapeRows(sessionId),
    });
}
function upsertRows(rows, fresh, compare) {
    if (fresh === undefined || fresh.length === 0) {
        return rows;
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of fresh) {
        byId.set(row.id, row);
    }
    return [...byId.values()].sort(compare);
}
function byTimeThenId(a, b) {
    const atA = a.at ?? Number.NEGATIVE_INFINITY;
    const atB = b.at ?? Number.NEGATIVE_INFINITY;
    return atA - atB || a.id - b.id;
}
/**
 * Fold rows read since a watcher's last pass into the rows it
 * already holds, keeping each table in the order its full
 * read returns, so the merged session reads exactly as a
 * fresh load would.
 */
/** The delta's session row when it is all the delta holds. */
function sessionOnlyRow(delta) {
    if (delta.session === undefined)
        return null;
    const tables = [
        delta.turns,
        delta.steps,
        delta.humans,
        delta.branches,
        delta.requests,
        delta.samples,
        delta.segments,
        delta.pauses,
        delta.loads,
        delta.promptAttachments,
        delta.compactionFiles,
        delta.requestShapes,
        delta.contextReports,
    ];
    const only = tables.every((rows) => rows === undefined) &&
        delta.replacedAttachmentTurns === undefined;
    return only ? delta.session : null;
}
/** Held attachments with the replaced turns' sets folded in:
 * a replaced turn's old rows go, then the fresh rows upsert. */
function mergeAttachments(held, delta) {
    const replaced = new Set(delta.replacedAttachmentTurns ?? []);
    const kept = replaced.size === 0
        ? held
        : held.filter((row) => !replaced.has(row.turnId));
    return upsertRows(kept, delta.promptAttachments, (a, b) => a.id - b.id);
}
/** The tables a delta carries whole: each list replaces the held one. */
function replacedLists(data, delta) {
    return {
        contextReports: delta.contextReports ?? data.contextReports,
        compactionFiles: delta.compactionFiles ?? data.compactionFiles,
        requestShapes: delta.requestShapes ?? data.requestShapes,
    };
}
export function mergeSessionData(data, delta) {
    // A pass that moved only the session row — its clock
    // advances on nearly every event — keeps the held rows and
    // their maps exactly as they are.
    const alone = sessionOnlyRow(delta);
    if (alone !== null) {
        return { ...data, session: alone };
    }
    return buildSessionData(delta.session ?? data.session, {
        turns: upsertRows(data.turns, delta.turns, (a, b) => a.sequence === b.sequence ? a.id - b.id : a.sequence - b.sequence),
        steps: upsertRows(data.steps, delta.steps, (a, b) => byTimeThenId({ at: a.startedAt, id: a.id }, { at: b.startedAt, id: b.id })),
        humans: upsertRows(data.humans, delta.humans, (a, b) => a.occurredAt - b.occurredAt || a.id - b.id),
        branches: upsertRows(data.branches, delta.branches, (a, b) => byTimeThenId({ at: a.startedAt, id: a.id }, { at: b.startedAt, id: b.id })),
        requests: upsertRows(data.requests, delta.requests, (a, b) => byTimeThenId({ at: a.startedAt, id: a.id }, { at: b.startedAt, id: b.id })),
        samples: upsertRows(data.samples, delta.samples, (a, b) => a.sampledAt - b.sampledAt || a.id - b.id),
        segments: upsertRows(data.segments, delta.segments, (a, b) => a.startedAt - b.startedAt || a.id - b.id),
        pauses: upsertRows(data.pauses, delta.pauses, (a, b) => a.pausedAt - b.pausedAt || a.id - b.id),
        loads: upsertRows(data.loads, delta.loads, (a, b) => a.occurredAt - b.occurredAt || a.id - b.id),
        promptAttachments: mergeAttachments(data.promptAttachments, delta),
        ...replacedLists(data, delta),
    });
}
/**
 * The model the session's latest main-thread request ran on:
 * the model the summary and the room describe. The session's
 * first model stands only when no main request names one.
 */
export function latestMainModel(data) {
    let model = null;
    for (const request of data.requests) {
        if (request.branchId === null &&
            request.querySource === "main" &&
            request.model !== null) {
            model = request.model;
        }
    }
    return model ?? data.session.model;
}
/** The turn a row belongs to when its own turn link is missing. */
function turnByTime(turns, at) {
    if (turns.length === 0) {
        return undefined;
    }
    if (at === null) {
        return turns[turns.length - 1];
    }
    let chosen;
    for (const turn of turns) {
        if (turn.startedAt !== null && turn.startedAt <= at) {
            chosen = turn;
        }
    }
    return chosen ?? turns[0];
}
export function groupByTurn(turnsById, rows, atOf) {
    const byTurn = new Map();
    // The map's values are the session's turns in the order
    // they were loaded, which is the order turnByTime reads.
    const turns = [...turnsById.values()];
    for (const row of rows) {
        const turn = row.turnId !== null && turnsById.has(row.turnId)
            ? turnsById.get(row.turnId)
            : turnByTime(turns, atOf(row));
        if (turn === undefined) {
            continue;
        }
        const list = byTurn.get(turn.id) ?? [];
        list.push(row);
        byTurn.set(turn.id, list);
    }
    return byTurn;
}
/**
 * Who approved a step, from its permission decision: only an
 * accepted decision counts, and only when its source names
 * the user — a telemetry source beginning "user", or an
 * inferred accept, which means the step proceeded past the
 * ask. A reject, or a source that names anything else, makes
 * no claim about a person.
 */
function approvedByFor(stepId, decisionByStep) {
    const decision = decisionByStep.get(stepId);
    if (decision === undefined ||
        (decision.decision !== "accept" && decision.decision !== "accept_permanent")) {
        return undefined;
    }
    const source = decision.decisionSource;
    if (source === "inferred" || (source !== null && source.startsWith("user"))) {
        return "you";
    }
    return undefined;
}
/** The first index whose sample was taken at or after `at`. */
function firstSampleAtOrAfter(samples, at) {
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const sample = samples[mid];
        if (sample === undefined || sample.sampledAt < at) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo;
}
// The samples are one thread's: a subagent's context is its
// own, so another thread's requests never bracket its steps.
function contextAround(samples, step) {
    if (step.startedAt === null) {
        return {};
    }
    // Samples are read in time order, so the pair bracketing the
    // step is found by search, not by walking every sample.
    const end = step.endedAt ?? step.startedAt;
    const beforeIndex = firstSampleAtOrAfter(samples, step.startedAt + 1) - 1;
    const before = beforeIndex >= 0 ? (samples[beforeIndex]?.contextTokens ?? null) : null;
    const afterIndex = firstSampleAtOrAfter(samples, end);
    const after = afterIndex < samples.length
        ? (samples[afterIndex]?.contextTokens ?? null)
        : null;
    if (before === null) {
        return {};
    }
    return after === null
        ? { contextBefore: before }
        : { contextBefore: before, contextAfter: after };
}
export function branchTotalsFor(branch, data) {
    // Requests are read in start order, so the branch's first is
    // its cold start: the cache its first request wrote.
    const firstRequest = data.requests.find((request) => request.branchId === branch.id);
    return {
        steps: data.steps.filter((step) => step.branchId === branch.id).length,
        requests: data.requests.filter((request) => request.branchId === branch.id)
            .length,
        durationMs: branch.startedAt !== null && branch.endedAt !== null
            ? branch.endedAt - branch.startedAt
            : null,
        coldStartTokens: firstRequest === undefined ? null : cacheWriteTokens(firstRequest),
    };
}
/** The step whose saved output a Read step reads back, when
 * the session recorded that step. */
export function savedOutputSource(step, data) {
    const toolUseId = savedOutputToolUseId(step, data.session.id);
    return toolUseId === null ? undefined : data.stepsByToolUse.get(toolUseId);
}
export function stepContext(step, turn, data) {
    const branch = step.branchId === null ? undefined : data.branchesById.get(step.branchId);
    const spawning = data.branchBySpawningStep.get(step.id);
    const name = branch === undefined
        ? undefined
        : describeBranch(branch.agentType, branch.agentId);
    const approvedBy = approvedByFor(step.id, data.decisionByStep);
    const source = savedOutputSource(step, data);
    return {
        sessionId: data.session.id,
        ...(turn === undefined ? {} : { turnSequence: turn.sequence }),
        ...(name === undefined ? {} : { branchName: name }),
        ...(approvedBy === undefined ? {} : { approvedBy }),
        ...(source === undefined
            ? {}
            : { savedOutputOf: describeStep(source).sentence }),
        telemetrySeen: data.session.sources.includes("telemetry"),
        ...contextAround(data.samplesByBranch.get(step.branchId) ?? [], step),
        ...(spawning === undefined
            ? {}
            : { branchTotals: branchTotalsFor(spawning, data) }),
    };
}
