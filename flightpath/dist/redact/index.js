// Intake redaction: turn any raw event — a hook payload, a telemetry
// record, a transcript entry — into one that is safe to write to disk.
//
// The rules live in allowlist.ts (what text may survive) and
// secrets.ts (what must be scrubbed from surviving text). This module
// is the walker that applies them. It depends on nothing beyond its
// own tables, the shared value readers and the prompt cut, and
// never mutates its input: every function returns a new object
// stamped with REDACTION_VERSION.
import { ASK_USER_QUESTION_TEXT_KEYS, COMMON_TEXT_KEYS, EVENT_ARRAY_ITEM_TEXT_KEYS, EVENT_PROMPT_KEY, EVENT_TEXT_KEYS, HOOK_EFFORT_TEXT, KNOWN_TOOLS, TELEMETRY_COST_KEY, TELEMETRY_IDENTITY_KEY, TELEMETRY_BOOLEAN_KEYS, TELEMETRY_NUMERIC_KEYS, TELEMETRY_TEXT_KEYS, TOOL_INPUT_TEXT_KEYS, TRANSCRIPT_ENTRY_TEXT, TRANSCRIPT_MESSAGE_TEXT, } from "./allowlist.js";
import { scrubSecrets } from "./secrets.js";
import { cutPromptText } from "../storage/prompt-text.js";
import { isPlainObject } from "../util/json.js";
/** The redaction rules' version, stamped onto every redacted event. */
export const REDACTION_VERSION = 1;
const NO_TEXT = new Set();
function sizeOf(text) {
    return { chars: text.length };
}
/**
 * Walk one value. A string survives (scrubbed) only when `keepText` is
 * set for its key; containers recurse, and a container's children are
 * judged by their own keys, never by their parent's.
 */
function walkValue(value, keepText) {
    if (typeof value === "string") {
        return keepText ? scrubSecrets(value) : sizeOf(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => walkValue(item, false));
    }
    if (isPlainObject(value)) {
        return walkObject(value, NO_TEXT);
    }
    return value;
}
/** Walk an object one level deep: `textKeys` decides each field. */
function walkObject(obj, textKeys) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        // Keys are scrubbed too: a header or file name can hold a credential.
        out[scrubSecrets(key)] = walkValue(value, textKeys.has(key));
    }
    return out;
}
/** Walk an object at every depth: `textKeys` decides each field. */
function walkDeepObject(obj, textKeys) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        out[scrubSecrets(key)] =
            (key === "answers" || key === "answer") && isPlainObject(value)
                ? redactAnswersMap(value, textKeys)
                : walkDeepValue(value, textKeys.has(key), textKeys);
    }
    return out;
}
/**
 * AskUserQuestion answers arrive as a map from question text to the
 * chosen label, so the labels are values under keys that can never be
 * allow-listed. Keep the map's string values (and string arrays, for
 * multi-select) as the chosen options they are.
 */
function redactAnswersMap(obj, textKeys) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string") {
            out[scrubSecrets(key)] = scrubSecrets(value);
        }
        else if (Array.isArray(value)) {
            out[scrubSecrets(key)] = value.map((item) => typeof item === "string"
                ? scrubSecrets(item)
                : walkDeepValue(item, false, textKeys));
        }
        else {
            out[scrubSecrets(key)] = walkDeepValue(value, false, textKeys);
        }
    }
    return out;
}
function walkDeepValue(value, keepText, textKeys) {
    if (typeof value === "string") {
        return keepText ? scrubSecrets(value) : sizeOf(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => walkDeepValue(item, false, textKeys));
    }
    if (isPlainObject(value)) {
        return walkDeepObject(value, textKeys);
    }
    return value;
}
function redactToolInput(toolName, value) {
    if (!isPlainObject(value)) {
        return walkValue(value, false);
    }
    if (toolName === "AskUserQuestion") {
        return walkDeepObject(value, ASK_USER_QUESTION_TEXT_KEYS);
    }
    if (!KNOWN_TOOLS.has(toolName)) {
        // Unknown tools, including every mcp__* tool: keys and sizes only.
        return walkObject(value, NO_TEXT);
    }
    return walkObject(value, TOOL_INPUT_TEXT_KEYS);
}
function redactToolResponse(toolName, value) {
    if (toolName === "AskUserQuestion" && isPlainObject(value)) {
        // The response holds the questions, the options and the answers;
        // the allow-list keeps questions and labels, sizes for the rest.
        return walkDeepObject(value, ASK_USER_QUESTION_TEXT_KEYS);
    }
    // Every other response is output: file text, command output,
    // generated text. It always reduces to sizes.
    return walkValue(value, false);
}
/** Redact one raw hook payload. The input is never modified. */
export function redactHookEvent(payload) {
    const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const textKeys = new Set([
        ...COMMON_TEXT_KEYS,
        ...(EVENT_TEXT_KEYS[eventName] ?? []),
    ]);
    const arrayItemKeys = EVENT_ARRAY_ITEM_TEXT_KEYS[eventName] ?? {};
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key === "tool_input") {
            out[scrubSecrets(key)] = redactToolInput(toolName, value);
        }
        else if (key === "effort" && isPlainObject(value)) {
            out[scrubSecrets(key)] = walkObject(value, HOOK_EFFORT_TEXT);
        }
        else if (key === "tool_response") {
            out[scrubSecrets(key)] = redactToolResponse(toolName, value);
        }
        else if (arrayItemKeys[key] !== undefined && Array.isArray(value)) {
            const itemKeys = new Set(arrayItemKeys[key]);
            out[scrubSecrets(key)] = value.map((item) => isPlainObject(item)
                ? walkObject(item, itemKeys)
                : walkValue(item, false));
        }
        else {
            const kept = walkValue(value, textKeys.has(key));
            // The cut follows the scrub, so a secret that straddles the
            // limit is replaced whole before anything is dropped.
            out[scrubSecrets(key)] =
                typeof kept === "string" && EVENT_PROMPT_KEY[eventName] === key
                    ? cutPromptText(kept)
                    : kept;
        }
    }
    out.redaction_version = REDACTION_VERSION;
    return out;
}
function isAttributeEntry(value) {
    return (isPlainObject(value) &&
        typeof value.key === "string" &&
        "value" in value &&
        Object.keys(value).length === 2);
}
function redactAttributeEntry(entry) {
    const key = scrubSecrets(entry.key);
    const value = entry.value;
    if (isPlainObject(value) &&
        ("intValue" in value || "doubleValue" in value || "boolValue" in value)) {
        // Numeric and boolean attribute values carry no text; keep them as
        // they are (OTLP JSON encodes 64-bit integers as strings).
        return { key, value };
    }
    if (isPlainObject(value) && typeof value.stringValue === "string") {
        if (TELEMETRY_TEXT_KEYS.has(entry.key)) {
            return {
                key,
                value: { stringValue: scrubSecrets(value.stringValue) },
            };
        }
        // A count or duration that arrived as a string is kept as
        // that string when it really is a number, so the intake can
        // read it as one; anything else reduces to its size.
        if (TELEMETRY_NUMERIC_KEYS.has(entry.key) &&
            value.stringValue.trim().length > 0 &&
            Number.isFinite(Number(value.stringValue))) {
            return { key, value: { stringValue: value.stringValue } };
        }
        // A boolean that arrived as a string is kept when it really
        // is one; anything else under the key reduces to its size.
        if (TELEMETRY_BOOLEAN_KEYS.has(entry.key) &&
            (value.stringValue === "true" || value.stringValue === "false")) {
            return { key, value: { stringValue: value.stringValue } };
        }
        return { key, value: sizeOf(value.stringValue) };
    }
    return { key, value: redactTelemetryValue(value) };
}
function redactTelemetryValue(value) {
    if (Array.isArray(value)) {
        if (value.length > 0 && value.every(isAttributeEntry)) {
            return value
                .filter((entry) => !TELEMETRY_IDENTITY_KEY.test(entry.key) &&
                !TELEMETRY_COST_KEY.test(entry.key))
                .map(redactAttributeEntry);
        }
        return value.map(redactTelemetryValue);
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (TELEMETRY_IDENTITY_KEY.test(key) || TELEMETRY_COST_KEY.test(key)) {
                continue;
            }
            out[scrubSecrets(key)] =
                typeof item === "string" && key === "eventName"
                    ? scrubSecrets(item)
                    : redactTelemetryValue(item);
        }
        return out;
    }
    if (typeof value === "string") {
        return sizeOf(value);
    }
    return value;
}
/** Redact one telemetry record (or a whole export body). */
export function redactTelemetryRecord(record) {
    const out = redactTelemetryValue(record);
    out.redaction_version = REDACTION_VERSION;
    return out;
}
// Transcript entries have a fixed envelope: the entry, its message,
// and the message's content blocks. Text survives only at the places
// the allow-list names for that level; everything inside tool calls
// and tool results reduces to sizes, however it happens to be keyed.
function redactContentBlock(block) {
    if (!isPlainObject(block)) {
        return walkValue(block, false);
    }
    const type = typeof block.type === "string" ? block.type : "";
    const out = {};
    for (const [key, value] of Object.entries(block)) {
        const keepText = key === "type" ||
            (type === "tool_use" && (key === "id" || key === "name")) ||
            (type === "tool_result" && key === "tool_use_id");
        out[scrubSecrets(key)] = walkValue(value, keepText);
    }
    return out;
}
function redactTranscriptMessage(message) {
    const out = {};
    for (const [key, value] of Object.entries(message)) {
        if (key === "content" && Array.isArray(value)) {
            out[key] = value.map(redactContentBlock);
        }
        else {
            out[scrubSecrets(key)] = walkValue(value, TRANSCRIPT_MESSAGE_TEXT.has(key));
        }
    }
    return out;
}
/** Redact one transcript entry. The input is never modified. */
export function redactTranscriptEntry(entry) {
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
        if (key === "message" && isPlainObject(value)) {
            out[key] = redactTranscriptMessage(value);
        }
        else {
            out[scrubSecrets(key)] = walkValue(value, TRANSCRIPT_ENTRY_TEXT.has(key));
        }
    }
    out.redaction_version = REDACTION_VERSION;
    return out;
}
