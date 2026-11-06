// The journey builder: folds each stored hook event into the
// journey tables (sessions, segments, turns, steps, branches,
// human events, loads, conditions), working only from the stored
// (already redacted) event and its received_at.
//
// The rules below come from the hook payloads themselves:
// events for one prompt share a prompt_id; a step can end with
// no closing event (an interrupt, a rejection); subagent events
// carry an agent_id but no parent id, so branches link by
// agent_type and order; and an internal helper appears as a
// SubagentStop with no SubagentStart.

import { isFlightpathCommand } from "../commands.js";
import { effortLevel } from "../effort.js";
import { isAgentMessage } from "../prompt-kind.js";
import {
  readSettingsFiles,
  userAndProjectSettingsFiles,
} from "../settings-files.js";
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
  preparePromptTextStatements,
  promptTextColumns,
  setTurnPromptColumns,
  type PromptTextColumns,
  type PromptTextStatements,
} from "../storage/prompt-text.js";
import type { LiveSessionHost } from "../storage/read.js";
import {
  prepareSkillLoadStatements,
  triggerTranscriptSkillLoad,
  type SkillLoadStatements,
} from "../storage/skill-load.js";
import type { DatabaseSync } from "../storage/sqlite.js";
import { sameProcessStart } from "../util/host-process.js";
import {
  asText,
  isPlainObject,
  num,
  obj,
  parseStringArray,
  str,
} from "../util/json.js";

type Row = Record<string, unknown>;
type StatementSync = ReturnType<DatabaseSync["prepare"]>;

/**
 * The hook effort fill, named so the query-plan test runs the
 * statement the builder actually prepares: it reaches the
 * turn's requests on the requests (turn_id) index.
 */
export const FILL_REQUEST_EFFORT_SQL =
  "UPDATE requests SET effort = ? WHERE session_id = ? AND turn_id = ? AND effort IS NULL";

/** Total text size of a redacted tool response, in characters. */
function responseSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + responseSize(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Row);
    const first = entries[0];
    if (
      entries.length === 1 &&
      first !== undefined &&
      first[0] === "chars" &&
      typeof first[1] === "number"
    ) {
      return first[1];
    }
    return entries.reduce<number>(
      (sum, [, item]) => sum + responseSize(item),
      0,
    );
  }
  return 0;
}

/**
 * Plugin names from the enabledPlugins maps of the user and
 * project settings files. Names only — the part before the
 * marketplace marker — and nothing else in those files is read
 * into the journey.
 */
function readEnabledPlugins(cwd: string): string[] {
  const names = new Set<string>();
  const { settings } = readSettingsFiles(userAndProjectSettingsFiles(cwd));
  for (const file of settings) {
    const plugins = obj(file, "enabledPlugins");
    if (plugins === undefined) continue;
    for (const [key, enabled] of Object.entries(plugins)) {
      if (!enabled) continue;
      const name = key.split("@")[0];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

export interface JourneyBuilder {
  applyHookEvent(event: Row, receivedAt: number): void;
  recordPause(sessionId: string, at: number): void;
  recordResume(sessionId: string, at: number): void;
  /**
   * End a session the daemon concluded is over, at its last
   * event's time: its open turns, steps and branches close
   * there, and the end is marked unseen — no end event arrived.
   */
  endSessionUnseen(sessionId: string, at: number): void;
  /**
   * The watch's end: like endSessionUnseen, but it lands only
   * when the stored row is still the row the watch read — an
   * event arriving while the watch read process times moves
   * the row, and then nothing is ended and false says so.
   */
  endSessionUnseenIfUnchanged(session: LiveSessionHost): boolean;
}

interface SessionStatements extends ConditionsStatements, PromptTextStatements {
  getSession: StatementSync;
  insertSession: StatementSync;
  clearJoinedPartway: StatementSync;
  touchSession: StatementSync;
  setProjectPath: StatementSync;
  setModel: StatementSync;
  saveConditions: StatementSync;
  getTurnByPrompt: StatementSync;
  getOpenTurn: StatementSync;
  nextSequence: StatementSync;
  insertTurn: StatementSync;
  getTurnById: StatementSync;
  endTurn: StatementSync;
  endTurnConcluded: StatementSync;
  reopenConcludedTurns: StatementSync;
  getOpenTurns: StatementSync;
}

interface BranchStatements {
  getBranch: StatementSync;
  insertBranch: StatementSync;
  endBranch: StatementSync;
  branchBySpawningStep: StatementSync;
  setBranchStartedAt: StatementSync;
  setBranchType: StatementSync;
  spawningTurnByBranch: StatementSync;
}

interface StepStatements
  extends BranchLinkStatements, BranchStatements, SkillLoadStatements {
  getStepByToolUse: StatementSync;
  insertStep: StatementSync;
  fillTranscriptStep: StatementSync;
  closeStep: StatementSync;
  reopenConcludedSteps: StatementSync;
  openSteps: StatementSync;
  insertHumanEvent: StatementSync;
  insertLoad: StatementSync;
  fillRequestEffort: StatementSync;
  askedAboutStep: StatementSync;
  decisionForStep: StatementSync;
  linkCandidates: StatementSync;
  setStepResultSize: StatementSync;
  getPromptEventByTurn: StatementSync;
}

interface SegmentStatements {
  getNearbyCompactSegment: StatementSync;
  insertSegment: StatementSync;
  endAllBranches: StatementSync;
  endAllBranchesConcluded: StatementSync;
  reopenConcludedBranches: StatementSync;
  endSession: StatementSync;
  endSessionUnseen: StatementSync;
  endSessionUnseenIfUnchanged: StatementSync;
  reviveSession: StatementSync;
  setHostProcess: StatementSync;
  sessionsOnHost: StatementSync;
  insertPause: StatementSync;
  pauseSession: StatementSync;
  resumePauses: StatementSync;
  unpauseSession: StatementSync;
}

// Each prepare function returns exactly its own group, so the
// spread below needs no cast and a statement missing from every
// group is a compile error rather than a runtime surprise.
type JourneyStatements = SessionStatements & StepStatements & SegmentStatements;

function prepareSessionStatements(db: DatabaseSync): SessionStatements {
  return {
    ...prepareConditionsStatements(db),
    ...preparePromptTextStatements(db),
    getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    insertSession: db.prepare(
      "INSERT OR IGNORE INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, 'live', ?, ?, ?)",
    ),
    clearJoinedPartway: db.prepare(
      "UPDATE sessions SET joined_partway = 0 WHERE id = ?",
    ),
    touchSession: db.prepare(
      "UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?",
    ),
    setProjectPath: db.prepare(
      "UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL",
    ),
    setModel: db.prepare(
      "UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL",
    ),
    saveConditions: db.prepare(
      "UPDATE session_conditions SET permission_modes = ?, instruction_files = ?, enabled_plugins = ?, claude_code_version = ?, sources_seen = ?, updated_at = ? WHERE session_id = ?",
    ),
    getTurnByPrompt: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND prompt_id = ?",
    ),
    getOpenTurn: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY sequence DESC LIMIT 1",
    ),
    nextSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE session_id = ?",
    ),
    insertTurn: db.prepare(
      "INSERT INTO turns (session_id, prompt_id, sequence, started_at, prompt_text, prompt_chars, prompt_lines, flightpath_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    getTurnById: db.prepare("SELECT * FROM turns WHERE id = ?"),
    endTurn: db.prepare(
      "UPDATE turns SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
    ),
    endTurnConcluded: db.prepare(
      "UPDATE turns SET ended_at = ?, end_source = 'concluded' WHERE id = ? AND ended_at IS NULL",
    ),
    reopenConcludedTurns: db.prepare(
      "UPDATE turns SET ended_at = NULL, end_source = NULL WHERE session_id = ? AND end_source = 'concluded'",
    ),
    getOpenTurns: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NULL",
    ),
  };
}

function prepareBranchStatements(db: DatabaseSync): BranchStatements {
  return {
    getBranch: db.prepare(
      "SELECT * FROM branches WHERE session_id = ? AND agent_id = ?",
    ),
    insertBranch: db.prepare(
      "INSERT INTO branches (session_id, agent_id, spawning_step_id, agent_type, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    endBranch: db.prepare(
      "UPDATE branches SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
    ),
    branchBySpawningStep: db.prepare(
      "SELECT id FROM branches WHERE spawning_step_id = ?",
    ),
    setBranchStartedAt: db.prepare(
      "UPDATE branches SET started_at = ? WHERE id = ?",
    ),
    setBranchType: db.prepare(
      "UPDATE branches SET agent_type = ?, kind = ? WHERE id = ?",
    ),
    spawningTurnByBranch: db.prepare(
      "SELECT steps.turn_id AS turn_id FROM branches JOIN steps ON steps.id = branches.spawning_step_id WHERE branches.id = ?",
    ),
  };
}

function prepareStepStatements(db: DatabaseSync): StepStatements {
  return {
    ...prepareBranchLinkStatements(db),
    ...prepareSkillLoadStatements(db),
    ...prepareBranchStatements(db),
    getStepByToolUse: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1",
    ),
    insertStep: db.prepare(
      "INSERT INTO steps (session_id, turn_id, branch_id, tool_use_id, tool_name, input_summary, outcome, outcome_source, started_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 'hook', ?)",
    ),
    // A step the transcript built for a call whose hook record
    // had not landed yet: when the record lands, the row
    // stands as the transcript left it — closed, with its
    // outcome, end and sizes — and the record only fills what
    // the transcript could not know (a turn, a branch, an
    // input summary, a start time it left null). It never
    // reopens the step or clears a settled fact.
    fillTranscriptStep: db.prepare(
      "UPDATE steps SET turn_id = COALESCE(turn_id, ?), branch_id = COALESCE(branch_id, ?), input_summary = COALESCE(input_summary, ?), started_at = COALESCE(started_at, ?) WHERE session_id = ? AND tool_use_id = ? AND outcome_source = 'transcript' AND outcome IN ('succeeded', 'failed')",
    ),
    closeStep: db.prepare(
      "UPDATE steps SET outcome = ?, outcome_source = ?, ended_at = ?, duration_ms = ? WHERE id = ?",
    ),
    reopenConcludedSteps: db.prepare(
      "UPDATE steps SET outcome = 'open', outcome_source = NULL, ended_at = NULL, duration_ms = NULL WHERE session_id = ? AND outcome_source = 'concluded'",
    ),
    openSteps: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND outcome = 'open'",
    ),
    insertHumanEvent: db.prepare(
      "INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, trigger, memory_type, file_path, occurred_at, source, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 'hook', ?)",
    ),
    fillRequestEffort: db.prepare(FILL_REQUEST_EFFORT_SQL),
    askedAboutStep: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_request' LIMIT 1",
    ),
    decisionForStep: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_decision' LIMIT 1",
    ),
    linkCandidates: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_name IN ('Agent', 'Task') AND started_at >= ? AND started_at <= ? ORDER BY started_at, id",
    ),
    setStepResultSize: db.prepare(
      "UPDATE steps SET result_size = ? WHERE id = ?",
    ),
    getPromptEventByTurn: db.prepare(
      "SELECT id FROM human_events WHERE turn_id = ? AND kind = 'prompt' LIMIT 1",
    ),
  };
}

function prepareSegmentStatements(db: DatabaseSync): SegmentStatements {
  return {
    getNearbyCompactSegment: db.prepare(
      "SELECT id FROM segments WHERE session_id = ? AND kind = 'compact' AND ABS(started_at - ?) <= 10000 LIMIT 1",
    ),
    insertSegment: db.prepare(
      "INSERT INTO segments (session_id, kind, started_at, context_tokens, prompt_cache_likely_expired) VALUES (?, ?, ?, ?, ?)",
    ),
    endAllBranches: db.prepare(
      "UPDATE branches SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
    ),
    endAllBranchesConcluded: db.prepare(
      "UPDATE branches SET ended_at = ?, end_source = 'concluded' WHERE session_id = ? AND ended_at IS NULL",
    ),
    reopenConcludedBranches: db.prepare(
      "UPDATE branches SET ended_at = NULL, end_source = NULL WHERE session_id = ? AND end_source = 'concluded'",
    ),
    endSession: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 1 WHERE id = ?",
    ),
    endSessionUnseen: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0 WHERE id = ?",
    ),
    endSessionUnseenIfUnchanged: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0 WHERE id = ? AND status = 'live' AND last_seen_at = ? AND host_pid IS ?",
    ),
    reviveSession: db.prepare(
      "UPDATE sessions SET status = 'live' WHERE id = ? AND status = 'ended'",
    ),
    setHostProcess: db.prepare(
      "UPDATE sessions SET host_pid = ?, host_started_at = ? WHERE id = ?",
    ),
    sessionsOnHost: db.prepare(
      "SELECT id, last_seen_at, host_started_at FROM sessions WHERE host_pid = ? AND status = 'live'",
    ),
    insertPause: db.prepare(
      "INSERT INTO pauses (session_id, paused_at) VALUES (?, ?)",
    ),
    pauseSession: db.prepare(
      "UPDATE sessions SET status = 'paused' WHERE id = ? AND status != 'ended'",
    ),
    resumePauses: db.prepare(
      "UPDATE pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL",
    ),
    unpauseSession: db.prepare(
      "UPDATE sessions SET status = 'live' WHERE id = ? AND status = 'paused'",
    ),
  };
}

function prepareStatements(db: DatabaseSync): JourneyStatements {
  return {
    ...prepareSessionStatements(db),
    ...prepareStepStatements(db),
    ...prepareSegmentStatements(db),
  };
}

export function createJourneyBuilder(db: DatabaseSync): JourneyBuilder {
  const statements = prepareStatements(db);
  const applyEvent = (event: Row, at: number): void =>
    applyHookEvent(statements, event, at);
  const apply = (event: Row, at: number): void => {
    applyEvent(event, at);
    endSessionReplacedByStart(statements, event);
  };
  return {
    applyHookEvent: apply,
    recordPause: (sessionId, at) => recordPause(statements, sessionId, at),
    recordResume: (sessionId, at) => recordResume(statements, sessionId, at),
    endSessionUnseen: (sessionId, at) =>
      endSessionUnseen(statements, sessionId, at),
    endSessionUnseenIfUnchanged: (session) =>
      endSessionUnseenIfUnchanged(statements, session),
  };
}

/**
 * Reopen exactly the rows the daemon's conclusion closed —
 * the steps, turns and branches it marked — ahead of the
 * event that revives the session. Every other row stands:
 * what the other sources wrote, and every real closing.
 */
function reopenConclusion(st: JourneyStatements, sessionId: string): void {
  st.reopenConcludedSteps.run(sessionId);
  st.reopenConcludedTurns.run(sessionId);
  st.reopenConcludedBranches.run(sessionId);
}

function ensureConditions(
  st: JourneyStatements,
  sessionId: string,
  at: number,
): Row {
  st.insertConditions.run(sessionId, at);
  return st.getConditions.get(sessionId) as Row;
}

function saveConditions(
  st: JourneyStatements,
  sessionId: string,
  row: Row,
  at: number,
): void {
  st.saveConditions.run(
    asText(row.permission_modes),
    asText(row.instruction_files),
    asText(row.enabled_plugins),
    asText(row.claude_code_version),
    asText(row.sources_seen),
    at,
    sessionId,
  );
}

function ensureSession(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const isStart = event.hook_event_name === "SessionStart";
  st.insertSession.run(sessionId, at, at, isStart ? 0 : 1);
  st.touchSession.run(at, sessionId);
  const cwd = str(event, "cwd");
  if (cwd !== undefined) {
    st.setProjectPath.run(cwd, sessionId);
  }
  const model = str(event, "model");
  if (model !== undefined) {
    st.setModel.run(model, sessionId);
  }
}

function updateConditions(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const row = ensureConditions(st, sessionId, at);
  let changed = false;
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("hook")) {
    sources.push("hook");
    row.sources_seen = JSON.stringify(sources);
    changed = true;
  }
  const mode = str(event, "permission_mode");
  if (mode !== undefined) {
    const modes = parseStringArray(row.permission_modes);
    if (modes[modes.length - 1] !== mode) {
      modes.push(mode);
      row.permission_modes = JSON.stringify(modes);
      changed = true;
    }
  }
  if (changed) saveConditions(st, sessionId, row, at);
}

function ensurePlugins(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const row = ensureConditions(st, sessionId, at);
  if (row.enabled_plugins !== null && row.enabled_plugins !== undefined) {
    return; // Read once per session.
  }
  const cwd =
    str(event, "cwd") ??
    str(st.getSession.get(sessionId) as Row, "project_path");
  row.enabled_plugins = JSON.stringify(
    cwd !== undefined ? readEnabledPlugins(cwd) : [],
  );
  saveConditions(st, sessionId, row, at);
}

function closeStepRow(
  st: JourneyStatements,
  step: Row,
  outcome: string,
  source: string,
  at: number,
): void {
  const started = typeof step.started_at === "number" ? step.started_at : null;
  st.closeStep.run(
    outcome,
    source,
    at,
    started !== null ? at - started : null,
    step.id as number,
  );
}

/**
 * Which closing a close-out is: the daemon's conclusion marks
 * what it closes, so a revival can reopen exactly those rows;
 * every other closing is inferred from the event stream and
 * stands. Steps carry the mark in outcome_source, turns and
 * branches in end_source.
 */
type ClosingSource = "inferred" | "concluded";

/**
 * Close one step that never got a closing event. A step whose
 * last event was a permission request closes as rejected; the
 * rest close as interrupted.
 */
function closeStepWithoutEvent(
  st: JourneyStatements,
  step: Row,
  at: number,
  source: ClosingSource,
): void {
  const asked = st.askedAboutStep.get(step.id as number);
  closeStepRow(
    st,
    step,
    asked !== undefined ? "rejected" : "interrupted",
    source,
    at,
  );
}

/**
 * Close the open steps in scope (one turn, or the whole session
 * when turnId is null). Steps inside a branch are out of a
 * turn's scope: a subagent routinely outlives the main turn, so
 * its steps close when the branch ends, or with the session.
 */
function closeOpenSteps(
  st: JourneyStatements,
  sessionId: string,
  turnId: number | null,
  at: number,
  source: ClosingSource,
): void {
  const steps = st.openSteps.all(sessionId) as Row[];
  for (const step of steps) {
    if (turnId !== null && step.turn_id !== turnId) continue;
    if (turnId !== null && step.branch_id !== null) continue;
    closeStepWithoutEvent(st, step, at, source);
  }
}

function closeTurn(
  st: JourneyStatements,
  sessionId: string,
  turn: Row,
  at: number,
  source: ClosingSource,
): void {
  closeOpenSteps(st, sessionId, turn.id as number, at, source);
  if (source === "concluded") {
    st.endTurnConcluded.run(at, turn.id as number);
  } else {
    st.endTurn.run(at, turn.id as number);
  }
}

// Redaction cuts the event's prompt, so a prompt's true size is
// the figures the hook measured before it did.
function hookPromptColumns(event: Row, text: string | null): PromptTextColumns {
  const columns = promptTextColumns(text);
  const chars = num(event, "prompt_chars");
  const lines = num(event, "prompt_lines");
  if (text === null || chars === undefined || lines === undefined) {
    return columns;
  }
  return { text: columns.text, chars, lines };
}

function ensureTurn(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): Row | undefined {
  const promptId = str(event, "prompt_id");
  if (promptId !== undefined) {
    const existing = st.getTurnByPrompt.get(sessionId, promptId) as
      Row | undefined;
    if (existing !== undefined) return existing;
  }
  // A new prompt closes the turn that was open before it.
  const open = st.getOpenTurn.get(sessionId) as Row | undefined;
  const promptText =
    event.hook_event_name === "UserPromptSubmit"
      ? (str(event, "prompt") ?? null)
      : null;
  if (promptId === undefined && promptText === null) {
    return open; // No prompt identity: ride the open turn, if any.
  }
  if (open !== undefined) closeTurn(st, sessionId, open, at, "inferred");
  const sequence = (st.nextSequence.get(sessionId) as { n: number }).n;
  const columns = hookPromptColumns(event, promptText);
  const result = st.insertTurn.run(
    sessionId,
    promptId ?? null,
    sequence,
    at,
    columns.text,
    columns.chars,
    columns.lines,
    0,
  );
  return st.getTurnById.get(Number(result.lastInsertRowid)) as Row;
}

function turnFor(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): Row | undefined {
  const promptId = str(event, "prompt_id");
  if (promptId !== undefined) {
    const turn = st.getTurnByPrompt.get(sessionId, promptId) as Row | undefined;
    if (turn !== undefined) return turn;
    return ensureTurn(st, sessionId, event, at);
  }
  return st.getOpenTurn.get(sessionId) as Row | undefined;
}

function permissionDecision(
  st: JourneyStatements,
  step: Row,
  turnId: unknown,
  at: number,
): void {
  const asked = st.askedAboutStep.get(step.id as number);
  if (asked === undefined) return;
  const decided = st.decisionForStep.get(step.id as number);
  if (decided !== undefined) return;
  st.insertHumanEvent.run(
    step.session_id as string,
    typeof turnId === "number" ? turnId : null,
    step.id as number,
    "permission_decision",
    at,
    "accept",
    "inferred",
    null,
  );
}

function expiredFlag(value: unknown): number | null {
  if (typeof value !== "boolean") return null;
  return value ? 1 : 0;
}

function applySessionStart(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  ensurePlugins(st, sessionId, event, at);
  // The hook notes the Claude Code process it runs under, so
  // the daemon can later tell whether that process is still
  // there. A start that notes nothing clears what an earlier
  // start recorded: the session no longer runs in that
  // process, and judging it by that process would end it
  // wrongly, over and over.
  const hostPid = num(event, "host_pid");
  const hostStartedAt = num(event, "host_started_at");
  if (hostPid !== undefined && hostStartedAt !== undefined) {
    st.setHostProcess.run(hostPid, hostStartedAt, sessionId);
  } else {
    st.setHostProcess.run(null, null, sessionId);
  }
  const version = str(event, "version");
  if (version !== undefined) {
    const row = ensureConditions(st, sessionId, at);
    if (row.claude_code_version !== version) {
      row.claude_code_version = version;
      saveConditions(st, sessionId, row, at);
    }
  }
  const kind = str(event, "source") ?? "startup";
  // A startup or a /clear proves the start was seen, whichever
  // event inserted the row; a resume or a compaction proves nothing.
  if (kind === "startup" || kind === "clear") {
    st.clearJoinedPartway.run(sessionId);
  }
  // A compaction gets one segment: telemetry may already
  // have opened it (its record carries the post-compact
  // size), in which case this start attaches to that one.
  const nearbyCompact =
    kind === "compact"
      ? st.getNearbyCompactSegment.get(sessionId, at)
      : undefined;
  if (nearbyCompact === undefined) {
    st.insertSegment.run(
      sessionId,
      kind,
      at,
      num(event, "context_tokens") ?? null,
      expiredFlag(event.prompt_cache_likely_expired),
    );
  }
}

/**
 * End the session a start replaces, for an event as it
 * arrives: one process runs one session at a time, so a start
 * that notes a process another live session already holds —
 * /clear and /resume start the new session in the same
 * process — means the older session is over, and if its own
 * end event was lost it would otherwise read as live for as
 * long as the window stays open. Only the live apply calls
 * this, once the event has landed: the ending belongs to the
 * moment the replacing start arrives, not to any later
 * re-read of the session's stored events.
 */
function endSessionReplacedByStart(st: JourneyStatements, event: Row): void {
  if (str(event, "hook_event_name") !== "SessionStart") {
    return;
  }
  const sessionId = str(event, "session_id");
  const hostPid = num(event, "host_pid");
  const hostStartedAt = num(event, "host_started_at");
  if (
    sessionId === undefined ||
    hostPid === undefined ||
    hostStartedAt === undefined
  ) {
    return;
  }
  endReplacedSessions(st, sessionId, hostPid, hostStartedAt);
}

/**
 * End any other live session holding this start's process.
 * The start time must match too: the same id later naming a
 * different process is a different process, not a replacement.
 */
function endReplacedSessions(
  st: JourneyStatements,
  sessionId: string,
  hostPid: number,
  hostStartedAt: number,
): void {
  const others = st.sessionsOnHost.all(hostPid) as Row[];
  for (const other of others) {
    if (other.id === sessionId) {
      continue;
    }
    const otherStartedAt = other.host_started_at as number | null;
    if (
      otherStartedAt !== null &&
      sameProcessStart(otherStartedAt, hostStartedAt)
    ) {
      endSessionUnseen(st, other.id as string, other.last_seen_at as number);
    }
  }
}

function applyUserPromptSubmit(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  // The hook classified the prompt before dropping its text:
  // only a typed prompt is a turn, and anything else records
  // nothing as a prompt. An event from an older hook carries
  // no kind, so its text is checked the way it always was.
  const kind = str(event, "prompt_kind");
  if (kind !== undefined) {
    if (kind !== "typed") return;
  } else {
    const submitted = str(event, "prompt");
    // Flightpath's own commands make no request, so they are not turns.
    if (submitted !== undefined && isFlightpathCommand(submitted)) return;
    // A subagent's hand-back is not a turn either, and its text
    // — a report on the person's files — is never stored as
    // prompt text (ADR-0004, ADR-0017).
    if (submitted !== undefined && isAgentMessage(submitted)) return;
  }
  const turn = ensureTurn(st, sessionId, event, at);
  if (turn === undefined) return;
  const text = str(event, "prompt");
  if (text !== undefined && turn.prompt_text === null) {
    setTurnPromptColumns(st, turn.id as number, hookPromptColumns(event, text));
  }
  if (text === undefined && turn.prompt_chars === null) {
    const chars = num(event, "prompt_chars");
    const lines = num(event, "prompt_lines");
    if (chars !== undefined && lines !== undefined) {
      fillTurnPromptFigures(st, turn.id as number, chars, lines);
    }
  }
  const seen = st.getPromptEventByTurn.get(turn.id as number);
  if (seen === undefined) {
    st.insertHumanEvent.run(
      sessionId,
      turn.id as number,
      null,
      "prompt",
      at,
      null,
      null,
      null,
    );
  }
}

function applyUserPromptExpansion(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const command = str(event, "command_name");
  // An expansion opens its command's turn, unmarked:
  // no route marks a turn as Flightpath's own yet, so the
  // overhead sum reads 0 (ADR-0021).
  if (command === undefined || !isFlightpathCommand(command)) {
    ensureTurn(st, sessionId, event, at);
  }
  // Flightpath's own commands are blocked by its hook and
  // never reach the model, so they record no load.
  if (command !== undefined && !isFlightpathCommand(command)) {
    recordSkillLoad(st, sessionId, command, "user_slash", at);
  }
}

/**
 * The transcript may have recorded this skill's load from its
 * text already; the hook then only says how it was triggered.
 */
function recordSkillLoad(
  st: JourneyStatements,
  sessionId: string,
  name: string,
  trigger: string,
  at: number,
): void {
  if (triggerTranscriptSkillLoad(st, sessionId, name, trigger, at)) return;
  st.insertLoad.run(sessionId, "skill", name, trigger, null, null, at, null);
}

/**
 * Write the step a PreToolUse opens. When the transcript
 * built a step for the call already — its result settled
 * before this record landed — the record fills what the
 * transcript could not know and otherwise leaves that row
 * exactly as it stands, instead of adding a second step
 * for the same call.
 */
function openStep(
  st: JourneyStatements,
  sessionId: string,
  turnId: number | null,
  branchId: number | null,
  event: Row,
  at: number,
): void {
  const input = obj(event, "tool_input");
  const inputSummary = input !== undefined ? JSON.stringify(input) : null;
  const toolUseId = str(event, "tool_use_id");
  if (toolUseId !== undefined) {
    const filled = st.fillTranscriptStep.run(
      turnId,
      branchId,
      inputSummary,
      at,
      sessionId,
      toolUseId,
    );
    if (filled.changes > 0) return;
  }
  st.insertStep.run(
    sessionId,
    turnId,
    branchId,
    toolUseId ?? null,
    str(event, "tool_name") ?? "unknown",
    inputSummary,
    at,
  );
}

/**
 * The turn a step belongs to: its prompt's turn or the open
 * turn — unless the step runs in a branch whose spawning step
 * is known, when it takes that step's turn: a background
 * subagent's work belongs to the turn that launched it,
 * however many turns pass while it works.
 */
function stepTurnId(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
  branch: Row | undefined,
): number | null {
  const turn = turnFor(st, sessionId, event, at);
  if (branch !== undefined) {
    const spawning = st.spawningTurnByBranch.get(branch.id as number) as
      { turn_id: number | null } | undefined;
    if (spawning !== undefined && typeof spawning.turn_id === "number") {
      return spawning.turn_id;
    }
  }
  return turn !== undefined ? (turn.id as number) : null;
}

function applyPreToolUse(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const agentId = str(event, "agent_id");
  const branch =
    agentId !== undefined
      ? (st.getBranch.get(sessionId, agentId) as Row | undefined)
      : undefined;
  // An agent id no start named: Claude Code runs short-lived
  // agents that fire a tool call with no SubagentStart at all.
  // Their work is background work, so the step gets the branch
  // a stop with no start gets — never the main conversation.
  let branchId: number | null =
    branch !== undefined ? (branch.id as number) : null;
  if (agentId !== undefined && branch === undefined) {
    branchId = insertBranch(
      st,
      sessionId,
      agentId,
      null,
      str(event, "agent_type") ?? "",
      at,
      null,
    );
  }
  openStep(
    st,
    sessionId,
    stepTurnId(st, sessionId, event, at, branch),
    branchId,
    event,
    at,
  );
  if (str(event, "tool_name") === "Skill") {
    const input = obj(event, "tool_input");
    const skill = input !== undefined ? str(input, "skill") : undefined;
    if (skill !== undefined) recordSkillLoad(st, sessionId, skill, "agent", at);
  }
}

/**
 * Close the step a tool-use id names, when it is still open,
 * and return the step as it stood before the close. The one
 * closing the post-tool events and a PostToolBatch share: a
 * step either of them already closed keeps its outcome, so
 * the batch never overwrites what an event decided.
 */
function closeStepFromEvent(
  st: JourneyStatements,
  sessionId: string,
  toolUseId: string,
  outcome: string,
  source: string,
  at: number,
): Row | undefined {
  const step = st.getStepByToolUse.get(sessionId, toolUseId) as Row | undefined;
  if (step !== undefined && step.outcome === "open") {
    closeStepRow(st, step, outcome, source, at);
  }
  return step;
}

function applyPostToolUse(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
  failed: boolean,
): void {
  const toolUseId = str(event, "tool_use_id");
  if (toolUseId === undefined) return;
  const step = closeStepFromEvent(
    st,
    sessionId,
    toolUseId,
    failed ? "failed" : "succeeded",
    "hook",
    at,
  );
  if (step === undefined) return;
  // The tool ran, so a pending permission request was approved.
  permissionDecision(st, step, step.turn_id, at);
  if (!failed && str(event, "tool_name") === "AskUserQuestion") {
    const response = obj(event, "tool_response");
    const answers =
      response !== undefined ? obj(response, "answers") : undefined;
    st.insertHumanEvent.run(
      sessionId,
      typeof step.turn_id === "number" ? step.turn_id : null,
      step.id as number,
      "question_answered",
      at,
      null,
      null,
      JSON.stringify(answers ?? response ?? null),
    );
  }
  if (event.tool_response !== undefined && step.outcome === "open") {
    st.setStepResultSize.run(
      responseSize(event.tool_response),
      step.id as number,
    );
  }
}

/**
 * A batch closes the calls it names that got no closing event
 * of their own: some of Claude Code's short-lived agents end
 * their calls with a PostToolBatch and never a PostToolUse.
 * No result size is taken from the batch — it names calls, it
 * does not report their output.
 */
function applyPostToolBatch(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const calls = event.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (!isPlainObject(call)) continue;
    const toolUseId = str(call, "tool_use_id");
    if (toolUseId === undefined) continue;
    closeStepFromEvent(st, sessionId, toolUseId, "succeeded", "batch", at);
  }
}

function applyPermissionRequest(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const turn = turnFor(st, sessionId, event, at);
  const toolUseId = str(event, "tool_use_id");
  let step =
    toolUseId !== undefined
      ? (st.getStepByToolUse.get(sessionId, toolUseId) as Row | undefined)
      : undefined;
  if (step === undefined) {
    const toolName = str(event, "tool_name");
    step = (st.openSteps.all(sessionId) as Row[]).find(
      (s) => s.tool_name === toolName,
    );
  }
  st.insertHumanEvent.run(
    sessionId,
    turn !== undefined ? (turn.id as number) : null,
    step !== undefined ? (step.id as number) : null,
    "permission_request",
    at,
    null,
    null,
    null,
  );
}

function applyNotification(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  // A notification attaches to its prompt's turn and never opens
  // one: an idle notification names a prompt no submit opened.
  const promptId = str(event, "prompt_id");
  const turn =
    promptId !== undefined
      ? (st.getTurnByPrompt.get(sessionId, promptId) as Row | undefined)
      : (st.getOpenTurn.get(sessionId) as Row | undefined);
  const type = str(event, "notification_type");
  st.insertHumanEvent.run(
    sessionId,
    turn !== undefined ? (turn.id as number) : null,
    null,
    "waiting",
    at,
    null,
    null,
    type !== undefined ? JSON.stringify({ notification_type: type }) : null,
  );
}

function applyStop(st: JourneyStatements, sessionId: string, at: number): void {
  const open = st.getOpenTurn.get(sessionId) as Row | undefined;
  if (open !== undefined) closeTurn(st, sessionId, open, at, "inferred");
}

function findSpawningStep(
  st: JourneyStatements,
  sessionId: string,
  agentType: string,
  at: number,
): Row | undefined {
  // Link by order: the earliest step that launched this agent
  // type, started within ten seconds, not already linked. The
  // window is as wide as the delay Claude Code was seen to
  // take between a launch and its start; the type match and
  // the order keep launches of different types from swapping.
  const candidates = st.linkCandidates.all(sessionId, at - 10000, at) as Row[];
  for (const step of candidates) {
    const linked = st.branchBySpawningStep.get(step.id as number);
    if (linked !== undefined) continue;
    const input =
      typeof step.input_summary === "string"
        ? (JSON.parse(step.input_summary) as Row)
        : undefined;
    if (input !== undefined && str(input, "subagent_type") === agentType) {
      return step;
    }
  }
  return undefined;
}

/**
 * Insert one branch row and return its id. An agent with no
 * type is one of Claude Code's own helpers, so its branch is
 * internal; a named type is the person's subagent.
 */
function insertBranch(
  st: JourneyStatements,
  sessionId: string,
  agentId: string,
  spawningStepId: number | null,
  agentType: string,
  startedAt: number | null,
  endedAt: number | null,
): number {
  const result = st.insertBranch.run(
    sessionId,
    agentId,
    spawningStepId,
    agentType,
    agentType === "" ? "internal" : "user",
    startedAt,
    endedAt,
  );
  return Number(result.lastInsertRowid);
}

/**
 * Set a branch's spawning step: the one link rule every source
 * follows. The link lands, and the branch's steps are
 * re-stamped with the spawning step's turn, so the subagent's
 * work reads under the turn that launched it however late the
 * link arrives.
 */
function setSpawningStep(st: JourneyStatements, branch: Row, step: Row): void {
  const turnId = step.turn_id;
  linkBranchToStep(
    st,
    branch.id as number,
    step.id as number,
    typeof turnId === "number" ? turnId : null,
  );
}

/**
 * A start that finds its branch already recorded — a step or
 * a stop landed first — still has its say: the start's type
 * names it, and the window's link fills the spawning step
 * in. A started_at the branch already carries stands when
 * it is earlier: it is the first step's time, and the agent
 * was already working then.
 */
function fillBranchFromStart(
  st: JourneyStatements,
  sessionId: string,
  branch: Row,
  agentType: string,
  at: number,
): void {
  const startedAt = branch.started_at;
  if (typeof startedAt !== "number" || at < startedAt) {
    st.setBranchStartedAt.run(at, branch.id as number);
  }
  // A branch a step or a stop recorded first carries no
  // type: the start names the agent, and a named type is
  // the person's subagent, never an internal helper.
  if (branch.agent_type === "" && agentType !== "") {
    st.setBranchType.run(agentType, "user", branch.id as number);
  }
  if (typeof branch.spawning_step_id !== "number") {
    const spawning = findSpawningStep(st, sessionId, agentType, at);
    if (spawning !== undefined) setSpawningStep(st, branch, spawning);
  }
}

function applySubagentStart(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const agentId = str(event, "agent_id");
  if (agentId === undefined) return;
  const agentType = str(event, "agent_type") ?? "";
  const existing = st.getBranch.get(sessionId, agentId) as Row | undefined;
  if (existing !== undefined) {
    fillBranchFromStart(st, sessionId, existing, agentType, at);
    return;
  }
  const spawning = findSpawningStep(st, sessionId, agentType, at);
  insertBranch(
    st,
    sessionId,
    agentId,
    spawning !== undefined ? (spawning.id as number) : null,
    agentType,
    at,
    null,
  );
}

function applySubagentStop(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const agentId = str(event, "agent_id");
  if (agentId === undefined) return;
  const branch = st.getBranch.get(sessionId, agentId) as Row | undefined;
  if (branch !== undefined) {
    st.endBranch.run(at, branch.id as number);
    // The branch's own steps end with it: any still open
    // never got a closing event of their own.
    for (const step of st.openSteps.all(sessionId) as Row[]) {
      if (step.branch_id === branch.id) {
        closeStepWithoutEvent(st, step, at, "inferred");
      }
    }
    return;
  }
  // A stop with no start: an internal helper, or a branch
  // from before recording joined the session.
  const agentType = str(event, "agent_type") ?? "";
  insertBranch(st, sessionId, agentId, null, agentType, null, at);
}

function applyInstructionsLoaded(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
  at: number,
): void {
  const filePath = str(event, "file_path");
  st.insertLoad.run(
    sessionId,
    "instructions",
    null,
    null,
    str(event, "memory_type") ?? null,
    filePath ?? null,
    at,
    // The daemon statted the file when the event arrived and
    // carried the size on the event, so the stored event is
    // the size's record; a file already gone carries none.
    num(event, "file_size_bytes") ?? null,
  );
  if (filePath !== undefined) {
    const row = ensureConditions(st, sessionId, at);
    const files = parseStringArray(row.instruction_files);
    if (!files.includes(filePath)) {
      files.push(filePath);
      row.instruction_files = JSON.stringify(files);
      saveConditions(st, sessionId, row, at);
    }
  }
}

/** Close whatever a session left open at its end: its turns,
 *  its steps, then its branches. The conclusion's closing is
 *  marked as it lands, so a revival can tell it from a real
 *  closing and reopen exactly it. */
function closeOutSession(
  st: JourneyStatements,
  sessionId: string,
  at: number,
  source: ClosingSource,
): void {
  const turns = st.getOpenTurns.all(sessionId) as Row[];
  for (const turn of turns) closeTurn(st, sessionId, turn, at, source);
  closeOpenSteps(st, sessionId, null, at, source);
  if (source === "concluded") {
    st.endAllBranchesConcluded.run(at, sessionId);
  } else {
    st.endAllBranches.run(at, sessionId);
  }
}

function applySessionEnd(
  st: JourneyStatements,
  sessionId: string,
  at: number,
): void {
  closeOutSession(st, sessionId, at, "inferred");
  st.endSession.run(sessionId);
}

/**
 * End a session whose end the daemon concluded, at its last
 * event's time: the same closing as an end event, except the
 * end is marked unseen and every closing is marked concluded.
 */
function endSessionUnseen(
  st: JourneyStatements,
  sessionId: string,
  at: number,
): void {
  closeOutSession(st, sessionId, at, "concluded");
  st.endSessionUnseen.run(sessionId);
}

/**
 * The watch's end, guarded by the row the watch read: the
 * update lands only when the session is still live, still
 * last heard from at the read time, and still on the read
 * process — an event that arrived while the watch read
 * process times moves at least one of those, and then the
 * session is left exactly as the event left it.
 */
function endSessionUnseenIfUnchanged(
  st: JourneyStatements,
  session: LiveSessionHost,
): boolean {
  const result = st.endSessionUnseenIfUnchanged.run(
    session.id,
    session.lastSeenAt,
    session.hostPid,
  );
  if (result.changes === 0) {
    return false;
  }
  closeOutSession(st, session.id, session.lastSeenAt, "concluded");
  return true;
}

/**
 * Hook payloads carry the session's effort level as a common
 * field: where one is present, it fills the effort of the
 * turn's requests that have none yet. The transcript's
 * request entry is the primary source and replaces this
 * fallback when it arrives. The turn is only ever looked up,
 * never created: whether a turn exists cannot depend on
 * whether a payload happened to carry an effort level.
 */
function fillEffortFromHook(
  st: JourneyStatements,
  sessionId: string,
  event: Row,
): void {
  const effort = obj(event, "effort");
  const level = effortLevel(
    effort !== undefined ? str(effort, "level") : undefined,
  );
  if (level === null) return;
  const promptId = str(event, "prompt_id");
  const turn =
    promptId !== undefined
      ? (st.getTurnByPrompt.get(sessionId, promptId) as Row | undefined)
      : (st.getOpenTurn.get(sessionId) as Row | undefined);
  if (turn !== undefined) {
    st.fillRequestEffort.run(level, sessionId, turn.id as number);
  }
}

function applyHookEvent(st: JourneyStatements, event: Row, at: number): void {
  const sessionId = str(event, "session_id");
  if (sessionId === undefined) return;
  ensureSession(st, sessionId, event, at);
  updateConditions(st, sessionId, event, at);
  const name = str(event, "hook_event_name");
  // An event for a session that was concluded ended means the
  // conclusion was wrong — the session is there after all (a
  // resume, a laptop waking). It is live again, as one row:
  // nothing is duplicated, the new event folds in as usual.
  // The conclusion marked the rows it closed, and exactly
  // those reopen first, so the event lands on the session as
  // it stood before the conclusion; an end that was reported
  // (end_seen) reopens nothing.
  if (name !== "SessionEnd") {
    const row = st.getSession.get(sessionId) as Row | undefined;
    if (row !== undefined && row.status === "ended" && row.end_seen === 0) {
      reopenConclusion(st, sessionId);
    }
    st.reviveSession.run(sessionId);
  }
  dispatchHookEvent(st, sessionId, name, event, at);
  fillEffortFromHook(st, sessionId, event);
}

/** Fold one hook event into the journey by its name. */
function dispatchHookEvent(
  st: JourneyStatements,
  sessionId: string,
  name: string | undefined,
  event: Row,
  at: number,
): void {
  switch (name) {
    case "SessionStart":
      applySessionStart(st, sessionId, event, at);
      break;
    case "UserPromptSubmit":
      applyUserPromptSubmit(st, sessionId, event, at);
      break;
    case "UserPromptExpansion":
      applyUserPromptExpansion(st, sessionId, event, at);
      break;
    case "PreToolUse":
      applyPreToolUse(st, sessionId, event, at);
      break;
    case "PostToolUse":
      applyPostToolUse(st, sessionId, event, at, false);
      break;
    case "PostToolUseFailure":
      applyPostToolUse(st, sessionId, event, at, true);
      break;
    case "PostToolBatch":
      applyPostToolBatch(st, sessionId, event, at);
      break;
    case "PermissionRequest":
      applyPermissionRequest(st, sessionId, event, at);
      break;
    case "Notification":
      applyNotification(st, sessionId, event, at);
      break;
    case "Stop":
      applyStop(st, sessionId, at);
      break;
    case "SubagentStart":
      applySubagentStart(st, sessionId, event, at);
      break;
    case "SubagentStop":
      applySubagentStop(st, sessionId, event, at);
      break;
    case "InstructionsLoaded":
      applyInstructionsLoaded(st, sessionId, event, at);
      break;
    case "SessionEnd":
      applySessionEnd(st, sessionId, at);
      break;
    default:
      break;
  }
}

function recordPause(
  st: JourneyStatements,
  sessionId: string,
  at: number,
): void {
  // The session may have no journey rows yet (its start was
  // itself paused, say): the pause still has to land, so the
  // session row is created on the spot.
  st.insertSession.run(sessionId, at, at, 1);
  st.insertPause.run(sessionId, at);
  st.pauseSession.run(sessionId);
}

function recordResume(
  st: JourneyStatements,
  sessionId: string,
  at: number,
): void {
  st.insertSession.run(sessionId, at, at, 1);
  st.resumePauses.run(at, sessionId);
  st.unpauseSession.run(sessionId);
}
