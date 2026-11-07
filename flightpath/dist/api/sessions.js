// The session list: every stored session shaped for the
// picker — a title, its project, its counts, and a short note
// composed of the phrases that apply.
import { firstLine } from "../describe/format.js";
import { formatClock } from "../format.js";
export function sessionTitle(firstPromptText, settings) {
    if (!settings.storePromptText || firstPromptText === null) {
        return "Untitled session";
    }
    const line = firstLine(firstPromptText).trim();
    if (line === "") {
        return "Untitled session";
    }
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
/** How the session ended, for the list's note: the session
 * screen states the same fact on its own status line, so only
 * the list adds this phrase. */
function sessionEndNote(row) {
    return row.status === "ended" && !row.endSeen
        ? `Ended ${formatClock(row.lastSeenAt)} (no exit seen)`
        : null;
}
/** The note's phrases every caller shares. */
export function sessionNote(row) {
    const parts = [];
    if (row.joinedPartway) {
        parts.push("Joined partway");
    }
    if (row.sources.length === 1 && row.sources[0] === "transcript") {
        parts.push("Imported from transcript");
    }
    if (row.sources.length > 0 && !row.sources.includes("telemetry")) {
        parts.push("No telemetry");
    }
    if (row.pauseCount === 1) {
        parts.push("Paused once");
    }
    else if (row.pauseCount === 2) {
        parts.push("Paused twice");
    }
    else if (row.pauseCount > 2) {
        parts.push(`Paused ${row.pauseCount} times`);
    }
    return parts.join(" · ");
}
/** The list's note: the end phrase first, then the shared ones. */
function listNote(row) {
    const endNote = sessionEndNote(row);
    const note = sessionNote(row);
    if (endNote === null) {
        return note;
    }
    return note === "" ? endNote : `${endNote} · ${note}`;
}
/** One session's row as the session list shows it. */
export function sessionListItem(row, settings) {
    return {
        id: row.id,
        title: sessionTitle(row.firstPromptText, settings),
        project: row.projectPath,
        status: row.status,
        startedAt: row.firstSeenAt,
        endedAt: row.status === "ended" ? row.lastSeenAt : null,
        lastActivityAt: row.lastSeenAt,
        endSeen: row.endSeen,
        hasOpenStep: row.openStepCount > 0,
        turns: row.turnCount,
        steps: row.stepCount,
        tokensProcessed: row.tokensProcessed,
        contextNow: row.contextNow,
        sources: row.sources,
        note: listNote(row),
    };
}
/**
 * A session with nothing in it: no turn, no request, and not
 * live. Installing the plugin leaves these behind (a start
 * and an end, nothing between); they are kept and purged
 * like any other session, only left out of the list. This
 * one function decides emptiness for the list's read and
 * for the stream that keeps the list current.
 */
export function isEmptySession(row) {
    return row.turnCount === 0 && row.requestCount === 0 && row.status !== "live";
}
/** How many stored sessions the list leaves out as empty. */
export function emptyHiddenCount(storage) {
    return storage.listSessionRows().filter(isEmptySession).length;
}
/** GET /api/sessions — live first, `q` matches titles and projects. */
export function listSessions(storage, settings, query) {
    const rows = storage.listSessionRows();
    const visible = rows.filter((row) => !isEmptySession(row));
    const items = visible.map((row) => sessionListItem(row, settings));
    const emptyHidden = rows.length - visible.length;
    if (query === null || query.trim() === "") {
        return { sessions: items, emptyHidden };
    }
    const needle = query.trim().toLowerCase();
    return {
        sessions: items.filter((item) => item.title.toLowerCase().includes(needle) ||
            (item.project ?? "").toLowerCase().includes(needle)),
        emptyHidden,
    };
}
