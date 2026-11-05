// Telemetry intake: Claude Code's OpenTelemetry log export,
// received at POST /v1/logs, redacted, and merged into the
// journey (ADR-0012, ADR-0017). The SQL lives in store.ts.
//
// What telemetry adds over hooks and transcripts: exact request
// durations, background requests (suggestions, session titles,
// compaction calls), who made each permission decision, failed
// tool results the hooks closed only by inference, subagent
// totals, and hook execution timings. The merge rules live
// here and in the one `requests` upsert (transcripts/index.ts):
// telemetry wins over transcript values, in either order.
//
// Telemetry applies only to sessions the hooks have admitted.
// The hook is what enforces exclusion and pausing at capture
// time, so a session with no row — an excluded folder, a
// session that started paused — must never be created by
// telemetry. Records for an unknown session are held briefly
// (telemetry can outrun the hook event that admits its session)
// and dropped if no hook event arrives.
//
// Everything applied comes from the redacted record — the
// allow-list decides what text exists by then. The one thing
// read from the raw record is its timestamp: a number, not
// content. Dollar figures never reach this module at all; the
// redaction drops cost keys whole (ADR-0005).

import { effortLevel } from "../effort.js";
import { REDACTION_VERSION, redactTelemetryRecord } from "../redact/index.js";
import { isExcludedFolder, type Settings } from "../settings/index.js";
import type { Storage } from "../storage/index.js";
import {
  boolAttr,
  isPlainObject,
  numAttr,
  textAttr,
  type AttributeMap,
} from "../util/json.js";

export { createTelemetryStore, type TelemetryStore } from "./store.js";

interface TelemetryProcessResult {
  accepted: number;
  dropped: number;
  unknown: number;
  held: number;
}

export interface TelemetryIntake {
  processExport(
    storage: Storage,
    body: unknown,
    options: { settings: Settings; receivedAt: number },
  ): TelemetryProcessResult;
  /**
   * Apply any records held for a session, once the hooks have
   * admitted it. Called as hook events for the session land.
   */
  flushSession(
    storage: Storage,
    sessionId: string,
    options: { settings: Settings },
  ): TelemetryProcessResult;
  /** Drop held records whose session never arrived. */
  dropStale(now: number): number;
}

/** How long an unknown session's records are held for its hook. */
const HOLD_MS = 15_000;
const HOLD_CAP = 500;

type HeldRecords = Map<
  string,
  { records: { raw: Record<string, unknown>; receivedAt: number }[] }
>;

export function createTelemetryIntake(): TelemetryIntake {
  const held: HeldRecords = new Map();
  return {
    processExport: (storage, body, options) =>
      processExport(held, storage, body, options),
    flushSession: (storage, sessionId, options) =>
      flushHeld(held, storage, sessionId, options),
    dropStale: (now) => dropStale(held, now),
  };
}

function emptyResult(): TelemetryProcessResult {
  return { accepted: 0, dropped: 0, unknown: 0, held: 0 };
}

/** Every log record in an export body, in arrival order. */
function allLogRecords(body: unknown): Record<string, unknown>[] {
  if (!isPlainObject(body) || !Array.isArray(body.resourceLogs)) {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const resourceLog of body.resourceLogs) {
    if (!isPlainObject(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
      continue;
    }
    collectScopeRecords(resourceLog.scopeLogs, records);
  }
  return records;
}

function collectScopeRecords(
  scopeLogs: unknown[],
  records: Record<string, unknown>[],
): void {
  for (const scopeLog of scopeLogs) {
    if (!isPlainObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
      continue;
    }
    for (const rawRecord of scopeLog.logRecords) {
      if (isPlainObject(rawRecord)) records.push(rawRecord);
    }
  }
}

function processExport(
  held: HeldRecords,
  storage: Storage,
  body: unknown,
  options: { settings: Settings; receivedAt: number },
): TelemetryProcessResult {
  const result = emptyResult();
  const notedSessions = new Set<string>();
  for (const rawRecord of allLogRecords(body)) {
    processRecord(
      held,
      storage,
      rawRecord,
      options,
      notedSessions,
      result,
      true,
    );
  }
  return result;
}

function flushHeld(
  held: HeldRecords,
  storage: Storage,
  sessionId: string,
  options: { settings: Settings },
): TelemetryProcessResult {
  const result = emptyResult();
  const entry = held.get(sessionId);
  if (entry === undefined) return result;
  if (storage.sessionProjectPath(sessionId) === undefined) {
    return result; // Still unadmitted; the hold stands.
  }
  held.delete(sessionId);
  const notedSessions = new Set<string>();
  for (const record of entry.records) {
    processRecord(
      held,
      storage,
      record.raw,
      { settings: options.settings, receivedAt: record.receivedAt },
      notedSessions,
      result,
      false,
    );
  }
  return result;
}

function dropStale(held: HeldRecords, now: number): number {
  let dropped = 0;
  for (const [sessionId, entry] of held) {
    const oldest = entry.records[0];
    if (oldest !== undefined && now - oldest.receivedAt > HOLD_MS) {
      dropped += entry.records.length;
      held.delete(sessionId);
    }
  }
  return dropped;
}

function processRecord(
  held: HeldRecords,
  storage: Storage,
  rawRecord: Record<string, unknown>,
  options: { settings: Settings; receivedAt: number },
  notedSessions: Set<string>,
  result: TelemetryProcessResult,
  allowHold: boolean,
): void {
  const at = recordTimeMs(rawRecord, options.receivedAt);
  const redacted = redactTelemetryRecord(rawRecord);
  const attrs = readAttrs(redacted);
  const sessionId = textAttr(attrs, "session.id");
  if (sessionId === null || storage.isForgotten(sessionId)) {
    result.dropped += 1;
    return;
  }
  const projectPath = storage.sessionProjectPath(sessionId);
  if (projectPath === undefined) {
    // No session row: the hooks have not admitted this
    // session (or its first event is still in flight). Never
    // create it from telemetry — hold briefly, then drop.
    holdRecord(held, rawRecord, options, sessionId, result, allowHold);
    return;
  }
  if (isExcludedOrPaused(storage, projectPath, options, sessionId, at)) {
    result.dropped += 1;
    return;
  }
  if (!notedSessions.has(sessionId)) {
    storage.noteTelemetrySeen(sessionId, at);
    notedSessions.add(sessionId);
  }
  insertRawRecord(storage, attrs, sessionId, at, redacted);
  result.accepted += 1;
  const eventName = textAttr(attrs, "event.name") ?? "";
  const kind = eventName.slice(eventName.lastIndexOf(".") + 1);
  applyRecord(
    storage,
    kind,
    attrs,
    { sessionId, at, promptId: textAttr(attrs, "prompt.id") },
    result,
  );
}

function holdRecord(
  held: HeldRecords,
  rawRecord: Record<string, unknown>,
  options: { receivedAt: number },
  sessionId: string,
  result: TelemetryProcessResult,
  allowHold: boolean,
): void {
  if (!allowHold) {
    result.dropped += 1;
    return;
  }
  let entry = held.get(sessionId);
  if (entry === undefined) {
    entry = { records: [] };
    held.set(sessionId, entry);
  }
  if (entry.records.length < HOLD_CAP) {
    entry.records.push({ raw: rawRecord, receivedAt: options.receivedAt });
    result.held += 1;
  } else {
    result.dropped += 1;
  }
}

function isExcludedOrPaused(
  storage: Storage,
  projectPath: string | null,
  options: { settings: Settings },
  sessionId: string,
  at: number,
): boolean {
  if (
    projectPath !== null &&
    isExcludedFolder(projectPath, options.settings.excludedFolders)
  ) {
    return true;
  }
  return storage
    .pausesFor(sessionId)
    .some(
      (pause) =>
        at >= pause.pausedAt &&
        (pause.resumedAt === null || at < pause.resumedAt),
    );
}

function insertRawRecord(
  storage: Storage,
  attrs: AttributeMap,
  sessionId: string,
  at: number,
  redacted: Record<string, unknown>,
): void {
  const sequence = numAttr(attrs, "event.sequence");
  storage.insertRawEvent({
    source: "telemetry",
    sessionId,
    eventAt: at,
    redactionVersion: REDACTION_VERSION,
    body: JSON.stringify(redacted),
    ...(sequence !== null
      ? { envelopeId: `telemetry:${sessionId}:${sequence}:${at}` }
      : {}),
  });
}

interface RecordContext {
  sessionId: string;
  at: number;
  promptId: string | null;
}

type RecordApplier = (
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
) => void;

function applyRecord(
  storage: Storage,
  kind: string,
  attrs: AttributeMap,
  context: RecordContext,
  result: TelemetryProcessResult,
): void {
  const applier = RECORD_APPLIERS[kind];
  if (applier === undefined) {
    // Stored by the caller, counted, not applied.
    result.unknown += 1;
    return;
  }
  applier(storage, attrs, context);
}

function applyApiRequest(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const { sessionId, at, promptId } = context;
  const rawSource = textAttr(attrs, "query_source");
  const background = rawSource !== null && BACKGROUND_SOURCES.has(rawSource);
  let turnId: number | null = null;
  if (!background && promptId !== null) {
    turnId =
      storage.turnIdByPrompt(sessionId, promptId) ??
      storage.ensureTranscriptTurn(sessionId, promptId, at, null);
  }
  let branchId: number | null = null;
  if (rawSource !== null && rawSource.startsWith("agent:")) {
    const agentType = textAttr(attrs, "agent_type");
    if (agentType !== null) {
      branchId = storage.branchIdByAgentType(sessionId, agentType, at);
    }
  }
  storage.upsertRequest({
    sessionId,
    requestId: textAttr(attrs, "request_id"),
    turnId,
    branchId,
    model: textAttr(attrs, "model"),
    querySource: storedQuerySource(rawSource),
    inputTokens: numAttr(attrs, "input_tokens"),
    outputTokens: numAttr(attrs, "output_tokens"),
    cacheReadTokens: numAttr(attrs, "cache_read_tokens"),
    cacheWrite5mTokens:
      numAttr(attrs, "cache_creation_5m_tokens") ??
      numAttr(attrs, "cache_creation_tokens"),
    cacheWrite1hTokens: numAttr(attrs, "cache_creation_1h_tokens"),
    tokenSource: "telemetry",
    startedAt: at,
    durationMs: numAttr(attrs, "duration_ms"),
    effort: effortLevel(textAttr(attrs, "effort")),
  });
}

function applyUserPrompt(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const { sessionId, at, promptId } = context;
  if (promptId === null) return;
  const turnId =
    storage.turnIdByPrompt(sessionId, promptId) ??
    storage.ensureTranscriptTurn(sessionId, promptId, at, null);
  storage.recordPromptEvent({
    sessionId,
    turnId,
    at,
    promptLength: numAttr(attrs, "prompt_length"),
  });
}

function applyToolResult(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const toolUseId = textAttr(attrs, "tool_use_id");
  if (toolUseId !== null && boolAttr(attrs, "success") === false) {
    storage.correctStepOutcome({
      sessionId: context.sessionId,
      toolUseId,
      at: context.at,
      durationMs: numAttr(attrs, "duration_ms"),
    });
  }
}

function applyToolDecision(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const toolUseId = textAttr(attrs, "tool_use_id");
  const decision = textAttr(attrs, "decision");
  const source = textAttr(attrs, "source");
  if (toolUseId !== null && decision !== null && source !== null) {
    storage.correctPermissionDecision({
      sessionId: context.sessionId,
      toolUseId,
      decision,
      source,
      at: context.at,
    });
  }
}

function applySkillActivated(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const name = textAttr(attrs, "skill.name");
  if (name !== null) {
    storage.addSkillLoad({
      sessionId: context.sessionId,
      name,
      at: context.at,
    });
  }
}

function applyCompaction(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  storage.recordCompaction({
    sessionId: context.sessionId,
    at: context.at,
    postTokens: numAttr(attrs, "post_tokens"),
  });
}

function applySubagentCompleted(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  const agentType = textAttr(attrs, "agent_type");
  if (agentType !== null) {
    storage.setBranchTotals({
      sessionId: context.sessionId,
      agentType,
      totalTokens: numAttr(attrs, "total_tokens"),
      at: context.at,
    });
  }
}

function applyHookExecution(
  storage: Storage,
  attrs: AttributeMap,
  context: RecordContext,
): void {
  storage.addHookExecution({
    sessionId: context.sessionId,
    name: textAttr(attrs, "hook_name") ?? "unknown",
    durationMs: numAttr(attrs, "total_duration_ms"),
    numHooks: numAttr(attrs, "num_hooks"),
    at: context.at,
  });
}

const RECORD_APPLIERS: Record<string, RecordApplier> = {
  api_request: applyApiRequest,
  user_prompt: applyUserPrompt,
  tool_result: applyToolResult,
  tool_decision: applyToolDecision,
  skill_activated: applySkillActivated,
  compaction: applyCompaction,
  subagent_completed: applySubagentCompleted,
  hook_execution_complete: applyHookExecution,
};

/** Attributes of a redacted log record, coerced to plain values. */
function readAttrs(record: Record<string, unknown>): AttributeMap {
  const attrs: AttributeMap = new Map();
  const list = record.attributes;
  if (!Array.isArray(list)) return attrs;
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.key !== "string") continue;
    const value = entry.value;
    if (!isPlainObject(value)) continue;
    if (typeof value.stringValue === "string") {
      attrs.set(entry.key, value.stringValue);
    } else if (
      typeof value.intValue === "string" ||
      typeof value.intValue === "number"
    ) {
      attrs.set(entry.key, Number(value.intValue));
    } else if (typeof value.doubleValue === "number") {
      attrs.set(entry.key, value.doubleValue);
    } else if (typeof value.boolValue === "boolean") {
      attrs.set(entry.key, value.boolValue);
    }
  }
  return attrs;
}

/**
 * The record's own time, from the raw record: timeUnixNano is a
 * count, not content, so reading it before redaction is safe.
 */
function recordTimeMs(
  raw: Record<string, unknown>,
  receivedAt: number,
): number {
  for (const key of ["timeUnixNano", "observedTimeUnixNano"]) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") {
      const ms = Math.floor(Number(value) / 1_000_000);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return receivedAt;
}

const BACKGROUND_SOURCES: ReadonlySet<string> = new Set([
  "prompt_suggestion",
  "generate_session_title",
  "compact",
]);

/** The stored query_source for a telemetry api_request. */
function storedQuerySource(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "repl_main_thread") return "main";
  if (raw.startsWith("agent:")) return "subagent";
  if (raw === "prompt_suggestion") return "suggestion";
  if (raw === "generate_session_title") return "title";
  return raw;
}
