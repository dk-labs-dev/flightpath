// Capture: keeping one session's held rows current without
// re-reading the session. A pass asks the store for the rows
// past the capture's high-water marks plus the rows still
// open — the only ones that can change in place — merges them
// into the held data, and hands shaping a plan naming what
// moved. A full read happens only for a session's first
// capture and when a resync is asked for: the marks make the
// common pass proportional to what changed, not to the
// session's size.
import { groupByTurn, loadSessionData, mergeSessionData, stepTurnIds, } from "../api/index.js";
import { appendEntry } from "./stream.js";
import { shapeSessionChanges, } from "./stream-shaping.js";
export function newCapture() {
    return {
        marks: {
            turnMax: 0,
            stepMax: 0,
            humanMax: 0,
            branchMax: 0,
            segmentMax: 0,
            pauseMax: 0,
            sampleMax: 0,
            loadMax: 0,
            attachmentMax: 0,
        },
        sessionRowJson: "",
        stepJson: new Map(),
        humanJson: new Map(),
        branchJson: new Map(),
        pauseJson: new Map(),
        turnJson: new Map(),
        summaryJson: null,
        openSteps: new Set(),
        watchSteps: new Set(),
        openBranches: new Set(),
        openPauses: new Set(),
        openTurns: new Set(),
        openTurnId: null,
        data: null,
        requestMax: 0,
        changeSeq: 0,
        baseline: true,
        resync: false,
    };
}
export function captureSession(hub, sessionId, mode) {
    const capture = hub.captures.get(sessionId);
    if (capture === undefined)
        return;
    const sessionRow = hub.storage.sessionRow(sessionId);
    if (sessionRow === undefined) {
        noteSessionGone(hub, capture, sessionId);
        return;
    }
    const probe = hub.storage.streamProbe(sessionId);
    if (capture.data === null || capture.resync) {
        fullCapture(hub, capture, sessionRow, probe, mode);
        return;
    }
    deltaCapture(hub, capture, sessionRow, probe, mode);
}
function noteSessionGone(hub, capture, sessionId) {
    if (capture.baseline)
        return;
    hub.captures.delete(sessionId);
    hub.picker.delete(sessionId);
    const tombstone = {
        event: "session",
        data: { sessionId, deleted: true },
    };
    appendEntry(hub, "session", sessionId, tombstone);
    appendEntry(hub, "picker", sessionId, tombstone);
}
function emitFor(hub, capture, sessionId, mode) {
    if (capture.baseline && mode === "record") {
        return { session: () => undefined, picker: () => undefined };
    }
    return {
        session: (message) => appendEntry(hub, "session", sessionId, message),
        picker: (message) => appendEntry(hub, "picker", sessionId, message),
    };
}
function fullCapture(hub, capture, sessionRow, probe, mode) {
    const data = loadSessionData(hub.storage, sessionRow.id);
    if (data === undefined)
        return;
    capture.data = data;
    // The load holds every change so far: the mark starts past
    // the newest entry and the entries go, so none folds twice.
    capture.changeSeq = hub.storage.changeMaxSeq(sessionRow.id);
    hub.storage.clearSessionChanges(sessionRow.id);
    refreshOpenSets(capture, data);
    shapeSessionChanges(hub, capture, data, fullPlan(data), emitFor(hub, capture, sessionRow.id, mode));
    finishPass(capture, probe, sessionRow);
}
function deltaCapture(hub, capture, sessionRow, probe, mode) {
    const held = capture.data;
    if (held === null)
        return;
    const delta = {};
    const moved = gatherFreshRows(hub, capture, sessionRow.id, probe, delta);
    const rowMoved = JSON.stringify(sessionRow) !== capture.sessionRowJson;
    if (rowMoved) {
        delta.session = sessionRow;
    }
    if (!moved && !rowMoved)
        return;
    const data = mergeSessionData(held, delta);
    capture.data = data;
    refreshOpenSets(capture, data);
    shapeSessionChanges(hub, capture, data, planFromDelta(data, delta, capture), emitFor(hub, capture, sessionRow.id, mode));
    finishPass(capture, probe, sessionRow);
}
function gatherFreshRows(hub, capture, sessionId, probe, delta) {
    const storage = hub.storage;
    const marks = capture.marks;
    let moved = false;
    const take = (key, rows) => {
        if (rows !== undefined && rows.length > 0) {
            delta[key] = rows;
            moved = true;
        }
    };
    if (probe.turnMax > marks.turnMax) {
        take("turns", storage.turnRowsSince(sessionId, marks.turnMax));
    }
    if (probe.stepMax > marks.stepMax) {
        take("steps", storage.stepRowsSince(sessionId, marks.stepMax));
    }
    if (probe.humanMax > marks.humanMax) {
        take("humans", storage.humanRowsSince(sessionId, marks.humanMax));
    }
    if (probe.branchMax > marks.branchMax) {
        take("branches", storage.branchRowsSince(sessionId, marks.branchMax));
    }
    if (probe.segmentMax > marks.segmentMax) {
        take("segments", storage.segmentRowsSince(sessionId, marks.segmentMax));
    }
    if (probe.pauseMax > marks.pauseMax) {
        take("pauses", storage.pauseRowsSince(sessionId, marks.pauseMax));
    }
    if (probe.sampleMax > marks.sampleMax) {
        take("samples", storage.sampleRowsSince(sessionId, marks.sampleMax));
    }
    if (probe.loadMax > marks.loadMax) {
        take("loads", storage.loadRowsSince(sessionId, marks.loadMax));
    }
    if (probe.attachmentMax > marks.attachmentMax) {
        take("promptAttachments", storage.attachmentRowsSince(sessionId, marks.attachmentMax));
    }
    take("requests", storage.requestRowsSince(sessionId, capture.requestMax));
    moved = gatherOpenRows(hub, capture, delta) || moved;
    moved = gatherBranchRequests(hub, capture, delta) || moved;
    moved = gatherChangedRows(hub, capture, delta) || moved;
    moved = gatherReports(hub, capture, delta) || moved;
    return moved;
}
// A report written during a live session — the user ran
// /context to check — reaches the held rows here: reports
// are one row per model, read by their session's key, so
// the whole set is re-read on each pass and folds in only
// when it changed.
function gatherReports(hub, capture, delta) {
    const held = capture.data;
    if (held === null)
        return false;
    const reports = hub.storage.contextReportsFor(held.session.id);
    if (JSON.stringify(reports) === JSON.stringify(held.contextReports)) {
        return false;
    }
    delta.contextReports = reports;
    return true;
}
// Rows writers changed after inserting them — a request's
// completed counts, a closed turn's images — reach the held
// session here: the triggers recorded them past the capture's
// mark, each is re-read by id, and only a row that actually
// moved folds in. A turn's attachments re-read as the set
// they now are; the entries are consumed either way.
function gatherChangedRows(hub, capture, delta) {
    const held = capture.data;
    if (held === null)
        return false;
    const storage = hub.storage;
    const changes = storage.changedRowsSince(held.session.id, capture.changeSeq);
    if (changes.length === 0)
        return false;
    let moved = false;
    const attachmentTurns = new Set();
    let shapesMoved = false;
    let compactionFilesMoved = false;
    for (const change of changes) {
        if (change.tableName === "prompt_attachments") {
            attachmentTurns.add(change.rowId);
        }
        else if (change.tableName === "session_shapes") {
            shapesMoved = true;
        }
        else if (change.tableName === "compaction_files") {
            compactionFilesMoved = true;
        }
        else {
            moved = gatherChangedRow(hub, capture, delta, change) || moved;
        }
    }
    for (const turnId of attachmentTurns) {
        moved = gatherChangedAttachments(hub, capture, delta, turnId) || moved;
    }
    if (shapesMoved || requestsNameUnheldShape(held, delta)) {
        const shapes = storage.requestShapeRows(held.session.id);
        if (JSON.stringify(shapes) !== JSON.stringify(held.requestShapes)) {
            delta.requestShapes = shapes;
            moved = true;
        }
    }
    if (compactionFilesMoved) {
        const files = storage.compactionFileRows(held.session.id);
        if (JSON.stringify(files) !== JSON.stringify(held.compactionFiles)) {
            delta.compactionFiles = files;
            moved = true;
        }
    }
    const last = changes[changes.length - 1];
    if (last !== undefined) {
        capture.changeSeq = last.seq;
        storage.clearChangedRows(held.session.id, last.seq);
    }
    return moved;
}
function gatherChangedRow(hub, capture, delta, change) {
    const held = capture.data;
    if (held === null)
        return false;
    const storage = hub.storage;
    if (change.tableName === "requests") {
        const row = movedRow(storage.requestRowById(change.rowId), held.requests);
        if (row === undefined)
            return false;
        (delta.requests ??= []).push(row);
        return true;
    }
    if (change.tableName === "turns") {
        const row = movedRow(storage.turnRowById(change.rowId), held.turns);
        if (row === undefined)
            return false;
        (delta.turns ??= []).push(row);
        return true;
    }
    if (change.tableName === "branches") {
        const row = movedRow(storage.branchRowById(change.rowId), held.branches);
        if (row === undefined)
            return false;
        (delta.branches ??= []).push(row);
        return true;
    }
    if (change.tableName === "steps") {
        const read = storage.stepRowById(change.rowId);
        if (read === undefined)
            return false;
        const row = movedRow(stepRowOf(read), held.steps);
        if (row === undefined)
            return false;
        (delta.steps ??= []).push(row);
        return true;
    }
    if (change.tableName === "loads") {
        const row = movedRow(storage.loadRowById(change.rowId), held.loads);
        if (row === undefined)
            return false;
        (delta.loads ??= []).push(row);
        return true;
    }
    return false;
}
/** A re-read row when it differs from the held one. */
function movedRow(row, heldRows) {
    if (row === undefined)
        return undefined;
    const before = heldRows.find((held) => held.id === row.id);
    if (before === undefined)
        return undefined;
    return JSON.stringify(row) === JSON.stringify(before) ? undefined : row;
}
// A replaced turn's attachments, re-read whole: the held
// set for the turn goes, the stored set folds in.
function gatherChangedAttachments(hub, capture, delta, turnId) {
    const held = capture.data;
    if (held === null)
        return false;
    const rows = hub.storage.promptAttachmentsForTurn(held.session.id, turnId);
    const before = held.promptAttachments.filter((row) => row.turnId === turnId);
    if (JSON.stringify(rows) === JSON.stringify(before))
        return false;
    (delta.replacedAttachmentTurns ??= []).push(turnId);
    if (rows.length > 0) {
        (delta.promptAttachments ??= []).push(...rows);
    }
    return true;
}
// A request in this pass naming a shape the held data does
// not carry: its shape row is read with the session's shapes.
function requestsNameUnheldShape(held, delta) {
    const heldHashes = new Set(held.requestShapes.map((shape) => shape.hash));
    return (delta.requests ?? []).some((request) => request.shapeHash !== null && !heldHashes.has(request.shapeHash));
}
// The rows still open are the only ones that can change in
// place; each is re-read and joins the pass only when it
// actually moved, so a quiet pass over a long session costs
// the probe and a handful of indexed reads.
function gatherOpenRows(hub, capture, delta) {
    const held = capture.data;
    if (held === null)
        return false;
    const storage = hub.storage;
    let moved = false;
    for (const id of capture.openTurns) {
        const row = storage.turnRowById(id);
        const before = held.turnsById.get(id);
        if (row === undefined || before === undefined)
            continue;
        if (JSON.stringify(row) === JSON.stringify(before))
            continue;
        (delta.turns ??= []).push(row);
        moved = true;
    }
    moved = gatherOpenSteps(hub, capture, delta) || moved;
    for (const id of capture.openBranches) {
        const row = storage.branchRowById(id);
        const before = held.branchesById.get(id);
        if (row === undefined || before === undefined)
            continue;
        if (JSON.stringify(row) === JSON.stringify(before))
            continue;
        (delta.branches ??= []).push(row);
        moved = true;
    }
    for (const id of capture.openPauses) {
        const row = storage.pauseRowById(id);
        if (row === undefined)
            continue;
        const before = held.pauses.find((pause) => pause.id === id);
        if (before === undefined)
            continue;
        if (JSON.stringify(row) === JSON.stringify(before))
            continue;
        (delta.pauses ??= []).push(row);
        moved = true;
    }
    const latestId = capture.marks.sampleMax;
    if (latestId > 0) {
        const row = storage.contextSampleRowById(latestId);
        const before = held.samples.find((sample) => sample.id === latestId);
        if (row !== undefined &&
            before !== undefined &&
            JSON.stringify(row) !== JSON.stringify(before)) {
            (delta.samples ??= []).push(row);
            moved = true;
        }
    }
    return moved;
}
/** A step as the held rows carry it: the by-id read also
 * carries its session's id, which the held row does not. */
function stepRowOf(read) {
    return {
        id: read.id,
        turnId: read.turnId,
        branchId: read.branchId,
        toolName: read.toolName,
        inputSummary: read.inputSummary,
        outcome: read.outcome,
        startedAt: read.startedAt,
        endedAt: read.endedAt,
        durationMs: read.durationMs,
        resultSize: read.resultSize,
        resultRequestId: read.resultRequestId,
        contextChars: read.contextChars,
        contextImages: read.contextImages,
        asyncLaunch: read.asyncLaunch,
        toolUseId: read.toolUseId,
        savedOutputBytes: read.savedOutputBytes,
    };
}
// The steps a pass watches — the open ones and the ones an
// open branch owns or spawned — re-read by id; the read row
// carries its session's id, which the held row does not.
function gatherOpenSteps(hub, capture, delta) {
    const held = capture.data;
    if (held === null)
        return false;
    let moved = false;
    const watched = new Set([...capture.openSteps, ...capture.watchSteps]);
    for (const id of watched) {
        const read = hub.storage.stepRowById(id);
        const before = held.stepsById.get(id);
        if (read === undefined || before === undefined)
            continue;
        const row = stepRowOf(read);
        if (JSON.stringify(row) === JSON.stringify(before))
            continue;
        (delta.steps ??= []).push(row);
        moved = true;
    }
    return moved;
}
// A running branch's totals are its requests as much as its
// steps: its requests are re-read while it is open, and join
// the pass when one of them moved.
function gatherBranchRequests(hub, capture, delta) {
    const held = capture.data;
    if (held === null || capture.openBranches.size === 0)
        return false;
    const heldById = new Map(held.requests.map((row) => [row.id, row]));
    let moved = false;
    for (const branchId of capture.openBranches) {
        const rows = hub.storage.requestRowsForBranch(held.session.id, branchId);
        for (const row of rows) {
            const before = heldById.get(row.id);
            if (before !== undefined &&
                JSON.stringify(row) === JSON.stringify(before)) {
                continue;
            }
            (delta.requests ??= []).push(row);
            moved = true;
        }
    }
    return moved;
}
function planFromDelta(data, delta, capture) {
    const plan = emptyPlan(data);
    for (const step of delta.steps ?? [])
        plan.stepIds.add(step.id);
    for (const human of delta.humans ?? [])
        plan.humanIds.add(human.id);
    for (const branch of delta.branches ?? [])
        plan.branchIds.add(branch.id);
    for (const segment of delta.segments ?? [])
        plan.segmentIds.add(segment.id);
    for (const pause of delta.pauses ?? [])
        plan.pauseIds.add(pause.id);
    for (const sample of delta.samples ?? [])
        plan.sampleIds.add(sample.id);
    for (const turn of delta.turns ?? [])
        plan.turnIds.add(turn.id);
    for (const turnId of delta.replacedAttachmentTurns ?? []) {
        plan.turnIds.add(turnId);
    }
    addBranchActivity(data, delta, plan);
    // A moment can settle a step's own description — who
    // approved it, what was asked — so the step is read again.
    for (const human of delta.humans ?? []) {
        if (human.stepId !== null)
            plan.stepIds.add(human.stepId);
    }
    // What is still open is read again on every pass: an open
    // step's, branch's or pause's telling can settle without a
    // new row anywhere, and the shaping diff keeps a pass that
    // finds nothing new silent.
    for (const id of capture.openSteps)
        plan.stepIds.add(id);
    for (const id of capture.watchSteps)
        plan.stepIds.add(id);
    for (const id of capture.openBranches)
        plan.branchIds.add(id);
    for (const id of capture.openPauses)
        plan.pauseIds.add(id);
    // Moments in the open turn are read again: what they say
    // rests on rows that land while the turn runs.
    for (const human of data.humans) {
        if (plan.humanTurnIds.get(human.id) === capture.openTurnId) {
            plan.humanIds.add(human.id);
        }
    }
    for (const id of plan.stepIds) {
        const turnId = plan.stepTurnIds.get(id);
        if (turnId !== undefined)
            plan.turnIds.add(turnId);
    }
    for (const id of plan.humanIds) {
        const turnId = plan.humanTurnIds.get(id);
        if (turnId !== undefined)
            plan.turnIds.add(turnId);
    }
    return plan;
}
// A branch's steps and requests move its totals, and its
// spawning step's sentence carries those totals: both are
// read again whenever either moves.
function addBranchActivity(data, delta, plan) {
    const active = new Set();
    for (const step of delta.steps ?? []) {
        if (step.branchId !== null)
            active.add(step.branchId);
    }
    for (const request of delta.requests ?? []) {
        if (request.branchId !== null)
            active.add(request.branchId);
    }
    for (const branchId of active) {
        plan.branchIds.add(branchId);
        const branch = data.branchesById.get(branchId);
        if (branch !== undefined && branch.spawningStepId !== null) {
            plan.stepIds.add(branch.spawningStepId);
        }
    }
}
function humanTurnIds(data) {
    const grouped = groupByTurn(data.turnsById, data.humans, (event) => event.occurredAt);
    const turnIds = new Map();
    for (const [turnId, events] of grouped) {
        for (const event of events) {
            turnIds.set(event.id, turnId);
        }
    }
    return turnIds;
}
function emptyPlan(data) {
    return {
        turnIds: new Set(),
        stepIds: new Set(),
        humanIds: new Set(),
        branchIds: new Set(),
        segmentIds: new Set(),
        pauseIds: new Set(),
        sampleIds: new Set(),
        stepTurnIds: stepTurnIds(data),
        humanTurnIds: humanTurnIds(data),
    };
}
function fullPlan(data) {
    const plan = emptyPlan(data);
    for (const turn of data.turns)
        plan.turnIds.add(turn.id);
    for (const step of data.steps)
        plan.stepIds.add(step.id);
    for (const human of data.humans)
        plan.humanIds.add(human.id);
    for (const branch of data.branches)
        plan.branchIds.add(branch.id);
    for (const segment of data.segments)
        plan.segmentIds.add(segment.id);
    for (const pause of data.pauses)
        plan.pauseIds.add(pause.id);
    for (const sample of data.samples)
        plan.sampleIds.add(sample.id);
    return plan;
}
function refreshOpenSets(capture, data) {
    capture.openTurns = new Set(data.turns.filter((turn) => turn.endedAt === null).map((turn) => turn.id));
    capture.openTurnId = null;
    for (const turn of data.turns) {
        if (turn.endedAt === null)
            capture.openTurnId = turn.id;
    }
    capture.openBranches = new Set(data.branches
        .filter((branch) => branch.endedAt === null)
        .map((branch) => branch.id));
    capture.openPauses = new Set(data.pauses
        .filter((pause) => pause.resumedAt === null)
        .map((pause) => pause.id));
    const openSteps = new Set();
    const watchSteps = new Set();
    for (const step of data.steps) {
        if (step.outcome === "open") {
            openSteps.add(step.id);
        }
        const branch = step.branchId !== null
            ? data.branchesById.get(step.branchId)
            : data.branchBySpawningStep.get(step.id);
        if (branch !== undefined && branch.endedAt === null) {
            watchSteps.add(step.id);
        }
    }
    capture.openSteps = openSteps;
    capture.watchSteps = watchSteps;
}
function finishPass(capture, probe, sessionRow) {
    capture.marks = probe;
    capture.sessionRowJson = JSON.stringify(sessionRow);
    capture.baseline = false;
    capture.resync = false;
    const data = capture.data;
    if (data !== null) {
        for (const request of data.requests) {
            if (request.id > capture.requestMax) {
                capture.requestMax = request.id;
            }
        }
    }
}
