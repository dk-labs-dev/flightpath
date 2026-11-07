// The telemetry store: every SQL write the telemetry intake
// makes, apart from the shared requests upsert. Kept apart from
// the intake so each file stays one job (ADR-0012, ADR-0017).
import { prepareConditionsStatements, } from "../storage/conditions.js";
import { parseStringArray } from "../util/json.js";
function prepareSessionStatements(db) {
    return {
        ...prepareConditionsStatements(db),
        getSession: db.prepare("SELECT project_path FROM sessions WHERE id = ?"),
        updateSources: db.prepare("UPDATE session_conditions SET sources_seen = ?, updated_at = ? WHERE session_id = ?"),
        updateHookStats: db.prepare("UPDATE session_conditions SET hook_stats = ?, updated_at = ? WHERE session_id = ?"),
    };
}
function prepareEventStatements(db) {
    return {
        getStepByToolUse: db.prepare("SELECT * FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1"),
        getDecisionEvent: db.prepare("SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_decision' LIMIT 1"),
        getRequestEvent: db.prepare("SELECT id, turn_id FROM human_events WHERE step_id = ? AND kind = 'permission_request' LIMIT 1"),
        updateDecision: db.prepare("UPDATE human_events SET decision = ?, decision_source = ?, occurred_at = ? WHERE id = ?"),
        insertHumanEvent: db.prepare("INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
        getPromptEvent: db.prepare("SELECT id FROM human_events WHERE turn_id = ? AND kind = 'prompt' LIMIT 1"),
        closeStep: db.prepare("UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', ended_at = ?, duration_ms = ? WHERE id = ?"),
        correctStep: db.prepare("UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', duration_ms = COALESCE(?, duration_ms) WHERE id = ?"),
        // Branches of one type overlapping a moment: the window's end
        // carries a small grace, because the completion event and the
        // hook that ended the branch are stamped by different clocks.
        getBranchesByType: db.prepare("SELECT id FROM branches WHERE session_id = ? AND agent_type = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)"),
        // An end telemetry reports replaces a concluded one and
        // clears its mark, like the transcript's closings; a real
        // end already recorded stands.
        updateBranch: db.prepare("UPDATE branches SET total_tokens = COALESCE(?, total_tokens), token_source = 'telemetry', ended_at = CASE WHEN end_source = 'concluded' THEN ? ELSE COALESCE(ended_at, ?) END, end_source = CASE WHEN end_source = 'concluded' THEN NULL ELSE end_source END WHERE id = ?"),
        recentSkillLoad: db.prepare("SELECT id FROM loads WHERE session_id = ? AND kind = 'skill' AND name = ? AND ABS(occurred_at - ?) <= 5000 LIMIT 1"),
        insertLoad: db.prepare("INSERT INTO loads (session_id, kind, name, trigger, memory_type, file_path, occurred_at, source) VALUES (?, 'skill', ?, NULL, NULL, NULL, ?, 'telemetry')"),
        getNearbyCompact: db.prepare("SELECT id, context_tokens FROM segments WHERE session_id = ? AND kind = 'compact' AND ABS(started_at - ?) <= 10000 ORDER BY ABS(started_at - ?) LIMIT 1"),
        setSegmentTokens: db.prepare("UPDATE segments SET context_tokens = ? WHERE id = ? AND context_tokens IS NULL"),
        insertSegment: db.prepare("INSERT INTO segments (session_id, kind, started_at, context_tokens, prompt_cache_likely_expired) VALUES (?, 'compact', ?, ?, NULL)"),
    };
}
function prepareStatements(db) {
    return {
        ...prepareSessionStatements(db),
        ...prepareEventStatements(db),
    };
}
export function createTelemetryStore(db) {
    const statements = prepareStatements(db);
    return {
        noteTelemetrySeen: (sessionId, at) => noteTelemetrySeen(statements, sessionId, at),
        sessionProjectPath: (sessionId) => sessionProjectPath(statements, sessionId),
        correctPermissionDecision: (input) => correctPermissionDecision(statements, input),
        correctStepOutcome: (input) => correctStepOutcome(statements, input),
        setBranchTotals: (input) => setBranchTotals(statements, input),
        branchIdByAgentType: (sessionId, agentType, at) => uniqueBranchByType(statements, sessionId, agentType, at),
        addSkillLoad: (input) => addSkillLoad(statements, input),
        recordPromptEvent: (input) => recordPromptEvent(statements, input),
        recordCompaction: (input) => recordCompaction(statements, input),
        addHookExecution: (input) => addHookExecution(statements, input),
    };
}
function conditionRow(statements, sessionId, at) {
    statements.insertConditions.run(sessionId, at);
    return statements.getConditions.get(sessionId);
}
function noteTelemetrySeen(statements, sessionId, at) {
    const row = conditionRow(statements, sessionId, at);
    const sources = parseStringArray(row.sources_seen);
    if (!sources.includes("telemetry"))
        sources.push("telemetry");
    statements.updateSources.run(JSON.stringify(sources), at, sessionId);
}
function sessionProjectPath(statements, sessionId) {
    const row = statements.getSession.get(sessionId);
    if (row === undefined)
        return undefined;
    return typeof row.project_path === "string" ? row.project_path : null;
}
function correctPermissionDecision(statements, input) {
    const step = statements.getStepByToolUse.get(input.sessionId, input.toolUseId);
    if (step === undefined)
        return false;
    const stepId = step.id;
    const existing = statements.getDecisionEvent.get(stepId);
    if (existing !== undefined) {
        statements.updateDecision.run(input.decision, input.source, input.at, existing.id);
        return true;
    }
    const request = statements.getRequestEvent.get(stepId);
    if (request === undefined)
        return false;
    statements.insertHumanEvent.run(input.sessionId, request.turn_id ?? (typeof step.turn_id === "number" ? step.turn_id : null), stepId, "permission_decision", input.at, input.decision, input.source, null);
    return true;
}
function correctStepOutcome(statements, input) {
    const step = statements.getStepByToolUse.get(input.sessionId, input.toolUseId);
    if (step === undefined)
        return false;
    if (step.outcome === "open") {
        const started = typeof step.started_at === "number" ? step.started_at : null;
        statements.closeStep.run(input.at, input.durationMs ?? (started !== null ? input.at - started : null), step.id);
        return true;
    }
    if (step.outcome_source === "inferred" ||
        step.outcome_source === "concluded") {
        statements.correctStep.run(input.durationMs, step.id);
        return true;
    }
    return false;
}
function uniqueBranchByType(statements, sessionId, agentType, at) {
    const rows = statements.getBranchesByType.all(sessionId, agentType, at, at - 5000);
    if (rows.length !== 1)
        return null;
    const row = rows[0];
    return row === undefined ? null : row.id;
}
function setBranchTotals(statements, input) {
    const branchId = uniqueBranchByType(statements, input.sessionId, input.agentType, input.at);
    if (branchId === null)
        return false;
    statements.updateBranch.run(input.totalTokens, input.at, input.at, branchId);
    return true;
}
function addSkillLoad(statements, input) {
    if (statements.recentSkillLoad.get(input.sessionId, input.name, input.at) !==
        undefined) {
        return;
    }
    statements.insertLoad.run(input.sessionId, input.name, input.at);
}
function recordPromptEvent(statements, input) {
    if (statements.getPromptEvent.get(input.turnId) !== undefined)
        return;
    statements.insertHumanEvent.run(input.sessionId, input.turnId, null, "prompt", input.at, null, null, input.promptLength !== null
        ? JSON.stringify({ prompt_length: input.promptLength })
        : null);
}
function recordCompaction(statements, input) {
    const nearby = statements.getNearbyCompact.get(input.sessionId, input.at, input.at);
    if (nearby !== undefined) {
        if (input.postTokens !== null) {
            statements.setSegmentTokens.run(input.postTokens, nearby.id);
        }
        return;
    }
    statements.insertSegment.run(input.sessionId, input.at, input.postTokens);
}
function addHookExecution(statements, input) {
    const row = conditionRow(statements, input.sessionId, input.at);
    const stats = readHookStats(row.hook_stats);
    stats.executions += 1;
    if (input.durationMs !== null) {
        stats.total_ms += input.durationMs;
        stats.max_ms = Math.max(stats.max_ms, input.durationMs);
    }
    const entry = stats.by_hook[input.name] ?? {
        count: 0,
        total_ms: 0,
        max_ms: 0,
        num_hooks: 0,
    };
    entry.count += 1;
    if (input.durationMs !== null) {
        entry.total_ms += input.durationMs;
        entry.max_ms = Math.max(entry.max_ms, input.durationMs);
    }
    if (input.numHooks !== null)
        entry.num_hooks = input.numHooks;
    stats.by_hook[input.name] = entry;
    statements.updateHookStats.run(JSON.stringify(stats), input.at, input.sessionId);
}
function readHookStats(raw) {
    const empty = {
        executions: 0,
        total_ms: 0,
        max_ms: 0,
        by_hook: {},
    };
    if (typeof raw !== "string")
        return empty;
    try {
        const parsed = JSON.parse(raw);
        return {
            executions: parsed.executions ?? 0,
            total_ms: parsed.total_ms ?? 0,
            max_ms: parsed.max_ms ?? 0,
            by_hook: parsed.by_hook ?? {},
        };
    }
    catch {
        // A damaged stats value restarts from this execution.
        return empty;
    }
}
