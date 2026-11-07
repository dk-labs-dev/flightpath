// The effort levels a request can run at: the fixed vocabulary every
// source reports in. A value outside the set records as none.
const EFFORT_LEVELS = new Set([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
/** One reported effort value: trimmed, lower-cased, kept only when known. */
export function effortLevel(value) {
    if (typeof value !== "string")
        return null;
    const level = value.trim().toLowerCase();
    return EFFORT_LEVELS.has(level) ? level : null;
}
