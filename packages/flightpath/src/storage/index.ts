// Opens flightpath.db in the data folder (ADR-0014), in WAL mode so
// the daemon and a reader never block each other, applies numbered
// migrations (schema.ts), and refuses a newer version's database
// untouched. The only place importing node:sqlite (via ./sqlite.js).

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createJourneyBuilder } from "../journey/index.js";
import { scrubSecrets } from "../redact/secrets.js";
import {
  createTelemetryStore,
  type TelemetryStore,
} from "../telemetry/index.js";
import {
  createTranscriptIngest,
  type TranscriptIngest,
} from "../transcripts/index.js";
import {
  preparePromptTextStatements,
  setTurnPromptText,
} from "./prompt-text.js";
import {
  findingDismissalMethods,
  sessionDetailMethods,
  sessionLiveRowMethods,
  sessionReadMethods,
  sessionWatchMethods,
  streamProbeMethod,
  type BranchRow,
  type ChangedRow,
  type CompactionFileRow,
  type ContextReportRow,
  type ContextSampleRow,
  type HumanRow,
  type LiveSessionHost,
  type LoadRow,
  type PauseRow,
  type PromptAttachmentRow,
  type RequestRow,
  type RequestShapeRow,
  type SegmentRow,
  type SessionListRow,
  type SessionReadRow,
  type StepReadRow,
  type StepRow,
  type TurnRow,
} from "./read.js";
import { FORGET_ORDER, MIGRATIONS } from "./schema.js";
import { DatabaseSync } from "./sqlite.js";

// The read side lives in ./read.ts; its row types and named
// statements are re-exported here, where storage's readers look.
export type {
  BranchRow,
  CompactionFileRow,
  ContextReportRow,
  ContextSampleRow,
  HumanRow,
  LoadRow,
  PauseRow,
  PromptAttachmentRow,
  RequestRow,
  RequestShapeRow,
  SegmentRow,
  SessionListRow,
  SessionReadRow,
  StepReadRow,
  StepRow,
  TurnRow,
} from "./read.js";
export {
  ATTACHMENT_ROWS_SINCE_SQL,
  ATTACHMENT_ROWS_SQL,
  ATTACHMENTS_FOR_TURN_SQL,
  BRANCH_BY_ID_SQL,
  BRANCH_ROWS_SINCE_SQL,
  BRANCH_ROWS_SQL,
  CHANGE_MAX_SEQ_SQL,
  COMPACTION_FILES_SQL,
  DISMISSALS_SQL,
  HUMAN_ROWS_SINCE_SQL,
  HUMAN_ROWS_SQL,
  LIVE_SESSION_HOSTS_SQL,
  LIVE_SESSIONS_SQL,
  LOAD_ROWS_SINCE_SQL,
  LOAD_ROWS_SQL,
  PAUSE_BY_ID_SQL,
  PAUSE_ROWS_SINCE_SQL,
  PAUSE_ROWS_SQL,
  REQUEST_BY_ID_SQL,
  REQUEST_ROWS_FOR_BRANCH_SQL,
  REQUEST_ROWS_SINCE_SQL,
  REQUEST_ROWS_SQL,
  ROW_CHANGES_SINCE_SQL,
  SAMPLE_BY_ID_SQL,
  SAMPLE_ROWS_SINCE_SQL,
  SAMPLE_ROWS_SQL,
  SEGMENT_ROWS_SINCE_SQL,
  SEGMENT_ROWS_SQL,
  SESSION_LIST_SQL,
  SESSION_ROW_SQL,
  SESSION_SCAN_SQL,
  SESSION_SHAPES_SQL,
  STEP_BY_ID_SQL,
  STEP_ROWS_SINCE_SQL,
  STEP_ROWS_SQL,
  STREAM_PROBE_SQL,
  TURN_BY_ID_SQL,
  TURN_ROWS_SINCE_SQL,
  TURN_ROWS_SQL,
} from "./read.js";

type RawEventSource = "hook" | "telemetry" | "transcript";

interface RawEventInput {
  source: RawEventSource;
  sessionId?: string;
  /** When the event happened, if the source reports it (ms epoch). */
  eventAt?: number;
  redactionVersion: number;
  /** The redacted payload, as a JSON string. */
  body: string;
  /** The envelope's stable id, when the payload is an envelope. */
  envelopeId?: string;
  /** Defaults to now; settable so imports can preserve timing. */
  receivedAt?: number;
}

export interface Storage extends TranscriptIngest, TelemetryStore {
  readonly dbPath: string;
  /** The schema version the database is at (PRAGMA user_version). */
  userVersion(): number;
  /**
   * Store one redacted payload for later (re)processing; true when
   * a row was written. The unique index on envelope_id decides
   * duplicates; a payload without one is never a duplicate.
   */
  insertRawEvent(event: RawEventInput): boolean;
  countRawEvents(sessionId?: string): number;
  /**
   * Store an envelope and fold it into the journey in the same
   * transaction: either both land or neither does. True when the
   * envelope was stored, false on a duplicate.
   */
  insertEnvelopeJourney(
    event: RawEventInput & { envelopeId: string },
    journeyEvent: Record<string, unknown>,
  ): boolean;
  /**
   * Run fn inside a transaction: its writes land together or
   * not at all — the transcript reader commits one chunk's
   * rows this way, so a failure mid-chunk leaves it unread.
   */
  transaction<T>(fn: () => T): T;
  /** Record that recording paused for a session (a pause flag was set). */
  recordPause(sessionId: string, at?: number): void;
  /** Record that a paused session resumed recording. */
  recordResume(sessionId: string, at?: number): void;
  /** End a session the daemon concluded is over, marked unseen. */
  endSessionUnseen(sessionId: string, at: number): void;
  /** That end, only while the row is unchanged; false if it moved. */
  endSessionUnseenIfUnchanged(session: LiveSessionHost): boolean;
  liveSessionHosts(): LiveSessionHost[];
  /** True when the user has forgotten this session (ADR-0019). */
  isForgotten(sessionId: string): boolean;
  /**
   * Delete everything stored for a session, in one transaction, and
   * leave only its `forgotten` marker, so it is never re-imported.
   */
  forgetSession(sessionId: string, forgottenAt?: number): void;
  /**
   * Delete everything stored for a session, in one transaction,
   * leaving no marker behind: the deletion retention and
   * delete-all-data make (ADR-0025). Unlike forgetting, nothing
   * stops the session being recorded again if it shows up live.
   */
  deleteSession(sessionId: string): void;
  /**
   * Delete a session like deleteSession, and record the purge,
   * so the transcript import never brings the session back.
   */
  purgeSession(sessionId: string, purgedAt?: number): void;
  /** True when retention has purged this session (ADR-0025). */
  isPurged(sessionId: string): boolean;
  /**
   * Sessions retention may delete for age: not live, last seen
   * before the cutoff, oldest first. A session that never
   * ended counts as not live once it has been quiet since
   * `staleBeforeMs`, so it is not kept forever.
   */
  sessionsToPurge(
    cutoffMs: number,
    staleBeforeMs: number,
  ): { id: string; lastSeenAt: number }[];
  /** The oldest session that is not live, if there is one. */
  oldestNonLiveSession(
    staleBeforeMs: number,
  ): { id: string; lastSeenAt: number } | null;
  /** How many sessions an age purge at this cutoff would delete. */
  countSessionsOlderThan(cutoffMs: number, staleBeforeMs: number): number;
  /** How many sessions are stored, live and ended alike. */
  countSessions(): number;
  /** The sessions recording now, oldest first, with their first prompts' text. */
  liveSessions(): { id: string; firstPromptText: string | null }[];
  allSessionIds(): string[];
  /**
   * Every session with its list aggregates, live sessions
   * first, then by last activity, newest first.
   */
  listSessionRows(): SessionListRow[];
  /** One session with its conditions, or undefined. */
  sessionRow(sessionId: string): SessionReadRow | undefined;
  // One session's rows from each journey table — turns in
  // sequence order, the rest in the order they happened.
  turnRows(sessionId: string): TurnRow[];
  stepRows(sessionId: string): StepRow[];
  humanRows(sessionId: string): HumanRow[];
  branchRows(sessionId: string): BranchRow[];
  segmentRows(sessionId: string): SegmentRow[];
  pauseRows(sessionId: string): PauseRow[];
  requestRows(sessionId: string): RequestRow[];
  contextSampleRows(sessionId: string): ContextSampleRow[];
  /** The session's /context reports, one per model, oldest first. */
  contextReportsFor(sessionId: string): ContextReportRow[];
  /** The files put back after the session's compactions, oldest first. */
  compactionFileRows(sessionId: string): CompactionFileRow[];
  loadRows(sessionId: string): LoadRow[];
  promptAttachmentRows(sessionId: string): PromptAttachmentRow[];
  /** The shapes the session named or its requests were sent with. */
  requestShapeRows(sessionId: string): RequestShapeRow[];
  /** The ids of the session's findings a person dismissed. */
  listDismissals(sessionId: string): string[];
  /** Keep a finding dismissed; dismissing it again changes nothing. */
  dismissFinding(sessionId: string, findingId: string): void;
  /**
   * Tokens of the requests a Flightpath command caused in this
   * session (ADR-0021). Zero when no command ran.
   */
  flightpathOverheadTokens(sessionId: string): number;
  /** One step with its session id, or undefined. */
  stepRowById(stepId: number): StepReadRow | undefined;
  // One row by its id, or undefined — a watcher's re-read of
  // the rows that can still change in place.
  turnRowById(turnId: number): TurnRow | undefined;
  branchRowById(branchId: number): BranchRow | undefined;
  pauseRowById(pauseId: number): PauseRow | undefined;
  contextSampleRowById(sampleId: number): ContextSampleRow | undefined;
  loadRowById(loadId: number): LoadRow | undefined;
  requestRowById(requestId: number): RequestRow | undefined;
  /**
   * Every session's id, status and last activity — the light
   * scan a watcher diffs to notice sessions arriving, moving
   * or being deleted, without the list's aggregates.
   */
  sessionScanRows(): { id: string; status: string; lastSeenAt: number }[];
  /**
   * The newest row id in each of a session's journey tables:
   * a watcher's high-water marks, so it can ask only for the
   * rows past the ones it has already seen.
   */
  streamProbe(sessionId: string): {
    turnMax: number;
    stepMax: number;
    humanMax: number;
    branchMax: number;
    segmentMax: number;
    pauseMax: number;
    sampleMax: number;
    loadMax: number;
    attachmentMax: number;
  };
  // Each journey table's rows past a watcher's mark, in id
  // order: the delta reads a capture pass merges in.
  turnRowsSince(sessionId: string, afterId: number): TurnRow[];
  stepRowsSince(sessionId: string, afterId: number): StepRow[];
  humanRowsSince(sessionId: string, afterId: number): HumanRow[];
  branchRowsSince(sessionId: string, afterId: number): BranchRow[];
  segmentRowsSince(sessionId: string, afterId: number): SegmentRow[];
  pauseRowsSince(sessionId: string, afterId: number): PauseRow[];
  requestRowsSince(sessionId: string, afterId: number): RequestRow[];
  sampleRowsSince(sessionId: string, afterId: number): ContextSampleRow[];
  /** One branch's requests, in the order they started. */
  requestRowsForBranch(sessionId: string, branchId: number): RequestRow[];
  loadRowsSince(sessionId: string, afterId: number): LoadRow[];
  attachmentRowsSince(
    sessionId: string,
    afterId: number,
  ): PromptAttachmentRow[];
  /** One turn's attachments as they now stand, whole — re-read, not diffed. */
  promptAttachmentsForTurn(
    sessionId: string,
    turnId: number,
  ): PromptAttachmentRow[];
  /** The rows writers changed after inserting them, past a capture's mark. */
  changedRowsSince(sessionId: string, afterSeq: number): ChangedRow[];
  /** The session's newest change entry, or 0 when it has none. */
  changeMaxSeq(sessionId: string): number;
  clearChangedRows(sessionId: string, throughSeq: number): void;
  clearSessionChanges(sessionId: string): void;
  /** Drop every change entry: no capture survives a restart, and one loads in full first. */
  clearAllChanges(): void;
  /** Drop the change entries of sessions no capture holds: only a held
   * capture consumes them, so unwatched entries would grow unbounded. */
  dropUncapturedChanges(heldSessionIds: string[]): void;
  /** The database's size on disk: the main file plus its WAL. */
  databaseBytes(): number;
  /** Checkpoint the WAL, truncating it back to zero. */
  checkpointWal(): void;
  /** Give freed pages back to the disk (incremental vacuum). */
  incrementalVacuum(): void;
  close(): void;
}

// The newest schema this build opens.
const MAX_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

type JourneyBuilder = ReturnType<typeof createJourneyBuilder>;
type StatementSync = ReturnType<DatabaseSync["prepare"]>;

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function applyMigrations(db: DatabaseSync): void {
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
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }
}

function configureDatabase(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // Before anything that could write: a newer database is refused.
    const version = readUserVersion(db);
    if (version > MAX_SCHEMA_VERSION) {
      throw new Error(
        `flightpath.db was created by a newer version of Flightpath ` +
          `(schema ${version}); this build supports up to schema ` +
          `${MAX_SCHEMA_VERSION}. The database was not modified.`,
      );
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
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('auto_vacuum', 'incremental')",
      ).run();
    }
  } catch (error) {
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
function redactStoredPromptTexts(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, prompt_text FROM turns WHERE prompt_text IS NOT NULL AND prompt_chars IS NULL",
    )
    .all() as { id: number; prompt_text: string }[];
  if (rows.length === 0) return;
  const st = preparePromptTextStatements(db);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      setTurnPromptText(st, row.id, scrubSecrets(row.prompt_text));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// One session's rows, gone: branches point at their spawning
// step and steps point back at their branch, so the branch
// side of the cycle is cleared first, then children before
// parents (FORGET_ORDER). The caller wraps this in a
// transaction and leaves whichever marker its deletion means.
function deleteSessionRows(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    "UPDATE branches SET spawning_step_id = NULL WHERE session_id = ?",
  ).run(sessionId);
  for (const table of FORGET_ORDER) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
  }
  // Shapes carry no session column: the rule is migration 8's —
  // one goes only when nothing references it and nothing names it.
  db.prepare(
    "DELETE FROM request_shapes WHERE hash NOT IN (SELECT shape_hash FROM requests WHERE shape_hash IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_shapes)",
  ).run();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

function insertRawEventRow(
  insertEvent: StatementSync,
  event: RawEventInput & { envelopeId?: string },
): boolean {
  const result = insertEvent.run(
    event.source,
    event.sessionId ?? null,
    event.receivedAt ?? Date.now(),
    event.eventAt ?? null,
    event.redactionVersion,
    event.body,
    event.envelopeId ?? null,
  );
  return result.changes > 0;
}

function rawEventMethods(db: DatabaseSync, journey: JourneyBuilder) {
  const insertEvent = db.prepare(
    "INSERT INTO raw_events (source, session_id, received_at, event_at, redaction_version, body, envelope_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (envelope_id) DO NOTHING",
  );
  const countAll = db.prepare("SELECT COUNT(*) AS n FROM raw_events");
  const countForSession = db.prepare(
    "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?",
  );
  return {
    insertRawEvent: (event: RawEventInput) =>
      insertRawEventRow(insertEvent, event),
    insertEnvelopeJourney: (
      event: RawEventInput & { envelopeId: string },
      journeyEvent: Record<string, unknown>,
    ) =>
      runTransaction(db, () => {
        const inserted = insertRawEventRow(insertEvent, event);
        if (inserted) {
          journey.applyHookEvent(journeyEvent, event.receivedAt ?? Date.now());
        }
        return inserted;
      }),
    countRawEvents: (sessionId?: string) => {
      const row = (
        sessionId === undefined
          ? countAll.get()
          : countForSession.get(sessionId)
      ) as { n: number };
      return row.n;
    },
  };
}

function sessionAdminMethods(db: DatabaseSync, journey: JourneyBuilder) {
  const forgottenRow = db.prepare(
    "SELECT session_id FROM forgotten WHERE session_id = ?",
  );
  const purgedRow = db.prepare(
    "SELECT session_id FROM purged WHERE session_id = ?",
  );
  const insertForgotten = db.prepare(
    "INSERT OR IGNORE INTO forgotten (session_id, forgotten_at) VALUES (?, ?)",
  );
  const insertPurged = db.prepare(
    "INSERT OR IGNORE INTO purged (session_id, purged_at) VALUES (?, ?)",
  );
  return {
    recordPause: (sessionId: string, at: number = Date.now()) =>
      journey.recordPause(sessionId, at),
    recordResume: (sessionId: string, at: number = Date.now()) =>
      journey.recordResume(sessionId, at),
    endSessionUnseen: (sessionId: string, at: number) =>
      journey.endSessionUnseen(sessionId, at),
    endSessionUnseenIfUnchanged: (session: LiveSessionHost) =>
      journey.endSessionUnseenIfUnchanged(session),
    isForgotten: (sessionId: string) =>
      forgottenRow.get(sessionId) !== undefined,
    forgetSession: (sessionId: string, forgottenAt: number = Date.now()) => {
      runTransaction(db, () => {
        deleteSessionRows(db, sessionId);
        insertForgotten.run(sessionId, forgottenAt);
      });
    },
    deleteSession: (sessionId: string) => {
      runTransaction(db, () => deleteSessionRows(db, sessionId));
    },
    purgeSession: (sessionId: string, purgedAt: number = Date.now()) => {
      runTransaction(db, () => {
        deleteSessionRows(db, sessionId);
        insertPurged.run(sessionId, purgedAt);
      });
    },
    isPurged: (sessionId: string) => purgedRow.get(sessionId) !== undefined,
  };
}

function retentionMethods(db: DatabaseSync, dbPath: string) {
  const toPurgeRows = db.prepare(
    "SELECT id, last_seen_at FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ? ORDER BY last_seen_at ASC",
  );
  const oldestNonLiveRow = db.prepare(
    "SELECT id, last_seen_at FROM sessions WHERE status != 'live' OR last_seen_at < ? ORDER BY last_seen_at ASC LIMIT 1",
  );
  const countOlderRow = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ?",
  );
  const allIdRows = db.prepare("SELECT id FROM sessions");
  return {
    sessionsToPurge: (cutoffMs: number, staleBeforeMs: number) =>
      (
        toPurgeRows.all(staleBeforeMs, cutoffMs) as {
          id: string;
          last_seen_at: number;
        }[]
      ).map((row) => ({ id: row.id, lastSeenAt: row.last_seen_at })),
    oldestNonLiveSession: (staleBeforeMs: number) => {
      const row = oldestNonLiveRow.get(staleBeforeMs) as
        { id: string; last_seen_at: number } | undefined;
      if (row === undefined) return null;
      return { id: row.id, lastSeenAt: row.last_seen_at };
    },
    countSessionsOlderThan: (cutoffMs: number, staleBeforeMs: number) =>
      (countOlderRow.get(staleBeforeMs, cutoffMs) as { n: number }).n,
    allSessionIds: () =>
      (allIdRows.all() as { id: string }[]).map((row) => row.id),
    databaseBytes: () => {
      let bytes = 0;
      for (const path of [dbPath, `${dbPath}-wal`]) {
        try {
          bytes += statSync(path).size;
        } catch {
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
export function openStorage(options: { dataDir: string }): Storage {
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
    transaction: <T>(fn: () => T): T => runTransaction(db, fn),
    ...rawEventMethods(db, journey),
    ...sessionAdminMethods(db, journey),
    ...sessionReadMethods(db),
    ...retentionMethods(db, dbPath),
    ...sessionDetailMethods(db),
    ...sessionWatchMethods(db),
    ...sessionLiveRowMethods(db),
    ...streamProbeMethod(db),
    ...findingDismissalMethods(db),
    close: () => db.close(),
  };
}
