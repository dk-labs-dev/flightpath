// The transcript store: every SQL write the transcript
// reader makes (ADR-0019), including the one upsert path for
// `requests` that telemetry also uses, so the merge rules
// live in exactly one place.
//
// Extraction happens in parse.ts; everything stored has
// passed through intake redaction (ADR-0017). No message
// text, tool output or file content is ever written. The
// follower that reads the files lives in follower.ts.
import { linkBranchToStep, prepareBranchLinkStatements, } from "../storage/branch-link.js";
import { prepareConditionsStatements, } from "../storage/conditions.js";
import { fillTurnPromptFigures, fillTurnPromptText, preparePromptTextStatements, promptTextColumns, } from "../storage/prompt-text.js";
import { findLoadForSkillText, prepareSkillLoadStatements, } from "../storage/skill-load.js";
import { asText, numberValue, parseStringArray } from "../util/json.js";
function prepareRequestStatements(db) {
    return {
        getRequest: db.prepare("SELECT * FROM requests WHERE session_id = ? AND request_id = ? ORDER BY id LIMIT 1"),
        insertRequest: db.prepare("INSERT INTO requests (session_id, request_id, turn_id, branch_id, model, query_source, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, started_at, duration_ms, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
        updateRequest: db.prepare("UPDATE requests SET turn_id = ?, branch_id = ?, model = ?, query_source = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_5m_tokens = ?, cache_write_1h_tokens = ?, token_source = ?, started_at = ?, duration_ms = ?, effort = ? WHERE id = ?"),
        getSampleByRequest: db.prepare("SELECT id, context_tokens FROM context_samples WHERE request_id = ? AND source = ? LIMIT 1"),
        getSampleByValue: db.prepare("SELECT id FROM context_samples WHERE session_id = ? AND sampled_at = ? AND context_tokens = ? AND source = ? LIMIT 1"),
        insertSample: db.prepare("INSERT INTO context_samples (session_id, request_id, sampled_at, context_tokens, source) VALUES (?, ?, ?, ?, ?)"),
        updateSample: db.prepare("UPDATE context_samples SET sampled_at = ?, context_tokens = ? WHERE id = ?"),
        // A concluded closing is the daemon's guess, not a
        // source's fact: an interrupt the transcript reports
        // replaces it, so the revival never reopens the step.
        closeStep: db.prepare("UPDATE steps SET outcome = 'interrupted', outcome_source = 'transcript', ended_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END WHERE session_id = ? AND tool_use_id = ? AND (outcome = 'open' OR outcome_source = 'concluded')"),
    };
}
function prepareSessionStatements(db) {
    return {
        getPauses: db.prepare("SELECT paused_at, resumed_at FROM pauses WHERE session_id = ? ORDER BY paused_at"),
        countRaw: db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?"),
        projectPaths: db.prepare("SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL"),
        getProjectPath: db.prepare("SELECT project_path FROM sessions WHERE id = ?"),
        insertSession: db.prepare("INSERT OR IGNORE INTO sessions (id, project_path, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, ?, 'live', ?, ?, 1)"),
        finishImport: db.prepare("UPDATE sessions SET status = 'ended', end_seen = 0, first_seen_at = ?, last_seen_at = ? WHERE id = ?"),
        fillProjectPath: db.prepare("UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL"),
        touch: db.prepare("UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?"),
        getSessionState: db.prepare("SELECT status, end_seen FROM sessions WHERE id = ?"),
    };
}
function prepareTurnStatements(db) {
    return {
        ...preparePromptTextStatements(db),
        ...prepareBranchLinkStatements(db),
        ...prepareSessionStatements(db),
        getTurnByPrompt: db.prepare("SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?"),
        getLatestTurn: db.prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY sequence DESC LIMIT 1"),
        // A concluded end is provisional — the daemon's guess,
        // not a source's fact — so the turn the conclusion ended
        // is still the open one here, and a source's own end is
        // the one that lands (see the endTurn statement below).
        getOpenTurn: db.prepare("SELECT id FROM turns WHERE session_id = ? AND (ended_at IS NULL OR end_source = 'concluded') ORDER BY sequence DESC LIMIT 1"),
        nextSequence: db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE session_id = ?"),
        insertTurn: db.prepare("INSERT INTO turns (session_id, prompt_id, sequence, started_at, ended_at, end_source, prompt_text, prompt_chars, prompt_lines, flightpath_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"),
        // The same rule as the step close above: an end a source
        // reports replaces a concluded one and clears its mark.
        endTurn: db.prepare("UPDATE turns SET ended_at = ?, end_source = NULL WHERE id = ? AND (ended_at IS NULL OR end_source = 'concluded')"),
        getBranch: db.prepare("SELECT id, spawning_step_id FROM branches WHERE session_id = ? AND agent_id = ?"),
        getSpawningTurn: db.prepare("SELECT steps.turn_id AS turn_id FROM branches JOIN steps ON steps.id = branches.spawning_step_id WHERE branches.session_id = ? AND branches.agent_id = ?"),
        getStepByToolUse: db.prepare("SELECT id, turn_id FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1"),
        markPartial: db.prepare("UPDATE sessions SET tokens_partial = 1 WHERE id = ?"),
    };
}
function prepareStepResultStatements(db) {
    return {
        linkStepResult: db.prepare("UPDATE steps SET result_request_id = ?, context_chars = ?, context_images = ?, async_launch = ?, saved_output_bytes = ? WHERE session_id = ? AND tool_use_id = ? AND result_request_id IS NULL"),
        // The insert lands only when no step names the call: a
        // step the hooks recorded is the record, and the
        // transcript's version of the call adds nothing to it.
        insertTranscriptStep: db.prepare(`INSERT INTO steps (session_id, turn_id, branch_id, tool_use_id, tool_name, input_summary, outcome, outcome_source, started_at, ended_at, duration_ms, result_request_id, context_chars, context_images, async_launch, saved_output_bytes)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM steps WHERE session_id = ? AND tool_use_id = ?)`),
    };
}
/**
 * The per-turn attachment delete, named so the query-plan test
 * runs the statement the store actually prepares: the table is
 * deleted by session (forget, purge) and read by
 * turn, so its index leads with the session.
 */
export const DELETE_PROMPT_ATTACHMENTS_SQL = "DELETE FROM prompt_attachments WHERE session_id = ? AND turn_id = ?";
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
function preparePromptFactStatements(db) {
    return {
        setTurnImages: db.prepare("UPDATE turns SET image_count = ?, image_bytes = ? WHERE id = ?"),
        deleteAttachments: db.prepare(DELETE_PROMPT_ATTACHMENTS_SQL),
        insertAttachment: db.prepare("INSERT INTO prompt_attachments (session_id, turn_id, kind, name, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?)"),
        upsertCompactionFile: db.prepare("INSERT INTO compaction_files (session_id, at, name, size_bytes, reread) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, at, name) DO UPDATE SET size_bytes = excluded.size_bytes, reread = excluded.reread"),
        upsertContextReport: db.prepare("INSERT INTO context_reports (session_id, model, window, autocompact_buffer, system_prompt, system_tools, mcp_instructions, memory_files, skills, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, model) DO UPDATE SET window = excluded.window, autocompact_buffer = excluded.autocompact_buffer, system_prompt = excluded.system_prompt, system_tools = excluded.system_tools, mcp_instructions = excluded.mcp_instructions, memory_files = excluded.memory_files, skills = excluded.skills, reported_at = excluded.reported_at"),
    };
}
function prepareClaudeMessageStatements(db) {
    return { insertClaudeMessage: db.prepare(INSERT_CLAUDE_MESSAGE_SQL) };
}
function prepareRequestShapeStatements(db) {
    return {
        setRequestEffort: db.prepare("UPDATE requests SET effort = ? WHERE id = ?"),
        insertShape: db.prepare("INSERT OR IGNORE INTO request_shapes (hash, system_bytes, tools) VALUES (?, ?, ?)"),
        noteShape: db.prepare("INSERT OR IGNORE INTO session_shapes (session_id, hash) VALUES (?, ?)"),
        // The named row must exist for the link to land: the
        // foreign key would refuse the hash of a deleted shape,
        // and the request keeps no shape instead.
        setShape: db.prepare("UPDATE requests SET shape_hash = ? WHERE id = ? AND EXISTS (SELECT 1 FROM request_shapes WHERE hash = ?)"),
        setCacheFacts: db.prepare("UPDATE requests SET cache_lifetimes = ?, context_edits = ? WHERE id = ?"),
    };
}
function prepareTranscriptLoadStatements(db) {
    return {
        ...prepareSkillLoadStatements(db),
        // `IS ?` is null-safe equality: a repeat is the same
        // session, kind, moment, name and thread from the same
        // source.
        findTranscriptLoad: db.prepare("SELECT id FROM loads WHERE session_id = ? AND source = 'transcript' AND kind = ? AND occurred_at = ? AND name IS ? AND branch_id IS ? AND file_path IS ? LIMIT 1"),
        insertTranscriptLoad: db.prepare("INSERT INTO loads (session_id, kind, name, file_path, occurred_at, source, size_bytes, item_count, names, branch_id) VALUES (?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?)"),
        fillInstructionSize: db.prepare("UPDATE loads SET size_bytes = ? WHERE id = (SELECT id FROM loads WHERE session_id = ? AND kind = 'instructions' AND file_path = ? AND size_bytes IS NULL AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1)"),
        fillSkillSize: db.prepare("UPDATE loads SET size_bytes = ? WHERE id = ? AND size_bytes IS NULL"),
        findSkillFile: db.prepare("SELECT id FROM loads WHERE session_id = ? AND kind = 'skill-file' AND parent_load_id = ? AND file_path = ? LIMIT 1"),
        insertSkillFile: db.prepare("INSERT INTO loads (session_id, kind, file_path, occurred_at, source, size_bytes, line_count, parent_load_id) VALUES (?, 'skill-file', ?, ?, 'transcript', ?, ?, ?)"),
    };
}
function prepareConditionStatements(db) {
    return {
        ...prepareConditionsStatements(db),
        updateConditions: db.prepare("UPDATE session_conditions SET sources_seen = ?, claude_code_version = ?, updated_at = ? WHERE session_id = ?"),
    };
}
function prepareIngestStatements(db) {
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
function stepResultLinks(st) {
    return {
        linkStepResult: (sessionId, toolUseId, requestRowId, size) => {
            st.linkStepResult.run(requestRowId, size.chars, size.images, size.asyncLaunch ? 1 : 0, size.savedBytes, sessionId, toolUseId);
        },
        createTranscriptStep: (input) => {
            st.insertTranscriptStep.run(input.sessionId, input.turnId, input.branchId, input.toolUseId, input.toolName, input.inputSummary, input.failed ? "failed" : "succeeded", input.startedAt, input.endedAt, input.startedAt !== null ? input.endedAt - input.startedAt : null, input.requestRowId, input.size.chars, input.size.images, input.size.asyncLaunch ? 1 : 0, input.size.savedBytes, input.sessionId, input.toolUseId);
        },
    };
}
function promptFacts(st) {
    return {
        setTurnImages: (turnId, count, bytes) => {
            st.setTurnImages.run(count, bytes, turnId);
        },
        fillTurnPromptFigures: (turnId, chars, lines) => fillTurnPromptFigures(st, turnId, chars, lines),
        replacePromptAttachments: (sessionId, turnId, attachments) => {
            st.deleteAttachments.run(sessionId, turnId);
            for (const attachment of attachments) {
                st.insertAttachment.run(sessionId, turnId, attachment.kind, attachment.name, attachment.sizeBytes, attachment.lineCount);
            }
        },
        addPromptAttachment: (sessionId, turnId, attachment) => {
            st.insertAttachment.run(sessionId, turnId, attachment.kind, attachment.name, attachment.sizeBytes, attachment.lineCount);
        },
        addCompactionFile: (sessionId, file) => {
            st.upsertCompactionFile.run(sessionId, file.at, file.name, file.sizeBytes, file.reread ? 1 : 0);
        },
        recordContextReport: (sessionId, report, at) => {
            st.upsertContextReport.run(sessionId, report.model, report.window, report.autocompactBuffer, report.systemPrompt, report.systemTools, report.mcpInstructions, report.memoryFiles, report.skills, at);
        },
        ...claudeMessages(st),
    };
}
function recordSkillText(st, input) {
    const loadId = findLoadForSkillText(st, input.sessionId, input.name, input.at);
    if (loadId !== null) {
        st.fillSkillSize.run(input.bytes, loadId);
        return loadId;
    }
    const inserted = st.insertTranscriptLoad.run(input.sessionId, "skill", input.name, null, input.at, input.bytes, null, null, null);
    return Number(inserted.lastInsertRowid);
}
function transcriptLoads(st) {
    return {
        recordTranscriptLoad: (input) => {
            const existing = st.findTranscriptLoad.get(input.sessionId, input.kind, input.at, input.name, input.branchId, input.filePath ?? null);
            if (existing !== undefined)
                return;
            st.insertTranscriptLoad.run(input.sessionId, input.kind, input.name, input.filePath ?? null, input.at, input.chars, input.count, input.names === null ? null : JSON.stringify(input.names), input.branchId);
        },
        fillInstructionSize: (input) => {
            st.fillInstructionSize.run(input.chars, input.sessionId, input.filePath, input.at);
        },
        recordSkillText: (input) => recordSkillText(st, input),
        addSkillFile: (input) => {
            const existing = st.findSkillFile.get(input.sessionId, input.skillLoadId, input.path);
            if (existing !== undefined)
                return;
            st.insertSkillFile.run(input.sessionId, input.path, input.at, input.bytes, input.lines, input.skillLoadId);
        },
    };
}
/** The summary a message keeps in `detail`: names and sizes only. */
function claudeMessageDetail(message) {
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
function claudeMessages(st) {
    return {
        insertClaudeMessage: (sessionId, turnId, at, message) => {
            const detail = claudeMessageDetail(message);
            st.insertClaudeMessage.run(sessionId, turnId, message.kind, at, detail, sessionId, at, message.kind, detail);
        },
    };
}
function projectFolders(st) {
    return {
        recordedProjectPaths: () => st.projectPaths.all().map((row) => row.project_path),
        projectPathOf: (sessionId) => {
            const row = st.getProjectPath.get(sessionId);
            return row?.project_path ?? null;
        },
    };
}
function requestShapes(st) {
    return {
        setRequestEffort: (requestRowId, effort) => {
            st.setRequestEffort.run(effort, requestRowId);
        },
        upsertRequestShape: (shapeHash, shape) => {
            st.insertShape.run(shapeHash, shape.systemBytes, JSON.stringify(shape.tools));
        },
        noteRequestShape: (sessionId, shapeHash) => {
            st.noteShape.run(sessionId, shapeHash);
        },
        setRequestShape: (requestRowId, hash) => {
            st.setShape.run(hash, requestRowId, hash);
        },
        setRequestCacheFacts: (requestRowId, cacheLifetimes, contextEdits) => {
            st.setCacheFacts.run(JSON.stringify(cacheLifetimes), JSON.stringify(contextEdits), requestRowId);
        },
    };
}
function linkBranch(st, sessionId, agentId, toolUseId, onlyUnlinked) {
    const branch = st.getBranch.get(sessionId, agentId);
    if (branch === undefined)
        return;
    if (onlyUnlinked && branch.spawning_step_id !== null)
        return;
    const step = st.getStepByToolUse.get(sessionId, toolUseId);
    if (step === undefined)
        return;
    linkBranchToStep(st, branch.id, step.id, step.turn_id);
}
function turnAndBranchLinks(st) {
    return {
        turnIdByPrompt: (sessionId, promptId) => {
            const row = st.getTurnByPrompt.get(sessionId, promptId);
            return row?.id ?? null;
        },
        latestTurnId: (sessionId) => {
            const row = st.getLatestTurn.get(sessionId);
            return row?.id ?? null;
        },
        ensureTranscriptTurn: (sessionId, promptId, at, promptText) => ensureTranscriptTurn(st, sessionId, promptId, at, promptText),
        branchIdByAgent: (sessionId, agentId) => {
            const row = st.getBranch.get(sessionId, agentId);
            return row?.id ?? null;
        },
        spawningTurnId: (sessionId, agentId) => {
            const row = st.getSpawningTurn.get(sessionId, agentId);
            return row?.turn_id ?? null;
        },
        linkBranchStep: (sessionId, agentId, toolUseId) => linkBranch(st, sessionId, agentId, toolUseId, false),
        linkUnlinkedBranchStep: (sessionId, agentId, toolUseId) => linkBranch(st, sessionId, agentId, toolUseId, true),
    };
}
export function createTranscriptIngest(db) {
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
        pausesFor: (sessionId) => st.getPauses.all(sessionId).map((row) => ({
            pausedAt: row.paused_at,
            resumedAt: row.resumed_at ?? null,
        })),
        hasRawEvents: (sessionId) => st.countRaw.get(sessionId).n > 0,
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
        noteTranscriptSeen: (sessionId, version, at) => noteTranscriptSeen(st, sessionId, version, at),
        touchSession: (sessionId, at) => {
            st.touch.run(at, sessionId);
        },
    };
}
function pick(incomingWins, incoming, existing) {
    return incomingWins ? (incoming ?? existing) : (existing ?? incoming);
}
function insertRequestRow(st, input) {
    const result = st.insertRequest.run(input.sessionId, input.requestId, input.turnId, input.branchId, input.model, input.querySource, input.inputTokens, input.outputTokens, input.cacheReadTokens, input.cacheWrite5mTokens, input.cacheWrite1hTokens, input.tokenSource, input.startedAt, input.durationMs, input.effort ?? null);
    return Number(result.lastInsertRowid);
}
function mergeStartedAt(sameSource, incomingWins, input, existingStarted) {
    if (!sameSource) {
        return pick(incomingWins, input.startedAt, existingStarted);
    }
    // A repeat from the same source keeps the earliest start it
    // reported.
    if (existingStarted === null)
        return input.startedAt;
    if (input.startedAt === null)
        return existingStarted;
    return Math.min(existingStarted, input.startedAt);
}
/**
 * The cache-write pair, resolved together: a source that
 * reports only the total (which rides in the 5m column, 1h
 * null) must not flatten a split the other source reported.
 * When the total equals the split's sum, the split stands —
 * the same number, with more precision.
 */
function mergeCachePair(input, existing, incomingWins) {
    const existing5m = numberValue(existing.cache_write_5m_tokens);
    const existing1h = numberValue(existing.cache_write_1h_tokens);
    let merged5m = pick(incomingWins, input.cacheWrite5mTokens, existing5m);
    let merged1h = pick(incomingWins, input.cacheWrite1hTokens, existing1h);
    if (input.cacheWrite5mTokens !== null &&
        input.cacheWrite1hTokens !== null &&
        existing1h === null &&
        existing5m === input.cacheWrite5mTokens + input.cacheWrite1hTokens) {
        merged5m = input.cacheWrite5mTokens;
        merged1h = input.cacheWrite1hTokens;
    }
    else if (existing5m !== null &&
        existing1h !== null &&
        input.cacheWrite1hTokens === null &&
        input.cacheWrite5mTokens === existing5m + existing1h) {
        merged5m = existing5m;
        merged1h = existing1h;
    }
    return { cacheWrite5mTokens: merged5m, cacheWrite1hTokens: merged1h };
}
function mergeRequest(input, existing) {
    // Telemetry displaces transcript as the source. A repeat
    // from the SAME source takes the newer entry's values: one
    // response is written as several entries sharing a request
    // id, and the counts in the earlier ones are mid-stream, so
    // filling gaps would keep the request short. The start
    // stays the earliest the source reported.
    const sameSource = existing.token_source === input.tokenSource;
    const incomingWins = sameSource ||
        (input.tokenSource === "telemetry" &&
            existing.token_source !== "telemetry");
    const cachePair = mergeCachePair(input, existing, incomingWins);
    return {
        turnId: pick(incomingWins, input.turnId, numberValue(existing.turn_id)),
        branchId: pick(incomingWins, input.branchId, numberValue(existing.branch_id)),
        model: pick(incomingWins, input.model, asText(existing.model)),
        querySource: pick(incomingWins, input.querySource, asText(existing.query_source)),
        inputTokens: pick(incomingWins, input.inputTokens, numberValue(existing.input_tokens)),
        outputTokens: pick(incomingWins, input.outputTokens, numberValue(existing.output_tokens)),
        cacheReadTokens: pick(incomingWins, input.cacheReadTokens, numberValue(existing.cache_read_tokens)),
        cacheWrite5mTokens: cachePair.cacheWrite5mTokens,
        cacheWrite1hTokens: cachePair.cacheWrite1hTokens,
        tokenSource: incomingWins && !sameSource ? "telemetry" : asText(existing.token_source),
        startedAt: mergeStartedAt(sameSource, incomingWins, input, numberValue(existing.started_at)),
        durationMs: pick(incomingWins, input.durationMs, numberValue(existing.duration_ms)),
        // Effort fills an empty column and is never overwritten by
        // an upsert: the transcript's request entry is the primary
        // source and sets the column directly, so an upsert from
        // either source must not displace a value already recorded.
        effort: asText(existing.effort) ?? input.effort ?? null,
    };
}
function upsertRequest(st, input) {
    if (input.requestId === null) {
        return insertRequestRow(st, input);
    }
    const existing = st.getRequest.get(input.sessionId, input.requestId);
    if (existing === undefined) {
        return insertRequestRow(st, input);
    }
    const id = existing.id;
    const merged = mergeRequest(input, existing);
    st.updateRequest.run(merged.turnId, merged.branchId, merged.model, merged.querySource, merged.inputTokens, merged.outputTokens, merged.cacheReadTokens, merged.cacheWrite5mTokens, merged.cacheWrite1hTokens, merged.tokenSource, merged.startedAt, merged.durationMs, merged.effort, id);
    return id;
}
function insertContextSample(st, input) {
    if (input.requestRowId !== null) {
        const existing = st.getSampleByRequest.get(input.requestRowId, input.source);
        if (existing !== undefined) {
            // One sample per request per source; a repeat from the
            // same source carries the newer count (see the upsert),
            // so the sample moves with it.
            if (existing.context_tokens !== input.contextTokens) {
                st.updateSample.run(input.sampledAt, input.contextTokens, existing.id);
            }
            return;
        }
    }
    else {
        const dupe = st.getSampleByValue.get(input.sessionId, input.sampledAt, input.contextTokens, input.source);
        if (dupe !== undefined)
            return;
    }
    st.insertSample.run(input.sessionId, input.requestRowId, input.sampledAt, input.contextTokens, input.source);
}
function ensureTranscriptTurn(st, sessionId, promptId, at, promptText) {
    const columns = promptTextColumns(promptText);
    if (promptId !== null) {
        const existing = st.getTurnByPrompt.get(sessionId, promptId);
        if (existing !== undefined) {
            if (promptText !== null) {
                fillTurnPromptText(st, existing.id, promptText);
            }
            return existing.id;
        }
    }
    const open = st.getOpenTurn.get(sessionId);
    if (open !== undefined)
        st.endTurn.run(at, open.id);
    const sequence = st.nextSequence.get(sessionId).n;
    // A turn can be created here while the daemon's
    // conclusion stands — a late transcript read, a telemetry
    // prompt — and neither source revives it; only a hook
    // event does. It goes in already closed, at its own start
    // and marked concluded, so an ended session never holds an
    // open turn and a later revival reopens this one with the
    // rest.
    const session = st.getSessionState.get(sessionId);
    const concluded = session !== undefined &&
        session.status === "ended" &&
        session.end_seen === 0;
    const result = st.insertTurn.run(sessionId, promptId, sequence, at, concluded ? at : null, concluded ? "concluded" : null, columns.text, columns.chars, columns.lines);
    return Number(result.lastInsertRowid);
}
function noteTranscriptSeen(st, sessionId, version, at) {
    st.insertConditions.run(sessionId, at);
    const row = st.getConditions.get(sessionId);
    const sources = parseStringArray(row.sources_seen);
    if (!sources.includes("transcript"))
        sources.push("transcript");
    const versionValue = typeof row.claude_code_version === "string"
        ? row.claude_code_version
        : (version ?? null);
    st.updateConditions.run(JSON.stringify(sources), versionValue, at, sessionId);
}
