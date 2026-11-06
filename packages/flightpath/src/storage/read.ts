// The read side of storage: the row types the screens are
// built from, and one prepared statement per question, each
// keyed by an indexed column so a snapshot never scans a
// table. The statements alias their columns to the row types'
// own names, so rows are read as those types directly; the
// only conversions left are the ones where a value really
// changes form — two flags stored as 0/1, and the JSON arrays.

import {
  bool,
  isPlainObject,
  num,
  parseStringArray,
  str,
} from "../util/json.js";
import { OVERHEAD_SQL, REQUEST_TOKEN_SUM } from "./request-tokens.js";
import type { DatabaseSync } from "./sqlite.js";

/** One session with the aggregates the session list shows. */
export type SessionListRow = {
  id: string;
  projectPath: string | null;
  model: string | null;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  joinedPartway: boolean;
  /** False when the daemon concluded the end; no end event arrived. */
  endSeen: boolean;
  /** True when some of the session's token counts never arrived. */
  tokensPartial: boolean;
  /** The Claude Code process the session runs in, when the
   * hook noted it at the session's start. */
  hostPid: number | null;
  hostStartedAt: number | null;
  /** Steps still open: a session running one is not quiet. */
  openStepCount: number;
  turnCount: number;
  requestCount: number;
  stepCount: number;
  pauseCount: number;
  tokensProcessed: number;
  /** The latest context sample's size, or null when none was recorded. */
  contextNow: number | null;
  sources: string[];
  /** The first turn's prompt text, when it was kept. */
  firstPromptText: string | null;
};

/** One session with everything the snapshot's summary needs. */
export type SessionReadRow = SessionListRow & {
  permissionModes: string[];
};

/** A live session and the process it runs in, when noted: the
 * one shape the session-end watch reads, named once here. */
export type LiveSessionHost = {
  id: string;
  lastSeenAt: number;
  hostPid: number | null;
  hostStartedAt: number | null;
};

export type TurnRow = {
  id: number;
  sequence: number;
  startedAt: number | null;
  endedAt: number | null;
  promptText: string | null;
  flightpathCommand: boolean;
  /** The prompt's full length and line count, kept beside its capped text. */
  promptChars: number | null;
  promptLines: number | null;
  /** The images the prompt carried: how many, and their total encoded size. */
  imageCount: number | null;
  imageBytes: number | null;
};

export type BranchRow = {
  id: number;
  agentId: string | null;
  agentType: string | null;
  kind: string | null;
  spawningStepId: number | null;
  startedAt: number | null;
  endedAt: number | null;
  totalTokens: number | null;
};

export type ContextSampleRow = {
  id: number;
  requestId: number | null;
  sampledAt: number;
  contextTokens: number;
};

/** The category rows of a /context report, in tokens; null
 * where the report listed no such row. */
export type ReportCategories = {
  systemPrompt: number | null;
  systemTools: number | null;
  mcpInstructions: number | null;
  memoryFiles: number | null;
  skills: number | null;
};

/** One model's /context report in a session, as stored. */
export type ContextReportRow = ReportCategories & {
  model: string;
  window: number;
  autocompactBuffer: number | null;
  reportedAt: number;
};

/** A file Claude Code put back after a compaction, as stored. */
export type CompactionFileRow = {
  id: number;
  /** The compaction's moment, to pair the file with its segment. */
  at: number;
  name: string;
  sizeBytes: number | null;
  /** Read in full again; false when only named. */
  reread: boolean;
};

export type StepRow = {
  id: number;
  turnId: number | null;
  branchId: number | null;
  toolName: string;
  inputSummary: string | null;
  outcome: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  resultSize: number | null;
  /** The request that first carried this step's result, when the transcript named it. */
  resultRequestId: number | null;
  /** The characters of this step's result the model was sent, when the transcript named them. */
  contextChars: number | null;
  /** The images inside this step's result, when the transcript named them. */
  contextImages: number | null;
  /** 1 when this step's result only announced a background subagent, 0 when it carried the answer, null until the transcript names it. */
  asyncLaunch: number | null;
  /** The id Claude Code gave the call, when the step has one. */
  toolUseId: string | null;
  /** The size of the output Claude Code saved to a file, when it did. */
  savedOutputBytes: number | null;
};

export type HumanRow = {
  id: number;
  turnId: number | null;
  stepId: number | null;
  kind: string;
  occurredAt: number;
  decision: string | null;
  decisionSource: string | null;
  detail: string | null;
};

export type SegmentRow = {
  id: number;
  kind: string;
  startedAt: number;
  contextTokens: number | null;
};

export type PauseRow = {
  id: number;
  pausedAt: number;
  resumedAt: number | null;
};

export type RequestRow = {
  id: number;
  turnId: number | null;
  branchId: number | null;
  model: string | null;
  querySource: string | null;
  startedAt: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  tokenSource: string | null;
  /** The effort the request ran at, when a source reported it. */
  effort: string | null;
  /** The hash of the request shape it was sent with, when recorded. */
  shapeHash: string | null;
  /** The cache lifetime of each cached block in the request, when recorded. */
  cacheLifetimes: string[] | null;
};

/** One thing a session loaded: a skill or an instruction file. */
export type LoadRow = {
  id: number;
  kind: string;
  name: string | null;
  trigger: string | null;
  memoryType: string | null;
  filePath: string | null;
  occurredAt: number;
  source: string;
  /** An instruction file's size on disk, when the daemon could stat it. */
  sizeBytes: number | null;
  /** How many of a thing a startup load names, when it counts them. */
  itemCount: number | null;
  /** The names a startup listing carries, when it was stored with them. */
  names: string[] | null;
  /** The subagent a startup listing belongs to; null for the main thread's. */
  branchId: number | null;
  /** The skill load a skill-file load was attached by; null for every other load. */
  parentLoadId: number | null;
  /** A skill-file's line count, when the attachment gave one. */
  lineCount: number | null;
};

/** One thing a prompt carried, as kind, name and size — never contents. */
export type PromptAttachmentRow = {
  id: number;
  turnId: number;
  kind: string;
  name: string | null;
  sizeBytes: number | null;
  /** The prompt attachment's own line count; the other kinds carry none. */
  lineCount: number | null;
};

/** One tool definition's size within a request shape. */
type ShapeTool = {
  name: string;
  bytes: number;
  mcp: boolean;
};

/** One request shape: the system prompt's size and its tools, by hash. */
export type RequestShapeRow = {
  hash: string;
  systemBytes: number | null;
  tools: ShapeTool[];
};

/** One recorded change to a stored row: the row a writer
 * updated after inserting it, as the change trigger noted it.
 * For prompt_attachments the row id is the turn whose whole
 * attachment set changed. */
export type ChangedRow = {
  seq: number;
  tableName: string;
  rowId: number;
};

/** A step with the session it belongs to, for the detail view. */
export type StepReadRow = StepRow & {
  sessionId: string;
};

// A session row as its SQL returns it: the values that
// change form on the way out — the two flags as 0/1 and the
// sources as a JSON string — are still in their stored shape.
type SessionSqlRow = Omit<
  SessionListRow,
  "joinedPartway" | "endSeen" | "tokensPartial" | "sources"
> & {
  joinedPartway: number;
  endSeen: number;
  tokensPartial: number;
  sourcesSeen: string | null;
};

function toSessionListRow(row: SessionSqlRow): SessionListRow {
  const { sourcesSeen, ...rest } = row;
  return {
    ...rest,
    joinedPartway: row.joinedPartway === 1,
    endSeen: row.endSeen === 1,
    tokensPartial: row.tokensPartial === 1,
    sources: parseStringArray(sourcesSeen),
  };
}

const SESSION_AGGREGATES = `
    (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turnCount,
    (SELECT COUNT(*) FROM requests WHERE session_id = s.id) AS requestCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id) AS stepCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id AND outcome = 'open') AS openStepCount,
    (SELECT COUNT(*) FROM pauses WHERE session_id = s.id) AS pauseCount,
    (SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) FROM requests WHERE session_id = s.id) AS tokensProcessed,
    (SELECT cs.context_tokens FROM context_samples cs WHERE cs.session_id = s.id ORDER BY cs.sampled_at DESC, cs.id DESC LIMIT 1) AS contextNow,
    (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText`;

// The read side's statements, named so the query-plan test
// runs the very statements these methods prepare, not copies.
const COUNT_SESSIONS_SQL = "SELECT COUNT(*) AS n FROM sessions";
export const SESSION_LIST_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id ORDER BY (s.status = 'live') DESC, s.last_seen_at DESC`;
export const SESSION_ROW_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, c.permission_modes AS permissionModes, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id WHERE s.id = ?`;
export const LIVE_SESSION_HOSTS_SQL = `SELECT s.id, s.last_seen_at AS lastSeenAt, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt FROM sessions s WHERE s.status = 'live' ORDER BY s.id ASC`;
export const LIVE_SESSIONS_SQL = `SELECT s.id, (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText FROM sessions s WHERE s.status = 'live' ORDER BY s.first_seen_at ASC`;

// The read side's session rows: the session count, the list,
// one session, and the command overhead — whose statement is
// prepared once here, since every snapshot asks for it.
export function sessionReadMethods(db: DatabaseSync) {
  const countSessionRows = db.prepare(COUNT_SESSIONS_SQL);
  const listSessionQuery = db.prepare(SESSION_LIST_SQL);
  const sessionQuery = db.prepare(SESSION_ROW_SQL);
  const liveSessionQuery = db.prepare(LIVE_SESSIONS_SQL);
  const liveHostsQuery = db.prepare(LIVE_SESSION_HOSTS_SQL);
  const overheadQuery = db.prepare(OVERHEAD_SQL);
  return {
    countSessions: () => (countSessionRows.get() as { n: number }).n,
    liveSessionHosts: () => liveHostsQuery.all() as LiveSessionHost[],
    liveSessions: () =>
      liveSessionQuery.all() as {
        id: string;
        firstPromptText: string | null;
      }[],
    listSessionRows: () =>
      (listSessionQuery.all() as SessionSqlRow[]).map(toSessionListRow),
    sessionRow: (sessionId: string) => {
      const row = sessionQuery.get(sessionId) as
        (SessionSqlRow & { permissionModes: string | null }) | undefined;
      if (row === undefined) {
        return undefined;
      }
      const { permissionModes, ...rest } = row;
      return {
        ...toSessionListRow(rest),
        permissionModes: parseStringArray(permissionModes),
      };
    },
    flightpathOverheadTokens: (sessionId: string) =>
      (overheadQuery.get(sessionId) as { total: number }).total,
  };
}

// Named for the same reason as the session statements above.
export const TURN_ROWS_SQL =
  "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? ORDER BY sequence ASC";
export const STEP_ROWS_SQL =
  "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const HUMAN_ROWS_SQL =
  "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
export const BRANCH_ROWS_SQL =
  "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const SEGMENT_ROWS_SQL =
  "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const PAUSE_ROWS_SQL =
  "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? ORDER BY paused_at ASC, id ASC";
const REQUEST_COLUMNS =
  "id, turn_id AS turnId, branch_id AS branchId, model, query_source AS querySource, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_5m_tokens AS cacheWrite5mTokens, cache_write_1h_tokens AS cacheWrite1hTokens, token_source AS tokenSource, started_at AS startedAt, duration_ms AS durationMs, effort, shape_hash AS shapeHash, cache_lifetimes AS cacheLifetimes";
export const REQUEST_ROWS_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? ORDER BY started_at ASC, id ASC`;
export const LOAD_ROWS_SQL =
  "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
export const ATTACHMENT_ROWS_SQL =
  "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? ORDER BY id ASC";
// The shapes a session named in its shape entries, plus the
// ones its requests were sent with: a request can name a
// shape whose naming row another session's cleanup removed.
export const SESSION_SHAPES_SQL =
  "SELECT hash, system_bytes AS systemBytes, tools FROM request_shapes WHERE hash IN (SELECT hash FROM session_shapes WHERE session_id = ?) OR hash IN (SELECT shape_hash FROM requests WHERE session_id = ? AND shape_hash IS NOT NULL) ORDER BY hash ASC";
export const SAMPLE_ROWS_SQL =
  "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? ORDER BY sampled_at ASC, id ASC";
const CONTEXT_REPORTS_SQL =
  "SELECT model, window, autocompact_buffer AS autocompactBuffer, system_prompt AS systemPrompt, system_tools AS systemTools, mcp_instructions AS mcpInstructions, memory_files AS memoryFiles, skills, reported_at AS reportedAt FROM context_reports WHERE session_id = ? ORDER BY reported_at ASC";
export const COMPACTION_FILES_SQL =
  "SELECT id, at, name, size_bytes AS sizeBytes, reread FROM compaction_files WHERE session_id = ? ORDER BY at ASC, id ASC";
export const DISMISSALS_SQL =
  "SELECT finding_id AS findingId FROM finding_dismissals WHERE session_id = ?";
const DISMISS_FINDING_SQL =
  "INSERT INTO finding_dismissals (session_id, finding_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT (session_id, finding_id) DO NOTHING";
export const TURN_FOR_PROMPT_SQL =
  "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?";
export const TURN_ROWS_SINCE_SQL =
  "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const STEP_ROWS_SINCE_SQL =
  "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const HUMAN_ROWS_SINCE_SQL =
  "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const BRANCH_ROWS_SINCE_SQL =
  "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const SEGMENT_ROWS_SINCE_SQL =
  "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const PAUSE_ROWS_SINCE_SQL =
  "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const REQUEST_ROWS_SINCE_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND id > ? ORDER BY id ASC`;
export const SAMPLE_ROWS_SINCE_SQL =
  "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const REQUEST_ROWS_FOR_BRANCH_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND branch_id = ? ORDER BY started_at ASC, id ASC`;
export const LOAD_ROWS_SINCE_SQL =
  "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const ATTACHMENT_ROWS_SINCE_SQL =
  "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const ATTACHMENTS_FOR_TURN_SQL =
  "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND turn_id = ? ORDER BY id ASC";
export const ROW_CHANGES_SINCE_SQL =
  "SELECT seq, table_name AS tableName, row_id AS rowId FROM row_changes WHERE session_id = ? AND seq > ? ORDER BY seq ASC";
export const CHANGE_MAX_SEQ_SQL =
  "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM row_changes WHERE session_id = ?";
const CLEAR_ROW_CHANGES_SQL =
  "DELETE FROM row_changes WHERE session_id = ? AND seq <= ?";
const CLEAR_SESSION_ROW_CHANGES_SQL =
  "DELETE FROM row_changes WHERE session_id = ?";
const CLEAR_ALL_ROW_CHANGES_SQL = "DELETE FROM row_changes";
const CHANGE_SESSIONS_SQL =
  "SELECT DISTINCT session_id AS sessionId FROM row_changes";
export const REQUEST_BY_ID_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`;
export const STEP_BY_ID_SQL =
  "SELECT id, session_id AS sessionId, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE id = ?";
export const TURN_BY_ID_SQL =
  "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE id = ?";
export const BRANCH_BY_ID_SQL =
  "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE id = ?";
export const PAUSE_BY_ID_SQL =
  "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE id = ?";
export const SAMPLE_BY_ID_SQL =
  "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE id = ?";
const LOAD_BY_ID_SQL =
  "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE id = ?";
export const SESSION_SCAN_SQL =
  "SELECT id, status, last_seen_at AS lastSeenAt FROM sessions ORDER BY id ASC";
export const STREAM_PROBE_SQL = `SELECT
  (SELECT COALESCE(MAX(id), 0) FROM turns WHERE session_id = ?) AS turnMax,
  (SELECT COALESCE(MAX(id), 0) FROM steps WHERE session_id = ?) AS stepMax,
  (SELECT COALESCE(MAX(id), 0) FROM human_events WHERE session_id = ?) AS humanMax,
  (SELECT COALESCE(MAX(id), 0) FROM branches WHERE session_id = ?) AS branchMax,
  (SELECT COALESCE(MAX(id), 0) FROM segments WHERE session_id = ?) AS segmentMax,
  (SELECT COALESCE(MAX(id), 0) FROM pauses WHERE session_id = ?) AS pauseMax,
  (SELECT COALESCE(MAX(id), 0) FROM context_samples WHERE session_id = ?) AS sampleMax,
  (SELECT COALESCE(MAX(id), 0) FROM loads WHERE session_id = ?) AS loadMax,
  (SELECT COALESCE(MAX(id), 0) FROM prompt_attachments WHERE session_id = ?) AS attachmentMax`;

/** A session's high-water marks: the newest row id in each of
 * its journey tables, as the stream's probe reads them. */
type StreamProbeRow = {
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

// A turn row as its SQL returns it: flightpath_command is
// still the stored 0/1; every other column already carries
// its own name.
type TurnSqlRow = Omit<TurnRow, "flightpathCommand"> & {
  flightpathCommand: number;
};

// A request row as its SQL returns it: the cache lifetimes
// are still the stored JSON text.
type RequestSqlRow = Omit<RequestRow, "cacheLifetimes"> & {
  cacheLifetimes: string | null;
};

function toRequestRow(row: RequestSqlRow): RequestRow {
  return {
    ...row,
    cacheLifetimes:
      row.cacheLifetimes === null ? null : parseStringArray(row.cacheLifetimes),
  };
}

// A load row as its SQL returns it: the names are still the
// stored JSON text.
type LoadSqlRow = Omit<LoadRow, "names"> & { names: string | null };

function toLoadRow(row: LoadSqlRow): LoadRow {
  return {
    ...row,
    names: row.names === null ? null : parseStringArray(row.names),
  };
}

function toLoadRowIfAny(row: LoadSqlRow | undefined): LoadRow | undefined {
  return row === undefined ? undefined : toLoadRow(row);
}

// A shape row as its SQL returns it: the tools are still the
// stored JSON text — an array of {name, bytes, mcp}.
type ShapeSqlRow = Omit<RequestShapeRow, "tools"> & { tools: string | null };

function toRequestShapeRow(row: ShapeSqlRow): RequestShapeRow {
  return {
    hash: row.hash,
    systemBytes: row.systemBytes,
    tools: shapeTools(row.tools),
  };
}

function shapeTools(text: string | null): ShapeTool[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tools: ShapeTool[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const name = str(item, "name");
    const bytes = num(item, "bytes");
    if (name === undefined || bytes === undefined) continue;
    tools.push({ name, bytes, mcp: bool(item, "mcp") });
  }
  return tools;
}

// The read side's per-session rows: a session's turns, steps,
// moments, branches, segments, pauses, requests and samples,
// each in the order the screens read them.
export function sessionDetailMethods(db: DatabaseSync) {
  const turnQuery = db.prepare(TURN_ROWS_SQL);
  const stepQuery = db.prepare(STEP_ROWS_SQL);
  const humanQuery = db.prepare(HUMAN_ROWS_SQL);
  const branchQuery = db.prepare(BRANCH_ROWS_SQL);
  const segmentQuery = db.prepare(SEGMENT_ROWS_SQL);
  const pauseQuery = db.prepare(PAUSE_ROWS_SQL);
  const requestQuery = db.prepare(REQUEST_ROWS_SQL);
  const sampleQuery = db.prepare(SAMPLE_ROWS_SQL);
  const contextReportQuery = db.prepare(CONTEXT_REPORTS_SQL);
  const compactionFileQuery = db.prepare(COMPACTION_FILES_SQL);
  const loadQuery = db.prepare(LOAD_ROWS_SQL);
  const attachmentQuery = db.prepare(ATTACHMENT_ROWS_SQL);
  const shapeQuery = db.prepare(SESSION_SHAPES_SQL);
  const stepByIdQuery = db.prepare(STEP_BY_ID_SQL);
  return {
    turnRows: (sessionId: string) =>
      (turnQuery.all(sessionId) as TurnSqlRow[]).map((row) => ({
        ...row,
        flightpathCommand: row.flightpathCommand === 1,
      })),
    stepRows: (sessionId: string) => stepQuery.all(sessionId) as StepRow[],
    humanRows: (sessionId: string) => humanQuery.all(sessionId) as HumanRow[],
    branchRows: (sessionId: string) =>
      branchQuery.all(sessionId) as BranchRow[],
    segmentRows: (sessionId: string) =>
      segmentQuery.all(sessionId) as SegmentRow[],
    pauseRows: (sessionId: string) => pauseQuery.all(sessionId) as PauseRow[],
    requestRows: (sessionId: string) =>
      (requestQuery.all(sessionId) as RequestSqlRow[]).map(toRequestRow),
    contextSampleRows: (sessionId: string) =>
      sampleQuery.all(sessionId) as ContextSampleRow[],
    contextReportsFor: (sessionId: string) =>
      contextReportQuery.all(sessionId) as ContextReportRow[],
    compactionFileRows: (sessionId: string) =>
      (
        compactionFileQuery.all(sessionId) as (Omit<
          CompactionFileRow,
          "reread"
        > & { reread: number })[]
      ).map((row) => ({ ...row, reread: row.reread === 1 })),
    loadRows: (sessionId: string) =>
      (loadQuery.all(sessionId) as LoadSqlRow[]).map(toLoadRow),
    promptAttachmentRows: (sessionId: string) =>
      attachmentQuery.all(sessionId) as PromptAttachmentRow[],
    requestShapeRows: (sessionId: string) =>
      (shapeQuery.all(sessionId, sessionId) as ShapeSqlRow[]).map(
        toRequestShapeRow,
      ),
    stepRowById: (stepId: number) =>
      stepByIdQuery.get(stepId) as StepReadRow | undefined,
  };
}

// The watcher's reads: single rows by id, the rows past a
// high-water mark, one branch's requests, the light session
// scan and the high-water probe — the queries a change
// watcher diffs between passes (ADR-0009).
export function sessionWatchMethods(db: DatabaseSync) {
  const turnByIdQuery = db.prepare(TURN_BY_ID_SQL);
  const branchByIdQuery = db.prepare(BRANCH_BY_ID_SQL);
  const pauseByIdQuery = db.prepare(PAUSE_BY_ID_SQL);
  const sampleByIdQuery = db.prepare(SAMPLE_BY_ID_SQL);
  const loadByIdQuery = db.prepare(LOAD_BY_ID_SQL);
  const sessionScanQuery = db.prepare(SESSION_SCAN_SQL);
  const turnSinceQuery = db.prepare(TURN_ROWS_SINCE_SQL);
  const stepSinceQuery = db.prepare(STEP_ROWS_SINCE_SQL);
  const humanSinceQuery = db.prepare(HUMAN_ROWS_SINCE_SQL);
  const branchSinceQuery = db.prepare(BRANCH_ROWS_SINCE_SQL);
  const segmentSinceQuery = db.prepare(SEGMENT_ROWS_SINCE_SQL);
  const pauseSinceQuery = db.prepare(PAUSE_ROWS_SINCE_SQL);
  const requestSinceQuery = db.prepare(REQUEST_ROWS_SINCE_SQL);
  const sampleSinceQuery = db.prepare(SAMPLE_ROWS_SINCE_SQL);
  return {
    turnRowById: (turnId: number) => {
      const row = turnByIdQuery.get(turnId) as TurnSqlRow | undefined;
      return row === undefined
        ? undefined
        : { ...row, flightpathCommand: row.flightpathCommand === 1 };
    },
    branchRowById: (branchId: number) =>
      branchByIdQuery.get(branchId) as BranchRow | undefined,
    pauseRowById: (pauseId: number) =>
      pauseByIdQuery.get(pauseId) as PauseRow | undefined,
    contextSampleRowById: (sampleId: number) =>
      sampleByIdQuery.get(sampleId) as ContextSampleRow | undefined,
    loadRowById: (loadId: number) =>
      toLoadRowIfAny(loadByIdQuery.get(loadId) as LoadSqlRow | undefined),
    sessionScanRows: () =>
      sessionScanQuery.all() as {
        id: string;
        status: string;
        lastSeenAt: number;
      }[],
    turnRowsSince: (sessionId: string, afterId: number) =>
      (turnSinceQuery.all(sessionId, afterId) as TurnSqlRow[]).map((row) => ({
        ...row,
        flightpathCommand: row.flightpathCommand === 1,
      })),
    stepRowsSince: (sessionId: string, afterId: number) =>
      stepSinceQuery.all(sessionId, afterId) as StepRow[],
    humanRowsSince: (sessionId: string, afterId: number) =>
      humanSinceQuery.all(sessionId, afterId) as HumanRow[],
    branchRowsSince: (sessionId: string, afterId: number) =>
      branchSinceQuery.all(sessionId, afterId) as BranchRow[],
    segmentRowsSince: (sessionId: string, afterId: number) =>
      segmentSinceQuery.all(sessionId, afterId) as SegmentRow[],
    pauseRowsSince: (sessionId: string, afterId: number) =>
      pauseSinceQuery.all(sessionId, afterId) as PauseRow[],
    requestRowsSince: (sessionId: string, afterId: number) =>
      (requestSinceQuery.all(sessionId, afterId) as RequestSqlRow[]).map(
        toRequestRow,
      ),
    sampleRowsSince: (sessionId: string, afterId: number) =>
      sampleSinceQuery.all(sessionId, afterId) as ContextSampleRow[],
  };
}

/**
 * The reads a live capture folds in beyond the watched rows:
 * the loads and attachments past their marks, a branch's
 * requests, rows re-read by id as they change, a changed
 * turn's attachments as they now stand, and the change feed —
 * what the triggers recorded, consumed by the capture that
 * folded it in and pruned for the sessions no capture holds.
 */
export function sessionLiveRowMethods(db: DatabaseSync) {
  const requestByIdQuery = db.prepare(REQUEST_BY_ID_SQL);
  const branchRequestQuery = db.prepare(REQUEST_ROWS_FOR_BRANCH_SQL);
  const loadSinceQuery = db.prepare(LOAD_ROWS_SINCE_SQL);
  const attachmentSinceQuery = db.prepare(ATTACHMENT_ROWS_SINCE_SQL);
  const attachmentsForTurnQuery = db.prepare(ATTACHMENTS_FOR_TURN_SQL);
  const changesSinceQuery = db.prepare(ROW_CHANGES_SINCE_SQL);
  const changeMaxSeqQuery = db.prepare(CHANGE_MAX_SEQ_SQL);
  const clearChangesQuery = db.prepare(CLEAR_ROW_CHANGES_SQL);
  const clearSessionChangesQuery = db.prepare(CLEAR_SESSION_ROW_CHANGES_SQL);
  const clearAllChangesQuery = db.prepare(CLEAR_ALL_ROW_CHANGES_SQL);
  const changeSessionsQuery = db.prepare(CHANGE_SESSIONS_SQL);
  return {
    requestRowById: (requestId: number) => {
      const row = requestByIdQuery.get(requestId) as RequestSqlRow | undefined;
      return row === undefined ? undefined : toRequestRow(row);
    },
    requestRowsForBranch: (sessionId: string, branchId: number) =>
      (branchRequestQuery.all(sessionId, branchId) as RequestSqlRow[]).map(
        toRequestRow,
      ),
    loadRowsSince: (sessionId: string, afterId: number) =>
      (loadSinceQuery.all(sessionId, afterId) as LoadSqlRow[]).map(toLoadRow),
    attachmentRowsSince: (sessionId: string, afterId: number) =>
      attachmentSinceQuery.all(sessionId, afterId) as PromptAttachmentRow[],
    promptAttachmentsForTurn: (sessionId: string, turnId: number) =>
      attachmentsForTurnQuery.all(sessionId, turnId) as PromptAttachmentRow[],
    changedRowsSince: (sessionId: string, afterSeq: number) =>
      changesSinceQuery.all(sessionId, afterSeq) as ChangedRow[],
    changeMaxSeq: (sessionId: string) =>
      (changeMaxSeqQuery.get(sessionId) as { maxSeq: number }).maxSeq,
    clearChangedRows: (sessionId: string, throughSeq: number) => {
      clearChangesQuery.run(sessionId, throughSeq);
    },
    clearSessionChanges: (sessionId: string) => {
      clearSessionChangesQuery.run(sessionId);
    },
    clearAllChanges: () => {
      clearAllChangesQuery.run();
    },
    dropUncapturedChanges: (heldSessionIds: string[]) => {
      const held = new Set(heldSessionIds);
      const rows = changeSessionsQuery.all() as { sessionId: string }[];
      for (const row of rows) {
        if (!held.has(row.sessionId)) {
          clearSessionChangesQuery.run(row.sessionId);
        }
      }
    },
  };
}

export function streamProbeMethod(db: DatabaseSync) {
  const streamProbeQuery = db.prepare(STREAM_PROBE_SQL);
  return {
    streamProbe: (sessionId: string) =>
      streamProbeQuery.get(
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
      ) as StreamProbeRow,
  };
}

// The turn a hook's prompt id names; the hooks and the telemetry
// share that id, so it is how a hook event finds its turn.
export function turnForPromptMethod(db: DatabaseSync) {
  const turnForPromptQuery = db.prepare(TURN_FOR_PROMPT_SQL);
  return {
    turnIdForPrompt: (sessionId: string, promptId: string) =>
      (
        turnForPromptQuery.get(sessionId, promptId) as
          { id: number } | undefined
      )?.id,
  };
}

// The findings a person dismissed. A finding is computed on
// every read, so only its id is kept.
export function findingDismissalMethods(db: DatabaseSync) {
  const dismissalQuery = db.prepare(DISMISSALS_SQL);
  const dismissQuery = db.prepare(DISMISS_FINDING_SQL);
  return {
    listDismissals: (sessionId: string) =>
      (dismissalQuery.all(sessionId) as { findingId: string }[]).map(
        (row) => row.findingId,
      ),
    dismissFinding: (sessionId: string, findingId: string) => {
      dismissQuery.run(sessionId, findingId, Date.now());
    },
  };
}
