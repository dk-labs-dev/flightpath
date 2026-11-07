// Parsing one transcript line into what the reader may use.
//
// A transcript entry holds the whole conversation, so this is
// the extraction boundary: the parser takes the request id, the
// model, the token counts, timestamps, the prompt id, tool-use
// ids and interrupt markers, and — from the request entries
// newer versions write — a request's effort and the sizes and
// names of what it was sent. A prompt's images and attachments
// reduce to media types, names and sizes here; the image data
// itself is measured, never read out. Message text is
// read only to recognize an interrupt marker (a boolean, never
// stored) and, when the user keeps prompt text, to hand the
// prompt to the turn the entry opens, exactly as the hook does.
// Whatever is stored passes through redactTranscriptEntry first
// (ADR-0017, ADR-0019).
import { effortLevel } from "../effort.js";
import { AGENT_MESSAGE_OPENING, TASK_NOTIFICATION_OPENING, } from "../prompt-kind.js";
import { REDACTION_VERSION, redactTranscriptEntry } from "../redact/index.js";
import { scrubSecrets } from "../redact/secrets.js";
import { countOf, isPlainObject, textOf } from "../util/json.js";
// The openings of Claude Code's own user entries, in one
// place. `command` marks a local command's own entries —
// its invocation and the output it prints — against the rest.
const CLAUDE_OPENINGS = [
    { marker: "<command-name>", command: true },
    { marker: "<local-command-stdout>", command: true },
    { marker: "<local-command-stderr>", command: true },
    { marker: "<local-command-caveat>", command: false },
    { marker: TASK_NOTIFICATION_OPENING, command: false },
    { marker: AGENT_MESSAGE_OPENING, command: false },
];
const NON_PROMPT_OPENINGS = CLAUDE_OPENINGS.map((opening) => opening.marker);
const COMMAND_OPENINGS = CLAUDE_OPENINGS.filter((opening) => opening.command).map((opening) => opening.marker);
/**
 * A user entry is a typed prompt unless its origin names
 * someone other than the person, or its first text block
 * opens with one of Claude Code's own openings. A command
 * entry is a command whatever its origin says.
 */
export function isTypedPrompt(parsed) {
    if (parsed.originKind !== null && parsed.originKind !== "human") {
        return false;
    }
    return !parsed.opensWithClaudeOpening;
}
const COMMAND_NAME = /^<command-name>\s*(\S+?)\s*<\/command-name>/;
// A command run in the terminal leaves its name in an entry of
// its own; /context leaves only its report, a meta entry that
// opens with this heading.
const CONTEXT_REPORT_OPENING = "## Context Usage";
function commandNameOf(entry, texts) {
    const opening = texts[0]?.trimStart() ?? "";
    if (entry.isMeta === true && opening.startsWith(CONTEXT_REPORT_OPENING)) {
        return "/context";
    }
    return COMMAND_NAME.exec(opening)?.[1] ?? null;
}
/**
 * Whether a user entry is Claude Code speaking, and if so
 * what to keep of it. A recorded origin decides; an entry
 * with none is a command only by its text, and a typed
 * prompt carries the origin "human" and is never one.
 */
function claudeMessageOf(entry, origin, texts, chars) {
    const originKind = origin === undefined ? undefined : textOf(origin.kind);
    if (originKind === "peer" && origin?.handback === true) {
        return {
            kind: "handback",
            agentType: textOf(origin.name) ?? null,
            agentId: textOf(origin.from) ?? null,
            chars,
        };
    }
    if (originKind === "task-notification")
        return { kind: "notice", chars };
    if (originKind !== undefined)
        return null;
    const name = commandNameOf(entry, texts);
    return name === null ? null : { kind: "command", name: scrubSecrets(name) };
}
// The two texts Claude Code writes into a user entry when the
// user interrupts. They are recognized, never stored: the entry
// reduces to sizes under redaction like any other text.
const INTERRUPT_TEXTS = new Set([
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
]);
function timestampOf(entry) {
    const raw = entry.timestamp;
    if (typeof raw !== "string")
        return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
}
function versionOf(entry) {
    return textOf(entry.version);
}
function readContent(content) {
    const blocks = {
        texts: [],
        toolResultSizes: new Map(),
        errorResultIds: [],
        interruptResultIds: [],
        images: [],
    };
    if (typeof content === "string") {
        blocks.texts.push(content);
        return blocks;
    }
    if (!Array.isArray(content))
        return blocks;
    for (const block of content) {
        if (!isPlainObject(block))
            continue;
        if (block.type === "text" && typeof block.text === "string") {
            blocks.texts.push(block.text);
        }
        else if (block.type === "image") {
            // The image itself is never read: its media type and the
            // encoded size are the record (ADR-0004).
            const source = isPlainObject(block.source) ? block.source : undefined;
            blocks.images.push({
                mediaType: source !== undefined ? (textOf(source.media_type) ?? null) : null,
                bytes: source !== undefined && typeof source.data === "string"
                    ? source.data.length
                    : 0,
            });
        }
        else if (block.type === "tool_result") {
            const id = textOf(block.tool_use_id);
            if (id === undefined)
                continue;
            const texts = toolResultTexts(block.content);
            blocks.toolResultSizes.set(id, {
                chars: texts.reduce((sum, text) => sum + text.length, 0),
                images: toolResultImages(block.content),
                asyncLaunch: false,
                savedBytes: savedOutputBytes(texts),
            });
            if (block.is_error === true)
                blocks.errorResultIds.push(id);
            if (texts.some((text) => INTERRUPT_TEXTS.has(text.trim()))) {
                blocks.interruptResultIds.push(id);
            }
        }
    }
    return blocks;
}
/**
 * A tool result's own content, as text: the string itself, or
 * its text blocks' text.
 */
function toolResultTexts(content) {
    if (typeof content === "string")
        return [content];
    if (!Array.isArray(content))
        return [];
    return content
        .filter((part) => isPlainObject(part) &&
        part.type === "text" &&
        typeof part.text === "string")
        .map((part) => part.text);
}
const SAVED_OUTPUT_OPENING = "<persisted-output>";
const SAVED_OUTPUT_SIZE = /Output too large \((\d+(?:\.\d+)?)(KB|MB)\)/;
/** Bytes a saved-output notice gives for the file; null for any other result. */
function savedOutputBytes(texts) {
    const notice = texts.find((text) => text.trimStart().startsWith(SAVED_OUTPUT_OPENING));
    const size = notice === undefined ? null : SAVED_OUTPUT_SIZE.exec(notice);
    if (size?.[1] === undefined)
        return null;
    return Math.round(Number(size[1]) * (size[2] === "MB" ? 1_000_000 : 1_000));
}
/**
 * Flags the result of a tool that started a subagent in the
 * background. The entry's `toolUseResult` says so, and it
 * names no tool use, so it speaks for the entry only when the
 * entry holds a single result.
 */
function markAsyncLaunch(results, toolUseResult) {
    if (!isPlainObject(toolUseResult) || results.size !== 1)
        return;
    if (toolUseResult.status !== "async_launched")
        return;
    for (const size of results.values())
        size.asyncLaunch = true;
}
function toolResultImages(content) {
    if (!Array.isArray(content))
        return 0;
    return content.filter((part) => isPlainObject(part) && part.type === "image")
        .length;
}
function usageOf(message) {
    const usage = message.usage;
    if (!isPlainObject(usage))
        return undefined;
    const inputTokens = countOf(usage.input_tokens);
    const outputTokens = countOf(usage.output_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
        return undefined;
    }
    let cacheWrite5mTokens = null;
    let cacheWrite1hTokens = null;
    const split = isPlainObject(usage.cache_creation)
        ? usage.cache_creation
        : undefined;
    const split5m = split !== undefined ? countOf(split.ephemeral_5m_input_tokens) : undefined;
    const split1h = split !== undefined ? countOf(split.ephemeral_1h_input_tokens) : undefined;
    if (split5m !== undefined || split1h !== undefined) {
        cacheWrite5mTokens = split5m ?? 0;
        cacheWrite1hTokens = split1h ?? 0;
    }
    else {
        // No split reported: the total rides in the 5m column and the
        // 1h column stays null, so the stored value claims no more
        // precision than the entry reported.
        cacheWrite5mTokens = countOf(usage.cache_creation_input_tokens) ?? null;
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens: countOf(usage.cache_read_input_tokens) ?? null,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
    };
}
/**
 * The transcript's own record of a call, for a step the
 * hooks never reported.
 */
function toolUsesOf(redacted) {
    const message = isPlainObject(redacted.message)
        ? redacted.message
        : undefined;
    const content = message !== undefined && Array.isArray(message.content)
        ? message.content
        : [];
    const uses = [];
    for (const block of content) {
        if (!isPlainObject(block) || block.type !== "tool_use")
            continue;
        const id = textOf(block.id);
        if (id === undefined)
            continue;
        uses.push({
            id,
            name: textOf(block.name) ?? "unknown",
            inputSummary: isPlainObject(block.input)
                ? JSON.stringify(block.input)
                : null,
        });
    }
    return uses;
}
function parseAssistantEntry(entry, message, timestampMs, version) {
    const usage = usageOf(message);
    if (usage === undefined) {
        // An assistant entry without usable usage is exactly the
        // shape that must mark the session partial, not be guessed.
        return { kind: "unknown", reason: "assistant-without-usage" };
    }
    const redacted = redactTranscriptEntry(entry);
    return {
        kind: "request",
        timestampMs,
        version,
        requestId: textOf(entry.requestId) ?? null,
        requestRef: textOf(entry.requestRef) ?? null,
        model: textOf(message.model) ?? null,
        usage,
        toolUses: toolUsesOf(redacted),
        redacted,
    };
}
/**
 * The size of an attached file: the byte length of the text
 * its content carries, as `content.file.content` — the one
 * layout the capture shows for a file attachment. The content
 * itself is never read out; only its length is taken.
 */
function attachmentContentBytes(content) {
    const file = attachedFile(content);
    return typeof file?.content === "string"
        ? Buffer.byteLength(file.content, "utf8")
        : null;
}
/** The file an attachment's content holds, as the capture lays it out. */
function attachedFile(content) {
    return isPlainObject(content) && isPlainObject(content.file)
        ? content.file
        : undefined;
}
/** The line count the attachment states for its content. */
function attachmentContentLines(content) {
    const lines = attachedFile(content)?.numLines;
    return typeof lines === "number" ? lines : null;
}
/** The strings in a value that is an array; anything else is none. */
function stringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
function joinedLength(texts) {
    let total = 0;
    for (const text of texts)
        total += text.length;
    return total;
}
/**
 * What one startup attachment adds, when it adds anything the
 * store names. The text itself is never read out. A hook whose
 * output is empty adds nothing, and neither does a delta that
 * only removes. `hook_system_message` stays out: an error
 * line, not a load.
 */
function parseStartupItem(attachment) {
    switch (textOf(attachment.type)) {
        case "skill_listing":
            return skillListingItem(attachment);
        case "mcp_instructions_delta":
            return deltaItem(attachment, "mcp-instructions", "addedBlocks");
        case "agent_listing_delta": {
            const chars = joinedLength(stringList(attachment.addedLines));
            if (chars === 0)
                return null;
            return { kind: "agent-listing", name: null, count: null, chars };
        }
        case "deferred_tools_delta":
            return deltaItem(attachment, "deferred-tool-names", "addedLines");
        case "hook_success":
            return hookOutputItem(attachment);
        case "instructions":
            return instructionsItem(attachment);
        default:
            return null;
    }
}
function skillListingItem(attachment) {
    const names = stringList(attachment.names);
    const chars = typeof attachment.content === "string" ? attachment.content.length : 0;
    const count = countOf(attachment.skillCount) ?? (names.length > 0 ? names.length : null);
    if (chars === 0 && (count ?? 0) === 0)
        return null;
    return {
        kind: "skill-listing",
        name: null,
        count,
        chars,
        names: names.map(scrubSecrets),
    };
}
/**
 * A delta that adds named text: MCP servers' instructions
 * (their blocks) or the names of tools loaded on demand
 * (their lines). The count is the names it adds; the size is
 * the added text's total length. A delta that only removes
 * adds nothing.
 */
function deltaItem(attachment, kind, textsKey) {
    const names = stringList(attachment.addedNames).length;
    const chars = joinedLength(stringList(attachment[textsKey]));
    if (chars === 0 && names === 0)
        return null;
    // A delta that adds text but names nothing counts
    // nothing: no count reads as none, never as zero.
    return { kind, name: null, count: names === 0 ? null : names, chars };
}
/**
 * A session-start hook's output: it reaches the model as
 * context; the hook's captured stdout is its own log, not
 * what was sent. An empty output adds nothing.
 */
function hookOutputItem(attachment) {
    const content = attachment.content;
    if (typeof content !== "string" || content.length === 0)
        return null;
    const hookName = textOf(attachment.hookName);
    return {
        kind: "hook-output",
        // A hook's name is text from the transcript: it passes
        // the same secret scrubbing as any stored text.
        name: hookName === undefined ? null : scrubSecrets(hookName),
        count: null,
        chars: content.length,
    };
}
/** The instruction files' entry: each file, as path and size. */
function instructionsItem(attachment) {
    const rawFiles = Array.isArray(attachment.files) ? attachment.files : [];
    const files = [];
    for (const raw of rawFiles) {
        if (!isPlainObject(raw))
            continue;
        const path = textOf(raw.path);
        if (path === undefined)
            continue;
        files.push({
            path,
            chars: typeof raw.content === "string" ? raw.content.length : 0,
        });
    }
    if (files.length === 0)
        return null;
    return { kind: "instructions", files };
}
/**
 * An attachment entry: the files a prompt carried arrive as
 * their own entries, with no message. A file attachment is a
 * prompt fact; the startup kinds name what was added at
 * session start; the rest record nothing here.
 */
function parseAttachmentEntry(entry, timestampMs, version) {
    const attachment = isPlainObject(entry.attachment)
        ? entry.attachment
        : undefined;
    if (attachment === undefined) {
        return {
            kind: "other",
            timestampMs,
            version,
            redacted: redactTranscriptEntry(entry),
        };
    }
    if (textOf(attachment.type) === "compact_file_reference") {
        return fileAttachment(entry, attachment, timestampMs, version, true);
    }
    if (textOf(attachment.type) !== "file") {
        const item = parseStartupItem(attachment);
        if (item !== null) {
            return {
                kind: "startup-item",
                timestampMs,
                version,
                item,
                redacted: redactTranscriptEntry(entry),
            };
        }
        return {
            kind: "other",
            timestampMs,
            version,
            redacted: redactTranscriptEntry(entry),
        };
    }
    return fileAttachment(entry, attachment, timestampMs, version, false);
}
function fileAttachment(entry, attachment, timestampMs, version, referenceOnly) {
    const displayPath = textOf(attachment.displayPath);
    const filename = textOf(attachment.filename);
    return {
        kind: "attachment",
        timestampMs,
        version,
        attachment: {
            kind: "file",
            // A display path is text from the transcript: it passes
            // the same secret scrubbing as any stored text.
            name: displayPath === undefined ? null : scrubSecrets(displayPath),
            path: filename === undefined ? null : scrubSecrets(filename),
            sizeBytes: attachmentContentBytes(attachment.content),
            lineCount: attachmentContentLines(attachment.content),
            referenceOnly,
        },
        redacted: redactTranscriptEntry(entry),
    };
}
/** A size as `/context` writes it: a decimal and its unit,
 * or a bare count when the size is under a thousand. */
function contextSize(value, unit) {
    const amount = Number.parseFloat(value);
    const lowerUnit = unit.toLowerCase();
    if (lowerUnit === "m")
        return Math.round(amount * 1_000_000);
    if (lowerUnit === "k")
        return Math.round(amount * 1_000);
    return Math.round(amount);
}
const CATEGORY_ROW = /^\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i;
/** The report's category table as label to tokens: only
 * rows whose size is a decimal, with a unit or none. */
function categorySizes(lines) {
    const sizes = new Map();
    for (const line of lines) {
        const row = line.match(CATEGORY_ROW);
        if (row?.[1] !== undefined && row[2] !== undefined) {
            sizes.set(row[1], contextSize(row[2], row[3] ?? ""));
        }
    }
    return sizes;
}
function contextReportText(texts) {
    return texts.find((candidate) => candidate.trimStart().startsWith(CONTEXT_REPORT_OPENING));
}
/**
 * What a `/context` report states, or null: the model and
 * window lines must both match, or the report is left
 * unread and the model list stands; a category row that
 * doesn't match reads as none.
 */
function contextReportOf(text) {
    const lines = text.split("\n");
    const modelLine = lines.find((line) => line.startsWith("**Model:**"));
    const model = modelLine?.match(/^\*\*Model:\*\*\s*(\S+)\s*$/)?.[1];
    const tokensLine = lines.find((line) => line.startsWith("**Tokens:**"));
    const tokens = tokensLine?.match(/^\*\*Tokens:\*\*\s*[\d.]+\s*[km]\s*\/\s*([\d.]+)\s*([km])\b/i);
    if (model === undefined ||
        tokens?.[1] === undefined ||
        tokens[2] === undefined) {
        return null;
    }
    const sizes = categorySizes(lines);
    return {
        model,
        window: contextSize(tokens[1], tokens[2]),
        autocompactBuffer: sizes.get("Autocompact buffer") ?? null,
        systemPrompt: sizes.get("System prompt") ?? null,
        systemTools: sizes.get("System tools") ?? null,
        mcpInstructions: sizes.get("MCP server instructions") ?? null,
        memoryFiles: sizes.get("Memory files") ?? null,
        skills: sizes.get("Skills") ?? null,
    };
}
const SKILL_TEXT_OPENING = "Base directory for this skill:";
/** The last part of the skill's folder, whichever separator the path uses. */
const SKILL_FOLDER_NAME = /([^\\/]+)[\\/]*$/;
function skillText(entry, texts) {
    const opening = texts[0]?.trimStart() ?? "";
    if (entry.isMeta !== true || !opening.startsWith(SKILL_TEXT_OPENING)) {
        return null;
    }
    const folder = opening.slice(SKILL_TEXT_OPENING.length).split("\n")[0] ?? "";
    const name = SKILL_FOLDER_NAME.exec(folder.trim())?.[1];
    if (name === undefined)
        return null;
    return {
        name: scrubSecrets(name),
        bytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0),
    };
}
const COMMAND_MESSAGE_NAME = /^<command-message>([^<]+)<\/command-message>/;
function commandMessageName(entry, texts) {
    if (entry.isMeta !== true)
        return null;
    const name = COMMAND_MESSAGE_NAME.exec(texts[0]?.trimStart() ?? "")?.[1];
    return name === undefined ? null : scrubSecrets(name);
}
function isInterruptText(texts) {
    return texts.some((text) => INTERRUPT_TEXTS.has(text.trim()));
}
function parseUserEntry(entry, message, timestampMs, version, options) {
    const blocks = readContent(message.content);
    markAsyncLaunch(blocks.toolResultSizes, entry.toolUseResult);
    const isInterrupt = isInterruptText(blocks.texts);
    // A user entry's own text is the prompt only when it is not
    // carrying tool results back. The stored entry's redaction keeps
    // only this text's size, so the prompt is scrubbed here with the
    // hook path's secret rules (ADR-0017). The unscrubbed join is
    // measured in passing only; it is never stored.
    const isPrompt = blocks.toolResultSizes.size === 0;
    const joined = options.keepPromptText && isPrompt
        ? scrubSecrets(blocks.texts.join("\n"))
        : "";
    const promptTextAll = isPrompt ? blocks.texts.join("\n") : "";
    const origin = isPlainObject(entry.origin) ? entry.origin : undefined;
    const firstText = blocks.texts[0]?.trimStart();
    // Only a meta entry carries the report: a typed prompt
    // that pastes one is the user's own text, not a reading.
    const report = entry.isMeta === true ? contextReportText(blocks.texts) : undefined;
    return {
        kind: "user",
        timestampMs,
        version,
        promptId: textOf(entry.promptId) ?? null,
        isInterrupt,
        isMeta: entry.isMeta === true,
        originKind: origin !== undefined ? (textOf(origin.kind) ?? null) : null,
        claudeMessage: claudeMessageOf(entry, origin, blocks.texts, promptTextAll.length),
        isCompactSummary: entry.isCompactSummary === true,
        isCommandEntry: firstText !== undefined &&
            COMMAND_OPENINGS.some((opening) => firstText.startsWith(opening)),
        opensWithClaudeOpening: firstText !== undefined &&
            NON_PROMPT_OPENINGS.some((opening) => firstText.startsWith(opening)),
        contextReport: report === undefined ? null : contextReportOf(report),
        commandOutput: report === undefined
            ? null
            : { command: "/context", chars: report.length },
        skillText: skillText(entry, blocks.texts),
        commandMessageName: commandMessageName(entry, blocks.texts),
        toolResultSizes: blocks.toolResultSizes,
        errorResultIds: blocks.errorResultIds,
        interruptResultIds: blocks.interruptResultIds,
        promptText: joined.length > 0 ? joined : null,
        images: blocks.images,
        promptChars: promptTextAll.length,
        promptLines: promptTextAll.length === 0 ? 0 : promptTextAll.split("\n").length,
        promptBytes: Buffer.byteLength(promptTextAll, "utf8"),
        redacted: redactTranscriptEntry(entry),
    };
}
/**
 * The cache lifetime of each cached block, in the order the
 * request entry's cacheControl names them: a block controlled
 * as ephemeral without a stated lifetime uses the five-minute
 * default.
 */
function cacheLifetimesOf(cacheControl) {
    if (!Array.isArray(cacheControl))
        return [];
    const lifetimes = [];
    for (const item of cacheControl) {
        if (!isPlainObject(item))
            continue;
        const value = isPlainObject(item.value) ? item.value : undefined;
        if (value === undefined)
            continue;
        const ttl = textOf(value.ttl);
        if (ttl !== undefined)
            lifetimes.push(ttl);
        else if (value.type === "ephemeral")
            lifetimes.push("5m");
    }
    return lifetimes;
}
/**
 * One content block's size in bytes: its text in UTF-8 when
 * it has text, otherwise its JSON. The one measure every
 * block size in this file uses.
 */
function blockBytes(block) {
    if (isPlainObject(block) && typeof block.text === "string") {
        return Buffer.byteLength(block.text, "utf8");
    }
    return Buffer.byteLength(JSON.stringify(block) ?? "", "utf8");
}
/** A system value's size in bytes: its text blocks in total. */
function systemBytesOf(system) {
    if (typeof system === "string")
        return Buffer.byteLength(system, "utf8");
    if (!Array.isArray(system))
        return null;
    let bytes = 0;
    for (const block of system) {
        bytes += blockBytes(block);
    }
    return bytes;
}
function toolsOf(tools) {
    if (!Array.isArray(tools))
        return [];
    const shapes = [];
    for (const tool of tools) {
        if (!isPlainObject(tool))
            continue;
        const name = textOf(tool.name) ?? "unknown";
        shapes.push({
            name,
            bytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
            mcp: name.startsWith("mcp__"),
        });
    }
    return shapes;
}
function contextEditsOf(params) {
    const management = params !== undefined && isPlainObject(params.context_management)
        ? params.context_management
        : undefined;
    if (management === undefined || !Array.isArray(management.edits)) {
        return [];
    }
    const types = [];
    for (const edit of management.edits) {
        if (!isPlainObject(edit))
            continue;
        const type = textOf(edit.type);
        if (type !== undefined)
            types.push(type);
    }
    return types;
}
function parseApiRequestEntry(entry, timestampMs, version) {
    const params = isPlainObject(entry.params) ? entry.params : undefined;
    const outputConfig = params !== undefined && isPlainObject(params.output_config)
        ? params.output_config
        : undefined;
    return {
        kind: "api-request",
        timestampMs,
        version,
        clientId: textOf(entry.id) ?? null,
        shapeHash: textOf(entry.shapeHash) ?? null,
        effort: effortLevel(outputConfig?.effort),
        cacheLifetimes: cacheLifetimesOf(entry.cacheControl),
        contextEdits: contextEditsOf(params),
        redacted: redactTranscriptEntry(entry),
    };
}
function parseApiRequestShapeEntry(entry, timestampMs, version) {
    const shape = isPlainObject(entry.shape) ? entry.shape : undefined;
    const systemBytes = shape === undefined ? null : systemBytesOf(shape.system);
    const tools = shape === undefined ? [] : toolsOf(shape.tools);
    return {
        kind: "api-request-shape",
        timestampMs,
        version,
        shapeHash: textOf(entry.shapeHash) ?? null,
        systemBytes,
        tools,
        // The stored copy is the parsed form — sizes, names and
        // the entry's own hash — not the entry's outline: the
        // outline repeats every key of every tool's input schema
        // for data nothing reads.
        redacted: {
            type: "api-request-shape",
            sessionId: textOf(entry.sessionId) ?? null,
            shapeHash: textOf(entry.shapeHash) ?? null,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
            version: version ?? null,
            systemBytes,
            tools,
            redaction_version: REDACTION_VERSION,
        },
    };
}
function blobBlockSize(block) {
    return {
        type: isPlainObject(block) ? (textOf(block.type) ?? "unknown") : "unknown",
        bytes: blockBytes(block),
    };
}
function parseApiRequestBlobEntry(entry, timestampMs, version) {
    const message = isPlainObject(entry.message) ? entry.message : undefined;
    const content = message !== undefined && Array.isArray(message.content)
        ? message.content
        : [];
    return {
        kind: "api-request-blob",
        timestampMs,
        version,
        // The blob is a copy of the request's messages: the stored
        // copy is the parsed form — the hash and each block's type
        // and size — never the messages themselves.
        redacted: {
            type: "api-request-blob",
            sessionId: textOf(entry.sessionId) ?? null,
            hash: textOf(entry.hash) ?? null,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
            version: version ?? null,
            message: {
                role: message !== undefined ? (textOf(message.role) ?? null) : null,
                blocks: content.map(blobBlockSize),
            },
            redaction_version: REDACTION_VERSION,
        },
    };
}
/** The id a task notification names in one of its tags, or
 * null when the tag is absent or empty. */
function notificationId(content, tag) {
    const open = `<${tag}>`;
    const start = content.indexOf(open);
    if (start === -1)
        return null;
    const from = start + open.length;
    const end = content.indexOf(`</${tag}>`, from);
    if (end === -1)
        return null;
    const value = content.slice(from, end).trim();
    return value === "" ? null : value;
}
/**
 * A queue entry carrying a task notification, parsed for the
 * two ids it names; null when the entry queues anything else.
 * The notification's text and summary are never read, and the
 * stored copy is the redacted entry, whose content is a size.
 */
function parseTaskNotification(entry, timestampMs, version) {
    if (textOf(entry.operation) !== "enqueue")
        return null;
    const content = textOf(entry.content);
    if (content === undefined || !content.includes("<task-notification>")) {
        return null;
    }
    return {
        kind: "task-notification",
        timestampMs,
        version,
        taskId: notificationId(content, "task-id"),
        toolUseId: notificationId(content, "tool-use-id"),
        redacted: redactTranscriptEntry(entry),
    };
}
/** Parse one JSONL line. Never throws. */
export function parseTranscriptLine(line, options) {
    let entry;
    try {
        entry = JSON.parse(line);
    }
    catch {
        return { kind: "unknown", reason: "not-json" };
    }
    if (!isPlainObject(entry)) {
        return { kind: "unknown", reason: "not-an-object" };
    }
    const timestampMs = timestampOf(entry);
    const version = versionOf(entry);
    // The request entries newer versions write carry no message:
    // they describe a request the assistant entries record, so
    // they are recognized by type before the message check.
    const entryType = textOf(entry.type);
    if (entryType === "api-request") {
        return parseApiRequestEntry(entry, timestampMs, version);
    }
    if (entryType === "api-request-shape") {
        return parseApiRequestShapeEntry(entry, timestampMs, version);
    }
    if (entryType === "api-request-blob") {
        return parseApiRequestBlobEntry(entry, timestampMs, version);
    }
    if (entryType === "queue-operation") {
        const notification = parseTaskNotification(entry, timestampMs, version);
        if (notification !== null)
            return notification;
    }
    if (entryType === "attachment") {
        return parseAttachmentEntry(entry, timestampMs, version);
    }
    if (entryType === "system" && textOf(entry.subtype) === "compact_boundary") {
        return {
            kind: "compaction-boundary",
            timestampMs,
            version,
            redacted: redactTranscriptEntry(entry),
        };
    }
    const message = isPlainObject(entry.message) ? entry.message : undefined;
    if (message === undefined) {
        // Bookkeeping entries (summaries, snapshots, queue markers)
        // carry no message and nothing the reader needs.
        return {
            kind: "other",
            timestampMs,
            version,
            redacted: redactTranscriptEntry(entry),
        };
    }
    const role = textOf(message.role);
    const type = textOf(entry.type);
    if (role === "assistant" || type === "assistant") {
        return parseAssistantEntry(entry, message, timestampMs, version);
    }
    if (role === "user" || type === "user") {
        return parseUserEntry(entry, message, timestampMs, version, options);
    }
    return { kind: "unknown", reason: "unrecognized-message" };
}
