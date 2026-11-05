// The telemetry store: every SQL write the telemetry intake
// makes, apart from the shared requests upsert. Kept apart from
// the intake so each file stays one job (ADR-0012, ADR-0017).

import {
  prepareConditionsStatements,
  type ConditionsStatements,
} from "../storage/conditions.js";
import type { DatabaseSync } from "../storage/sqlite.js";
import { parseStringArray } from "../util/json.js";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

export interface TelemetryStore {
  /** Record telemetry among the session's capture sources. */
  noteTelemetrySeen(sessionId: string, at: number): void;
  /** The session's project path: undefined when no row exists. */
  sessionProjectPath(sessionId: string): string | null | undefined;
  /**
   * Set the real decision on the permission event belonging to
   * a step, replacing an inferred one or adding the decision
   * event next to its request. Returns true when an event was
   * written.
   */
  correctPermissionDecision(input: {
    sessionId: string;
    toolUseId: string;
    decision: string;
    source: string;
    at: number;
  }): boolean;
  /**
   * A failed tool result from telemetry: closes an open step as
   * failed, or corrects a step the hooks closed by inference.
   * A step the hooks closed themselves stands. Returns true
   * when a step changed.
   */
  correctStepOutcome(input: {
    sessionId: string;
    toolUseId: string;
    at: number;
    durationMs: number | null;
  }): boolean;
  /** Totals from a subagent completion, on the matching branch. */
  setBranchTotals(input: {
    sessionId: string;
    agentType: string;
    totalTokens: number | null;
    at: number;
  }): boolean;
  /**
   * The branch an event belongs to, by agent type — only when
   * exactly one branch of that type overlaps the event's time.
   * Two parallel subagents of one type are left for the
   * subagent transcript, which carries the request ids.
   */
  branchIdByAgentType(
    sessionId: string,
    agentType: string,
    at: number,
  ): number | null;
  /** A skill activation, unless the hooks already recorded it. */
  addSkillLoad(input: { sessionId: string; name: string; at: number }): void;
  /** The human prompt event for a turn, once. */
  recordPromptEvent(input: {
    sessionId: string;
    turnId: number;
    at: number;
    promptLength: number | null;
  }): void;
  /**
   * A compaction: attach the post-compact size to the segment
   * the hooks opened for it when one is nearby, and open one
   * only when none is — a compaction gets one segment, in
   * either arrival order.
   */
  recordCompaction(input: {
    sessionId: string;
    at: number;
    postTokens: number | null;
  }): void;
  /** One hook execution, folded into the session's hook stats. */
  addHookExecution(input: {
    sessionId: string;
    name: string;
    durationMs: number | null;
    numHooks: number | null;
    at: number;
  }): void;
}

type Row = Record<string, unknown>;

interface HookStats {
  executions: number;
  total_ms: number;
  max_ms: number;
  by_hook: Record<
    string,
    { count: number; total_ms: number; max_ms: number; num_hooks: number }
  >;
}

interface SessionStatements extends ConditionsStatements {
  getSession: StatementSync;
  updateSources: StatementSync;
  updateHookStats: StatementSync;
}

interface EventStatements {
  getStepByToolUse: StatementSync;
  getDecisionEvent: StatementSync;
  getRequestEvent: StatementSync;
  updateDecision: StatementSync;
  insertHumanEvent: StatementSync;
  getPromptEvent: StatementSync;
  closeStep: StatementSync;
  correctStep: StatementSync;
  getBranchesByType: StatementSync;
  updateBranch: StatementSync;
  recentSkillLoad: StatementSync;
  insertLoad: StatementSync;
  getNearbyCompact: StatementSync;
  setSegmentTokens: StatementSync;
  insertSegment: StatementSync;
}

// Each prepare function returns exactly its own group, so the
// spread below needs no cast and a statement missing from every
// group is a compile error rather than a runtime surprise.
type TelemetryStatements = SessionStatements & EventStatements;

function prepareSessionStatements(db: DatabaseSync): SessionStatements {
  return {
    ...prepareConditionsStatements(db),
    getSession: db.prepare("SELECT project_path FROM sessions WHERE id = ?"),
    updateSources: db.prepare(
      "UPDATE session_conditions SET sources_seen = ?, updated_at = ? WHERE session_id = ?",
    ),
    updateHookStats: db.prepare(
      "UPDATE session_conditions SET hook_stats = ?, updated_at = ? WHERE session_id = ?",
    ),
  };
}

function prepareEventStatements(db: DatabaseSync): EventStatements {
  return {
    getStepByToolUse: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1",
    ),
    getDecisionEvent: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_decision' LIMIT 1",
    ),
    getRequestEvent: db.prepare(
      "SELECT id, turn_id FROM human_events WHERE step_id = ? AND kind = 'permission_request' LIMIT 1",
    ),
    updateDecision: db.prepare(
      "UPDATE human_events SET decision = ?, decision_source = ?, occurred_at = ? WHERE id = ?",
    ),
    insertHumanEvent: db.prepare(
      "INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    getPromptEvent: db.prepare(
      "SELECT id FROM human_events WHERE turn_id = ? AND kind = 'prompt' LIMIT 1",
    ),
    closeStep: db.prepare(
      "UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', ended_at = ?, duration_ms = ? WHERE id = ?",
    ),
    correctStep: db.prepare(
      "UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', duration_ms = COALESCE(?, duration_ms) WHERE id = ?",
    ),
    // Branches of one type overlapping a moment: the window's end
    // carries a small grace, because the completion event and the
    // hook that ended the branch are stamped by different clocks.
    getBranchesByType: db.prepare(
      "SELECT id FROM branches WHERE session_id = ? AND agent_type = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)",
    ),
    // An end telemetry reports replaces a concluded one and
    // clears its mark, like the transcript's closings; a real
    // end already recorded stands.
    updateBranch: db.prepare(
      "UPDATE branches SET total_tokens = COALESCE(?, total_tokens), token_source = 'telemetry', ended_at = CASE WHEN end_source = 'concluded' THEN ? ELSE COALESCE(ended_at, ?) END, end_source = CASE WHEN end_source = 'concluded' THEN NULL ELSE end_source END WHERE id = ?",
    ),
    recentSkillLoad: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND kind = 'skill' AND name = ? AND ABS(occurred_at - ?) <= 5000 LIMIT 1",
    ),
    insertLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, trigger, memory_type, file_path, occurred_at, source) VALUES (?, 'skill', ?, NULL, NULL, NULL, ?, 'telemetry')",
    ),
    getNearbyCompact: db.prepare(
      "SELECT id, context_tokens FROM segments WHERE session_id = ? AND kind = 'compact' AND ABS(started_at - ?) <= 10000 ORDER BY ABS(started_at - ?) LIMIT 1",
    ),
    setSegmentTokens: db.prepare(
      "UPDATE segments SET context_tokens = ? WHERE id = ? AND context_tokens IS NULL",
    ),
    insertSegment: db.prepare(
      "INSERT INTO segments (session_id, kind, started_at, context_tokens, prompt_cache_likely_expired) VALUES (?, 'compact', ?, ?, NULL)",
    ),
  };
}

function prepareStatements(db: DatabaseSync): TelemetryStatements {
  return {
    ...prepareSessionStatements(db),
    ...prepareEventStatements(db),
  };
}

export function createTelemetryStore(db: DatabaseSync): TelemetryStore {
  const statements = prepareStatements(db);
  return {
    noteTelemetrySeen: (sessionId, at) =>
      noteTelemetrySeen(statements, sessionId, at),
    sessionProjectPath: (sessionId) =>
      sessionProjectPath(statements, sessionId),
    correctPermissionDecision: (input) =>
      correctPermissionDecision(statements, input),
    correctStepOutcome: (input) => correctStepOutcome(statements, input),
    setBranchTotals: (input) => setBranchTotals(statements, input),
    branchIdByAgentType: (sessionId, agentType, at) =>
      uniqueBranchByType(statements, sessionId, agentType, at),
    addSkillLoad: (input) => addSkillLoad(statements, input),
    recordPromptEvent: (input) => recordPromptEvent(statements, input),
    recordCompaction: (input) => recordCompaction(statements, input),
    addHookExecution: (input) => addHookExecution(statements, input),
  };
}

function conditionRow(
  statements: TelemetryStatements,
  sessionId: string,
  at: number,
): Row {
  statements.insertConditions.run(sessionId, at);
  return statements.getConditions.get(sessionId) as Row;
}

function noteTelemetrySeen(
  statements: TelemetryStatements,
  sessionId: string,
  at: number,
): void {
  const row = conditionRow(statements, sessionId, at);
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("telemetry")) sources.push("telemetry");
  statements.updateSources.run(JSON.stringify(sources), at, sessionId);
}

function sessionProjectPath(
  statements: TelemetryStatements,
  sessionId: string,
): string | null | undefined {
  const row = statements.getSession.get(sessionId) as Row | undefined;
  if (row === undefined) return undefined;
  return typeof row.project_path === "string" ? row.project_path : null;
}

function correctPermissionDecision(
  statements: TelemetryStatements,
  input: {
    sessionId: string;
    toolUseId: string;
    decision: string;
    source: string;
    at: number;
  },
): boolean {
  const step = statements.getStepByToolUse.get(
    input.sessionId,
    input.toolUseId,
  ) as Row | undefined;
  if (step === undefined) return false;
  const stepId = step.id as number;
  const existing = statements.getDecisionEvent.get(stepId) as
    { id: number } | undefined;
  if (existing !== undefined) {
    statements.updateDecision.run(
      input.decision,
      input.source,
      input.at,
      existing.id,
    );
    return true;
  }
  const request = statements.getRequestEvent.get(stepId) as
    { id: number; turn_id: number | null } | undefined;
  if (request === undefined) return false;
  statements.insertHumanEvent.run(
    input.sessionId,
    request.turn_id ?? (typeof step.turn_id === "number" ? step.turn_id : null),
    stepId,
    "permission_decision",
    input.at,
    input.decision,
    input.source,
    null,
  );
  return true;
}

function correctStepOutcome(
  statements: TelemetryStatements,
  input: {
    sessionId: string;
    toolUseId: string;
    at: number;
    durationMs: number | null;
  },
): boolean {
  const step = statements.getStepByToolUse.get(
    input.sessionId,
    input.toolUseId,
  ) as Row | undefined;
  if (step === undefined) return false;
  if (step.outcome === "open") {
    const started =
      typeof step.started_at === "number" ? step.started_at : null;
    statements.closeStep.run(
      input.at,
      input.durationMs ?? (started !== null ? input.at - started : null),
      step.id as number,
    );
    return true;
  }
  if (
    step.outcome_source === "inferred" ||
    step.outcome_source === "concluded"
  ) {
    statements.correctStep.run(input.durationMs, step.id as number);
    return true;
  }
  return false;
}

function uniqueBranchByType(
  statements: TelemetryStatements,
  sessionId: string,
  agentType: string,
  at: number,
): number | null {
  const rows = statements.getBranchesByType.all(
    sessionId,
    agentType,
    at,
    at - 5000,
  ) as Row[];
  if (rows.length !== 1) return null;
  const row = rows[0];
  return row === undefined ? null : (row.id as number);
}

function setBranchTotals(
  statements: TelemetryStatements,
  input: {
    sessionId: string;
    agentType: string;
    totalTokens: number | null;
    at: number;
  },
): boolean {
  const branchId = uniqueBranchByType(
    statements,
    input.sessionId,
    input.agentType,
    input.at,
  );
  if (branchId === null) return false;
  statements.updateBranch.run(input.totalTokens, input.at, input.at, branchId);
  return true;
}

function addSkillLoad(
  statements: TelemetryStatements,
  input: { sessionId: string; name: string; at: number },
): void {
  if (
    statements.recentSkillLoad.get(input.sessionId, input.name, input.at) !==
    undefined
  ) {
    return;
  }
  statements.insertLoad.run(input.sessionId, input.name, input.at);
}

function recordPromptEvent(
  statements: TelemetryStatements,
  input: {
    sessionId: string;
    turnId: number;
    at: number;
    promptLength: number | null;
  },
): void {
  if (statements.getPromptEvent.get(input.turnId) !== undefined) return;
  statements.insertHumanEvent.run(
    input.sessionId,
    input.turnId,
    null,
    "prompt",
    input.at,
    null,
    null,
    input.promptLength !== null
      ? JSON.stringify({ prompt_length: input.promptLength })
      : null,
  );
}

function recordCompaction(
  statements: TelemetryStatements,
  input: { sessionId: string; at: number; postTokens: number | null },
): void {
  const nearby = statements.getNearbyCompact.get(
    input.sessionId,
    input.at,
    input.at,
  ) as Row | undefined;
  if (nearby !== undefined) {
    if (input.postTokens !== null) {
      statements.setSegmentTokens.run(input.postTokens, nearby.id as number);
    }
    return;
  }
  statements.insertSegment.run(input.sessionId, input.at, input.postTokens);
}

function addHookExecution(
  statements: TelemetryStatements,
  input: {
    sessionId: string;
    name: string;
    durationMs: number | null;
    numHooks: number | null;
    at: number;
  },
): void {
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
  if (input.numHooks !== null) entry.num_hooks = input.numHooks;
  stats.by_hook[input.name] = entry;
  statements.updateHookStats.run(
    JSON.stringify(stats),
    input.at,
    input.sessionId,
  );
}

function readHookStats(raw: unknown): HookStats {
  const empty: HookStats = {
    executions: 0,
    total_ms: 0,
    max_ms: 0,
    by_hook: {},
  };
  if (typeof raw !== "string") return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<HookStats>;
    return {
      executions: parsed.executions ?? 0,
      total_ms: parsed.total_ms ?? 0,
      max_ms: parsed.max_ms ?? 0,
      by_hook: parsed.by_hook ?? {},
    };
  } catch {
    // A damaged stats value restarts from this execution.
    return empty;
  }
}
