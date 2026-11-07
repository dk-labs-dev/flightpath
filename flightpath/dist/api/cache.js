// The prompt cache the last main request left behind, for the
// summary's clock. It holds when the cache started, not how
// long is left, so the stream stays quiet while a session idles.
import { mainSeries, seriesPoints } from "./tokens.js";
export function lastMainCache(data) {
    const requests = mainSeries(data);
    const last = seriesPoints(requests).at(-1);
    if (last === undefined || last.cacheLifetime === null || last.tokens === 0) {
        return null;
    }
    // A compaction rewrites the context the last request cached.
    const compactedSince = data.segments.some((segment) => segment.kind === "compact" && segment.startedAt > last.at);
    if (compactedSince)
        return null;
    // A request recorded from the transcript alone has no duration.
    const duration = requests.find((r) => r.id === last.requestId)?.durationMs;
    return {
        lifetime: last.cacheLifetime,
        endedAt: last.at + (duration ?? 0),
        contextTokens: last.tokens,
    };
}
