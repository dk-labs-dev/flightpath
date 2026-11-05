// The transcript store: every SQL write the transcript
// reader makes (ADR-0019), including the one upsert path for
// `requests` that telemetry also uses, so the merge rules
// live in exactly one place.
//
// Extraction happens in parse.ts; everything stored has
// passed through intake redaction (ADR-0017). No message
// text, tool output or file content is ever written. The
// follower that reads the files lives in follower.ts.

import {
  linkBranchToStep,
  prepareBranchLinkStatements,
  type BranchLinkStatements,
} from "../storage/branch-link.js";
import {
  prepareConditionsStatements,
  type ConditionsStatements,
} from "../storage/conditions.js";
import {
  fillTurnPromptFigures,
  fillTurnPromptText,
  preparePromptTextStatements,
  promptTextColumns,
  type PromptTextStatements,
} from "../storage/prompt-text.js";
import {
  findLoadForSkillText,
  prepareSkillLoadStatements,
  type SkillLoadStatements,
} from "../storage/skill-load.js";
import type { DatabaseSync } from "../storage/sqlite.js";
import { asText, numberValue, parseStringArray } from "../util/json.js";
import type {
  ParsedClaudeMessage,
  ParsedContextReport,
  ParsedResultSize,
  ParsedToolShape,
} from "./parse.js";

interface RequestUpsert {
  sessionId: string;
  requestId: string | null;
  turnId: number | null;
  branchId: number | null;
  model: string | null;
  querySource: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  tokenSource: "transcript" | "telemetry";
  startedAt: number | null;
  durationMs: number | null;
  /** The effort the request ran at, when the source reports it. */
  effort?: string | null;
}

/** What came with one prompt, as kind, name and size only. */
export interface PromptAttachmentInput {
  kind: "image" | "file" | "prompt";
  name: string | null;
  sizeBytes: number | null;
  lineCount: number | null;
}

/** A file put back after a compaction, as name and size only. */
interface CompactionFileInput {
  /** The compaction's moment: the boundary entry's time. */
  at: number;
  name: string;
  sizeBytes: number | null;
  /** Read in full again, rather than named only. */
  reread: boolean;
}

/**
 * One request shape, as sizes and names only: what a shape
 * entry carries — the system prompt's size and each tool
 * definition's name and size. The cache lifetimes and
 * context edits a request applied are facts of the request,
 * not of the shape, and are stored on the request row.
 */
export interface RequestShapeData {
  systemBytes: number | null;
  tools: ParsedToolShape[];
}

export interface PauseWindow {
  pausedAt: number;
  resumedAt: number | null;
}

export interface TranscriptIngest {
  /**
   * The one write path for `requests`, keyed by (session,
   * request id). Telemetry is the more precise source: when a
   * telemetry row and a transcript row meet, the result is a
   * single row carrying telemetry's values and source, with any
   * field telemetry lacks filled from the transcript — whichever
   * order they arrived in. A request with no id always inserts.
   */
  upsertRequest(input: RequestUpsert): number;
  /** One context sample; a repeat of the same sample is ignored. */
  insertContextSample(input: {
    sessionId: string;
    requestRowId: number | null;
    sampledAt: number;
    contextTokens: number;
    source: "transcript" | "telemetry";
  }): void;
  /**
   * Record a `/context` report for its model in the session:
   * one row per model, a later report replacing the earlier.
   */
  recordContextReport(
    sessionId: string,
    report: ParsedContextReport,
    at: number,
  ): void;
  /**
   * Close the step a transcript interrupt marker belongs to.
   * Returns true when an open step was closed.
   */
  closeStepInterrupted(
    sessionId: string,
    toolUseId: string,
    at: number,
  ): boolean;
  /**
   * Link a step to the request that first carried its result,
   * recording the result's size as it was sent with the link.
   * A step already linked keeps its first request and sizes.
   */
  linkStepResult(
    sessionId: string,
    toolUseId: string,
    requestRowId: number,
    size: ParsedResultSize,
  ): void;
  /**
   * Create the step for a tool call only the transcript saw —
   * the hooks never reported it — already closed by the
   * result the transcript carried for it and linked to the
   * request that first took that result in. A step the hooks
   * did record is left exactly as it is.
   */
  createTranscriptStep(input: {
    sessionId: string;
    turnId: number | null;
    branchId: number | null;
    toolUseId: string;
    toolName: string;
    inputSummary: string | null;
    startedAt: number | null;
    endedAt: number;
    failed: boolean;
    requestRowId: number;
    size: ParsedResultSize;
  }): void;
  setTurnImages(turnId: number, count: number, bytes: number): void;
  /**
   * Replace a turn's recorded attachments with the ones its
   * prompt entry carried, so re-reading the entry restates the
   * same set instead of adding it again.
   */
  replacePromptAttachments(
    sessionId: string,
    turnId: number,
    attachments: PromptAttachmentInput[],
  ): void;
  /**
   * Add one attachment the transcript recorded as its own
   * entry, after the prompt entry that carried it: attachment
   * entries follow their prompt in the file, and the prompt
   * entry's replace has already run when one lands.
   */
  addPromptAttachment(
    sessionId: string,
    turnId: number,
    attachment: PromptAttachmentInput,
  ): void;
  /**
   * Record a file Claude Code put back after a compaction. A
   * transcript read again from the start restates the file
   * (same session, moment and name) instead of adding it twice.
   */
  addCompactionFile(sessionId: string, file: CompactionFileInput): void;
  /**
   * Record one thing Claude Code put in front of the model —
   * a listing added at session start, a hook's output, a
   * command's report — as a load: its kind, a name when it
   * has one, how many of the thing it counts, and the size
   * of the text that reached the model, in characters. A
   * repeat of the same load from a re-read of the same line
   * is ignored, so following a file that shrinks and grows
   * again never counts it twice.
   */
  recordTranscriptLoad(input: {
    sessionId: string;
    kind: string;
    name: string | null;
    count: number | null;
    /** The names a listing carries. */
    names: string[] | null;
    chars: number;
    at: number;
    /** The subagent the load belongs to; null for the main thread. */
    branchId: number | null;
    /** An instruction file's path; absent for every other kind. */
    filePath?: string | null;
  }): void;
  /**
   * Fill an instruction file's missing size from the size its
   * transcript entry carried: the entry names the file the
   * InstructionsLoaded hook recorded without one (the file
   * was already gone when the daemon tried to stat it). Only
   * the latest size-less row for the file at or before the
   * entry's time is filled; a size the hook did record stands.
   */
  fillInstructionSize(input: {
    sessionId: string;
    filePath: string;
    chars: number;
    at: number;
  }): void;
  /**
   * Take in the text Claude Code added when a skill loaded:
   * the skill's load is the nearest one of that name within
   * ten seconds, and it gets the text's size if it has none
   * yet. When the hook has not reported the skill, the text
   * records the load. Returns that load's id.
   */
  recordSkillText(input: {
    sessionId: string;
    name: string;
    bytes: number;
    at: number;
  }): number;
  /**
   * Record a file a skill attached as a load of its own,
   * pointing at the skill's load. The same file for the same
   * skill is recorded once, so a re-read adds nothing.
   */
  addSkillFile(input: {
    sessionId: string;
    skillLoadId: number;
    path: string;
    bytes: number | null;
    lines: number | null;
    at: number;
  }): void;
  /**
   * Record what Claude Code itself said on a turn: a command,
   * a subagent's hand-back or a notice, as a name or a size.
   * Reading the same entry again records nothing new.
   */
  insertClaudeMessage(
    sessionId: string,
    turnId: number,
    at: number,
    message: ParsedClaudeMessage,
  ): void;
  /**
   * Set a request's effort from its transcript request entry:
   * the primary source, so it replaces a fallback value the
   * hooks or telemetry filled in earlier.
   */
  setRequestEffort(requestRowId: number, effort: string): void;
  /**
   * Store one shape under the hash the transcript's shape
   * entries name it by; a shape already stored under that
   * hash stands.
   */
  upsertRequestShape(shapeHash: string, shape: RequestShapeData): void;
  /**
   * Record that a session named a shape, from its shape
   * entry: the naming is what keeps the shape stored while
   * the session's requests are still landing, and it is
   * deleted with the session.
   */
  noteRequestShape(sessionId: string, shapeHash: string): void;
  /**
   * Link a request to the shape its own entry names. The
   * link lands only when a row with that hash is stored: a
   * shape no remaining request referenced and no session
   * named may have been deleted when another session was
   * forgotten, and the request then records no shape.
   */
  setRequestShape(requestRowId: number, hash: string): void;
  /**
   * Set a request's cache lifetimes and context edits from
   * its transcript request entry: per-request facts the
   * entry itself carries, recorded whether or not the
   * request's shape row is stored.
   */
  setRequestCacheFacts(
    requestRowId: number,
    cacheLifetimes: string[],
    contextEdits: string[],
  ): void;
  pausesFor(sessionId: string): PauseWindow[];
  hasRawEvents(sessionId: string): boolean;
  /** Distinct project paths of sessions recorded so far. */
  recordedProjectPaths(): string[];
  /** The folder a session ran in; null until a source names it. */
  projectPathOf(sessionId: string): string | null;
  /** Create the session row for a transcript-only import. */
  ensureImportedSession(
    sessionId: string,
    projectPath: string,
    at: number,
  ): void;
  /**
   * Close out an imported session: it is a finished session, so
   * mark it ended with its bounds from its own entries rather
   * than the time of the import.
   */
  finishImportedSession(
    sessionId: string,
    firstAt: number,
    lastAt: number,
  ): void;
  turnIdByPrompt(sessionId: string, promptId: string): number | null;
  latestTurnId(sessionId: string): number | null;
  /**
   * The turn a transcript user entry opens, creating it when the
   * session has none for its prompt id (transcript-only imports).
   * An earlier turn left open is ended at `at`.
   */
  ensureTranscriptTurn(
    sessionId: string,
    promptId: string | null,
    at: number,
    promptText: string | null,
  ): number;
  /**
   * Fill a turn's prompt length from its transcript entry,
   * where the turn has none: the length is kept even when the
   * prompt's text is not.
   */
  fillTurnPromptFigures(turnId: number, chars: number, lines: number): void;
  branchIdByAgent(sessionId: string, agentId: string): number | null;
  /** The turn of the step that spawned a branch, when known. */
  spawningTurnId(sessionId: string, agentId: string): number | null;
  /**
   * Link a branch to the step a source names by its tool-use
   * id — a subagent file's meta — and re-stamp the branch's
   * steps with that step's turn: the one link rule, shared with
   * the journey builder. A branch or a step the name doesn't
   * match is left alone.
   */
  linkBranchStep(sessionId: string, agentId: string, toolUseId: string): void;
  /**
   * The same link, made only for a branch that has none: a task
   * notification names the call that ran the subagent, and a
   * resume's call is not the one that launched it.
   */
  linkUnlinkedBranchStep(
    sessionId: string,
    agentId: string,
    toolUseId: string,
  ): void;
  markTokensPartial(sessionId: string): void;
  /** Record the transcript as a seen source, and its version. */
  noteTranscriptSeen(
    sessionId: string,
    version: string | undefined,
    at: number,
  ): void;
  touchSession(sessionId: string, at: number): void;
}

type Row = Record<string, unknown>;
type StatementSync = ReturnType<DatabaseSync["prepare"]>;

// Each statement group has its own exact type; the store's
// statement set is their intersection, so a group split can
// never weaken a statement's type.
interface RequestStatements {
  getRequest: StatementSync;
  insertRequest: StatementSync;
  updateRequest: StatementSync;
  getSampleByRequest: StatementSync;
  getSampleByValue: StatementSync;
  insertSample: StatementSync;
  updateSample: StatementSync;
  closeStep: StatementSync;
}

interface SessionStatements {
  getPauses: StatementSync;
  countRaw: StatementSync;
  projectPaths: StatementSync;
  getProjectPath: StatementSync;
  insertSession: StatementSync;
  finishImport: StatementSync;
  fillProjectPath: StatementSync;
  touch: StatementSync;
  getSessionState: StatementSync;
}

interface TurnStatements
  extends PromptTextStatements, BranchLinkStatements, SessionStatements {
  getTurnByPrompt: StatementSync;
  getLatestTurn: StatementSync;
  getOpenTurn: StatementSync;
  nextSequence: StatementSync;
  insertTurn: StatementSync;
  endTurn: StatementSync;
  getBranch: StatementSync;
  getSpawningTurn: StatementSync;
  getStepByToolUse: StatementSync;
  markPartial: StatementSync;
}

interface StepResultStatements {
  linkStepResult: StatementSync;
  insertTranscriptStep: StatementSync;
}

interface PromptFactStatements {
  setTurnImages: StatementSync;
  deleteAttachments: StatementSync;
  insertAttachment: StatementSync;
  upsertCompactionFile: StatementSync;
  upsertContextReport: StatementSync;
}

interface ClaudeMessageStatements {
  insertClaudeMessage: StatementSync;
}

interface RequestShapeStatements {
  setRequestEffort: StatementSync;
  insertShape: StatementSync;
  noteShape: StatementSync;
  setShape: StatementSync;
  setCacheFacts: StatementSync;
}

interface TranscriptLoadStatements extends SkillLoadStatements {
  findTranscriptLoad: StatementSync;
  insertTranscriptLoad: StatementSync;
  fillInstructionSize: StatementSync;
  fillSkillSize: StatementSync;
  findSkillFile: StatementSync;
  insertSkillFile: StatementSync;
}

interface ConditionStatements extends ConditionsStatements {
  updateConditions: StatementSync;
}

type IngestStatements = RequestStatements &
  TurnStatements &
  StepResultStatements &
  PromptFactStatements &
  ClaudeMessageStatements &
  RequestShapeStatements &
  TranscriptLoadStatements &
  ConditionStatements;

function prepareRequestStatements(db: DatabaseSync): RequestStatements {
  return {
    getRequest: db.prepare(
      "SELECT * FROM requests WHERE session_id = ? AND request_id = ? ORDER BY id LIMIT 1",
    ),
    insertRequest: db.prepare(
      "INSERT INTO requests (session_id, request_id, turn_id, branch_id, model, query_source, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, started_at, duration_ms, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateRequest: db.prepare(
      "UPDATE requests SET turn_id = ?, branch_id = ?, model = ?, query_source = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_5m_tokens = ?, cache_write_1h_tokens = ?, token_source = ?, started_at = ?, duration_ms = ?, effort = ? WHERE id = ?",
    ),
    getSampleByRequest: db.prepare(
      "SELECT id, context_tokens FROM context_samples WHERE request_id = ? AND source = ? LIMIT 1",
    ),
    getSampleByValue: db.prepare(
      "SELECT id FROM context_samples WHERE session_id = ? AND sampled_at = ? AND context_tokens = ? AND source = ? LIMIT 1",
    ),
    insertSample: db.prepare(
      "INSERT INTO context_samples (session_id, request_id, sampled_at, context_tokens, source) VALUES (?, ?, ?, ?, ?)",
    ),
    updateSample: db.prepare(
      "UPDATE context_samples SET sampled_at = ?, context_tokens = ? WHERE id = ?",
    ),
    // A concluded closing is the daemon's guess, not a
    // source's fact: an interrupt the transcript reports
    // replaces it, so the revival never reopens the step.
    closeStep: db.prepare(
      "UPDATE steps SET outcome = 'interrupted', outcome_source = 'transcript', ended_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END WHERE session_id = ? AND tool_use_id = ? AND (outcome = 'open' OR outcome_source = 'concluded')",
    ),
  };
}

function prepareSessionStatements(db: DatabaseSync): SessionStatements {
  return {
    getPauses: db.prepare(
      "SELECT paused_at, resumed_at FROM pauses WHERE session_id = ? ORDER BY paused_at",
    ),
    countRaw: db.prepare(
      "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?",
    ),
    projectPaths: db.prepare(
      "SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL",
    ),
    getProjectPath: db.prepare(
      "SELECT project_path FROM sessions WHERE id = ?",
    ),
    insertSession: db.prepare(
      "INSERT OR IGNORE INTO sessions (id, project_path, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, ?, 'live', ?, ?, 1)",
    ),
    finishImport: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0, first_seen_at = ?, last_seen_at = ? WHERE id = ?",
    ),
    fillProjectPath: db.prepare(
      "UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL",
    ),
    touch: db.prepare(
      "UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?",
    ),
    getSessionState: db.prepare(
      "SELECT status, end_seen FROM sessions WHERE id = ?",
    ),
  };
}

function prepareTurnStatements(db: DatabaseSync): TurnStatements {
  return {
    ...preparePromptTextStatements(db),
    ...prepareBranchLinkStatements(db),
    ...prepareSessionStatements(db),
    getTurnByPrompt: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?",
    ),
    getLatestTurn: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
    ),
    // A concluded end is provisional — the daemon's guess,
    // not a source's fact — so the turn the conclusion ended
    // is still the open one here, and a source's own end is
    // the one that lands (see the endTurn statement below).
    getOpenTurn: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND (ended_at IS NULL OR end_source = 'concluded') ORDER BY sequence DESC LIMIT 1",
    ),
    nextSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE session_id = ?",
    ),
    insertTurn: db.prepare(
      "INSERT INTO turns (session_id, prompt_id, sequence, started_at, ended_at, end_source, prompt_text, prompt_chars, prompt_lines, flightpath_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ),
    // The same rule as the step close above: an end a source
    // reports replaces a concluded one and clears its mark.
    endTurn: db.prepare(
      "UPDATE turns SET ended_at = ?, end_source = NULL WHERE id = ? AND (ended_at IS NULL OR end_source = 'concluded')",
    ),
    getBranch: db.prepare(
      "SELECT id, spawning_step_id FROM branches WHERE session_id = ? AND agent_id = ?",
    ),
    getSpawningTurn: db.prepare(
      "SELECT steps.turn_id AS turn_id FROM branches JOIN steps ON steps.id = branches.spawning_step_id WHERE branches.session_id = ? AND branches.agent_id = ?",
    ),
    getStepByToolUse: db.prepare(
      "SELECT id, turn_id FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1",
    ),
    markPartial: db.prepare(
      "UPDATE sessions SET tokens_partial = 1 WHERE id = ?",
    ),
  };
}

function prepareStepResultStatements(db: DatabaseSync): StepResultStatements {
  return {
    linkStepResult: db.prepare(
      "UPDATE steps SET result_request_id = ?, context_chars = ?, context_images = ?, async_launch = ?, saved_output_bytes = ? WHERE session_id = ? AND tool_use_id = ? AND result_request_id IS NULL",
    ),
    // The insert lands only when no step names the call: a
    // step the hooks recorded is the record, and the
    // transcript's version of the call adds nothing to it.
    insertTranscriptStep: db.prepare(
      `INSERT INTO steps (session_id, turn_id, branch_id, tool_use_id, tool_name, input_summary, outcome, outcome_source, started_at, ended_at, duration_ms, result_request_id, context_chars, context_images, async_launch, saved_output_bytes)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM steps WHERE session_id = ? AND tool_use_id = ?)`,
    ),
  };
}

/**
 * The per-turn attachment delete, named so the query-plan test
 * runs the statement the store actually prepares: the table is
 * deleted by session (forget, purge) and read by
 * turn, so its index leads with the session.
 */
export const DELETE_PROMPT_ATTACHMENTS_SQL =
  "DELETE FROM prompt_attachments WHERE session_id = ? AND turn_id = ?";

/**
 * The insert skips a message already stored for the same
 * session, kind, time and detail, so a transcript read again
 * from the start restates its messages instead of repeating
 * them. Named so the query-plan test runs the statement the
 * store prepares: the check leads with the session's index.
 */
export const INSERT_CLAUDE_MESSAGE_SQL = `INSERT INTO human_events (session_id, turn_id, kind, occurred_at, detail)
  SELECT ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM human_events
    WHERE session_id = ? AND occurred_at = ? AND kind = ? AND detail = ?
  )`;

function preparePromptFactStatements(db: DatabaseSync): PromptFactStatements {
  return {
    setTurnImages: db.prepare(
      "UPDATE turns SET image_count = ?, image_bytes = ? WHERE id = ?",
    ),
    deleteAttachments: db.prepare(DELETE_PROMPT_ATTACHMENTS_SQL),
    insertAttachment: db.prepare(
      "INSERT INTO prompt_attachments (session_id, turn_id, kind, name, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    upsertCompactionFile: db.prepare(
      "INSERT INTO compaction_files (session_id, at, name, size_bytes, reread) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, at, name) DO UPDATE SET size_bytes = excluded.size_bytes, reread = excluded.reread",
    ),
    upsertContextReport: db.prepare(
      "INSERT INTO context_reports (session_id, model, window, autocompact_buffer, system_prompt, system_tools, mcp_instructions, memory_files, skills, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, model) DO UPDATE SET window = excluded.window, autocompact_buffer = excluded.autocompact_buffer, system_prompt = excluded.system_prompt, system_tools = excluded.system_tools, mcp_instructions = excluded.mcp_instructions, memory_files = excluded.memory_files, skills = excluded.skills, reported_at = excluded.reported_at",
    ),
  };
}

function prepareClaudeMessageStatements(
  db: DatabaseSync,
): ClaudeMessageStatements {
  return { insertClaudeMessage: db.prepare(INSERT_CLAUDE_MESSAGE_SQL) };
}

function prepareRequestShapeStatements(
  db: DatabaseSync,
): RequestShapeStatements {
  return {
    setRequestEffort: db.prepare("UPDATE requests SET effort = ? WHERE id = ?"),
    insertShape: db.prepare(
      "INSERT OR IGNORE INTO request_shapes (hash, system_bytes, tools) VALUES (?, ?, ?)",
    ),
    noteShape: db.prepare(
      "INSERT OR IGNORE INTO session_shapes (session_id, hash) VALUES (?, ?)",
    ),
    // The named row must exist for the link to land: the
    // foreign key would refuse the hash of a deleted shape,
    // and the request keeps no shape instead.
    setShape: db.prepare(
      "UPDATE requests SET shape_hash = ? WHERE id = ? AND EXISTS (SELECT 1 FROM request_shapes WHERE hash = ?)",
    ),
    setCacheFacts: db.prepare(
      "UPDATE requests SET cache_lifetimes = ?, context_edits = ? WHERE id = ?",
    ),
  };
}

function prepareTranscriptLoadStatements(
  db: DatabaseSync,
): TranscriptLoadStatements {
  return {
    ...prepareSkillLoadStatements(db),
    // `IS ?` is null-safe equality: a repeat is the same
    // session, kind, moment, name and thread from the same
    // source.
    findTranscriptLoad: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND source = 'transcript' AND kind = ? AND occurred_at = ? AND name IS ? AND branch_id IS ? AND file_path IS ? LIMIT 1",
    ),
    insertTranscriptLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, file_path, occurred_at, source, size_bytes, item_count, names, branch_id) VALUES (?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?)",
    ),
    fillInstructionSize: db.prepare(
      "UPDATE loads SET size_bytes = ? WHERE id = (SELECT id FROM loads WHERE session_id = ? AND kind = 'instructions' AND file_path = ? AND size_bytes IS NULL AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1)",
    ),
    fillSkillSize: db.prepare(
      "UPDATE loads SET size_bytes = ? WHERE id = ? AND size_bytes IS NULL",
    ),
    findSkillFile: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND kind = 'skill-file' AND parent_load_id = ? AND file_path = ? LIMIT 1",
    ),
    insertSkillFile: db.prepare(
      "INSERT INTO loads (session_id, kind, file_path, occurred_at, source, size_bytes, line_count, parent_load_id) VALUES (?, 'skill-file', ?, ?, 'transcript', ?, ?, ?)",
    ),
  };
}

function prepareConditionStatements(db: DatabaseSync): ConditionStatements {
  return {
    ...prepareConditionsStatements(db),
    updateConditions: db.prepare(
      "UPDATE session_conditions SET sources_seen = ?, claude_code_version = ?, updated_at = ? WHERE session_id = ?",
    ),
  };
}

function prepareIngestStatements(db: DatabaseSync): IngestStatements {
  return {
    ...prepareRequestStatements(db),
    ...prepareTurnStatements(db),
    ...prepareStepResultStatements(db),
    ...preparePromptFactStatements(db),
    ...prepareClaudeMessageStatements(db),
    ...prepareRequestShapeStatements(db),
    ...prepareTranscriptLoadStatements(db),
    ...prepareConditionStatements(db),
  };
}

type StepResultLinks = Pick<
  TranscriptIngest,
  "linkStepResult" | "createTranscriptStep"
>;

function stepResultLinks(st: IngestStatements): StepResultLinks {
  return {
    linkStepResult: (sessionId, toolUseId, requestRowId, size) => {
      st.linkStepResult.run(
        requestRowId,
        size.chars,
        size.images,
        size.asyncLaunch ? 1 : 0,
        size.savedBytes,
        sessionId,
        toolUseId,
      );
    },
    createTranscriptStep: (input) => {
      st.insertTranscriptStep.run(
        input.sessionId,
        input.turnId,
        input.branchId,
        input.toolUseId,
        input.toolName,
        input.inputSummary,
        input.failed ? "failed" : "succeeded",
        input.startedAt,
        input.endedAt,
        input.startedAt !== null ? input.endedAt - input.startedAt : null,
        input.requestRowId,
        input.size.chars,
        input.size.images,
        input.size.asyncLaunch ? 1 : 0,
        input.size.savedBytes,
        input.sessionId,
        input.toolUseId,
      );
    },
  };
}

type PromptFacts = Pick<
  TranscriptIngest,
  | "setTurnImages"
  | "fillTurnPromptFigures"
  | "replacePromptAttachments"
  | "addPromptAttachment"
  | "addCompactionFile"
  | "recordContextReport"
  | "insertClaudeMessage"
>;

function promptFacts(st: IngestStatements): PromptFacts {
  return {
    setTurnImages: (turnId, count, bytes) => {
      st.setTurnImages.run(count, bytes, turnId);
    },
    fillTurnPromptFigures: (turnId, chars, lines) =>
      fillTurnPromptFigures(st, turnId, chars, lines),
    replacePromptAttachments: (sessionId, turnId, attachments) => {
      st.deleteAttachments.run(sessionId, turnId);
      for (const attachment of attachments) {
        st.insertAttachment.run(
          sessionId,
          turnId,
          attachment.kind,
          attachment.name,
          attachment.sizeBytes,
          attachment.lineCount,
        );
      }
    },
    addPromptAttachment: (sessionId, turnId, attachment) => {
      st.insertAttachment.run(
        sessionId,
        turnId,
        attachment.kind,
        attachment.name,
        attachment.sizeBytes,
        attachment.lineCount,
      );
    },
    addCompactionFile: (sessionId, file) => {
      st.upsertCompactionFile.run(
        sessionId,
        file.at,
        file.name,
        file.sizeBytes,
        file.reread ? 1 : 0,
      );
    },
    recordContextReport: (sessionId, report, at) => {
      st.upsertContextReport.run(
        sessionId,
        report.model,
        report.window,
        report.autocompactBuffer,
        report.systemPrompt,
        report.systemTools,
        report.mcpInstructions,
        report.memoryFiles,
        report.skills,
        at,
      );
    },
    ...claudeMessages(st),
  };
}

type TranscriptLoads = Pick<
  TranscriptIngest,
  | "recordTranscriptLoad"
  | "fillInstructionSize"
  | "recordSkillText"
  | "addSkillFile"
>;

function recordSkillText(
  st: IngestStatements,
  input: Parameters<TranscriptIngest["recordSkillText"]>[0],
): number {
  const loadId = findLoadForSkillText(
    st,
    input.sessionId,
    input.name,
    input.at,
  );
  if (loadId !== null) {
    st.fillSkillSize.run(input.bytes, loadId);
    return loadId;
  }
  const inserted = st.insertTranscriptLoad.run(
    input.sessionId,
    "skill",
    input.name,
    null,
    input.at,
    input.bytes,
    null,
    null,
    null,
  );
  return Number(inserted.lastInsertRowid);
}

function transcriptLoads(st: IngestStatements): TranscriptLoads {
  return {
    recordTranscriptLoad: (input) => {
      const existing = st.findTranscriptLoad.get(
        input.sessionId,
        input.kind,
        input.at,
        input.name,
        input.branchId,
        input.filePath ?? null,
      ) as { id: number } | undefined;
      if (existing !== undefined) return;
      st.insertTranscriptLoad.run(
        input.sessionId,
        input.kind,
        input.name,
        input.filePath ?? null,
        input.at,
        input.chars,
        input.count,
        input.names === null ? null : JSON.stringify(input.names),
        input.branchId,
      );
    },
    fillInstructionSize: (input) => {
      st.fillInstructionSize.run(
        input.chars,
        input.sessionId,
        input.filePath,
        input.at,
      );
    },
    recordSkillText: (input) => recordSkillText(st, input),
    addSkillFile: (input) => {
      const existing = st.findSkillFile.get(
        input.sessionId,
        input.skillLoadId,
        input.path,
      );
      if (existing !== undefined) return;
      st.insertSkillFile.run(
        input.sessionId,
        input.path,
        input.at,
        input.bytes,
        input.lines,
        input.skillLoadId,
      );
    },
  };
}

/** The summary a message keeps in `detail`: names and sizes only. */
function claudeMessageDetail(message: ParsedClaudeMessage): string {
  switch (message.kind) {
    case "command":
      return JSON.stringify({ name: message.name });
    case "handback":
      return JSON.stringify({
        agent_type: message.agentType,
        agent_id: message.agentId,
        chars: message.chars,
      });
    case "notice":
      return JSON.stringify({ chars: message.chars });
  }
}

function claudeMessages(
  st: IngestStatements,
): Pick<TranscriptIngest, "insertClaudeMessage"> {
  return {
    insertClaudeMessage: (sessionId, turnId, at, message) => {
      const detail = claudeMessageDetail(message);
      st.insertClaudeMessage.run(
        sessionId,
        turnId,
        message.kind,
        at,
        detail,
        sessionId,
        at,
        message.kind,
        detail,
      );
    },
  };
}

type RequestShapes = Pick<
  TranscriptIngest,
  | "setRequestEffort"
  | "upsertRequestShape"
  | "noteRequestShape"
  | "setRequestShape"
  | "setRequestCacheFacts"
>;

type ProjectFolders = Pick<
  TranscriptIngest,
  "recordedProjectPaths" | "projectPathOf"
>;

function projectFolders(st: IngestStatements): ProjectFolders {
  return {
    recordedProjectPaths: () =>
      (st.projectPaths.all() as Row[]).map((row) => row.project_path as string),
    projectPathOf: (sessionId) => {
      const row = st.getProjectPath.get(sessionId) as Row | undefined;
      return (row?.project_path as string | null | undefined) ?? null;
    },
  };
}

function requestShapes(st: IngestStatements): RequestShapes {
  return {
    setRequestEffort: (requestRowId, effort) => {
      st.setRequestEffort.run(effort, requestRowId);
    },
    upsertRequestShape: (shapeHash, shape) => {
      st.insertShape.run(
        shapeHash,
        shape.systemBytes,
        JSON.stringify(shape.tools),
      );
    },
    noteRequestShape: (sessionId, shapeHash) => {
      st.noteShape.run(sessionId, shapeHash);
    },
    setRequestShape: (requestRowId, hash) => {
      st.setShape.run(hash, requestRowId, hash);
    },
    setRequestCacheFacts: (requestRowId, cacheLifetimes, contextEdits) => {
      st.setCacheFacts.run(
        JSON.stringify(cacheLifetimes),
        JSON.stringify(contextEdits),
        requestRowId,
      );
    },
  };
}

type TurnAndBranchLinks = Pick<
  TranscriptIngest,
  | "turnIdByPrompt"
  | "latestTurnId"
  | "ensureTranscriptTurn"
  | "branchIdByAgent"
  | "spawningTurnId"
  | "linkBranchStep"
  | "linkUnlinkedBranchStep"
>;

function linkBranch(
  st: IngestStatements,
  sessionId: string,
  agentId: string,
  toolUseId: string,
  onlyUnlinked: boolean,
): void {
  const branch = st.getBranch.get(sessionId, agentId) as
    { id: number; spawning_step_id: number | null } | undefined;
  if (branch === undefined) return;
  if (onlyUnlinked && branch.spawning_step_id !== null) return;
  const step = st.getStepByToolUse.get(sessionId, toolUseId) as
    { id: number; turn_id: number | null } | undefined;
  if (step === undefined) return;
  linkBranchToStep(st, branch.id, step.id, step.turn_id);
}

function turnAndBranchLinks(st: IngestStatements): TurnAndBranchLinks {
  return {
    turnIdByPrompt: (sessionId, promptId) => {
      const row = st.getTurnByPrompt.get(sessionId, promptId) as
        { id: number } | undefined;
      return row?.id ?? null;
    },
    latestTurnId: (sessionId) => {
      const row = st.getLatestTurn.get(sessionId) as { id: number } | undefined;
      return row?.id ?? null;
    },
    ensureTranscriptTurn: (sessionId, promptId, at, promptText) =>
      ensureTranscriptTurn(st, sessionId, promptId, at, promptText),
    branchIdByAgent: (sessionId, agentId) => {
      const row = st.getBranch.get(sessionId, agentId) as
        { id: number } | undefined;
      return row?.id ?? null;
    },
    spawningTurnId: (sessionId, agentId) => {
      const row = st.getSpawningTurn.get(sessionId, agentId) as
        { turn_id: number | null } | undefined;
      return row?.turn_id ?? null;
    },
    linkBranchStep: (sessionId, agentId, toolUseId) =>
      linkBranch(st, sessionId, agentId, toolUseId, false),
    linkUnlinkedBranchStep: (sessionId, agentId, toolUseId) =>
      linkBranch(st, sessionId, agentId, toolUseId, true),
  };
}

export function createTranscriptIngest(db: DatabaseSync): TranscriptIngest {
  const st = prepareIngestStatements(db);
  return {
    upsertRequest: (input) => upsertRequest(st, input),
    insertContextSample: (input) => insertContextSample(st, input),
    closeStepInterrupted: (sessionId, toolUseId, at) => {
      const result = st.closeStep.run(at, at, sessionId, toolUseId);
      return result.changes > 0;
    },
    ...stepResultLinks(st),
    ...promptFacts(st),
    ...transcriptLoads(st),
    ...requestShapes(st),
    ...projectFolders(st),
    pausesFor: (sessionId) =>
      (st.getPauses.all(sessionId) as Row[]).map((row) => ({
        pausedAt: row.paused_at as number,
        resumedAt: (row.resumed_at as number | null) ?? null,
      })),
    hasRawEvents: (sessionId) =>
      (st.countRaw.get(sessionId) as { n: number }).n > 0,
    ensureImportedSession: (sessionId, projectPath, at) => {
      st.insertSession.run(sessionId, projectPath, at, at);
      st.fillProjectPath.run(projectPath, sessionId);
    },
    finishImportedSession: (sessionId, firstAt, lastAt) => {
      st.finishImport.run(firstAt, lastAt, sessionId);
    },
    ...turnAndBranchLinks(st),
    markTokensPartial: (sessionId) => {
      st.markPartial.run(sessionId);
    },
    noteTranscriptSeen: (sessionId, version, at) =>
      noteTranscriptSeen(st, sessionId, version, at),
    touchSession: (sessionId, at) => {
      st.touch.run(at, sessionId);
    },
  };
}

function pick<T>(
  incomingWins: boolean,
  incoming: T | null,
  existing: T | null,
): T | null {
  return incomingWins ? (incoming ?? existing) : (existing ?? incoming);
}

function insertRequestRow(st: IngestStatements, input: RequestUpsert): number {
  const result = st.insertRequest.run(
    input.sessionId,
    input.requestId,
    input.turnId,
    input.branchId,
    input.model,
    input.querySource,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWrite5mTokens,
    input.cacheWrite1hTokens,
    input.tokenSource,
    input.startedAt,
    input.durationMs,
    input.effort ?? null,
  );
  return Number(result.lastInsertRowid);
}

function mergeStartedAt(
  sameSource: boolean,
  incomingWins: boolean,
  input: RequestUpsert,
  existingStarted: number | null,
): number | null {
  if (!sameSource) {
    return pick(incomingWins, input.startedAt, existingStarted);
  }
  // A repeat from the same source keeps the earliest start it
  // reported.
  if (existingStarted === null) return input.startedAt;
  if (input.startedAt === null) return existingStarted;
  return Math.min(existingStarted, input.startedAt);
}

/** An upsert's fields after the merge: the upsert minus its
 *  key, with the winning source widened to the stored text. */
type MergedRequest = Omit<
  RequestUpsert,
  "sessionId" | "requestId" | "tokenSource" | "effort"
> & { tokenSource: string | null; effort: string | null };

/**
 * The cache-write pair, resolved together: a source that
 * reports only the total (which rides in the 5m column, 1h
 * null) must not flatten a split the other source reported.
 * When the total equals the split's sum, the split stands —
 * the same number, with more precision.
 */
function mergeCachePair(
  input: RequestUpsert,
  existing: Row,
  incomingWins: boolean,
): { cacheWrite5mTokens: number | null; cacheWrite1hTokens: number | null } {
  const existing5m = numberValue(existing.cache_write_5m_tokens);
  const existing1h = numberValue(existing.cache_write_1h_tokens);
  let merged5m = pick(incomingWins, input.cacheWrite5mTokens, existing5m);
  let merged1h = pick(incomingWins, input.cacheWrite1hTokens, existing1h);
  if (
    input.cacheWrite5mTokens !== null &&
    input.cacheWrite1hTokens !== null &&
    existing1h === null &&
    existing5m === input.cacheWrite5mTokens + input.cacheWrite1hTokens
  ) {
    merged5m = input.cacheWrite5mTokens;
    merged1h = input.cacheWrite1hTokens;
  } else if (
    existing5m !== null &&
    existing1h !== null &&
    input.cacheWrite1hTokens === null &&
    input.cacheWrite5mTokens === existing5m + existing1h
  ) {
    merged5m = existing5m;
    merged1h = existing1h;
  }
  return { cacheWrite5mTokens: merged5m, cacheWrite1hTokens: merged1h };
}

function mergeRequest(input: RequestUpsert, existing: Row): MergedRequest {
  // Telemetry displaces transcript as the source. A repeat
  // from the SAME source takes the newer entry's values: one
  // response is written as several entries sharing a request
  // id, and the counts in the earlier ones are mid-stream, so
  // filling gaps would keep the request short. The start
  // stays the earliest the source reported.
  const sameSource = existing.token_source === input.tokenSource;
  const incomingWins =
    sameSource ||
    (input.tokenSource === "telemetry" &&
      existing.token_source !== "telemetry");
  const cachePair = mergeCachePair(input, existing, incomingWins);
  return {
    turnId: pick(incomingWins, input.turnId, numberValue(existing.turn_id)),
    branchId: pick(
      incomingWins,
      input.branchId,
      numberValue(existing.branch_id),
    ),
    model: pick(incomingWins, input.model, asText(existing.model)),
    querySource: pick(
      incomingWins,
      input.querySource,
      asText(existing.query_source),
    ),
    inputTokens: pick(
      incomingWins,
      input.inputTokens,
      numberValue(existing.input_tokens),
    ),
    outputTokens: pick(
      incomingWins,
      input.outputTokens,
      numberValue(existing.output_tokens),
    ),
    cacheReadTokens: pick(
      incomingWins,
      input.cacheReadTokens,
      numberValue(existing.cache_read_tokens),
    ),
    cacheWrite5mTokens: cachePair.cacheWrite5mTokens,
    cacheWrite1hTokens: cachePair.cacheWrite1hTokens,
    tokenSource:
      incomingWins && !sameSource ? "telemetry" : asText(existing.token_source),
    startedAt: mergeStartedAt(
      sameSource,
      incomingWins,
      input,
      numberValue(existing.started_at),
    ),
    durationMs: pick(
      incomingWins,
      input.durationMs,
      numberValue(existing.duration_ms),
    ),
    // Effort fills an empty column and is never overwritten by
    // an upsert: the transcript's request entry is the primary
    // source and sets the column directly, so an upsert from
    // either source must not displace a value already recorded.
    effort: asText(existing.effort) ?? input.effort ?? null,
  };
}

function upsertRequest(st: IngestStatements, input: RequestUpsert): number {
  if (input.requestId === null) {
    return insertRequestRow(st, input);
  }
  const existing = st.getRequest.get(input.sessionId, input.requestId) as
    Row | undefined;
  if (existing === undefined) {
    return insertRequestRow(st, input);
  }
  const id = existing.id as number;
  const merged = mergeRequest(input, existing);
  st.updateRequest.run(
    merged.turnId,
    merged.branchId,
    merged.model,
    merged.querySource,
    merged.inputTokens,
    merged.outputTokens,
    merged.cacheReadTokens,
    merged.cacheWrite5mTokens,
    merged.cacheWrite1hTokens,
    merged.tokenSource,
    merged.startedAt,
    merged.durationMs,
    merged.effort,
    id,
  );
  return id;
}

function insertContextSample(
  st: IngestStatements,
  input: {
    sessionId: string;
    requestRowId: number | null;
    sampledAt: number;
    contextTokens: number;
    source: "transcript" | "telemetry";
  },
): void {
  if (input.requestRowId !== null) {
    const existing = st.getSampleByRequest.get(
      input.requestRowId,
      input.source,
    ) as Row | undefined;
    if (existing !== undefined) {
      // One sample per request per source; a repeat from the
      // same source carries the newer count (see the upsert),
      // so the sample moves with it.
      if (existing.context_tokens !== input.contextTokens) {
        st.updateSample.run(
          input.sampledAt,
          input.contextTokens,
          existing.id as number,
        );
      }
      return;
    }
  } else {
    const dupe = st.getSampleByValue.get(
      input.sessionId,
      input.sampledAt,
      input.contextTokens,
      input.source,
    );
    if (dupe !== undefined) return;
  }
  st.insertSample.run(
    input.sessionId,
    input.requestRowId,
    input.sampledAt,
    input.contextTokens,
    input.source,
  );
}

function ensureTranscriptTurn(
  st: IngestStatements,
  sessionId: string,
  promptId: string | null,
  at: number,
  promptText: string | null,
): number {
  const columns = promptTextColumns(promptText);
  if (promptId !== null) {
    const existing = st.getTurnByPrompt.get(sessionId, promptId) as
      { id: number } | undefined;
    if (existing !== undefined) {
      if (promptText !== null) {
        fillTurnPromptText(st, existing.id, promptText);
      }
      return existing.id;
    }
  }
  const open = st.getOpenTurn.get(sessionId) as { id: number } | undefined;
  if (open !== undefined) st.endTurn.run(at, open.id);
  const sequence = (st.nextSequence.get(sessionId) as { n: number }).n;
  // A turn can be created here while the daemon's
  // conclusion stands — a late transcript read, a telemetry
  // prompt — and neither source revives it; only a hook
  // event does. It goes in already closed, at its own start
  // and marked concluded, so an ended session never holds an
  // open turn and a later revival reopens this one with the
  // rest.
  const session = st.getSessionState.get(sessionId) as
    { status: string; end_seen: number } | undefined;
  const concluded =
    session !== undefined &&
    session.status === "ended" &&
    session.end_seen === 0;
  const result = st.insertTurn.run(
    sessionId,
    promptId,
    sequence,
    at,
    concluded ? at : null,
    concluded ? "concluded" : null,
    columns.text,
    columns.chars,
    columns.lines,
  );
  return Number(result.lastInsertRowid);
}

function noteTranscriptSeen(
  st: IngestStatements,
  sessionId: string,
  version: string | undefined,
  at: number,
): void {
  st.insertConditions.run(sessionId, at);
  const row = st.getConditions.get(sessionId) as Row;
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("transcript")) sources.push("transcript");
  const versionValue =
    typeof row.claude_code_version === "string"
      ? row.claude_code_version
      : (version ?? null);
  st.updateConditions.run(JSON.stringify(sources), versionValue, at, sessionId);
}
