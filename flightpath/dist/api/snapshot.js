// One session's snapshot: the summary the header shows, its
// turns with every step and human moment carrying the sentence
// the describe module wrote for it, its branches and session
// events, and its context samples downsampled for the chart.
import { describeBranch, describeHuman, describePause, describeSegment, describeStep, readQuestions, } from "../describe/index.js";
import { parseRecord } from "../util/json.js";
import { lastMainCache } from "./cache.js";
import { contextReportFor, contextWindowFor, samplesForModel, } from "./context-limit.js";
import { branchTotalsFor, groupByTurn, latestMainModel, loadSessionData, stepContext, } from "./session-data.js";
import { sessionNote, sessionTitle } from "./sessions.js";
import { promptAttachmentsByTurn } from "./tokens.js";
const MAX_SAMPLE_POINTS = 1_000;
const STEPPED_IN_KINDS = new Set([
    "permission_decision",
    "rejection",
    "interrupt",
    "question_answered",
    "command",
]);
function questionOptions(step) {
    if (step === undefined || step.toolName !== "AskUserQuestion") {
        return undefined;
    }
    const labels = readQuestions(parseRecord(step.inputSummary)).flatMap((asked) => asked.options);
    return labels.length > 0 ? labels : undefined;
}
function humanSentence(event, data, settings, previousPromptAt) {
    const step = event.stepId === null ? undefined : data.stepsById.get(event.stepId);
    const turn = event.turnId === null ? undefined : data.turnsById.get(event.turnId);
    const options = questionOptions(step);
    return describeHuman(event, {
        ...(step === undefined ? {} : { step }),
        promptText: settings.storePromptText && turn !== undefined ? turn.promptText : null,
        promptLength: turn?.promptChars ?? null,
        sinceLastTurnMs: previousPromptAt === null ? null : event.occurredAt - previousPromptAt,
        ...(options === undefined ? {} : { options }),
    }).sentence;
}
/** One step as the snapshot shows it, sentence included. */
export function stepSummaryOf(step, turn, data) {
    return {
        id: step.id,
        toolName: step.toolName,
        outcome: step.outcome,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        durationMs: step.durationMs,
        branchId: step.branchId,
        resultRequestId: step.resultRequestId,
        sentence: describeStep(step, stepContext(step, turn, data)).sentence,
    };
}
/** The turn each step is grouped under, by step id. */
export function stepTurnIds(data) {
    const grouped = groupByTurn(data.turnsById, data.steps, (step) => step.startedAt);
    const turnIds = new Map();
    for (const [turnId, steps] of grouped) {
        for (const step of steps) {
            turnIds.set(step.id, turnId);
        }
    }
    return turnIds;
}
/** One turn's counts, read off its rows: no sentences, so a
 * reader that is not describing the turn can still count it. */
function turnCounts(steps, humans) {
    return {
        failures: steps.filter((step) => step.outcome === "failed").length,
        steppedIn: humans.filter((event) => STEPPED_IN_KINDS.has(event.kind))
            .length,
    };
}
function summarizeTurn(turn, steps, humans, attachments, data, settings, previousPromptAt) {
    const counts = turnCounts(steps, humans);
    let promptAt = previousPromptAt;
    const humanMoments = humans.map((event) => {
        const sentence = humanSentence(event, data, settings, promptAt);
        if (event.kind === "prompt") {
            promptAt = event.occurredAt;
        }
        return {
            id: event.id,
            kind: event.kind,
            occurredAt: event.occurredAt,
            sentence,
        };
    });
    const summary = {
        id: turn.id,
        sequence: turn.sequence,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        failures: counts.failures,
        steppedIn: counts.steppedIn,
        images: turn.imageCount ?? 0,
        files: attachments.filter((row) => row.kind === "file").length,
        steps: steps.map((step) => stepSummaryOf(step, turn, data)),
        humanMoments,
    };
    return { summary, previousPromptAt: promptAt };
}
function turnSummaries(data, settings) {
    return summarizeTurns(data, settings, null);
}
/**
 * Summaries for the named turns only, with the session's
 * totals counted over every turn: a reader following changes
 * describes the turns that moved — their sentences depend on
 * the turns before them, so the walk still visits each turn
 * in order — and reports the whole session's counts.
 */
export function turnSummariesFor(data, settings, turnIds) {
    return summarizeTurns(data, settings, turnIds);
}
/** The prompt time a skipped turn hands to the next one:
 * its last prompt moment's, or the time it was handed. */
function promptCarry(humans, current) {
    let promptAt = current;
    for (const event of humans) {
        if (event.kind === "prompt") {
            promptAt = event.occurredAt;
        }
    }
    return promptAt;
}
function summarizeTurns(data, settings, only) {
    const stepsByTurn = groupByTurn(data.turnsById, data.steps, (step) => step.startedAt);
    const humansByTurn = groupByTurn(data.turnsById, data.humans, (event) => event.occurredAt);
    const attachmentsByTurn = promptAttachmentsByTurn(data.promptAttachments);
    const turns = [];
    let failures = 0;
    let steppedIn = 0;
    let previousPromptAt = null;
    for (const turn of data.turns) {
        const steps = stepsByTurn.get(turn.id) ?? [];
        const humans = humansByTurn.get(turn.id) ?? [];
        const counts = turnCounts(steps, humans);
        failures += counts.failures;
        steppedIn += counts.steppedIn;
        if (only !== null && !only.has(turn.id)) {
            previousPromptAt = promptCarry(humans, previousPromptAt);
            continue;
        }
        const result = summarizeTurn(turn, steps, humans, attachmentsByTurn.get(turn.id) ?? [], data, settings, previousPromptAt);
        turns.push(result.summary);
        previousPromptAt = result.previousPromptAt;
    }
    return { turns, failures, steppedIn };
}
/** One branch as the snapshot shows it, sentence included. */
export function branchSummaryOf(data, branch) {
    const totals = branchTotalsFor(branch, data);
    const spawning = branch.spawningStepId === null
        ? undefined
        : data.stepsById.get(branch.spawningStepId);
    return {
        id: branch.id,
        agentId: branch.agentId,
        agentType: branch.agentType,
        kind: branch.kind,
        spawningStepId: branch.spawningStepId,
        startedAt: branch.startedAt,
        endedAt: branch.endedAt,
        totalTokens: branch.totalTokens,
        steps: totals.steps,
        requests: totals.requests,
        sentence: spawning !== undefined
            ? describeStep(spawning, { branchTotals: totals }).sentence
            : describeBranch(branch.agentType, branch.agentId),
    };
}
function branchSummaries(data) {
    return data.branches.map((branch) => branchSummaryOf(data, branch));
}
function segmentEvent(segment, previousContext) {
    return {
        kind: "segment",
        id: segment.id,
        at: segment.startedAt,
        sentence: describeSegment(segment, { contextBefore: previousContext })
            .sentence,
        segmentKind: segment.kind,
    };
}
/** One segment as the snapshot's events show it: its sentence
 * is told about the context the segment before it held. */
export function segmentEventOf(data, segment) {
    let previousContext = null;
    for (const earlier of data.segments) {
        if (earlier.id === segment.id) {
            break;
        }
        if (earlier.contextTokens !== null) {
            previousContext = earlier.contextTokens;
        }
    }
    return segmentEvent(segment, previousContext);
}
/** One pause as the snapshot's events show it. */
export function pauseEventOf(pause) {
    return {
        kind: "pause",
        id: pause.id,
        at: pause.pausedAt,
        sentence: describePause(pause).sentence,
    };
}
function sessionEvents(data) {
    const events = [];
    let previousContext = null;
    for (const segment of data.segments) {
        events.push(segmentEvent(segment, previousContext));
        if (segment.contextTokens !== null) {
            previousContext = segment.contextTokens;
        }
    }
    for (const pause of data.pauses) {
        events.push(pauseEventOf(pause));
    }
    return events.sort((a, b) => a.at - b.at || a.id - b.id);
}
function downsample(samples) {
    const points = samples.map((sample) => ({
        at: sample.sampledAt,
        contextTokens: sample.contextTokens,
    }));
    if (points.length <= MAX_SAMPLE_POINTS) {
        return points;
    }
    const stride = Math.ceil(points.length / MAX_SAMPLE_POINTS);
    const kept = points.filter((_, index) => index % stride === 0);
    const last = points[points.length - 1];
    if (last !== undefined && kept[kept.length - 1] !== last) {
        kept.push(last);
    }
    return kept;
}
function waitingSince(data) {
    let waiting = null;
    for (const event of data.humans) {
        if (event.kind === "waiting" || event.kind === "permission_request") {
            waiting = event.occurredAt;
        }
        else {
            waiting = null;
        }
    }
    return waiting;
}
/** The snapshot's summary for one session's loaded rows. */
export function snapshotSummary(data, storage, settings, totals) {
    const latestSample = data.samples[data.samples.length - 1];
    const model = latestMainModel(data);
    const window = contextWindowFor(model, samplesForModel(data.samples, data.requests, model), contextReportFor(data.contextReports, model));
    const lastStep = [...data.steps]
        .reverse()
        .find((step) => step.startedAt !== null);
    return {
        id: data.session.id,
        title: sessionTitle(data.session.firstPromptText, settings),
        project: data.session.projectPath,
        status: data.session.status,
        startedAt: data.session.firstSeenAt,
        endedAt: data.session.status === "ended" ? data.session.lastSeenAt : null,
        lastActivityAt: data.session.lastSeenAt,
        model,
        permissionModes: data.session.permissionModes,
        sources: data.session.sources,
        endSeen: data.session.endSeen,
        // The summary's own status line carries the end state;
        // the note is the shared phrases only.
        note: sessionNote(data.session),
        counts: {
            turns: data.turns.length,
            steps: data.steps.length,
            requests: data.requests.length,
            branches: data.branches.length,
            humanMoments: data.humans.length,
        },
        failures: totals.failures,
        steppedIn: totals.steppedIn,
        tokensProcessed: data.session.tokensProcessed,
        contextNow: latestSample?.contextTokens ?? null,
        window,
        overheadTokens: storage.flightpathOverheadTokens(data.session.id),
        waitingSince: waitingSince(data),
        lastStepAt: lastStep?.startedAt ?? null,
        cache: lastMainCache(data),
    };
}
/** GET /api/sessions/:id/snapshot — one session, shaped for the view. */
export function sessionSnapshot(storage, settings, sessionId) {
    const data = loadSessionData(storage, sessionId);
    if (data === undefined) {
        return undefined;
    }
    const { turns, failures, steppedIn } = turnSummaries(data, settings);
    return {
        summary: snapshotSummary(data, storage, settings, { failures, steppedIn }),
        turns,
        branches: branchSummaries(data),
        sessionEvents: sessionEvents(data),
        // The strip shows the main conversation only: a subagent's
        // samples are its own thread's, never the strip's.
        contextSamples: downsample(data.samplesByBranch.get(null) ?? []),
    };
}
