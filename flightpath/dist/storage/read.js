// The read side of storage: the row types the screens are
// built from, and one prepared statement per question, each
// keyed by an indexed column so a snapshot never scans a
// table. The statements alias their columns to the row types'
// own names, so rows are read as those types directly; the
// only conversions left are the ones where a value really
// changes form — two flags stored as 0/1, and the JSON arrays.
import { bool, isPlainObject, num, parseStringArray, str, } from "../util/json.js";
import { OVERHEAD_SQL, REQUEST_TOKEN_SUM } from "./request-tokens.js";
function toSessionListRow(row) {
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
export function sessionReadMethods(db) {
    const countSessionRows = db.prepare(COUNT_SESSIONS_SQL);
    const listSessionQuery = db.prepare(SESSION_LIST_SQL);
    const sessionQuery = db.prepare(SESSION_ROW_SQL);
    const liveSessionQuery = db.prepare(LIVE_SESSIONS_SQL);
    const liveHostsQuery = db.prepare(LIVE_SESSION_HOSTS_SQL);
    const overheadQuery = db.prepare(OVERHEAD_SQL);
    return {
        countSessions: () => countSessionRows.get().n,
        liveSessionHosts: () => liveHostsQuery.all(),
        liveSessions: () => liveSessionQuery.all(),
        listSessionRows: () => listSessionQuery.all().map(toSessionListRow),
        sessionRow: (sessionId) => {
            const row = sessionQuery.get(sessionId);
            if (row === undefined) {
                return undefined;
            }
            const { permissionModes, ...rest } = row;
            return {
                ...toSessionListRow(rest),
                permissionModes: parseStringArray(permissionModes),
            };
        },
        flightpathOverheadTokens: (sessionId) => overheadQuery.get(sessionId).total,
    };
}
// Named for the same reason as the session statements above.
export const TURN_ROWS_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? ORDER BY sequence ASC";
export const STEP_ROWS_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const HUMAN_ROWS_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
export const BRANCH_ROWS_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const SEGMENT_ROWS_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? ORDER BY started_at ASC, id ASC";
export const PAUSE_ROWS_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? ORDER BY paused_at ASC, id ASC";
const REQUEST_COLUMNS = "id, turn_id AS turnId, branch_id AS branchId, model, query_source AS querySource, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_5m_tokens AS cacheWrite5mTokens, cache_write_1h_tokens AS cacheWrite1hTokens, token_source AS tokenSource, started_at AS startedAt, duration_ms AS durationMs, effort, shape_hash AS shapeHash, cache_lifetimes AS cacheLifetimes";
export const REQUEST_ROWS_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? ORDER BY started_at ASC, id ASC`;
export const LOAD_ROWS_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
export const ATTACHMENT_ROWS_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? ORDER BY id ASC";
// The shapes a session named in its shape entries, plus the
// ones its requests were sent with: a request can name a
// shape whose naming row another session's cleanup removed.
export const SESSION_SHAPES_SQL = "SELECT hash, system_bytes AS systemBytes, tools FROM request_shapes WHERE hash IN (SELECT hash FROM session_shapes WHERE session_id = ?) OR hash IN (SELECT shape_hash FROM requests WHERE session_id = ? AND shape_hash IS NOT NULL) ORDER BY hash ASC";
export const SAMPLE_ROWS_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? ORDER BY sampled_at ASC, id ASC";
const CONTEXT_REPORTS_SQL = "SELECT model, window, autocompact_buffer AS autocompactBuffer, system_prompt AS systemPrompt, system_tools AS systemTools, mcp_instructions AS mcpInstructions, memory_files AS memoryFiles, skills, reported_at AS reportedAt FROM context_reports WHERE session_id = ? ORDER BY reported_at ASC";
export const COMPACTION_FILES_SQL = "SELECT id, at, name, size_bytes AS sizeBytes, reread FROM compaction_files WHERE session_id = ? ORDER BY at ASC, id ASC";
export const DISMISSALS_SQL = "SELECT finding_id AS findingId FROM finding_dismissals WHERE session_id = ?";
const DISMISS_FINDING_SQL = "INSERT INTO finding_dismissals (session_id, finding_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT (session_id, finding_id) DO NOTHING";
export const TURN_FOR_PROMPT_SQL = "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?";
export const TURN_ROWS_SINCE_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const STEP_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const HUMAN_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const BRANCH_ROWS_SINCE_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const SEGMENT_ROWS_SINCE_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const PAUSE_ROWS_SINCE_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const REQUEST_ROWS_SINCE_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND id > ? ORDER BY id ASC`;
export const SAMPLE_ROWS_SINCE_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const REQUEST_ROWS_FOR_BRANCH_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND branch_id = ? ORDER BY started_at ASC, id ASC`;
export const LOAD_ROWS_SINCE_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const ATTACHMENT_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND id > ? ORDER BY id ASC";
export const ATTACHMENTS_FOR_TURN_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND turn_id = ? ORDER BY id ASC";
export const ROW_CHANGES_SINCE_SQL = "SELECT seq, table_name AS tableName, row_id AS rowId FROM row_changes WHERE session_id = ? AND seq > ? ORDER BY seq ASC";
export const CHANGE_MAX_SEQ_SQL = "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM row_changes WHERE session_id = ?";
const CLEAR_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ? AND seq <= ?";
const CLEAR_SESSION_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ?";
const CLEAR_ALL_ROW_CHANGES_SQL = "DELETE FROM row_changes";
const CHANGE_SESSIONS_SQL = "SELECT DISTINCT session_id AS sessionId FROM row_changes";
export const REQUEST_BY_ID_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`;
export const STEP_BY_ID_SQL = "SELECT id, session_id AS sessionId, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE id = ?";
export const TURN_BY_ID_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE id = ?";
export const BRANCH_BY_ID_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE id = ?";
export const PAUSE_BY_ID_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE id = ?";
export const SAMPLE_BY_ID_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE id = ?";
const LOAD_BY_ID_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE id = ?";
export const SESSION_SCAN_SQL = "SELECT id, status, last_seen_at AS lastSeenAt FROM sessions ORDER BY id ASC";
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
function toRequestRow(row) {
    return {
        ...row,
        cacheLifetimes: row.cacheLifetimes === null ? null : parseStringArray(row.cacheLifetimes),
    };
}
function toLoadRow(row) {
    return {
        ...row,
        names: row.names === null ? null : parseStringArray(row.names),
    };
}
function toLoadRowIfAny(row) {
    return row === undefined ? undefined : toLoadRow(row);
}
function toRequestShapeRow(row) {
    return {
        hash: row.hash,
        systemBytes: row.systemBytes,
        tools: shapeTools(row.tools),
    };
}
function shapeTools(text) {
    if (text === null)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    const tools = [];
    for (const item of parsed) {
        if (!isPlainObject(item))
            continue;
        const name = str(item, "name");
        const bytes = num(item, "bytes");
        if (name === undefined || bytes === undefined)
            continue;
        tools.push({ name, bytes, mcp: bool(item, "mcp") });
    }
    return tools;
}
// The read side's per-session rows: a session's turns, steps,
// moments, branches, segments, pauses, requests and samples,
// each in the order the screens read them.
export function sessionDetailMethods(db) {
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
        turnRows: (sessionId) => turnQuery.all(sessionId).map((row) => ({
            ...row,
            flightpathCommand: row.flightpathCommand === 1,
        })),
        stepRows: (sessionId) => stepQuery.all(sessionId),
        humanRows: (sessionId) => humanQuery.all(sessionId),
        branchRows: (sessionId) => branchQuery.all(sessionId),
        segmentRows: (sessionId) => segmentQuery.all(sessionId),
        pauseRows: (sessionId) => pauseQuery.all(sessionId),
        requestRows: (sessionId) => requestQuery.all(sessionId).map(toRequestRow),
        contextSampleRows: (sessionId) => sampleQuery.all(sessionId),
        contextReportsFor: (sessionId) => contextReportQuery.all(sessionId),
        compactionFileRows: (sessionId) => compactionFileQuery.all(sessionId).map((row) => ({ ...row, reread: row.reread === 1 })),
        loadRows: (sessionId) => loadQuery.all(sessionId).map(toLoadRow),
        promptAttachmentRows: (sessionId) => attachmentQuery.all(sessionId),
        requestShapeRows: (sessionId) => shapeQuery.all(sessionId, sessionId).map(toRequestShapeRow),
        stepRowById: (stepId) => stepByIdQuery.get(stepId),
    };
}
// The watcher's reads: single rows by id, the rows past a
// high-water mark, one branch's requests, the light session
// scan and the high-water probe — the queries a change
// watcher diffs between passes (ADR-0009).
export function sessionWatchMethods(db) {
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
        turnRowById: (turnId) => {
            const row = turnByIdQuery.get(turnId);
            return row === undefined
                ? undefined
                : { ...row, flightpathCommand: row.flightpathCommand === 1 };
        },
        branchRowById: (branchId) => branchByIdQuery.get(branchId),
        pauseRowById: (pauseId) => pauseByIdQuery.get(pauseId),
        contextSampleRowById: (sampleId) => sampleByIdQuery.get(sampleId),
        loadRowById: (loadId) => toLoadRowIfAny(loadByIdQuery.get(loadId)),
        sessionScanRows: () => sessionScanQuery.all(),
        turnRowsSince: (sessionId, afterId) => turnSinceQuery.all(sessionId, afterId).map((row) => ({
            ...row,
            flightpathCommand: row.flightpathCommand === 1,
        })),
        stepRowsSince: (sessionId, afterId) => stepSinceQuery.all(sessionId, afterId),
        humanRowsSince: (sessionId, afterId) => humanSinceQuery.all(sessionId, afterId),
        branchRowsSince: (sessionId, afterId) => branchSinceQuery.all(sessionId, afterId),
        segmentRowsSince: (sessionId, afterId) => segmentSinceQuery.all(sessionId, afterId),
        pauseRowsSince: (sessionId, afterId) => pauseSinceQuery.all(sessionId, afterId),
        requestRowsSince: (sessionId, afterId) => requestSinceQuery.all(sessionId, afterId).map(toRequestRow),
        sampleRowsSince: (sessionId, afterId) => sampleSinceQuery.all(sessionId, afterId),
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
export function sessionLiveRowMethods(db) {
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
        requestRowById: (requestId) => {
            const row = requestByIdQuery.get(requestId);
            return row === undefined ? undefined : toRequestRow(row);
        },
        requestRowsForBranch: (sessionId, branchId) => branchRequestQuery.all(sessionId, branchId).map(toRequestRow),
        loadRowsSince: (sessionId, afterId) => loadSinceQuery.all(sessionId, afterId).map(toLoadRow),
        attachmentRowsSince: (sessionId, afterId) => attachmentSinceQuery.all(sessionId, afterId),
        promptAttachmentsForTurn: (sessionId, turnId) => attachmentsForTurnQuery.all(sessionId, turnId),
        changedRowsSince: (sessionId, afterSeq) => changesSinceQuery.all(sessionId, afterSeq),
        changeMaxSeq: (sessionId) => changeMaxSeqQuery.get(sessionId).maxSeq,
        clearChangedRows: (sessionId, throughSeq) => {
            clearChangesQuery.run(sessionId, throughSeq);
        },
        clearSessionChanges: (sessionId) => {
            clearSessionChangesQuery.run(sessionId);
        },
        clearAllChanges: () => {
            clearAllChangesQuery.run();
        },
        dropUncapturedChanges: (heldSessionIds) => {
            const held = new Set(heldSessionIds);
            const rows = changeSessionsQuery.all();
            for (const row of rows) {
                if (!held.has(row.sessionId)) {
                    clearSessionChangesQuery.run(row.sessionId);
                }
            }
        },
    };
}
export function streamProbeMethod(db) {
    const streamProbeQuery = db.prepare(STREAM_PROBE_SQL);
    return {
        streamProbe: (sessionId) => streamProbeQuery.get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId),
    };
}
// The turn a hook's prompt id names; the hooks and the telemetry
// share that id, so it is how a hook event finds its turn.
export function turnForPromptMethod(db) {
    const turnForPromptQuery = db.prepare(TURN_FOR_PROMPT_SQL);
    return {
        turnIdForPrompt: (sessionId, promptId) => turnForPromptQuery.get(sessionId, promptId)?.id,
    };
}
// The findings a person dismissed. A finding is computed on
// every read, so only its id is kept.
export function findingDismissalMethods(db) {
    const dismissalQuery = db.prepare(DISMISSALS_SQL);
    const dismissQuery = db.prepare(DISMISS_FINDING_SQL);
    return {
        listDismissals: (sessionId) => dismissalQuery.all(sessionId).map((row) => row.findingId),
        dismissFinding: (sessionId, findingId) => {
            dismissQuery.run(sessionId, findingId, Date.now());
        },
    };
}
