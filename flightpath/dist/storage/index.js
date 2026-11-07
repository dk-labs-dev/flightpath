// Opens flightpath.db in the data folder (ADR-0014), in WAL mode so
// the daemon and a reader never block each other, applies numbered
// migrations (schema.ts), and refuses a newer version's database
// untouched. The only place importing node:sqlite (via ./sqlite.js).
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJourneyBuilder } from "../journey/index.js";
import { scrubSecrets } from "../redact/secrets.js";
import { createTelemetryStore, } from "../telemetry/index.js";
import { createTranscriptIngest, } from "../transcripts/index.js";
import { preparePromptTextStatements, promptTextColumns, setTurnPromptColumns, } from "./prompt-text.js";
import { findingDismissalMethods, sessionDetailMethods, sessionLiveRowMethods, sessionReadMethods, sessionWatchMethods, streamProbeMethod, turnForPromptMethod, } from "./read.js";
import { FORGET_ORDER, MIGRATIONS } from "./schema.js";
import { DatabaseSync } from "./sqlite.js";
export { ATTACHMENT_ROWS_SINCE_SQL, ATTACHMENT_ROWS_SQL, ATTACHMENTS_FOR_TURN_SQL, BRANCH_BY_ID_SQL, BRANCH_ROWS_SINCE_SQL, BRANCH_ROWS_SQL, CHANGE_MAX_SEQ_SQL, COMPACTION_FILES_SQL, DISMISSALS_SQL, HUMAN_ROWS_SINCE_SQL, HUMAN_ROWS_SQL, LIVE_SESSION_HOSTS_SQL, LIVE_SESSIONS_SQL, LOAD_ROWS_SINCE_SQL, LOAD_ROWS_SQL, PAUSE_BY_ID_SQL, PAUSE_ROWS_SINCE_SQL, PAUSE_ROWS_SQL, REQUEST_BY_ID_SQL, REQUEST_ROWS_FOR_BRANCH_SQL, REQUEST_ROWS_SINCE_SQL, REQUEST_ROWS_SQL, ROW_CHANGES_SINCE_SQL, SAMPLE_BY_ID_SQL, SAMPLE_ROWS_SINCE_SQL, SAMPLE_ROWS_SQL, SEGMENT_ROWS_SINCE_SQL, SEGMENT_ROWS_SQL, SESSION_LIST_SQL, SESSION_ROW_SQL, SESSION_SCAN_SQL, SESSION_SHAPES_SQL, STEP_BY_ID_SQL, STEP_ROWS_SINCE_SQL, STEP_ROWS_SQL, STREAM_PROBE_SQL, TURN_BY_ID_SQL, TURN_FOR_PROMPT_SQL, TURN_ROWS_SINCE_SQL, TURN_ROWS_SQL, } from "./read.js";
// The newest schema this build opens.
const MAX_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
function readUserVersion(db) {
    const row = db.prepare("PRAGMA user_version").get();
    return row?.user_version ?? 0;
}
function applyMigrations(db) {
    let current = readUserVersion(db);
    for (const migration of MIGRATIONS) {
        if (migration.version <= current) {
            continue;
        }
        db.exec("BEGIN");
        try {
            db.exec(migration.sql);
            db.exec(`PRAGMA user_version = ${migration.version}`);
            db.exec("COMMIT");
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
        current = migration.version;
    }
}
function configureDatabase(db) {
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        // Before anything that could write: a newer database is refused.
        const version = readUserVersion(db);
        if (version > MAX_SCHEMA_VERSION) {
            throw new Error(`flightpath.db was created by a newer version of Flightpath ` +
                `(schema ${version}); this build supports up to schema ` +
                `${MAX_SCHEMA_VERSION}. The database was not modified.`);
        }
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA foreign_keys = ON");
        applyMigrations(db);
        redactStoredPromptTexts(db);
        // The one-time switch to incremental auto-vacuum (ADR-0025),
        // so retention deletes give their space back. It needs a
        // VACUUM outside a migration transaction; the meta row records it.
        const vacuumMarker = db
            .prepare("SELECT value FROM meta WHERE key = 'auto_vacuum'")
            .get();
        if (vacuumMarker === undefined) {
            db.exec("PRAGMA auto_vacuum = INCREMENTAL");
            db.exec("VACUUM");
            db.prepare("INSERT INTO meta (key, value) VALUES ('auto_vacuum', 'incremental')").run();
        }
    }
    catch (error) {
        db.close();
        throw error;
    }
}
/**
 * The one-time pass for prompt text stored before it was
 * redacted and capped at intake: scrub and cut each such row,
 * keeping the redacted text's full length and line count. A
 * row this pass — or any current writer — has stored carries
 * prompt_chars, so a later open finds nothing to do (ADR-0017).
 */
function redactStoredPromptTexts(db) {
    const rows = db
        .prepare("SELECT id, prompt_text FROM turns WHERE prompt_text IS NOT NULL AND prompt_chars IS NULL")
        .all();
    if (rows.length === 0)
        return;
    const st = preparePromptTextStatements(db);
    db.exec("BEGIN");
    try {
        for (const row of rows) {
            setTurnPromptColumns(st, row.id, promptTextColumns(scrubSecrets(row.prompt_text)));
        }
        db.exec("COMMIT");
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
function runTransaction(db, fn) {
    db.exec("BEGIN");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
// One session's rows, gone: branches point at their spawning
// step and steps point back at their branch, so the branch
// side of the cycle is cleared first, then children before
// parents (FORGET_ORDER). The caller wraps this in a
// transaction and leaves whichever marker its deletion means.
function deleteSessionRows(db, sessionId) {
    db.prepare("UPDATE branches SET spawning_step_id = NULL WHERE session_id = ?").run(sessionId);
    for (const table of FORGET_ORDER) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    // Shapes carry no session column: the rule is migration 8's —
    // one goes only when nothing references it and nothing names it.
    db.prepare("DELETE FROM request_shapes WHERE hash NOT IN (SELECT shape_hash FROM requests WHERE shape_hash IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_shapes)").run();
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}
function insertRawEventRow(insertEvent, event) {
    const result = insertEvent.run(event.source, event.sessionId ?? null, event.receivedAt ?? Date.now(), event.eventAt ?? null, event.redactionVersion, event.body, event.envelopeId ?? null);
    return result.changes > 0;
}
function rawEventMethods(db, journey) {
    const insertEvent = db.prepare("INSERT INTO raw_events (source, session_id, received_at, event_at, redaction_version, body, envelope_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (envelope_id) DO NOTHING");
    const countAll = db.prepare("SELECT COUNT(*) AS n FROM raw_events");
    const countForSession = db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?");
    return {
        insertRawEvent: (event) => insertRawEventRow(insertEvent, event),
        insertEnvelopeJourney: (event, journeyEvent) => runTransaction(db, () => {
            const inserted = insertRawEventRow(insertEvent, event);
            if (inserted) {
                journey.applyHookEvent(journeyEvent, event.receivedAt ?? Date.now());
            }
            return inserted;
        }),
        countRawEvents: (sessionId) => {
            const row = (sessionId === undefined
                ? countAll.get()
                : countForSession.get(sessionId));
            return row.n;
        },
    };
}
function sessionAdminMethods(db, journey) {
    const forgottenRow = db.prepare("SELECT session_id FROM forgotten WHERE session_id = ?");
    const purgedRow = db.prepare("SELECT session_id FROM purged WHERE session_id = ?");
    const insertForgotten = db.prepare("INSERT OR IGNORE INTO forgotten (session_id, forgotten_at) VALUES (?, ?)");
    const insertPurged = db.prepare("INSERT OR IGNORE INTO purged (session_id, purged_at) VALUES (?, ?)");
    return {
        recordPause: (sessionId, at = Date.now()) => journey.recordPause(sessionId, at),
        recordResume: (sessionId, at = Date.now()) => journey.recordResume(sessionId, at),
        endSessionUnseen: (sessionId, at) => journey.endSessionUnseen(sessionId, at),
        endSessionUnseenIfUnchanged: (session) => journey.endSessionUnseenIfUnchanged(session),
        isForgotten: (sessionId) => forgottenRow.get(sessionId) !== undefined,
        forgetSession: (sessionId, forgottenAt = Date.now()) => {
            runTransaction(db, () => {
                deleteSessionRows(db, sessionId);
                insertForgotten.run(sessionId, forgottenAt);
            });
        },
        deleteSession: (sessionId) => {
            runTransaction(db, () => deleteSessionRows(db, sessionId));
        },
        purgeSession: (sessionId, purgedAt = Date.now()) => {
            runTransaction(db, () => {
                deleteSessionRows(db, sessionId);
                insertPurged.run(sessionId, purgedAt);
            });
        },
        isPurged: (sessionId) => purgedRow.get(sessionId) !== undefined,
    };
}
function retentionMethods(db, dbPath) {
    const toPurgeRows = db.prepare("SELECT id, last_seen_at FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ? ORDER BY last_seen_at ASC");
    const oldestNonLiveRow = db.prepare("SELECT id, last_seen_at FROM sessions WHERE status != 'live' OR last_seen_at < ? ORDER BY last_seen_at ASC LIMIT 1");
    const countOlderRow = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ?");
    const allIdRows = db.prepare("SELECT id FROM sessions");
    return {
        sessionsToPurge: (cutoffMs, staleBeforeMs) => toPurgeRows.all(staleBeforeMs, cutoffMs).map((row) => ({ id: row.id, lastSeenAt: row.last_seen_at })),
        oldestNonLiveSession: (staleBeforeMs) => {
            const row = oldestNonLiveRow.get(staleBeforeMs);
            if (row === undefined)
                return null;
            return { id: row.id, lastSeenAt: row.last_seen_at };
        },
        countSessionsOlderThan: (cutoffMs, staleBeforeMs) => countOlderRow.get(staleBeforeMs, cutoffMs).n,
        allSessionIds: () => allIdRows.all().map((row) => row.id),
        databaseBytes: () => {
            let bytes = 0;
            for (const path of [dbPath, `${dbPath}-wal`]) {
                try {
                    bytes += statSync(path).size;
                }
                catch {
                    // A missing WAL is zero bytes, not an error.
                }
            }
            return bytes;
        },
        checkpointWal: () => {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        },
        incrementalVacuum: () => {
            db.exec("PRAGMA incremental_vacuum");
        },
    };
}
/** Open (creating if needed) the database in `dataDir`. */
export function openStorage(options) {
    mkdirSync(options.dataDir, { recursive: true });
    const dbPath = join(options.dataDir, "flightpath.db");
    const db = new DatabaseSync(dbPath);
    configureDatabase(db);
    const journey = createJourneyBuilder(db);
    return {
        dbPath,
        // The ingest and telemetry stores' methods are the
        // storage's own: spread, so the objects can never drift.
        ...createTranscriptIngest(db),
        ...createTelemetryStore(db),
        userVersion: () => readUserVersion(db),
        transaction: (fn) => runTransaction(db, fn),
        ...rawEventMethods(db, journey),
        ...sessionAdminMethods(db, journey),
        ...sessionReadMethods(db),
        ...retentionMethods(db, dbPath),
        ...sessionDetailMethods(db),
        ...sessionWatchMethods(db),
        ...sessionLiveRowMethods(db),
        ...streamProbeMethod(db),
        ...turnForPromptMethod(db),
        ...findingDismissalMethods(db),
        close: () => db.close(),
    };
}
