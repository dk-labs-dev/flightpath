// The windows are from the Claude Code table in the help centre's "How
// large is the context window on paid Claude plans", and the ids from the
// platform docs' model ID pages, both read 6 Nov 2026.
const MODEL_WINDOWS = new Map([
    ["claude-fable-5-1", 1_000_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5-5", 1_000_000],
    ["claude-haiku-5-5", 1_000_000],
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 200_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-haiku-4-5", 200_000],
]);
/** The window ladder, walked both ways: a measured window
 * rises to the next rung, and an inferred window names the
 * rung below it. */
export const KNOWN_WINDOWS = [200_000, 1_000_000];
function modelKey(model) {
    return model
        .toLowerCase()
        .replace(/\[1m\]$/, "")
        .replace(/-\d{8}$/, "");
}
function listedWindowFor(model) {
    if (model.toLowerCase().endsWith("[1m]")) {
        return 1_000_000;
    }
    return MODEL_WINDOWS.get(modelKey(model)) ?? null;
}
export function contextReportFor(reports, model) {
    if (model === null) {
        return null;
    }
    const key = modelKey(model);
    // Reports come back oldest first, and two stored ids can
    // share a key (a dated id and its undated twin): the
    // latest report for the model wins.
    for (let index = reports.length - 1; index >= 0; index -= 1) {
        const report = reports[index];
        if (report !== undefined && modelKey(report.model) === key) {
            return report;
        }
    }
    return null;
}
/**
 * The samples measured on requests to one model: a sample's
 * request names the model it was measured on, so one model's
 * samples never raise another model's window.
 */
export function samplesForModel(samples, requests, model) {
    if (model === null) {
        return [];
    }
    const key = modelKey(model);
    const onModel = new Set(requests
        .filter((request) => request.model !== null && modelKey(request.model) === key)
        .map((request) => request.id));
    return samples.filter((sample) => sample.requestId !== null && onModel.has(sample.requestId));
}
export function contextWindowFor(model, samples, reported) {
    if (model === null) {
        return { tokens: null, source: "unknown", reportedAt: null };
    }
    let base;
    let source;
    if (reported !== null) {
        base = reported.window;
        source = "context-command";
    }
    else {
        const listed = listedWindowFor(model);
        if (listed === null) {
            return { tokens: null, source: "unknown", reportedAt: null };
        }
        base = listed;
        source = "model-list";
    }
    // The report's moment rides along only while the report
    // is the size's source: a raise replaces the source, and
    // a listed size never had a report.
    const reportedAt = source === "context-command" && reported !== null
        ? reported.reportedAt
        : null;
    if (!samples.some((sample) => sample.contextTokens > base)) {
        return { tokens: base, source, reportedAt };
    }
    const raised = KNOWN_WINDOWS.find((size) => size > base);
    return raised === undefined
        ? { tokens: base, source, reportedAt }
        : { tokens: raised, source: "inferred", reportedAt: null };
}
