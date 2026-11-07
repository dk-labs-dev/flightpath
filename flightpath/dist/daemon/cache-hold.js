import { CACHE_LIFETIME_MS } from "../api/cache-lifetime.js";
import { lastMainCache } from "../api/cache.js";
import { loadSessionData } from "../api/session-data.js";
// Long enough for the cold-cache clock's "expired" line to show.
const EXPIRED_LINE_MS = 2 * 60_000;
// A bad timestamp cannot keep the daemon up longer than this.
const MAX_HOLD_MS = 65 * 60_000;
// Reading a session is costly and the idle timer ticks every second,
// so the last answer stands until an event arrives or a session
// starts or ends.
export function cacheHold(storage, lastActivity, previous) {
    const liveIds = storage.liveSessions().map((session) => session.id);
    const readsFrom = `${lastActivity} ${liveIds.join(" ")}`;
    if (previous?.readsFrom === readsFrom)
        return previous;
    let until = 0;
    for (const id of liveIds) {
        const data = loadSessionData(storage, id);
        const cache = data === undefined ? null : lastMainCache(data);
        if (cache === null)
            continue;
        until = Math.max(until, cache.endedAt + CACHE_LIFETIME_MS[cache.lifetime] + EXPIRED_LINE_MS);
    }
    return { readsFrom, until: Math.min(until, lastActivity + MAX_HOLD_MS) };
}
