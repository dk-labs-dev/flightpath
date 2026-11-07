// The live stream's hub (ADR-0009): one hub per daemon. It
// holds the ring of recent changes, fans them out to the
// pages watching, and answers a reconnect with a replay from
// where the page left off. The wire contract is typed in
// stream-messages.ts; capture (stream-capture.ts) keeps each
// watched session's rows current and shaping (stream-
// shaping.ts) turns a pass's changes into messages. Capture
// works by diffing, never by instrumenting the writers, and
// broadcasting is a write per open page on a timer of its
// own, so it never sits in an event's acknowledgment path.
import { randomBytes } from "node:crypto";
import { emptyHiddenCount, isEmptySession, sessionListItem, } from "../api/index.js";
import { currentHealth } from "./health.js";
import { captureSession, newCapture, } from "./stream-capture.js";
/**
 * One session's picker transition, the same for both stream
 * paths that shape a list row: an empty session leaves the
 * list once, marked `hidden` with the count; a session with
 * anything in it shows, carrying the count when it was
 * hidden before. The state is updated in place, and the
 * message's data is returned for the caller to emit — or
 * nothing, when the row's showing did not change.
 */
export function pickerRowChange(state, row, settings, storage) {
    if (isEmptySession(row)) {
        if (state.hidden)
            return undefined;
        state.hidden = true;
        state.listJson = null;
        state.fingerprint = `${row.status}:${row.lastSeenAt}`;
        return {
            sessionId: row.id,
            hidden: true,
            emptyHidden: emptyHiddenCount(storage),
        };
    }
    const wasHidden = state.hidden;
    state.hidden = false;
    const item = sessionListItem(row, settings);
    const json = JSON.stringify(item);
    if (json === state.listJson)
        return undefined;
    state.listJson = json;
    state.fingerprint = `${row.status}:${row.lastSeenAt}`;
    return wasHidden
        ? {
            sessionId: row.id,
            session: item,
            emptyHidden: emptyHiddenCount(storage),
        }
        : { sessionId: row.id, session: item };
}
const BUFFER_SIZE = 2_000;
const CAPTURE_DEBOUNCE_MS = 25;
const SWEEP_MS = 2_000;
const HEARTBEAT_MS = 15_000;
function frame(id, message) {
    return (`id: ${id}\n` +
        `event: ${message.event}\n` +
        `data: ${JSON.stringify(message.data)}\n\n`);
}
function healthState(hub) {
    return currentHealth(hub.dataDir, hub.settings().autostart);
}
function captureHealth(hub) {
    const state = healthState(hub);
    const json = JSON.stringify(state);
    if (json === hub.healthJson)
        return;
    hub.healthJson = json;
    appendEntry(hub, "all", null, { event: "health", data: state });
}
function matches(connection, entry) {
    if (entry.scope === "all")
        return true;
    if (connection.sessionId === null)
        return entry.scope === "picker";
    return entry.scope === "session" && entry.sessionId === connection.sessionId;
}
function writeFrame(connection, text) {
    try {
        connection.response.write(text);
        return true;
    }
    catch {
        // The page went away mid-write; its close event does the
        // cleanup, and this write simply did not land.
        return false;
    }
}
export function appendEntry(hub, scope, sessionId, message) {
    hub.sequence += 1;
    const entry = { id: hub.sequence, sessionId, scope, message };
    hub.buffer.push(entry);
    if (hub.buffer.length > BUFFER_SIZE) {
        const evicted = hub.buffer.shift();
        if (evicted !== undefined)
            hub.droppedThrough = evicted.id;
    }
    for (const connection of hub.connections) {
        if (entry.id > connection.lastSent && matches(connection, entry)) {
            if (writeFrame(connection, frame(`${hub.epoch}:${entry.id}`, message))) {
                connection.lastSent = entry.id;
            }
        }
    }
}
function scheduleFlush(hub) {
    if (hub.flushTimer !== null)
        return;
    hub.flushTimer = setTimeout(() => {
        hub.flushTimer = null;
        flush(hub);
    }, CAPTURE_DEBOUNCE_MS);
    hub.flushTimer.unref();
}
// Change entries are consumed only by a held capture: each
// pass drops the ones no capture holds, so a session nobody
// watches cannot grow the table for as long as its writers
// keep writing. A capture that starts later loads in full,
// so nothing it needs is lost with them.
function dropUncapturedChanges(hub) {
    hub.storage.dropUncapturedChanges([...hub.captures.keys()]);
}
function flush(hub) {
    if (!hub.activated) {
        // Nothing has ever watched: the pokes cost nothing, and
        // activation baselines whatever state exists by then.
        // Change entries have no consumer yet either, and the
        // writers keep writing them — clear them here, or a
        // recorder no page ever opens grows the table for as
        // long as it runs.
        hub.storage.clearAllChanges();
        hub.pendingHealth = false;
        hub.pendingAll = false;
        hub.pending.clear();
        return;
    }
    if (hub.pendingHealth) {
        hub.pendingHealth = false;
        captureHealth(hub);
    }
    const all = hub.pendingAll;
    hub.pendingAll = false;
    const pending = [...hub.pending];
    hub.pending.clear();
    if (all) {
        capturePicker(hub);
        for (const sessionId of hub.captures.keys()) {
            captureSession(hub, sessionId, "emit");
        }
        dropUncapturedChanges(hub);
        return;
    }
    for (const sessionId of pending) {
        captureSession(hub, sessionId, "emit");
    }
    dropUncapturedChanges(hub);
}
function capturePicker(hub) {
    if (!hub.pickerBaselined) {
        // The baseline sends nothing — the page's first read
        // shows the list — but it records which sessions the
        // list leaves out as empty, so a change to one of them
        // is told as a change when it comes.
        for (const row of hub.storage.listSessionRows()) {
            hub.picker.set(row.id, {
                fingerprint: `${row.status}:${row.lastSeenAt}`,
                listJson: null,
                hidden: isEmptySession(row),
            });
        }
        hub.pickerBaselined = true;
        return;
    }
    const rows = hub.storage.sessionScanRows();
    const seen = new Set();
    for (const row of rows) {
        seen.add(row.id);
        const fingerprint = `${row.status}:${row.lastSeenAt}`;
        const state = hub.picker.get(row.id);
        if (state === undefined) {
            hub.picker.set(row.id, { fingerprint, listJson: null, hidden: false });
            shapeListItem(hub, row.id);
            continue;
        }
        if (state.fingerprint !== fingerprint) {
            state.fingerprint = fingerprint;
            shapeListItem(hub, row.id);
        }
    }
    for (const sessionId of [...hub.picker.keys()]) {
        if (!seen.has(sessionId)) {
            const state = hub.picker.get(sessionId);
            hub.picker.delete(sessionId);
            appendEntry(hub, "picker", sessionId, {
                event: "session",
                data: state !== undefined && state.hidden
                    ? {
                        sessionId,
                        deleted: true,
                        emptyHidden: emptyHiddenCount(hub.storage),
                    }
                    : { sessionId, deleted: true },
            });
        }
    }
}
function shapeListItem(hub, sessionId) {
    const row = hub.storage.sessionRow(sessionId);
    const state = hub.picker.get(sessionId);
    if (row === undefined || state === undefined)
        return;
    const data = pickerRowChange(state, row, hub.settings(), hub.storage);
    if (data === undefined)
        return;
    appendEntry(hub, "picker", sessionId, { event: "session", data });
}
function parseLastEventId(raw) {
    if (raw === null)
        return null;
    const split = raw.lastIndexOf(":");
    if (split < 1)
        return null;
    const seq = Number(raw.slice(split + 1));
    if (!Number.isInteger(seq) || seq < 0)
        return null;
    return { epoch: raw.slice(0, split), seq };
}
function ensureCapture(hub, sessionId) {
    if (hub.captures.has(sessionId))
        return;
    // A capture exists only while something may watch the
    // session; the pass its arrival runs only records.
    hub.captures.set(sessionId, newCapture());
    captureSession(hub, sessionId, "record");
    if (!hub.picker.has(sessionId)) {
        const row = hub.storage.sessionRow(sessionId);
        if (row !== undefined) {
            const empty = isEmptySession(row);
            hub.picker.set(sessionId, {
                fingerprint: `${row.status}:${row.lastSeenAt}`,
                listJson: empty
                    ? null
                    : JSON.stringify(sessionListItem(row, hub.settings())),
                hidden: empty,
            });
        }
    }
}
/** Watching starts with the first page that connects: until
 * then the hub stays out of the daemon's way entirely, and
 * afterwards it keeps the ring current for pages that return. */
function activate(hub) {
    if (hub.activated)
        return;
    hub.activated = true;
    capturePicker(hub);
    captureHealth(hub);
}
function serveConnection(hub, response, sessionId, lastEventIdRaw) {
    if (hub.restarting) {
        // The listener is moving to a new port: end this at
        // once, so it cannot pin the old listener open; the
        // page reconnects at the new address.
        response.end();
        return;
    }
    activate(hub);
    if (sessionId !== null)
        ensureCapture(hub, sessionId);
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const connection = {
        response,
        sessionId,
        lastSent: hub.sequence,
        heartbeat: setInterval(() => {
            writeFrame(connection, ": hb\n\n");
        }, HEARTBEAT_MS),
    };
    connection.heartbeat.unref();
    hub.connections.add(connection);
    response.on("close", () => {
        clearInterval(connection.heartbeat);
        hub.connections.delete(connection);
    });
    greetConnection(hub, connection, lastEventIdRaw);
}
/** A new connection's greeting: the current health, then a
 * plain sync for a fresh page, a reset when the place it
 * left from is gone, or a replay of what it missed. */
function greetConnection(hub, connection, lastEventIdRaw) {
    writeFrame(connection, frame(`${hub.epoch}:${hub.sequence}`, {
        event: "health",
        data: healthState(hub),
    }));
    const last = parseLastEventId(lastEventIdRaw);
    if (last === null) {
        sendSync(hub, connection, 0, false);
        return;
    }
    if (last.epoch !== hub.epoch || last.seq < hub.droppedThrough) {
        writeFrame(connection, frame(`${hub.epoch}:${hub.sequence}`, { event: "reset", data: {} }));
        sendSync(hub, connection, 0, true);
        return;
    }
    let replayed = 0;
    for (const entry of hub.buffer) {
        if (entry.id <= last.seq || !matches(connection, entry))
            continue;
        if (writeFrame(connection, frame(`${hub.epoch}:${entry.id}`, entry.message))) {
            connection.lastSent = entry.id;
            replayed += 1;
        }
    }
    connection.lastSent = hub.sequence;
    sendSync(hub, connection, replayed, false);
}
function sendSync(hub, connection, replayed, reset) {
    writeFrame(connection, frame(`${hub.epoch}:${hub.sequence}`, {
        event: "sync",
        data: { replayed, reset },
    }));
}
function stopHub(hub, final) {
    if (hub.sweep !== null)
        clearInterval(hub.sweep);
    hub.sweep = null;
    if (hub.flushTimer !== null)
        clearTimeout(hub.flushTimer);
    hub.flushTimer = null;
    // The daemon's last word goes to the connections that are
    // open now, written directly — never into the ring buffer,
    // so a reconnect from before the stop never replays it.
    const text = frame(`${hub.epoch}:${hub.sequence}`, final);
    for (const connection of hub.connections) {
        writeFrame(connection, text);
    }
    endConnections(hub);
}
function endConnections(hub) {
    for (const connection of hub.connections) {
        clearInterval(connection.heartbeat);
        try {
            connection.response.end();
        }
        catch {
            // Already gone; ending it again changes nothing.
        }
    }
    hub.connections.clear();
}
export function newHubState(deps) {
    return {
        storage: deps.storage,
        settings: deps.settings,
        dataDir: deps.dataDir,
        epoch: randomBytes(4).toString("hex"),
        sequence: 0,
        droppedThrough: 0,
        buffer: [],
        connections: new Set(),
        captures: new Map(),
        picker: new Map(),
        healthJson: null,
        sweep: null,
        pending: new Set(),
        pendingAll: false,
        pendingHealth: false,
        restarting: false,
        flushTimer: null,
        pickerBaselined: false,
        activated: false,
    };
}
/** The hub: minted per daemon, started and stopped with it. */
export function createStreamHub(deps) {
    const hub = newHubState(deps);
    return {
        epoch: hub.epoch,
        serve: (response, sessionId, lastEventId) => serveConnection(hub, response, sessionId, lastEventId),
        noteSession: (sessionId) => {
            if (!hub.captures.has(sessionId))
                return;
            hub.pending.add(sessionId);
            scheduleFlush(hub);
        },
        noteAllSessions: () => {
            hub.pendingAll = true;
            scheduleFlush(hub);
        },
        noteHealth: () => {
            hub.pendingHealth = true;
            scheduleFlush(hub);
        },
        noteSettingsChanged: () => {
            for (const capture of hub.captures.values())
                capture.resync = true;
            for (const state of hub.picker.values())
                state.listJson = null;
            hub.pendingAll = true;
            scheduleFlush(hub);
        },
        connectionCount: () => hub.connections.size,
        start: () => {
            hub.sweep = setInterval(() => {
                if (!hub.activated)
                    return;
                captureHealth(hub);
                capturePicker(hub);
                for (const sessionId of hub.captures.keys()) {
                    captureSession(hub, sessionId, "emit");
                }
                dropUncapturedChanges(hub);
            }, SWEEP_MS);
            hub.sweep.unref();
        },
        stop: (final) => stopHub(hub, final),
        endConnections: () => endConnections(hub),
        beginRestart: () => {
            hub.restarting = true;
        },
        endRestart: () => {
            hub.restarting = false;
        },
    };
}
