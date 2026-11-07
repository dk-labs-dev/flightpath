// What the agent had been given by one step: the items
// that entered the step's thread in its epoch — since the
// session started, or since the last compaction — by name
// and size, never contents. A pure function of the loaded
// session, so a live session's answer is its held data read
// the same way, and the tests need no database.
import { handbackName, SUBAGENT_TOOLS } from "../describe/index.js";
import { estimatedTokens } from "../format.js";
import { requestContextTokens } from "../storage/request-tokens.js";
import { parseRecord, str } from "../util/json.js";
import { contextReportFor, contextWindowFor, samplesForModel, } from "./context-limit.js";
import { itemTokens, } from "./payloads.js";
import { backgroundReports, launchedInBackground, loadSessionData, } from "./session-data.js";
import { attachmentTokens, hasContextCount, isListedAttachment, isListedLoad, LISTING_KINDS, loadName, measuredResult, parentAgentTypeOf, promptAttachmentsByTurn, skillFilesOf, stepChars, stepLabel, } from "./tokens.js";
/** The step's thread's requests: the main thread's own, or
 * one branch's. A title request is not session context, so
 * the main thread means its main requests, as the token
 * history reads them. */
function threadRequests(data, branchId) {
    return data.requests.filter((request) => branchId === null
        ? request.branchId === null && request.querySource === "main"
        : request.branchId === branchId);
}
/**
 * The main thread's epoch: the last compaction at or
 * before the step's moment, or the session's start when no
 * compaction precedes it. A branch's epoch is its own
 * start, taken where the scope is decided.
 */
function mainEpoch(data, moment) {
    let latest = null;
    for (const segment of data.segments) {
        if (segment.kind !== "compact" || segment.startedAt > moment)
            continue;
        if (latest === null || segment.startedAt >= latest.startedAt) {
            latest = segment;
        }
    }
    return latest === null
        ? { startedAt: data.session.firstSeenAt, afterCompactionSegmentId: null }
        : { startedAt: latest.startedAt, afterCompactionSegmentId: latest.id };
}
/** The last request in a sorted series that started at or
 * before the moment. */
function lastAtOrBefore(requests, moment) {
    let chosen;
    for (const request of requests) {
        if ((request.startedAt ?? 0) > moment)
            break;
        chosen = request;
    }
    return chosen;
}
/** The thread's counted requests in start order: a request
 * that recorded no context count is never among them. */
function countedRequests(requests) {
    return requests
        .filter((request) => request.startedAt !== null && hasContextCount(request))
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id);
}
/** The main thread's first counted request: the one that
 * carried everything the session loaded at its start. */
export function firstMainRequest(data) {
    return countedRequests(threadRequests(data, null))[0];
}
/**
 * The request that measured the context at the step: the
 * one that carried the step's result when the transcript
 * named it, else the thread's first request starting after
 * the step's moment, else the latest one before it. A
 * request that recorded no context count measures nothing,
 * so it is never the measure, whichever rule reaches it.
 */
function measuredRequest(counted, step, moment) {
    let chosen;
    if (step.resultRequestId !== null) {
        chosen = counted.find((request) => request.id === step.resultRequestId);
    }
    if (chosen === undefined) {
        chosen =
            counted.find((request) => (request.startedAt ?? 0) > moment) ??
                lastAtOrBefore(counted, moment);
    }
    return chosen;
}
/** The measured request read as the payload states it: its
 * context count and its share of its own model's window. */
function measuredSummary(data, request) {
    const tokens = requestContextTokens(request);
    const model = request.model ?? data.session.model;
    const window = contextWindowFor(model, samplesForModel(data.samples, data.requests, model), contextReportFor(data.contextReports, model));
    return {
        requestId: request.id,
        tokens,
        window,
        share: window.tokens === null ? null : tokens / window.tokens,
    };
}
/** A read step's path, from the stored input summary the
 * describer reads — paths only, never contents. */
function readPath(step) {
    return str(parseRecord(step.inputSummary), "file_path") ?? "a file";
}
/**
 * One step as an item, by what it was: a branch's spawning
 * step is the subagent's return, a read is the file it
 * opened, anything else is its own result. A background
 * launch returned only its notice, so it is a plain result. A
 * read or result whose size the context's rise measures takes
 * the measure for its estimate; a subagent's return keeps its
 * estimate.
 */
function stepItem(data, step, measuredSizes) {
    const chars = stepChars(step);
    if (SUBAGENT_TOOLS.has(step.toolName) && !launchedInBackground(step)) {
        const branch = data.branchBySpawningStep.get(step.id);
        return {
            kind: "subagent-result",
            stepId: step.id,
            branchId: branch === undefined ? null : branch.id,
            label: stepLabel(data, step),
            chars,
            tokens: estimatedTokens(chars),
        };
    }
    const measuredTokens = measuredSizes.get(step.id);
    const sized = {
        chars,
        tokens: measuredTokens ?? estimatedTokens(chars),
        measured: measuredTokens !== undefined,
    };
    if (step.toolName === "Read") {
        return {
            kind: "file-read",
            stepId: step.id,
            path: readPath(step),
            ...sized,
        };
    }
    return {
        kind: "tool-result",
        stepId: step.id,
        label: stepLabel(data, step),
        ...sized,
    };
}
/** The steps of the thread that ended inside the epoch:
 * a step enters when its result comes back. */
function stepItems(data, branchId, epochStart, moment, measuredSizes) {
    const timed = [];
    for (const step of data.steps) {
        if (step.branchId !== branchId || step.endedAt === null)
            continue;
        if (step.endedAt < epochStart || step.endedAt > moment)
            continue;
        timed.push({
            at: step.endedAt,
            item: stepItem(data, step, measuredSizes),
        });
    }
    return timed;
}
/**
 * The reports of the thread's background subagents that
 * reached it inside the epoch: a launch returned only its
 * notice, and the report enters when it is handed back.
 */
function handbackItems(data, branchId, epochStart, moment) {
    return backgroundReports(data, branchId)
        .filter(({ handback }) => handback.occurredAt >= epochStart && handback.occurredAt <= moment)
        .map(({ branch, spawning, handback }) => ({
        at: handback.occurredAt,
        item: {
            kind: "subagent-result",
            stepId: spawning.id,
            branchId: branch.id,
            label: handbackName(handback.agentType),
            chars: handback.chars,
            tokens: estimatedTokens(handback.chars),
        },
    }));
}
/**
 * Each turn's prompt in the epoch, with the images and
 * files it carried as items of their own. Attachment rows
 * of the prompt's own kind are its text, already counted
 * in the prompt item.
 */
function promptItems(data, epochStart, moment) {
    const attachmentsByTurn = promptAttachmentsByTurn(data.promptAttachments);
    const timed = [];
    for (const turn of data.turns) {
        if (turn.startedAt === null)
            continue;
        if (turn.startedAt < epochStart || turn.startedAt > moment)
            continue;
        timed.push({
            at: turn.startedAt,
            item: {
                kind: "prompt",
                turnId: turn.id,
                sequence: turn.sequence,
                chars: turn.promptChars,
                tokens: estimatedTokens(turn.promptChars),
            },
        });
        for (const row of attachmentsByTurn.get(turn.id) ?? []) {
            if (!isListedAttachment(row))
                continue;
            timed.push({
                at: turn.startedAt,
                item: {
                    kind: row.kind,
                    turnId: turn.id,
                    name: row.name,
                    bytes: row.sizeBytes,
                    tokens: attachmentTokens(row),
                },
            });
        }
    }
    return timed;
}
/** One load as an item; a kind the lens doesn't name
 * makes no item. */
function loadItem(data, load) {
    if (!isListedLoad(load))
        return null;
    return {
        kind: load.kind,
        loadId: load.id,
        name: loadName(load),
        bytes: load.sizeBytes,
        tokens: estimatedTokens(load.sizeBytes),
        files: skillFilesOf(data, load),
    };
}
function loadItems(data, epochStart, moment) {
    const timed = [];
    for (const load of data.loads) {
        if (load.occurredAt < epochStart || load.occurredAt > moment)
            continue;
        const item = loadItem(data, load);
        if (item !== null)
            timed.push({ at: load.occurredAt, item });
    }
    return timed;
}
/** Every request in the thread that answered inside the
 * epoch, by its measured output. */
function replyItems(requests, epochStart, moment) {
    const timed = [];
    for (const request of requests) {
        if (request.outputTokens === null || request.startedAt === null) {
            continue;
        }
        if (request.startedAt < epochStart || request.startedAt > moment) {
            continue;
        }
        timed.push({
            at: request.startedAt,
            item: {
                kind: "reply",
                requestId: request.id,
                tokens: request.outputTokens,
            },
        });
    }
    return timed;
}
/** Each tool result in the thread that its request's rise
 * measures, by step id: the sizes the item list reads in
 * place of an estimate. */
function measuredSizes(data, counted) {
    const sizes = new Map();
    for (const [i, request] of counted.entries()) {
        const previous = counted[i - 1];
        if (previous === undefined)
            continue;
        const measured = measuredResult(data, previous, request);
        if (measured !== null)
            sizes.set(measured.step.id, measured.tokens);
    }
    return sizes;
}
/** The measured result sizes of every thread, the main one and
 * each branch, by step id. */
export function measuredStepSizes(data) {
    const sizes = new Map();
    const threads = [null, ...data.branches.map((branch) => branch.id)];
    for (const branchId of threads) {
        const counted = countedRequests(threadRequests(data, branchId));
        for (const [stepId, tokens] of measuredSizes(data, counted)) {
            sizes.set(stepId, tokens);
        }
    }
    return sizes;
}
/**
 * The items that entered inside one stretch of the thread,
 * in the order they entered. Prompts and loads are the main
 * thread's alone. Both ends of the window count, so the
 * stretch a compaction ended is read with an end just
 * before the compaction: what entered at the compaction's
 * own moment — the compact request's reply — opens the
 * next stretch, never both.
 */
function epochItems(data, branchId, requests, epochStart, moment) {
    const timed = [];
    if (branchId === null) {
        timed.push(...promptItems(data, epochStart, moment));
        timed.push(...loadItems(data, epochStart, moment));
    }
    const sizes = measuredSizes(data, countedRequests(requests));
    timed.push(...stepItems(data, branchId, epochStart, moment, sizes));
    timed.push(...handbackItems(data, branchId, epochStart, moment));
    timed.push(...replyItems(requests, epochStart, moment));
    // The sort is stable, so items that entered together keep
    // the order they were gathered in: a prompt before the
    // files it carried, a step before the reply that followed.
    timed.sort((a, b) => a.at - b.at);
    return timed.map((entry) => entry.item);
}
/** The thread's base: its first counted request's context,
 * the total the token history's base point carries. A
 * thread with no counted request has no base. */
function baseTokens(counted) {
    const first = counted[0];
    return first === undefined ? null : requestContextTokens(first);
}
/** The server an MCP tool's name names: mcp__<server>__<tool>. */
export function mcpServerOf(name) {
    const prefix = "mcp__";
    if (!name.startsWith(prefix))
        return null;
    const rest = name.slice(prefix.length);
    const cut = rest.indexOf("__");
    return cut > 0 ? rest.slice(0, cut) : null;
}
/** The epoch's instruction files of one thread, named as the
 * item list names a load, by the one shared naming rule. */
export function epochInstructions(data, branchId, epochStart, moment) {
    const list = [];
    for (const load of data.loads) {
        if (load.kind !== "instructions" || load.branchId !== branchId)
            continue;
        if (load.occurredAt < epochStart || load.occurredAt > moment)
            continue;
        list.push({
            loadId: load.id,
            name: loadName(load),
            bytes: load.sizeBytes,
            tokens: estimatedTokens(load.sizeBytes),
        });
    }
    return list;
}
/** The load kinds that name what a thread started with. */
const STARTUP_LOAD_KINDS = new Set([
    ...LISTING_KINDS,
    "preloaded-skill",
    "task-prompt",
]);
/** The report's figure for a startup kind, when the report
 * has a row for it. */
function reportedStartupTokens(report, kind) {
    switch (kind) {
        case "skill-listing":
            return report.skills;
        case "mcp-instructions":
            return report.mcpInstructions;
        default:
            return null;
    }
}
/**
 * A startup kind's size as the report states it. The report
 * counts a kind once, so it stands for a kind only when one
 * load made it up; several loads of a kind (servers that
 * connected later) keep their estimates, never the report's
 * total repeated on each.
 */
function withReportedSizes(list, report) {
    if (report === null)
        return list;
    return list.map((load) => {
        const reported = reportedStartupTokens(report, load.kind);
        const alone = list.filter((other) => other.kind === load.kind).length === 1;
        return reported !== null && alone
            ? { ...load, tokens: reported, fromContext: true }
            : load;
    });
}
/** A subagent's task is named by the type of the subagent that
 * launched it, null for the main conversation; the other kinds
 * keep the load's name. */
function startupLoadName(data, load) {
    const branch = load.branchId === null ? undefined : data.branchesById.get(load.branchId);
    if (branch === undefined)
        return load.name;
    if (load.kind === "task-prompt")
        return parentAgentTypeOf(data, branch);
    return load.name;
}
/**
 * One thread's startup additions in the epoch, largest first:
 * what Claude Code put in front of the model when the session
 * (or the stretch after a compaction) began. A compaction
 * re-sends them, and the repeat is a load of its own in the
 * new epoch's window, never a second copy in the old one.
 */
function epochStartup(data, branchId, epochStart, moment, report) {
    const list = [];
    for (const load of data.loads) {
        if (!STARTUP_LOAD_KINDS.has(load.kind))
            continue;
        // Each thread's start-up is its own: a subagent's transcript
        // re-sends the listings for its own context.
        if (load.branchId !== branchId)
            continue;
        if (load.occurredAt < epochStart || load.occurredAt > moment)
            continue;
        const chars = load.sizeBytes ?? 0;
        list.push({
            loadId: load.id,
            kind: load.kind,
            name: startupLoadName(data, load),
            count: load.itemCount,
            chars,
            tokens: estimatedTokens(chars),
            fromContext: false,
        });
    }
    return withReportedSizes(list.sort((a, b) => b.chars - a.chars), report);
}
/**
 * The `/context` report that describes the epoch's fixed
 * load: the latest one for the request's model, taken in
 * this epoch. A report is a snapshot of its moment, so one
 * taken after a compaction says nothing of the stretch
 * before it, and the fixed parts it sizes are the main
 * thread's.
 */
function epochReport(data, request, epochStart) {
    const report = contextReportFor(data.contextReports, request.model ?? data.session.model);
    if (report === null)
        return null;
    return mainEpoch(data, report.reportedAt).startedAt === epochStart
        ? report
        : null;
}
/** The system prompt's size: the report's figure when the
 * report has one, else the estimate from its bytes. */
function systemPart(systemBytes, report) {
    const reported = report?.systemPrompt ?? null;
    return {
        chars: systemBytes,
        tokens: reported ?? estimatedTokens(systemBytes),
        fromContext: reported !== null,
    };
}
/**
 * A shape's tools as the panel lists them: a tool the record
 * flags as MCP, or whose name carries the MCP form, groups by
 * its server; one whose server the name cannot name stays in
 * the plain list, largest first.
 */
function splitTools(shape) {
    const tools = [];
    const servers = new Map();
    for (const tool of shape.tools) {
        const server = tool.mcp || tool.name.startsWith("mcp__") ? mcpServerOf(tool.name) : null;
        if (server === null) {
            tools.push({
                name: tool.name,
                chars: tool.bytes,
                tokens: estimatedTokens(tool.bytes),
            });
            continue;
        }
        const group = servers.get(server) ?? { tools: 0, chars: 0 };
        group.tools += 1;
        group.chars += tool.bytes;
        servers.set(server, group);
    }
    tools.sort((a, b) => b.chars - a.chars);
    const mcp = [...servers.entries()]
        .map(([server, group]) => ({
        server,
        tools: group.tools,
        chars: group.chars,
        tokens: estimatedTokens(group.chars),
    }))
        .sort((a, b) => a.server.localeCompare(b.server));
    return { tools, mcp };
}
/**
 * The tool definitions' sizes shared out so they sum to the
 * figure a report gave for all of them, each in proportion
 * to its definition. The largest takes the rounding, so the
 * sum is exact.
 */
function sharedOut(tools, reported) {
    const chars = tools.reduce((sum, tool) => sum + tool.chars, 0);
    const shared = tools.map((tool) => ({
        ...tool,
        tokens: Math.round((reported * tool.chars) / chars),
    }));
    const rounding = reported - shared.reduce((sum, t) => sum + t.tokens, 0);
    const largest = shared[0];
    if (largest !== undefined)
        largest.tokens += rounding;
    return shared;
}
/**
 * The measured request's shape read as the fixed load: the
 * system prompt's size, each tool definition's size with
 * the MCP tools grouped by server, the epoch's instruction
 * files, and what was added at the epoch's start. A branch's
 * split names its own instruction files and start, never the
 * session's.
 * When the epoch's report sized the system tools, the tool
 * definitions share that figure out. MCP tools keep their
 * estimates: the report lists them apart, loaded on demand.
 */
function splitLoad(data, request, shape, systemBytes, branchId, epochStart, moment) {
    const split = splitTools(shape);
    const report = branchId === null ? epochReport(data, request, epochStart) : null;
    const toolsReported = split.tools.length > 0 ? (report?.systemTools ?? null) : null;
    const tools = toolsReported === null
        ? split.tools
        : sharedOut(split.tools, toolsReported);
    const { mcp } = split;
    const system = systemPart(systemBytes, report);
    const instructions = epochInstructions(data, branchId, epochStart, moment);
    const startup = epochStartup(data, branchId, epochStart, moment, report);
    return {
        kind: "split",
        requestId: request.id,
        total: splitTotalOf({ system, tools, mcp, instructions, startup }),
        system,
        tools,
        toolsReported,
        mcp,
        instructions,
        startup,
    };
}
/** The split's total: the sum a reader adds up from the
 * panel itself — every part's size, an unrecorded size
 * counting as nothing. Computed once, where the split is
 * built, so every reader of the panel works from one sum. */
function splitTotalOf(parts) {
    let total = parts.system.tokens;
    for (const part of [...parts.tools, ...parts.mcp, ...parts.startup]) {
        total += part.tokens;
    }
    for (const file of parts.instructions)
        total += file.tokens ?? 0;
    return total;
}
/**
 * What the measured request carried before any work: the
 * split of its recorded shape, or the thread's base total
 * when no shape — or no system size in it — was recorded,
 * or nothing when the thread recorded no context at all.
 */
function fixedLoad(data, branchId, counted, measured, epochStart, moment) {
    if (measured !== undefined && measured.shapeHash !== null) {
        const shape = data.requestShapes.find((row) => row.hash === measured.shapeHash);
        if (shape !== undefined && shape.systemBytes !== null) {
            return splitLoad(data, measured, shape, shape.systemBytes, branchId, epochStart, moment);
        }
    }
    const base = baseTokens(counted);
    return base === null ? null : { kind: "total", tokens: base };
}
/** How many of the files read most recently before a
 * compaction are re-read after it: five, per "What survives
 * compaction" in the official docs,
 * https://code.claude.com/docs/en/context-window#what-survives-compaction
 * — the same rule that re-injects the invoked skills. */
const RESTORED_FILE_LIMIT = 5;
/** How far a recorded file's moment may sit from its segment's
 * start for the two to be the same compaction. */
const COMPACTION_PAIR_MS = 10_000;
/** The files the transcript recorded for one compaction: those
 * whose moment is nearest this segment among the session's. */
function recordedFiles(data, segment) {
    const gap = (at, other) => Math.abs(other.startedAt - at);
    const restored = [];
    for (const file of data.compactionFiles) {
        const mine = gap(file.at, segment);
        if (mine > COMPACTION_PAIR_MS)
            continue;
        const nearer = data.segments.some((other) => other.kind === "compact" &&
            other.id !== segment.id &&
            gap(file.at, other) < mine);
        if (nearer)
            continue;
        restored.push({
            kind: "file",
            ref: file.id,
            name: file.name,
            reread: file.reread,
            tokens: file.reread ? estimatedTokens(file.sizeBytes) : null,
        });
    }
    return restored;
}
/** The most recently read files of the stretch before a
 * compaction, latest first, each path once. */
function recentFileReads(before) {
    const files = [];
    const seenPaths = new Set();
    for (let i = before.length - 1; i >= 0; i--) {
        if (files.length >= RESTORED_FILE_LIMIT)
            break;
        const item = before[i];
        if (item === undefined || item.kind !== "file-read")
            continue;
        if (seenPaths.has(item.path))
            continue;
        seenPaths.add(item.path);
        files.push({ kind: "file-read", ref: item.stepId, name: item.path });
    }
    return files;
}
/**
 * What a compaction put back: the files the transcript
 * recorded after it, or, for a compaction with none (recorded
 * before they were kept, or by an older Claude Code), the
 * rule in the official docs — the most recently read files of
 * the stretch before it. Every skill that stretch loaded is
 * added by the docs' rule either way. The view's note says
 * which parts are a rule, and nothing here claims more.
 */
function restoredItems(data, segment, before) {
    const recorded = recordedFiles(data, segment);
    const restored = recorded.length > 0 ? recorded : recentFileReads(before);
    const seenSkills = new Set();
    for (const item of before) {
        if (item.kind !== "skill" || seenSkills.has(item.loadId))
            continue;
        seenSkills.add(item.loadId);
        restored.push({ kind: "skill", ref: item.loadId, name: item.name });
    }
    return restored;
}
/** The start of the stretch a compaction ended: the
 * compaction before it, or the session's start. */
function previousEpochStart(data, segment) {
    let latest = null;
    for (const other of data.segments) {
        if (other.kind !== "compact" || other.id === segment.id)
            continue;
        const before = other.startedAt < segment.startedAt ||
            (other.startedAt === segment.startedAt && other.id < segment.id);
        if (!before)
            continue;
        if (latest === null || other.startedAt >= latest.startedAt) {
            latest = other;
        }
    }
    return latest === null ? data.session.firstSeenAt : latest.startedAt;
}
/**
 * The compaction that opened this stretch, read back: the
 * stretch before its items, built by the one item rule over
 * that earlier window, and what was put back.
 */
function compactionView(data, requests, segment) {
    // The window ends a millisecond before the compaction:
    // times are whole milliseconds, so the earlier stretch
    // loses nothing by it.
    const before = epochItems(data, null, requests, previousEpochStart(data, segment), segment.startedAt - 1);
    return {
        segmentId: segment.id,
        at: segment.startedAt,
        before,
        restored: restoredItems(data, segment, before),
        restoredNote: "restored by Claude Code (per its docs)",
    };
}
function epochSegment(data, epoch) {
    return epoch.afterCompactionSegmentId === null
        ? undefined
        : data.segments.find((row) => row.id === epoch.afterCompactionSegmentId);
}
/**
 * The fixed load's share of the remainder: the split's
 * total, whose instruction files the item list names
 * without a size, so every part is subtracted once. An
 * unsplit total is the thread's base, which already holds
 * the first prompt — and the first prompt is an item — so
 * subtracting it here would count that prompt twice.
 */
function fixedShare(fixed) {
    return fixed !== null && fixed.kind === "split" ? fixed.total : 0;
}
/**
 * An instruction file a split fixed load lists carries its
 * size there, so the item list names it without one. An
 * unsplit load lists none, and the file keeps its size in
 * the list.
 */
function withoutCountedInstructions(items, fixed) {
    if (fixed === null || fixed.kind !== "split")
        return items;
    return items.map((item) => item.kind === "instructions" ? { ...item, tokens: null } : item);
}
/** The totals: the measured count, the items' sum, what both
 * name — never more than was measured — and what the items
 * and the fixed load don't explain: null when they explain
 * it all or overshoot, never spread over the items. */
function totalsFor(measured, items, fixed) {
    const measuredTokens = measured === null ? null : measured.tokens;
    const itemsTotal = items.reduce((sum, item) => sum + (itemTokens(item) ?? 0), 0);
    // The fixed load is counted once: what the panel names is
    // not also left inside the unnamed remainder.
    const named = itemsTotal + fixedShare(fixed);
    const remainder = measuredTokens === null ? null : measuredTokens - named;
    return {
        measured: measuredTokens,
        items: itemsTotal,
        named: measuredTokens === null ? named : Math.min(named, measuredTokens),
        other: remainder !== null && remainder > 0 ? remainder : null,
    };
}
function scopeOf(data, branchId) {
    const branch = branchId === null ? undefined : data.branchesById.get(branchId);
    return branchId === null
        ? { kind: "main" }
        : {
            kind: "branch",
            branchId,
            agentType: branch === undefined ? null : branch.agentType,
        };
}
/** The thread's epoch: the main thread's from its last
 * compaction, a branch's from its first recorded moment. */
function epochOf(data, branchId, moment) {
    if (branchId === null)
        return mainEpoch(data, moment);
    const startedAt = data.branchesById.get(branchId)?.startedAt;
    if (startedAt === null || startedAt === undefined) {
        return {
            startedAt: data.session.firstSeenAt,
            afterCompactionSegmentId: null,
        };
    }
    // A subagent's transcript is written before its start event
    // arrives, so its task and start-up files are stamped earlier.
    let first = startedAt;
    for (const load of data.loads) {
        if (load.branchId === branchId && load.occurredAt < first) {
            first = load.occurredAt;
        }
    }
    return { startedAt: first, afterCompactionSegmentId: null };
}
function contextAt(data, anchor, pickMeasured) {
    const { branchId, moment } = anchor;
    const epoch = epochOf(data, branchId, moment);
    const requests = threadRequests(data, branchId);
    const counted = countedRequests(requests);
    const measuredRow = pickMeasured(counted);
    const measured = measuredRow === undefined ? null : measuredSummary(data, measuredRow);
    const segment = epochSegment(data, epoch);
    const fixed = fixedLoad(data, branchId, counted, measuredRow, epoch.startedAt, moment);
    const items = withoutCountedInstructions(epochItems(data, branchId, requests, epoch.startedAt, moment), fixed);
    return {
        stepId: anchor.stepId,
        scope: scopeOf(data, branchId),
        measured,
        epoch,
        items,
        fixedLoad: fixed,
        compaction: segment === undefined ? null : compactionView(data, requests, segment),
        totals: totalsFor(measured, items, fixed),
        states: {
            telemetry: data.session.sources.includes("telemetry"),
            tokensPartial: data.session.tokensPartial,
            joinedPartway: data.session.joinedPartway,
        },
    };
}
export function contextAtStep(data, stepId) {
    const step = data.stepsById.get(stepId);
    if (step === undefined)
        return null;
    // A step with no recorded times is read at the session's
    // last activity: the best moment the record holds.
    const moment = step.endedAt ?? step.startedAt ?? data.session.lastSeenAt;
    return contextAt(data, { stepId: step.id, branchId: step.branchId, moment }, (counted) => measuredRequest(counted, step, moment));
}
/**
 * What the agent had been given when one request was sent,
 * for a turn that ran no step to ask at. The request is its
 * own measure, and what had entered by the millisecond
 * before it started is what it carried. A request with no
 * recorded start has no moment to read at.
 */
function contextAtRequest(data, requestId) {
    const request = data.requests.find((row) => row.id === requestId);
    if (request?.startedAt == null)
        return null;
    const moment = request.startedAt - 1;
    return contextAt(data, { stepId: null, branchId: request.branchId, moment }, (counted) => counted.find((row) => row.id === request.id));
}
/** GET /api/sessions/:id/context — what one step had been given, or what
 * one request carried. */
export function sessionContext(storage, sessionId, ask) {
    const data = loadSessionData(storage, sessionId);
    if (data === undefined)
        return undefined;
    const found = "step" in ask
        ? contextAtStep(data, ask.step)
        : contextAtRequest(data, ask.request);
    return found ?? undefined;
}
