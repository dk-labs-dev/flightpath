// The transcript follower: tails a live session's transcripts
// from the last offset read as hook events arrive, and — on
// daemon start — imports the sessions hooks never captured,
// within strict limits: projects Flightpath has recorded in
// before, files modified since Flightpath was installed,
// never a forgotten session, never the entries inside a
// paused period, never an excluded folder (ADR-0019).
//
// Everything it applies lands through the store in
// ingest.ts; extraction happens in parse.ts, and everything
// stored has passed through intake redaction (ADR-0017).
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { REDACTION_VERSION } from "../redact/index.js";
import { scrubSecrets } from "../redact/secrets.js";
import { isExcludedFolder } from "../settings/index.js";
import { requestContextTokens } from "../storage/request-tokens.js";
import { yieldToEventLoop } from "../util/event-loop.js";
import { isPlainObject } from "../util/json.js";
import { writeFileAtomically } from "../util/fs.js";
import { isTypedPrompt, parseTranscriptLine, } from "./parse.js";
/** The Claude Code config folder, honouring CLAUDE_CONFIG_DIR. */
export function resolveClaudeConfigDir(env = process.env, home = homedir()) {
    const configured = env.CLAUDE_CONFIG_DIR;
    return configured !== undefined && configured.length > 0
        ? configured
        : join(home, ".claude");
}
/**
 * The auto-compact window from the Claude Code settings in
 * the config folder, when the user set one: the value the
 * token history measures the room against. Anything else —
 * no file, no key, a value that is not a positive number —
 * is no setting.
 */
export function readAutoCompactWindow(configDir) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    }
    catch {
        return null;
    }
    if (!isPlainObject(parsed))
        return null;
    const value = parsed["autoCompactWindow"];
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : null;
}
/** Project folder names encode a path: non-alphanumerics to '-'. */
export function encodeProjectPath(projectPath) {
    return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}
const INSTALL_STAMP = "installed-at";
/**
 * When Flightpath was first installed, as the import's lower
 * bound. The data folder's birth time is the honest answer for
 * installs that predate the stamp; the stamp (written on first
 * use) is the answer afterwards.
 */
function readInstalledAt(dataDir, now) {
    const stampPath = join(dataDir, INSTALL_STAMP);
    if (existsSync(stampPath)) {
        const parsed = Number(readFileSync(stampPath, "utf8").trim());
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    let installedAt = now;
    try {
        const birth = statSync(dataDir).birthtimeMs;
        if (Number.isFinite(birth) && birth > 0 && birth <= now) {
            installedAt = Math.floor(birth);
        }
    }
    catch {
        // No stat: the stamp written below is the bound.
    }
    try {
        writeFileSync(stampPath, String(installedAt), { flag: "wx" });
    }
    catch {
        // Already written, or the folder is read-only: either way the
        // computed value serves this run.
    }
    return installedAt;
}
export function createTranscriptFollower(storage, options) {
    const ctx = {
        storage,
        options,
        sessions: new Map(),
        offsetsPath: join(options.dataDir, "transcript-offsets.json"),
        persistedOffsets: null,
        chain: Promise.resolve(),
        refollowQueued: null,
    };
    return {
        follow: (sessionId, transcriptPath, cwd, sessionEnded = false) => followSession(ctx, sessionId, transcriptPath, cwd, sessionEnded),
        refollowActive: (now = Date.now()) => refollowActive(ctx, now),
        importAll: () => importAll(ctx),
    };
}
function sessionState(ctx, sessionId) {
    let state = ctx.sessions.get(sessionId);
    if (state === undefined) {
        state = {
            files: new Map(),
            partialMarked: false,
            versionNoted: undefined,
            lastActivityAt: 0,
            lastPath: null,
            lastCwd: undefined,
        };
        ctx.sessions.set(sessionId, state);
    }
    return state;
}
// Read offsets persist across daemon runs: the daemon exits
// when idle, and a long session's transcript can run to tens
// of megabytes, so re-reading from byte 0 on every start is
// not an option. The stored offset is the end of the last
// complete line; a trailing partial line is re-read whole.
function parseOffsetsInto(parsed, into) {
    if (typeof parsed !== "object" || parsed === null)
        return;
    for (const [path, value] of Object.entries(parsed)) {
        if (typeof value === "number" && value >= 0) {
            into.set(path, value);
        }
    }
}
function loadOffsets(ctx) {
    if (ctx.persistedOffsets !== null)
        return ctx.persistedOffsets;
    ctx.persistedOffsets = new Map();
    try {
        const parsed = JSON.parse(readFileSync(ctx.offsetsPath, "utf8"));
        parseOffsetsInto(parsed, ctx.persistedOffsets);
    }
    catch {
        // No file yet, or unreadable: start from the beginning.
    }
    return ctx.persistedOffsets;
}
function saveOffsets(ctx) {
    if (ctx.persistedOffsets === null)
        return;
    try {
        writeFileAtomically(ctx.offsetsPath, JSON.stringify(Object.fromEntries(ctx.persistedOffsets)));
    }
    catch {
        // Best effort: the in-memory offsets still serve this run.
    }
}
function fileState(ctx, state, path) {
    let file = state.files.get(path);
    if (file === undefined) {
        const offset = loadOffsets(ctx).get(path) ?? 0;
        file = {
            offset,
            partial: Buffer.alloc(0),
            pendingToolUse: [],
            currentTurnId: null,
            compactionAt: null,
            landedResults: new Map(),
            toolCalls: new Map(),
            lastRequestRowId: null,
            skillText: null,
            pendingApiRequests: new Map(),
            metaRead: false,
            openingToRecord: new Set(offset === 0 ? ["task-prompt", "preloaded-skills"] : []),
        };
        state.files.set(path, file);
    }
    return file;
}
function inPause(pauses, at) {
    if (at === null)
        return false;
    return pauses.some((pause) => at >= pause.pausedAt &&
        (pause.resumedAt === null || at < pause.resumedAt));
}
// One chunk of a transcript read: the memory a read can take
// is bounded by the chunk, not by the file, and between
// chunks the reader yields so queued hook events are handled.
// The line cap bounds the chunk's apply time, not just its
// size: a chunk of small lines is cheap to hold but still
// costs a database write per line, and an event arriving
// mid-chunk waits for the apply to finish.
const CHUNK_BYTES = 1 * 1024 * 1024;
const CHUNK_LINES = 200;
// A single line longer than this is consumed as one line
// anyway (it parses as an unknown entry and is skipped):
// real entries are far smaller, and the cap keeps one
// pathological line from unbounding the read.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
function entryTimestampMs(line) {
    try {
        const parsed = JSON.parse(line);
        if (typeof parsed.timestamp !== "string")
            return null;
        const at = Date.parse(parsed.timestamp);
        return Number.isNaN(at) ? null : at;
    }
    catch {
        // The tail window can cut the first line it holds; an
        // entry that does not parse is walked past.
        return null;
    }
}
/**
 * The timestamp of a transcript's last entry that carries
 * one, read from the file's tail: import's retention check,
 * so a whole file is never read just to date its end. Null
 * when no entry in the tail carries a readable timestamp.
 */
function readLastEntryAt(path) {
    let fd;
    let size;
    try {
        fd = openSync(path, "r");
        size = fstatSync(fd).size;
    }
    catch {
        return null;
    }
    try {
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const rawLine = lines[i];
            if (rawLine === undefined)
                continue;
            const line = rawLine.trim();
            if (line === "")
                continue;
            const at = entryTimestampMs(line);
            if (at !== null)
                return at;
        }
        return null;
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Read one chunk of the lines a file gained since the last
 * read, without moving the read position: the caller commits
 * the new position only once the chunk's lines have been
 * applied, so a failure partway through leaves them to be
 * read again. Every byte is read once: when the line cap
 * stops a chunk short of the window, the unconsumed tail is
 * carried in memory and applied by the next chunk, not read
 * again. A trailing line without its newline is held for
 * next time (and grown, chunk by chunk, up to
 * MAX_LINE_BYTES); a file that shrank (rotation, truncation)
 * starts over, and the store's upserts keep that from
 * double-counting.
 */
function readChunk(file, path) {
    let size;
    let fd;
    try {
        fd = openSync(path, "r");
        size = fstatSync(fd).size;
    }
    catch {
        return null;
    }
    try {
        const shrank = size < file.offset;
        const from = shrank ? 0 : file.offset;
        const held = shrank ? Buffer.alloc(0) : file.partial;
        const heldHasNewline = held.includes(0x0a);
        // Read enough to fill the window — unless what is held
        // is one line still growing, which only a longer read
        // can finish.
        const want = heldHasNewline
            ? Math.max(0, CHUNK_BYTES - held.length)
            : CHUNK_BYTES;
        const length = Math.min(size - from, want);
        if (length <= 0 && !heldHasNewline) {
            return null;
        }
        const fresh = Buffer.alloc(Math.max(0, length));
        if (length > 0)
            readSync(fd, fresh, 0, length, from);
        const data = Buffer.concat([held, fresh]);
        const nextOffset = from + Math.max(0, length);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline === -1) {
            return chunkWithoutNewline(data, nextOffset, size);
        }
        return splitChunkLines(data, lastNewline, nextOffset, size);
    }
    finally {
        closeSync(fd);
    }
}
function chunkWithoutNewline(data, nextOffset, size) {
    const end = nextOffset >= size;
    if (!end && data.length < MAX_LINE_BYTES) {
        // One line, still growing: hold it all and let the
        // next chunk continue it.
        return {
            lines: [],
            nextOffset,
            nextPartial: Buffer.from(data),
            end: false,
        };
    }
    if (!end) {
        // Past the line cap: consume what is held as one line
        // (an unknown entry, skipped) rather than grow forever.
        return {
            lines: [data.toString("utf8")],
            nextOffset,
            nextPartial: Buffer.alloc(0),
            end: false,
        };
    }
    // At the end of the file, a trailing line without its
    // newline is held for whenever the file grows.
    return {
        lines: [],
        nextOffset,
        nextPartial: Buffer.from(data),
        end: true,
    };
}
function splitChunkLines(data, lastNewline, nextOffset, size) {
    const lines = [];
    let start = 0;
    let consumed = 0;
    for (let i = 0; i <= lastNewline; i += 1) {
        if (data[i] === 0x0a) {
            lines.push(data.subarray(start, i).toString("utf8"));
            start = i + 1;
            consumed = start;
            if (lines.length >= CHUNK_LINES)
                break;
        }
    }
    const rest = data.subarray(consumed);
    const end = nextOffset >= size && !rest.includes(0x0a);
    return {
        lines,
        nextOffset,
        nextPartial: Buffer.from(rest),
        end,
    };
}
function noteSpan(span, timestampMs) {
    if (span === undefined || timestampMs === null)
        return;
    span.first =
        span.first === null ? timestampMs : Math.min(span.first, timestampMs);
    span.last =
        span.last === null ? timestampMs : Math.max(span.last, timestampMs);
}
function applyLine(ctx, sessionId, state, file, line, origin, result) {
    if (line.trim().length === 0)
        return;
    const { storage } = ctx;
    const parsed = parseTranscriptLine(line, {
        keepPromptText: origin.settings.storePromptText,
    });
    if (parsed.kind === "unknown") {
        result.skippedUnknown += 1;
        if (!state.partialMarked) {
            storage.markTokensPartial(sessionId);
            state.partialMarked = true;
        }
        return;
    }
    result.entries += 1;
    noteSpan(origin.span, parsed.timestampMs);
    if (parsed.version !== undefined && parsed.version !== state.versionNoted) {
        storage.noteTranscriptSeen(sessionId, parsed.version, Date.now());
        state.versionNoted = parsed.version;
    }
    if (inPause(origin.pauses, parsed.timestampMs)) {
        return; // A paused period is never filled in.
    }
    const at = parsed.timestampMs ?? Date.now();
    // The stored copy is the redacted entry (parse.ts produced
    // it); the entry's uuid, when it has one, dedupes re-reads.
    const uuid = typeof parsed.redacted.uuid === "string" ? parsed.redacted.uuid : null;
    storage.insertRawEvent({
        source: "transcript",
        sessionId,
        ...(parsed.timestampMs !== null ? { eventAt: parsed.timestampMs } : {}),
        redactionVersion: REDACTION_VERSION,
        body: JSON.stringify(parsed.redacted),
        ...(uuid !== null ? { envelopeId: `transcript:${uuid}` } : {}),
    });
    applyEntry(ctx, sessionId, file, parsed, at, origin, result);
}
function applyEntry(ctx, sessionId, file, parsed, at, origin, result) {
    // A skill's files follow its text with only attachments between.
    if (parsed.redacted.type !== "attachment")
        file.skillText = null;
    if (origin.branchId !== null) {
        recordSubagentStart(ctx, sessionId, file, parsed, at, origin.branchId);
    }
    if (parsed.kind === "user") {
        applyUserEntry(ctx, sessionId, file, parsed, at, origin);
        recordClaudeMessage(ctx, sessionId, file, parsed, at);
        recordSkillText(ctx, sessionId, file, parsed);
    }
    else if (parsed.kind === "compaction-boundary") {
        file.compactionAt = at;
    }
    else if (parsed.kind === "attachment") {
        applyAttachmentEntry(ctx, sessionId, file, parsed);
    }
    else if (parsed.kind === "startup-item") {
        applyStartupItem(ctx, sessionId, parsed, at, origin.branchId);
    }
    else if (parsed.kind === "request") {
        // The compaction's files precede its first request.
        file.compactionAt = null;
        applyRequestEntry(ctx, sessionId, file, parsed, origin, result);
    }
    else if (parsed.kind === "api-request") {
        applyApiRequestEntry(file, parsed);
    }
    else if (parsed.kind === "api-request-shape") {
        applyShapeEntry(ctx, sessionId, parsed);
    }
    else if (parsed.kind === "task-notification") {
        applyTaskNotification(ctx, sessionId, parsed);
    }
}
function applyTaskNotification(ctx, sessionId, parsed) {
    if (parsed.taskId === null || parsed.toolUseId === null)
        return;
    ctx.storage.linkUnlinkedBranchStep(sessionId, parsed.taskId, parsed.toolUseId);
}
/**
 * Record what came with one prompt (ADR-0004: kind, name and
 * size, never contents): its images, and the prompt itself —
 * its byte size and line count, always. Files the prompt
 * carried arrive as their own entries (applyAttachmentEntry);
 * words in the prompt text are never read as attachments.
 */
function applyPromptFacts(ctx, sessionId, turnId, parsed) {
    const { storage } = ctx;
    const attachments = [];
    let imageBytes = 0;
    for (const image of parsed.images) {
        imageBytes += image.bytes;
        attachments.push({
            kind: "image",
            name: image.mediaType,
            sizeBytes: image.bytes,
            lineCount: null,
        });
    }
    if (parsed.promptChars > 0) {
        attachments.push({
            kind: "prompt",
            name: null,
            sizeBytes: parsed.promptBytes,
            lineCount: parsed.promptLines,
        });
    }
    // The turn keeps the prompt's length too, where it has
    // none: with the text not kept, the length is all it holds.
    storage.fillTurnPromptFigures(turnId, parsed.promptChars, parsed.promptLines);
    storage.setTurnImages(turnId, parsed.images.length, imageBytes);
    storage.replacePromptAttachments(sessionId, turnId, attachments);
}
/** A path as the session's project folder names it; one outside
 * the folder, or with no folder known, stays as it is. */
function projectRelativePath(path, projectPath) {
    if (path === null || projectPath === null)
        return path;
    const inside = relative(projectPath, path);
    const outside = inside === ".." || inside.startsWith(`..${sep}`);
    return inside === "" || outside || isAbsolute(inside) ? path : inside;
}
/** The name an attached file goes by: its display path, else
 * its path relative to the project. */
function attachmentName(ctx, sessionId, attachment) {
    return (attachment.name ??
        projectRelativePath(attachment.path, ctx.storage.projectPathOf(sessionId)));
}
/**
 * The text Claude Code adds when a skill loads sizes the
 * skill's load, which the hook may report before or after it.
 */
function recordSkillText(ctx, sessionId, file, parsed) {
    if (parsed.skillText === null || parsed.timestampMs === null)
        return;
    const loadId = ctx.storage.recordSkillText({
        sessionId,
        name: parsed.skillText.name,
        bytes: parsed.skillText.bytes,
        at: parsed.timestampMs,
    });
    file.skillText = { loadId, timestampMs: parsed.timestampMs };
}
/**
 * One attachment entry: the file it names belongs to the
 * skill whose text it follows, else to the file's
 * current turn — attachment entries follow the prompt that
 * carried them — unless a compaction just happened, when the
 * files Claude Code put back belong to the compaction. With
 * no turn open in this file there is nothing to attach the
 * file to, and it is not recorded.
 */
function applyAttachmentEntry(ctx, sessionId, file, parsed) {
    if (file.compactionAt !== null) {
        const name = attachmentName(ctx, sessionId, parsed.attachment);
        if (name === null)
            return;
        ctx.storage.addCompactionFile(sessionId, {
            at: file.compactionAt,
            name,
            sizeBytes: parsed.attachment.sizeBytes,
            reread: !parsed.attachment.referenceOnly,
        });
        return;
    }
    // A named-only reference exists only after a compaction.
    if (parsed.attachment.referenceOnly)
        return;
    const skill = file.skillText;
    if (skill !== null) {
        const name = attachmentName(ctx, sessionId, parsed.attachment);
        if (name !== null) {
            ctx.storage.addSkillFile({
                sessionId,
                skillLoadId: skill.loadId,
                path: name,
                bytes: parsed.attachment.sizeBytes,
                lines: parsed.attachment.lineCount,
                at: skill.timestampMs,
            });
            return;
        }
    }
    if (file.currentTurnId === null)
        return;
    ctx.storage.addPromptAttachment(sessionId, file.currentTurnId, {
        kind: parsed.attachment.kind,
        name: parsed.attachment.name,
        sizeBytes: parsed.attachment.sizeBytes,
        lineCount: null,
    });
}
/**
 * One thing added at session start. The listings and a hook's
 * output become loads of their own kind — the follower writes
 * them, replay rebuilds them, and they are deleted with the
 * session, like every load. The instruction files' entry
 * writes no row of its own: the InstructionsLoaded hook
 * already recorded those loads, so the entry only fills a
 * size the hook could not stat.
 */
function applyStartupItem(ctx, sessionId, parsed, at, branchId) {
    const { storage } = ctx;
    const item = parsed.item;
    if (item.kind === "instructions") {
        // A subagent's files are recorded as its start, not by a hook.
        if (branchId !== null)
            return;
        for (const file of item.files) {
            storage.fillInstructionSize({
                sessionId,
                filePath: file.path,
                chars: file.chars,
                at,
            });
        }
        return;
    }
    storage.recordTranscriptLoad({
        sessionId,
        kind: item.kind,
        name: item.name,
        count: item.count,
        names: item.kind === "skill-listing" ? item.names : null,
        chars: item.chars,
        at,
        branchId,
    });
}
/**
 * What a subagent started with, as sizes (ADR-0004): its
 * transcript opens with the task prompt, then one meta entry
 * for each skill it preloads, then a reminder (not recorded)
 * and the instruction files it loaded. The listings that
 * follow are recorded by applyStartupItem.
 */
function recordSubagentStart(ctx, sessionId, file, parsed, at, branchId) {
    const load = { sessionId, count: null, names: null, at, branchId };
    if (parsed.kind === "user" && parsed.toolResultSizes.size === 0) {
        const skill = parsed.commandMessageName;
        if (skill !== null && file.openingToRecord.has("preloaded-skills")) {
            ctx.storage.recordTranscriptLoad({
                ...load,
                kind: "preloaded-skill",
                name: skill,
                chars: parsed.promptChars,
            });
        }
        else if (!parsed.isMeta && file.openingToRecord.has("task-prompt")) {
            file.openingToRecord.delete("task-prompt");
            ctx.storage.recordTranscriptLoad({
                ...load,
                kind: "task-prompt",
                name: null,
                chars: parsed.promptChars,
            });
        }
    }
    else if (parsed.kind === "request") {
        file.openingToRecord.delete("preloaded-skills");
    }
    else if (parsed.kind === "startup-item") {
        if (parsed.item.kind !== "instructions")
            return;
        for (const { path, chars } of parsed.item.files) {
            ctx.storage.recordTranscriptLoad({
                ...load,
                kind: "instructions",
                name: null,
                filePath: scrubSecrets(path),
                chars,
            });
        }
    }
}
/**
 * Remember an entry's landed results and each one's size as
 * sent, for the link the next recorded request settles. The
 * first sight of a result sets its size; a repeated entry for
 * the same id never replaces it.
 */
function recordLandedResults(file, parsed, at) {
    for (const [id, size] of parsed.toolResultSizes) {
        // The interruption's own result is not one that landed.
        if (parsed.interruptResultIds.includes(id))
            continue;
        if (!file.landedResults.has(id)) {
            file.landedResults.set(id, {
                size,
                at,
                failed: parsed.errorResultIds.includes(id),
            });
        }
    }
}
function recordClaudeMessage(ctx, sessionId, file, parsed, at) {
    if (parsed.claudeMessage === null || file.currentTurnId === null)
        return;
    ctx.storage.insertClaudeMessage(sessionId, file.currentTurnId, at, parsed.claudeMessage);
}
/** A `/context` report in the entry: what it states, and
 * the report itself as a load, because it entered the
 * conversation. */
function recordReportEntry(ctx, sessionId, parsed, at) {
    if (parsed.contextReport !== null) {
        ctx.storage.recordContextReport(sessionId, parsed.contextReport, at);
    }
    if (parsed.commandOutput !== null) {
        ctx.storage.recordTranscriptLoad({
            sessionId,
            kind: "command-output",
            name: parsed.commandOutput.command,
            count: null,
            names: null,
            chars: parsed.commandOutput.chars,
            at,
            branchId: null,
        });
    }
}
/**
 * Close every step still pending as interrupted: an
 * interrupt marker entry announces that each of them was
 * cut off, and nothing of theirs is still to come.
 */
function closePendingInterrupted(ctx, sessionId, file, at) {
    for (const id of file.pendingToolUse) {
        ctx.storage.closeStepInterrupted(sessionId, id, at);
    }
    file.pendingToolUse = [];
}
function applyUserEntry(ctx, sessionId, file, parsed, at, origin) {
    const { storage } = ctx;
    for (const id of parsed.toolResultSizes.keys()) {
        const index = file.pendingToolUse.indexOf(id);
        if (parsed.interruptResultIds.includes(id)) {
            // The interrupted tool is answered by an error result
            // carrying the marker text: it carries the interruption
            // itself, so close the step here — the marker entry
            // that follows would find nothing pending.
            storage.closeStepInterrupted(sessionId, id, at);
            if (index >= 0)
                file.pendingToolUse.splice(index, 1);
        }
        else if (!parsed.errorResultIds.includes(id)) {
            if (index >= 0)
                file.pendingToolUse.splice(index, 1);
        }
        // An error result without the marker stays pending: it
        // may be the interrupted tool (whose marker entry comes
        // next) or a plain failure (cleared at the next prompt).
    }
    recordLandedResults(file, parsed, at);
    recordReportEntry(ctx, sessionId, parsed, at);
    // Only an entry that is a prompt the person typed opens a
    // turn: no tool results coming back, not an interrupt
    // marker, not one of Claude Code's own housekeeping
    // entries, and typed — a command's entries, a subagent's
    // hand-back and a task notification are not turns, and
    // their text is never stored as a prompt.
    const isPromptEntry = parsed.toolResultSizes.size === 0 &&
        !parsed.isInterrupt &&
        !parsed.isMeta &&
        isTypedPrompt(parsed);
    if (isPromptEntry) {
        // Only an entry with the person's origin ends the compaction's files.
        if (parsed.originKind === "human")
            file.compactionAt = null;
        // A new prompt ends the previous turn's accounting:
        // anything still pending was a plain failure, and a result
        // no request took in before the prompt never reaches one.
        file.pendingToolUse = [];
        file.landedResults.clear();
        // The prompt's facts are recorded only for the turn this
        // entry actually resolved: a prompt id the hooks never
        // recorded, in a follow that may not create turns, leaves
        // the facts unrecorded rather than on the previous turn.
        let resolvedTurnId = null;
        if (parsed.promptId !== null) {
            resolvedTurnId =
                storage.turnIdByPrompt(sessionId, parsed.promptId) ??
                    (origin.createTurns
                        ? storage.ensureTranscriptTurn(sessionId, parsed.promptId, at, parsed.promptText)
                        : null);
            if (resolvedTurnId !== null)
                file.currentTurnId = resolvedTurnId;
        }
        else if (origin.createTurns) {
            resolvedTurnId = storage.ensureTranscriptTurn(sessionId, null, at, parsed.promptText);
            file.currentTurnId = resolvedTurnId;
        }
        if (resolvedTurnId !== null) {
            applyPromptFacts(ctx, sessionId, resolvedTurnId, parsed);
        }
    }
    if (parsed.isInterrupt) {
        closePendingInterrupted(ctx, sessionId, file, at);
    }
}
/**
 * Settle what a newly recorded request takes in: the steps
 * whose results landed since the previous request link to it
 * (its input is the first to include them). A landed call no
 * step names becomes a step from the transcript here, closed
 * by its result — the wait until the next request tells a
 * hook-reported call from one the hooks never reported.
 * Runs only for a request this file has not recorded before:
 * one request writes several response entries, and a result
 * landing between two of them belongs to the next request,
 * never to the one that issued the call.
 */
function settleRequestLinks(ctx, sessionId, file, rowId) {
    const { storage } = ctx;
    file.lastRequestRowId = rowId;
    for (const [id, landed] of file.landedResults) {
        storage.linkStepResult(sessionId, id, rowId, landed.size);
        const call = file.toolCalls.get(id);
        if (call !== undefined) {
            storage.createTranscriptStep({
                sessionId,
                turnId: call.turnId,
                branchId: call.branchId,
                toolUseId: id,
                toolName: call.name,
                inputSummary: call.inputSummary,
                startedAt: call.startedAt,
                endedAt: landed.at,
                failed: landed.failed,
                requestRowId: rowId,
                size: landed.size,
            });
        }
        file.toolCalls.delete(id);
    }
    file.landedResults.clear();
}
/**
 * Apply a held request entry to the request it describes: a
 * response entry names the entry's client id as its
 * requestRef. Applying is idempotent — the same effort, the
 * same cache facts and the same shape link every time — so
 * it runs on any entry of the request, including a re-read
 * of the file.
 */
function applyHeldApiRequest(ctx, file, parsed, rowId) {
    if (parsed.requestRef === null)
        return;
    const pending = file.pendingApiRequests.get(parsed.requestRef);
    if (pending === undefined)
        return;
    file.pendingApiRequests.delete(parsed.requestRef);
    applyApiRequest(ctx, pending, rowId);
}
function applyRequestEntry(ctx, sessionId, file, parsed, origin, result) {
    const { storage } = ctx;
    const turnId = file.currentTurnId ??
        origin.spawningTurnId ??
        storage.latestTurnId(sessionId);
    const rowId = storage.upsertRequest({
        sessionId,
        requestId: parsed.requestId,
        turnId,
        branchId: origin.branchId,
        model: parsed.model,
        querySource: origin.querySource,
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        cacheReadTokens: parsed.usage.cacheReadTokens,
        cacheWrite5mTokens: parsed.usage.cacheWrite5mTokens,
        cacheWrite1hTokens: parsed.usage.cacheWrite1hTokens,
        tokenSource: "transcript",
        startedAt: parsed.timestampMs,
        durationMs: null,
        effort: null,
    });
    result.requests += 1;
    // The upsert returns the same row for every response entry
    // of one request: only a row this file has not settled
    // settles (see settleRequestLinks).
    if (rowId !== file.lastRequestRowId) {
        settleRequestLinks(ctx, sessionId, file, rowId);
    }
    applyHeldApiRequest(ctx, file, parsed, rowId);
    if (parsed.timestampMs !== null) {
        const contextTokens = requestContextTokens(parsed.usage);
        storage.insertContextSample({
            sessionId,
            requestRowId: rowId,
            sampledAt: parsed.timestampMs,
            contextTokens,
            source: "transcript",
        });
    }
    // An id already pending stays pending once: a chunk read
    // again after a failed commit must leave the same state
    // as one read once.
    for (const use of parsed.toolUses) {
        if (!file.pendingToolUse.includes(use.id)) {
            file.pendingToolUse.push(use.id);
        }
    }
    recordToolCalls(file, parsed, turnId, origin.branchId);
}
/**
 * Keep a request entry's tool calls, from the first entry
 * that named each one: a later entry of the same request
 * restates the call, and the first sight is the record.
 */
function recordToolCalls(file, parsed, turnId, branchId) {
    for (const use of parsed.toolUses) {
        if (!file.toolCalls.has(use.id)) {
            file.toolCalls.set(use.id, {
                name: use.name,
                inputSummary: use.inputSummary,
                startedAt: parsed.timestampMs,
                turnId,
                branchId,
            });
        }
    }
}
/**
 * Apply one request entry's facts to the request it describes:
 * its effort, the cache lifetime per block and the context
 * edits it applied — facts of the request itself — and the
 * shape the entry names. The link names the shape row by the
 * transcript's own hash and lands only when that row is
 * stored: the shape entry that wrote it may have been read
 * by an earlier run of the follower, and a shape no session
 * named and no request referenced may since have been
 * deleted with a forgotten session, in which case the
 * request records no shape.
 */
function applyApiRequest(ctx, parsed, rowId) {
    const { storage } = ctx;
    if (parsed.effort !== null) {
        storage.setRequestEffort(rowId, parsed.effort);
    }
    storage.setRequestCacheFacts(rowId, parsed.cacheLifetimes, parsed.contextEdits);
    if (parsed.shapeHash !== null) {
        storage.setRequestShape(rowId, parsed.shapeHash);
    }
}
function applyApiRequestEntry(file, parsed) {
    // A request entry is written before the response entries of
    // the request it describes, so it is always held: a response
    // entry naming its client id applies it (see
    // applyHeldApiRequest). An entry whose request never lands
    // applies nothing.
    if (parsed.clientId !== null) {
        file.pendingApiRequests.set(parsed.clientId, parsed);
    }
}
function applyShapeEntry(ctx, sessionId, parsed) {
    // A shape entry is written when the shape changes, before
    // the requests it describes. It is stored under the hash it
    // names itself by, and links only to a request whose own
    // entry names that hash; an entry naming no hash keys no
    // row, and no request can name it either. The session's
    // naming of the shape is recorded with the row: the shape
    // is live from this entry until its last request lands,
    // which can be minutes later, and a forget or purge in
    // between must not delete it from under the live follow.
    if (parsed.shapeHash !== null) {
        const shape = {
            systemBytes: parsed.systemBytes,
            tools: parsed.tools,
        };
        ctx.storage.upsertRequestShape(parsed.shapeHash, shape);
        ctx.storage.noteRequestShape(sessionId, parsed.shapeHash);
    }
}
/**
 * Every field of the file's state, with its collections copied:
 * applying edits them in place, and a field left out of the
 * snapshot would survive a rollback.
 */
function snapshotChunkState(state, file) {
    return {
        file: {
            ...file,
            pendingToolUse: [...file.pendingToolUse],
            landedResults: new Map(file.landedResults),
            toolCalls: new Map(file.toolCalls),
            pendingApiRequests: new Map(file.pendingApiRequests),
            openingToRecord: new Set(file.openingToRecord),
        },
        partialMarked: state.partialMarked,
        versionNoted: state.versionNoted,
    };
}
function restoreChunkState(state, file, snapshot) {
    Object.assign(file, snapshot.file);
    state.partialMarked = snapshot.partialMarked;
    state.versionNoted = snapshot.versionNoted;
}
async function followFile(ctx, sessionId, state, path, origin, result) {
    const file = fileState(ctx, state, path);
    for (;;) {
        const read = readChunk(file, path);
        if (read === null)
            return;
        if (read.lines.length > 0) {
            // The chunk's rows land together or not at all: if
            // applying throws, the transaction rolls back and the
            // read position stands, so the next follow reads the
            // chunk again — and the store's upserts and the pending
            // guard keep that re-read from double-counting. The
            // in-memory state applying touches is restored too:
            // the transaction undoes the rows it wrote, so a flag
            // left set (tokens marked partial, a version noted, a
            // pending id) would make the re-read skip a write it
            // believes already happened.
            const before = snapshotChunkState(state, file);
            try {
                ctx.storage.transaction(() => {
                    for (const line of read.lines) {
                        applyLine(ctx, sessionId, state, file, line, origin, result);
                    }
                });
            }
            catch (error) {
                restoreChunkState(state, file, before);
                throw error;
            }
        }
        // The lines are in: only now does the read position move,
        // in memory and on disk together.
        file.offset = read.nextOffset;
        file.partial = read.nextPartial;
        loadOffsets(ctx).set(path, read.nextOffset - read.nextPartial.length);
        saveOffsets(ctx);
        if (read.end)
            return;
        // A long read never holds the daemon: between chunks,
        // queued hook events get their turn.
        await yieldToEventLoop();
    }
}
/**
 * The read settles — true — once the link has landed, the
 * meta names no usable call, or the branch exists and the
 * lookup finds no step for the call it names: the launch's
 * PreToolUse precedes all of the subagent's own events, the
 * branch among them, so that step is not expected, and the
 * branch keeps the link the window or a task notification
 * gave it. A meta not yet written, or a branch not yet
 * recorded, settles nothing: the next pass reads it again.
 */
function linkSubagentMeta(ctx, sessionId, agentId, metaPath) {
    let meta;
    try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
    }
    catch {
        return false;
    }
    if (!isPlainObject(meta))
        return true;
    const toolUseId = meta.toolUseId;
    if (typeof toolUseId !== "string" || toolUseId === "")
        return true;
    if (ctx.storage.branchIdByAgent(sessionId, agentId) === null)
        return false;
    ctx.storage.linkBranchStep(sessionId, agentId, toolUseId);
    return true;
}
async function followSubagentFiles(ctx, sessionId, state, transcriptPath, base, result) {
    // Subagent transcripts live beside the main one:
    // <project>/<session-id>/subagents/agent-<agentId>.jsonl
    const subagentsDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
    let names;
    try {
        names = readdirSync(subagentsDir).sort();
    }
    catch {
        names = [];
    }
    for (const name of names) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl"))
            continue;
        const agentId = name.slice("agent-".length, -".jsonl".length);
        const path = join(subagentsDir, name);
        const file = fileState(ctx, state, path);
        const branchId = ctx.storage.branchIdByAgent(sessionId, agentId);
        // A subagent's file appears before its start event: a live
        // follow leaves its opening lines until the branch exists.
        if (branchId === null && !base.createTurns && !base.sessionEnded)
            continue;
        if (!file.metaRead) {
            file.metaRead = linkSubagentMeta(ctx, sessionId, agentId, join(subagentsDir, `${name.slice(0, -".jsonl".length)}.meta.json`));
        }
        await followFile(ctx, sessionId, state, path, {
            createTurns: base.createTurns,
            querySource: "subagent",
            branchId,
            spawningTurnId: ctx.storage.spawningTurnId(sessionId, agentId),
            pauses: base.pauses,
            settings: base.settings,
            ...(base.span !== undefined ? { span: base.span } : {}),
        }, result);
    }
}
async function followInternal(ctx, sessionId, transcriptPath, createTurns, sessionEnded, span) {
    const result = { entries: 0, requests: 0, skippedUnknown: 0 };
    const state = sessionState(ctx, sessionId);
    const settings = ctx.options.settings();
    const pauses = ctx.storage.pausesFor(sessionId);
    await followFile(ctx, sessionId, state, transcriptPath, {
        createTurns,
        querySource: "main",
        branchId: null,
        spawningTurnId: null,
        pauses,
        settings,
        ...(span !== undefined ? { span } : {}),
    }, result);
    await followSubagentFiles(ctx, sessionId, state, transcriptPath, {
        createTurns,
        sessionEnded,
        pauses,
        settings,
        ...(span !== undefined ? { span } : {}),
    }, result);
    if (result.entries > 0) {
        ctx.storage.touchSession(sessionId, Date.now());
    }
    return result;
}
// Reads share the follower's per-file state, so they run one
// at a time, in the order they were asked for: a follow, a
// re-follow pass and an import file never interleave on the
// same state. Each read still yields between its chunks, so
// the queue never holds up the daemon's event loop.
function enqueue(ctx, task) {
    const run = ctx.chain.then(task, task);
    ctx.chain = run.then(() => undefined, () => undefined);
    return run;
}
/**
 * A forgotten session is never followed again, so its held
 * state is dropped outright rather than skipped over — an
 * idle entry would otherwise linger until the daemon exits.
 */
function dropIfForgotten(ctx, sessionId) {
    if (!ctx.storage.isForgotten(sessionId))
        return false;
    ctx.sessions.delete(sessionId);
    return true;
}
function followSession(ctx, sessionId, transcriptPath, cwd, sessionEnded) {
    const empty = { entries: 0, requests: 0, skippedUnknown: 0 };
    if (dropIfForgotten(ctx, sessionId))
        return Promise.resolve(empty);
    const settings = ctx.options.settings();
    if (cwd !== undefined && isExcludedFolder(cwd, settings.excludedFolders)) {
        return Promise.resolve(empty);
    }
    const state = sessionState(ctx, sessionId);
    state.lastActivityAt = Date.now();
    state.lastPath = transcriptPath;
    state.lastCwd = cwd;
    return enqueue(ctx, () => followInternal(ctx, sessionId, transcriptPath, false, sessionEnded));
}
function refollowActive(ctx, now) {
    if (ctx.refollowQueued !== null)
        return ctx.refollowQueued;
    ctx.refollowQueued = enqueue(ctx, async () => {
        for (const [sessionId, state] of ctx.sessions) {
            if (dropIfForgotten(ctx, sessionId))
                continue;
            if (state.lastPath === null)
                continue;
            if (now - state.lastActivityAt > 60_000)
                continue;
            const settings = ctx.options.settings();
            if (state.lastCwd !== undefined &&
                isExcludedFolder(state.lastCwd, settings.excludedFolders)) {
                continue;
            }
            const result = await followInternal(ctx, sessionId, state.lastPath, false, false);
            if (result.entries > 0)
                state.lastActivityAt = Date.now();
        }
    }).then(() => {
        ctx.refollowQueued = null;
    }, (error) => {
        ctx.refollowQueued = null;
        throw error;
    });
    return ctx.refollowQueued;
}
async function importOneFile(ctx, sessionId, path, projectPath, settings, installedAt, total) {
    // The eligibility checks run inside the queued task: a
    // session recorded by hooks while its import waited is no
    // longer transcript-only.
    if (ctx.storage.isForgotten(sessionId))
        return;
    if (ctx.storage.isPurged(sessionId))
        return;
    if (ctx.storage.hasRawEvents(sessionId))
        return;
    let mtime;
    try {
        mtime = statSync(path).mtimeMs;
    }
    catch {
        return;
    }
    if (mtime < installedAt)
        return;
    // A transcript whose last entry is older than the
    // retention window would be purged as soon as it
    // landed; it is not imported at all (ADR-0025).
    const lastEntryAt = readLastEntryAt(path);
    if (lastEntryAt !== null &&
        lastEntryAt < Date.now() - settings.retentionDays * DAY_MS) {
        return;
    }
    ctx.storage.ensureImportedSession(sessionId, projectPath, Math.floor(mtime));
    const span = {
        first: null,
        last: null,
    };
    const followed = await followInternal(ctx, sessionId, path, true, false, span);
    // An imported session is finished: ended, with its
    // bounds from its own first and last entries.
    ctx.storage.finishImportedSession(sessionId, span.first ?? Math.floor(mtime), span.last ?? Math.floor(mtime));
    total.importedSessions += 1;
    total.entries += followed.entries;
    total.requests += followed.requests;
}
async function importProjectFolder(ctx, projectsRoot, folder, projectPath, settings, installedAt, total) {
    const dir = join(projectsRoot, folder);
    let names;
    try {
        names = readdirSync(dir).sort();
    }
    catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith(".jsonl"))
            continue;
        const sessionId = basename(name, ".jsonl");
        const path = join(dir, name);
        // One file at a time, through the same queued reader
        // as live follows, so an import never holds the daemon
        // and a follow asked for in the meantime is served
        // between files.
        await enqueue(ctx, () => importOneFile(ctx, sessionId, path, projectPath, settings, installedAt, total));
    }
}
async function importAll(ctx) {
    const total = { importedSessions: 0, entries: 0, requests: 0 };
    const settings = ctx.options.settings();
    const installedAt = readInstalledAt(ctx.options.dataDir, Date.now());
    const recorded = new Map();
    for (const projectPath of ctx.storage.recordedProjectPaths()) {
        recorded.set(encodeProjectPath(projectPath), projectPath);
    }
    if (recorded.size === 0)
        return total;
    const projectsRoot = join(ctx.options.configDir, "projects");
    let folders;
    try {
        folders = readdirSync(projectsRoot).sort();
    }
    catch {
        return total;
    }
    for (const folder of folders) {
        const projectPath = recorded.get(folder);
        if (projectPath === undefined)
            continue;
        if (isExcludedFolder(projectPath, settings.excludedFolders)) {
            continue;
        }
        await importProjectFolder(ctx, projectsRoot, folder, projectPath, settings, installedAt, total);
    }
    return total;
}
