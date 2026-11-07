// Model requests: no sentence of their own — the panel fact
// for the request behind a step.
import { notRecorded } from "./format.js";
function partOfWords(querySource, telemetrySeen) {
    if (querySource === "subagent") {
        return "a subagent";
    }
    if (querySource === "main") {
        return "the main conversation";
    }
    if (querySource === "compact") {
        return "compaction";
    }
    if (querySource === "suggestion" || querySource === "title") {
        return "the background";
    }
    return notRecorded(telemetrySeen);
}
/** A request's panel fact: it has no row sentence of its own. */
export function describeRequest(request, ctx = {}) {
    return [
        {
            label: "Part of",
            value: partOfWords(request.querySource, ctx.telemetrySeen),
        },
    ];
}
