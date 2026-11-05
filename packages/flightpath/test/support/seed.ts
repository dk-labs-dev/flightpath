// Row builders for tests that seed a database directly, in
// the shapes the recorder writes: one call per row, every
// field defaulted, the interesting ones overridden. Each
// returns the row's id, the given one or the assigned one.

import type { DatabaseSync } from "../../src/storage/sqlite.js";

function run(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}

/** A stored JSON column's value: nothing, a stored string, or an object to store as JSON. */
function storedJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function seedSession(
  db: DatabaseSync,
  overrides: {
    id?: string;
    projectPath?: string | null;
    model?: string | null;
    status?: string;
    firstSeenAt?: number;
    lastSeenAt?: number;
    joinedPartway?: boolean;
    hostPid?: number;
    hostStartedAt?: number;
  } = {},
): string {
  const id = overrides.id ?? "sess-1";
  const firstSeenAt = overrides.firstSeenAt ?? 0;
  run(
    db,
    "INSERT INTO sessions (id, project_path, model, status, first_seen_at, last_seen_at, joined_partway, tokens_partial, host_pid, host_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    id,
    overrides.projectPath === undefined
      ? "/home/user/proj"
      : overrides.projectPath,
    overrides.model === undefined ? "claude-sonnet-4-5" : overrides.model,
    overrides.status ?? "ended",
    firstSeenAt,
    overrides.lastSeenAt ?? firstSeenAt,
    overrides.joinedPartway ? 1 : 0,
    overrides.hostPid ?? null,
    overrides.hostStartedAt ?? null,
  );
  return id;
}

export function seedConditions(
  db: DatabaseSync,
  sessionId: string,
  overrides: {
    permissionModes?: string[] | null;
    sources?: string[];
    updatedAt?: number;
  } = {},
): void {
  const modes =
    overrides.permissionModes === undefined
      ? ["default"]
      : overrides.permissionModes;
  run(
    db,
    "INSERT INTO session_conditions (session_id, permission_modes, sources_seen, updated_at) VALUES (?, ?, ?, ?)",
    sessionId,
    modes === null ? null : JSON.stringify(modes),
    JSON.stringify(overrides.sources ?? ["hook", "telemetry"]),
    overrides.updatedAt ?? 0,
  );
}

export function seedSegment(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    kind?: string;
    startedAt?: number;
    contextTokens?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO segments (id, session_id, kind, started_at, context_tokens) VALUES (?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.kind ?? "startup",
    overrides.startedAt ?? 0,
    overrides.contextTokens ?? null,
  );
}

export function seedLoad(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    kind?: string;
    name?: string | null;
    trigger?: string | null;
    filePath?: string | null;
    occurredAt?: number;
    source?: string;
    sizeBytes?: number | null;
    itemCount?: number | null;
    names?: string[] | null;
    branchId?: number | null;
    parentLoadId?: number | null;
    lineCount?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO loads (id, session_id, kind, name, trigger, file_path, occurred_at, source, size_bytes, item_count, names, branch_id, parent_load_id, line_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.kind ?? "skill",
    overrides.name ?? null,
    overrides.trigger ?? null,
    overrides.filePath ?? null,
    overrides.occurredAt ?? 0,
    overrides.source ?? "hook",
    overrides.sizeBytes ?? null,
    overrides.itemCount ?? null,
    storedJson(overrides.names),
    overrides.branchId ?? null,
    overrides.parentLoadId ?? null,
    overrides.lineCount ?? null,
  );
}

export function seedPromptAttachment(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    turnId: number;
    kind: string;
    name?: string | null;
    sizeBytes?: number | null;
    lineCount?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO prompt_attachments (id, session_id, turn_id, kind, name, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.turnId,
    overrides.kind,
    overrides.name ?? null,
    overrides.sizeBytes ?? null,
    overrides.lineCount ?? null,
  );
}

export function seedCompactionFile(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    at: number;
    name: string;
    sizeBytes?: number | null;
    reread?: boolean;
  },
): number {
  return run(
    db,
    "INSERT INTO compaction_files (id, session_id, at, name, size_bytes, reread) VALUES (?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.at,
    overrides.name,
    overrides.sizeBytes ?? null,
    overrides.reread === false ? 0 : 1,
  );
}

export function seedTurn(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    sequence?: number;
    startedAt?: number | null;
    endedAt?: number | null;
    promptText?: string | null;
    flightpathCommand?: boolean;
    promptChars?: number | null;
    promptLines?: number | null;
    imageCount?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO turns (id, session_id, sequence, started_at, ended_at, prompt_text, flightpath_command, prompt_chars, prompt_lines, image_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.sequence ?? 1,
    overrides.startedAt === undefined ? 0 : overrides.startedAt,
    overrides.endedAt ?? null,
    overrides.promptText ?? null,
    overrides.flightpathCommand ? 1 : 0,
    overrides.promptChars ?? null,
    overrides.promptLines ?? null,
    overrides.imageCount ?? null,
  );
}

export function seedBranch(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    agentId?: string | null;
    agentType?: string | null;
    kind?: string | null;
    spawningStepId?: number | null;
    startedAt?: number | null;
    endedAt?: number | null;
    totalTokens?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO branches (id, session_id, agent_id, agent_type, kind, spawning_step_id, started_at, ended_at, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.agentId ?? null,
    overrides.agentType ?? null,
    overrides.kind === undefined ? "user" : overrides.kind,
    overrides.spawningStepId ?? null,
    overrides.startedAt === undefined ? 0 : overrides.startedAt,
    overrides.endedAt ?? null,
    overrides.totalTokens ?? null,
  );
}

export function seedStep(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    turnId?: number | null;
    branchId?: number | null;
    toolName?: string;
    /** The step's input: an object to store as JSON, or a stored string. */
    input?: unknown;
    outcome?: string | null;
    startedAt?: number | null;
    endedAt?: number | null;
    durationMs?: number | null;
    resultSize?: number | null;
    resultRequestId?: number | null;
    contextChars?: number | null;
    asyncLaunch?: number | null;
    toolUseId?: string | null;
    savedOutputBytes?: number | null;
  },
): number {
  const startedAt = overrides.startedAt === undefined ? 0 : overrides.startedAt;
  const durationMs = overrides.durationMs ?? null;
  const endedAt =
    overrides.endedAt ??
    (durationMs !== null && startedAt !== null ? startedAt + durationMs : null);
  const input = overrides.input;
  return run(
    db,
    "INSERT INTO steps (id, session_id, turn_id, branch_id, tool_name, input_summary, outcome, started_at, ended_at, duration_ms, result_size, result_request_id, context_chars, async_launch, tool_use_id, saved_output_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.turnId ?? null,
    overrides.branchId ?? null,
    overrides.toolName ?? "Read",
    storedJson(input),
    overrides.outcome === undefined ? "succeeded" : overrides.outcome,
    startedAt,
    endedAt,
    durationMs,
    overrides.resultSize ?? null,
    overrides.resultRequestId ?? null,
    overrides.contextChars ?? null,
    overrides.asyncLaunch ?? null,
    overrides.toolUseId ?? null,
    overrides.savedOutputBytes ?? null,
  );
}

export function seedRequest(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    turnId?: number | null;
    branchId?: number | null;
    model?: string | null;
    querySource?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWrite5mTokens?: number | null;
    cacheWrite1hTokens?: number | null;
    tokenSource?: string | null;
    startedAt?: number | null;
    durationMs?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO requests (id, session_id, turn_id, branch_id, model, query_source, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, started_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.turnId ?? null,
    overrides.branchId ?? null,
    overrides.model === undefined ? "claude-sonnet-4-5" : overrides.model,
    overrides.querySource === undefined ? "main" : overrides.querySource,
    overrides.inputTokens ?? 0,
    overrides.outputTokens ?? 0,
    overrides.cacheReadTokens ?? 0,
    overrides.cacheWrite5mTokens ?? 0,
    overrides.cacheWrite1hTokens ?? 0,
    overrides.tokenSource === undefined ? "telemetry" : overrides.tokenSource,
    overrides.startedAt === undefined ? 0 : overrides.startedAt,
    overrides.durationMs === undefined ? 1000 : overrides.durationMs,
  );
}

export function seedSample(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    requestId?: number | null;
    sampledAt?: number;
    contextTokens?: number;
    source?: string;
  },
): number {
  return run(
    db,
    "INSERT INTO context_samples (id, session_id, request_id, sampled_at, context_tokens, source) VALUES (?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.requestId ?? null,
    overrides.sampledAt ?? 0,
    overrides.contextTokens ?? 0,
    overrides.source ?? "telemetry",
  );
}

export function seedMoment(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    turnId?: number | null;
    stepId?: number | null;
    kind: string;
    occurredAt?: number;
    decision?: string | null;
    /** Defaults to "inferred" for a decision, null without one. */
    decisionSource?: string | null;
    detail?: string | null;
  },
): number {
  const decision = overrides.decision ?? null;
  let decisionSource = overrides.decisionSource;
  if (decisionSource === undefined) {
    decisionSource = decision === null ? null : "inferred";
  }
  return run(
    db,
    "INSERT INTO human_events (id, session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.turnId ?? null,
    overrides.stepId ?? null,
    overrides.kind,
    overrides.occurredAt ?? 0,
    decision,
    decisionSource,
    overrides.detail ?? null,
  );
}

export function seedPause(
  db: DatabaseSync,
  overrides: {
    id?: number;
    sessionId: string;
    pausedAt?: number;
    resumedAt?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO pauses (id, session_id, paused_at, resumed_at) VALUES (?, ?, ?, ?)",
    overrides.id ?? null,
    overrides.sessionId,
    overrides.pausedAt ?? 0,
    overrides.resumedAt ?? null,
  );
}

export function seedRawEvent(
  db: DatabaseSync,
  overrides: {
    source?: string;
    sessionId: string;
    receivedAt?: number;
    eventAt?: number | null;
    redactionVersion?: number;
    /** The stored body: an object to store as JSON, or a stored string. */
    body: unknown;
  },
): void {
  run(
    db,
    "INSERT INTO raw_events (source, session_id, received_at, event_at, redaction_version, body) VALUES (?, ?, ?, ?, ?, ?)",
    overrides.source ?? "hook",
    overrides.sessionId,
    overrides.receivedAt ?? 0,
    overrides.eventAt === undefined ? null : overrides.eventAt,
    overrides.redactionVersion ?? 1,
    storedJson(overrides.body),
  );
}

/**
 * A realistic long session, seeded whole: 500 turns of ten
 * steps, a request and a context sample behind every step,
 * three human moments in every turn, and one branch over
 * the ten steps in the middle. `openTail` leaves the last
 * turn and its last step open, for a reader measuring a
 * session that is still live.
 */
export function seedRealisticSession(
  db: DatabaseSync,
  overrides: { id?: string; base: number; status?: string; openTail?: boolean },
): void {
  const id = overrides.id ?? "sess-big";
  const base = overrides.base;
  const openTail = overrides.openTail ?? false;
  seedSession(db, {
    id,
    projectPath: "/home/user/big",
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
    firstSeenAt: base,
    lastSeenAt: base + 30_600_000,
  });
  seedConditions(db, id, { updatedAt: base });
  for (let turn = 1; turn <= 500; turn += 1) {
    const at = base + turn * 60_000;
    seedTurn(db, {
      id: turn,
      sessionId: id,
      sequence: turn,
      startedAt: at,
      endedAt: openTail && turn === 500 ? null : at + 50_000,
      promptText: "A prompt",
    });
    seedMoment(db, {
      sessionId: id,
      turnId: turn,
      kind: "prompt",
      occurredAt: at,
    });
    seedMoment(db, {
      sessionId: id,
      turnId: turn,
      kind: "question_answered",
      occurredAt: at + 30_000,
    });
    seedMoment(db, {
      sessionId: id,
      turnId: turn,
      kind: "interrupt",
      occurredAt: at + 45_000,
    });
    for (let step = 0; step < 10; step += 1) {
      const isOpen = openTail && turn === 500 && step === 9;
      seedStep(db, {
        sessionId: id,
        turnId: turn,
        toolName: "Read",
        input: { file_path: "src/file.js" },
        outcome: isOpen ? "open" : "succeeded",
        startedAt: at + step * 1_000,
        endedAt: isOpen ? null : at + step * 1_000,
        durationMs: isOpen ? null : 10,
        resultSize: 100,
      });
      seedRequest(db, {
        sessionId: id,
        turnId: turn,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 40_000,
        cacheWrite5mTokens: 1_000,
        startedAt: at + step * 1_000,
      });
      seedSample(db, {
        sessionId: id,
        sampledAt: at + step * 1_000,
        contextTokens: 42_000,
      });
    }
  }
  seedBranch(db, {
    id: 1,
    sessionId: id,
    agentId: "agent-big",
    agentType: "worker",
    spawningStepId: 2500,
    startedAt: base + 250 * 60_000,
    endedAt: base + 251 * 60_000,
    totalTokens: 5000,
  });
  db.exec("UPDATE steps SET branch_id = 1 WHERE id BETWEEN 2491 AND 2500");
  db.exec(
    "UPDATE requests SET branch_id = 1, query_source = 'subagent' WHERE id BETWEEN 2491 AND 2500",
  );
}

/** A session with one ended turn, 0 to 9,000 — the stage
 * most token fixtures play on. */
export function seedOneTurn(
  db: DatabaseSync,
  id: string,
  model?: string,
): void {
  if (model === undefined) seedSession(db, { id });
  else seedSession(db, { id, model });
  seedTurn(db, {
    id: 1,
    sessionId: id,
    sequence: 1,
    startedAt: 0,
    endedAt: 9_000,
  });
}

/**
 * A request with exactly the counts given, nulls included —
 * seedRequest defaults an unrecorded count to zero, which is
 * not what a fixture about recorded and unrecorded counts can
 * plant. Model and source are a main-thread request's.
 */
export function seedRequestExact(
  db: DatabaseSync,
  overrides: {
    id: number;
    sessionId: string;
    turnId?: number | null;
    branchId?: number | null;
    model?: string;
    querySource?: string | null;
    startedAt?: number | null;
    durationMs?: number | null;
    effort?: string | null;
    shapeHash?: string | null;
    input?: number | null;
    output?: number | null;
    cacheRead?: number | null;
    cacheWrite5m?: number | null;
    cacheWrite1h?: number | null;
  },
): number {
  return run(
    db,
    "INSERT INTO requests (id, session_id, turn_id, branch_id, model, query_source, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, started_at, duration_ms, effort, shape_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'telemetry', ?, ?, ?, ?)",
    overrides.id,
    overrides.sessionId,
    overrides.turnId ?? null,
    overrides.branchId ?? null,
    overrides.model ?? "claude-sonnet",
    overrides.querySource ?? "main",
    overrides.input ?? null,
    overrides.output ?? null,
    overrides.cacheRead ?? null,
    overrides.cacheWrite5m ?? null,
    overrides.cacheWrite1h ?? null,
    overrides.startedAt ?? null,
    overrides.durationMs ?? null,
    overrides.effort ?? null,
    overrides.shapeHash ?? null,
  );
}

/** One recorded request shape: the system prompt's size and
 * its tool definitions' sizes, as the recorder stores them —
 * names and sizes only, never a description. */
export function seedRequestShape(
  db: DatabaseSync,
  overrides: {
    hash: string;
    systemBytes?: number | null;
    tools?: { name: string; bytes: number; mcp: boolean }[];
  },
): void {
  run(
    db,
    "INSERT INTO request_shapes (hash, system_bytes, tools) VALUES (?, ?, ?)",
    overrides.hash,
    overrides.systemBytes ?? null,
    JSON.stringify(overrides.tools ?? []),
  );
}

/**
 * The planted session the token lenses are checked against:
 * three turns, fourteen main requests whose context totals
 * are known by construction, a title request between the
 * fifth and sixth, and a user branch whose two requests
 * measure less than its stored total. Each main request's
 * total is split across input and cache, with an output the
 * context points must not count, and a context sample carries
 * the same total the way the recording's samples do. The
 * rises between the requests are planted too: steps with
 * known sizes and result links, a skill load, a compact
 * segment the last requests straddle — the ground truth the
 * fixture generator in the docs plants, row for row.
 */
export function seedPlantedSession(
  db: DatabaseSync,
  overrides: { branchShapeHash?: string | null } = {},
): string {
  const S = "sess-tokens";
  seedSession(db, { id: S, model: "claude-sonnet-5-5", joinedPartway: true });
  db.prepare("UPDATE sessions SET tokens_partial = 1 WHERE id = ?").run(S);
  seedConditions(db, S, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 1,
    sessionId: S,
    sequence: 1,
    startedAt: 0,
    endedAt: 9_000,
    promptChars: 17,
  });
  seedTurn(db, {
    id: 2,
    sessionId: S,
    sequence: 2,
    startedAt: 11_000,
    endedAt: 25_000,
    promptChars: 23,
  });
  seedTurn(db, {
    id: 3,
    sessionId: S,
    sequence: 3,
    startedAt: 30_000,
    endedAt: 40_000,
    promptChars: 145,
  });
  seedSegment(db, {
    id: 1,
    sessionId: S,
    kind: "startup",
    startedAt: 0,
    contextTokens: 20_000,
  });
  seedSegment(db, {
    id: 2,
    sessionId: S,
    kind: "compact",
    startedAt: 76_000,
    contextTokens: 25_000,
  });
  seedLoad(db, {
    id: 1,
    sessionId: S,
    kind: "skill",
    name: "deep-research",
    occurredAt: 45_000,
  });
  const main: {
    id: number;
    turnId: number;
    startedAt: number;
    input: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    output: number;
    total: number;
  }[] = [
    {
      id: 1,
      turnId: 1,
      startedAt: 1_000,
      input: 20_000,
      output: 300,
      total: 20_000,
    },
    {
      id: 2,
      turnId: 1,
      startedAt: 6_000,
      input: 2_000,
      cacheRead: 50_000,
      cacheWrite5m: 3_000,
      output: 400,
      total: 55_000,
    },
    {
      id: 3,
      turnId: 1,
      startedAt: 10_000,
      input: 3_000,
      cacheRead: 70_000,
      output: 500,
      total: 73_000,
    },
    {
      id: 4,
      turnId: 2,
      startedAt: 15_000,
      input: 1_000,
      cacheRead: 72_000,
      output: 200,
      total: 73_000,
    },
    {
      id: 5,
      turnId: 2,
      startedAt: 21_000,
      input: 5_000,
      cacheRead: 80_000,
      output: 200,
      total: 85_000,
    },
    {
      id: 6,
      turnId: 2,
      startedAt: 23_000,
      input: 1_000,
      cacheRead: 84_000,
      output: 200,
      total: 85_000,
    },
    {
      id: 7,
      turnId: 3,
      startedAt: 31_000,
      input: 3_000,
      cacheRead: 90_000,
      output: 600,
      total: 93_000,
    },
    {
      id: 8,
      turnId: 3,
      startedAt: 36_000,
      input: 3_000,
      cacheRead: 190_000,
      output: 700,
      total: 193_000,
    },
    {
      id: 9,
      turnId: 3,
      startedAt: 39_000,
      input: 2_000,
      cacheRead: 195_000,
      output: 300,
      total: 197_000,
    },
    {
      id: 10,
      turnId: 3,
      startedAt: 46_000,
      input: 2_000,
      cacheRead: 200_000,
      output: 300,
      total: 202_000,
    },
    {
      id: 11,
      turnId: 3,
      startedAt: 55_000,
      input: 2_000,
      cacheRead: 200_000,
      output: 300,
      total: 202_000,
    },
    {
      id: 12,
      turnId: 3,
      startedAt: 70_000,
      input: 2_000,
      cacheRead: 200_000,
      output: 300,
      total: 202_000,
    },
    {
      id: 13,
      turnId: 3,
      startedAt: 76_000,
      input: 5_000,
      cacheRead: 20_000,
      output: 300,
      total: 25_000,
    },
    {
      id: 14,
      turnId: 3,
      startedAt: 80_000,
      input: 2_000,
      cacheRead: 25_000,
      output: 300,
      total: 27_000,
    },
  ];
  for (const seed of main) {
    const { total, ...request } = seed;
    seedRequestExact(db, {
      sessionId: S,
      model: "claude-sonnet-5-5",
      ...request,
    });
    seedSample(db, {
      sessionId: S,
      requestId: seed.id,
      sampledAt: seed.startedAt,
      contextTokens: total,
    });
  }
  seedRequestExact(db, {
    id: 90,
    sessionId: S,
    turnId: 2,
    querySource: "title",
    startedAt: 22_000,
    input: 1_500,
    output: 50,
  });
  // The planted causes the token lenses are checked against:
  // each step's size, and the request its result first
  // counted in, as the transcript link records it. Seeded
  // after the requests, which the link names.
  seedStep(db, {
    id: 1,
    sessionId: S,
    turnId: 1,
    toolName: "Read",
    startedAt: 2_000,
    endedAt: 5_000,
    resultSize: 101_500,
    resultRequestId: 2,
  });
  seedStep(db, {
    id: 2,
    sessionId: S,
    turnId: 1,
    toolName: "Bash",
    startedAt: 7_000,
    endedAt: 9_000,
    resultSize: 5_800,
    resultRequestId: 3,
  });
  seedStep(db, {
    id: 3,
    sessionId: S,
    turnId: 1,
    toolName: "Read",
    startedAt: 7_000,
    endedAt: 9_500,
    resultSize: 46_400,
    resultRequestId: 3,
  });
  seedStep(db, {
    id: 4,
    sessionId: S,
    turnId: 2,
    toolName: "Task",
    startedAt: 12_000,
    endedAt: 20_000,
    resultSize: 34_800,
    resultRequestId: 5,
  });
  seedStep(db, {
    id: 5,
    sessionId: S,
    turnId: 3,
    toolName: "Read",
    startedAt: 32_000,
    endedAt: 35_999,
    resultSize: 145_000,
    resultRequestId: 8,
  });
  seedStep(db, {
    id: 6,
    sessionId: S,
    turnId: 3,
    toolName: "Bash",
    startedAt: 37_000,
    endedAt: 38_000,
    resultSize: 2_900,
    resultRequestId: 9,
  });
  seedStep(db, {
    id: 7,
    sessionId: S,
    turnId: 3,
    toolName: "Bash",
    startedAt: 50_000,
    endedAt: 75_000,
    resultSize: 217_500,
    resultRequestId: 13,
  });
  seedBranch(db, {
    id: 1,
    sessionId: S,
    agentId: "agent-1",
    agentType: "Explore",
    kind: "user",
    spawningStepId: 4,
    totalTokens: 61_000,
  });
  seedRequestExact(db, {
    id: 101,
    sessionId: S,
    turnId: 2,
    branchId: 1,
    model: "claude-sonnet-5-5",
    querySource: "subagent",
    startedAt: 13_000,
    input: 8_000,
  });
  seedRequestExact(db, {
    id: 102,
    sessionId: S,
    turnId: 2,
    branchId: 1,
    model: "claude-sonnet-5-5",
    querySource: "subagent",
    startedAt: 16_000,
    input: 2_000,
    cacheRead: 45_000,
    shapeHash: overrides.branchShapeHash ?? null,
  });
  return S;
}

/**
 * A 1M session whose turns grew by known amounts: seven
 * ended turns growing 10K..70K from a 100,000 base, then an
 * ended turn that shrank and an open turn that grew — the
 * two a turns-left estimate must not read. The series' last
 * point is 290,000 either way.
 */
export function seedGrowthSession(db: DatabaseSync): string {
  const S = "sess-room-median";
  seedSession(db, { id: S, model: "claude-sonnet[1m]" });
  const growths = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000];
  let at = 0;
  let requestId = 0;
  growths.forEach((growth, index) => {
    const turnId = index + 1;
    seedTurn(db, {
      id: turnId,
      sessionId: S,
      sequence: turnId,
      startedAt: at,
      endedAt: at + 9_000,
    });
    seedRequestExact(db, {
      id: ++requestId,
      sessionId: S,
      model: "claude-sonnet[1m]",
      turnId,
      startedAt: at + 1_000,
      input: 100_000,
    });
    seedRequestExact(db, {
      id: ++requestId,
      sessionId: S,
      model: "claude-sonnet[1m]",
      turnId,
      startedAt: at + 2_000,
      input: 100_000 + growth,
    });
    at += 10_000;
  });
  seedTurn(db, {
    id: 8,
    sessionId: S,
    sequence: 8,
    startedAt: at,
    endedAt: at + 9_000,
  });
  seedRequestExact(db, {
    id: ++requestId,
    sessionId: S,
    model: "claude-sonnet[1m]",
    turnId: 8,
    startedAt: at + 1_000,
    input: 290_000,
  });
  seedRequestExact(db, {
    id: ++requestId,
    sessionId: S,
    model: "claude-sonnet[1m]",
    turnId: 8,
    startedAt: at + 2_000,
    input: 285_000,
  });
  at += 10_000;
  seedTurn(db, {
    id: 9,
    sessionId: S,
    sequence: 9,
    startedAt: at,
    endedAt: null,
  });
  seedRequestExact(db, {
    id: ++requestId,
    sessionId: S,
    model: "claude-sonnet[1m]",
    turnId: 9,
    startedAt: at + 1_000,
    input: 285_000,
  });
  seedRequestExact(db, {
    id: ++requestId,
    sessionId: S,
    model: "claude-sonnet[1m]",
    turnId: 9,
    startedAt: at + 2_000,
    input: 290_000,
  });
  return S;
}

/** One recorded session: a single turn whose steps are tool
 * calls, each with the request that made it, over a context
 * that grows sample by sample. */
export function seedStepsSession(
  db: DatabaseSync,
  seed: {
    id: string;
    projectPath: string;
    start: number;
    prompt: string;
    steps: { toolName: string; input: unknown }[];
    samples: [
      { sampledAt: number; contextTokens: number },
      ...{ sampledAt: number; contextTokens: number }[],
    ];
  },
): void {
  const { id, start } = seed;
  seedSession(db, {
    id,
    projectPath: seed.projectPath,
    firstSeenAt: start,
    lastSeenAt: start + 900_000,
  });
  seedConditions(db, id, {});
  seedSegment(db, {
    sessionId: id,
    startedAt: start,
    contextTokens: seed.samples[0].contextTokens,
  });
  const turn = seedTurn(db, {
    sessionId: id,
    sequence: 1,
    startedAt: start + 10_000,
    endedAt: start + 200_000,
    promptText: seed.prompt,
  });
  seedMoment(db, {
    sessionId: id,
    turnId: turn,
    kind: "prompt",
    occurredAt: start + 10_000,
    detail: seed.prompt,
  });
  seed.steps.forEach((step, index) => {
    seedRequest(db, {
      sessionId: id,
      turnId: turn,
      startedAt: start + 19_000 + index * 20_000,
      durationMs: 900,
      inputTokens: 100,
      outputTokens: 50,
    });
    seedStep(db, {
      sessionId: id,
      turnId: turn,
      toolName: step.toolName,
      input: step.input,
      outcome: "succeeded",
      startedAt: start + 20_000 + index * 20_000,
      durationMs: 400,
    });
  });
  for (const sample of seed.samples) {
    seedSample(db, {
      sessionId: id,
      sampledAt: sample.sampledAt,
      contextTokens: sample.contextTokens,
    });
  }
}
