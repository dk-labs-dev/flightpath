// A rebuild's cause in plain words, worded once for every
// reader — the daemon's history and the view's curve alike.
// It reads only the payload's cause type, never the stored
// rows, so the browser bundle can carry it too.
export function rebuildCauseText(cause) {
    if (cause === null)
        return "cause unknown";
    switch (cause.kind) {
        case "compaction":
            return "after compaction (expected)";
        case "expired":
            return `the cache expired after ${cause.gapMinutes} minutes`;
        case "model":
            return `the model changed (${cause.from} → ${cause.to})`;
        case "effort":
            return `effort changed (${cause.from} → ${cause.to})`;
        case "tools":
            return "the tools sent to Claude changed";
    }
}
