// Readers over values whose shape is only known once it is
// checked — hook payloads, transcript entries, telemetry
// attributes. One home, so a value is read the same way in every
// module that meets it.
/** A plain object: not null, not an array. */
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A stored JSON text read as a record; anything else reads as empty. */
export function parseRecord(text) {
    if (text === null) {
        return {};
    }
    try {
        const value = JSON.parse(text);
        return isPlainObject(value) ? value : {};
    }
    catch {
        return {};
    }
}
/** The boolean at `key` in a record: true only when it is true. */
export function bool(record, key) {
    return record[key] === true;
}
/**
 * The length of a value the recorder reduced to a size: content
 * fields are stored as { chars: N }, never as text (ADR-0004),
 * so a character count is all a reader may use.
 */
export function charsOf(record, key) {
    const value = record[key];
    if (!isPlainObject(value)) {
        return undefined;
    }
    return typeof value.chars === "number" ? value.chars : undefined;
}
/** A non-empty string, or undefined. */
export function textOf(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/** A finite, non-negative number, or undefined. */
export function countOf(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
/** The non-empty string at `key` in a record, or undefined. */
export function str(record, key) {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/** The finite number at `key` in a record, or undefined. */
export function num(record, key) {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}
/** The plain object at `key` in a record, or undefined. */
export function obj(record, key) {
    const value = record[key];
    return isPlainObject(value) ? value : undefined;
}
/** A string as it stands (empty counts), or null. */
export function asText(value) {
    return typeof value === "string" ? value : null;
}
/** A number as it stands, or null. */
export function numberValue(value) {
    return typeof value === "number" ? value : null;
}
/**
 * The strings in a JSON-encoded array — the shape of the
 * stored `sources_seen` column; unparseable reads as none.
 */
export function parseStringArray(text) {
    if (typeof text !== "string")
        return [];
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((x) => typeof x === "string");
    }
    catch {
        return [];
    }
}
/** The non-empty string attribute at `key`, or null. */
export function textAttr(attrs, key) {
    const value = attrs.get(key);
    return typeof value === "string" && value.length > 0 ? value : null;
}
/** The number attribute at `key`, or null. */
export function numAttr(attrs, key) {
    const value = attrs.get(key);
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    // Several counts arrive as string values in a real export.
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
/** The boolean attribute at `key`, or null. */
export function boolAttr(attrs, key) {
    const value = attrs.get(key);
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return null;
}
