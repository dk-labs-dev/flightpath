import { afterEach, describe, expect, it } from "vitest";

import type { RunningDaemon } from "../src/daemon/server.js";
import { defaultSettings, type Settings } from "../src/settings/index.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import { createTelemetryIntake } from "../src/telemetry/index.js";
import { registerCleanup, runCleanups } from "./support/cleanup.js";
import { callDaemon } from "./support/daemon.js";
import { recordHookEvent } from "./support/events.js";
import { removeTree } from "./support/remove-tree.js";
import { firstRow, rowAt } from "./support/rows.js";
import { allStoredText, queryRows } from "./support/storage.js";
import {
  startTelemetryDaemon,
  telemetryExport,
  telemetryRecord,
} from "./support/telemetry.js";
import { makeTelemetryWorld } from "./support/worlds.js";

// Telemetry intake (ADR-0012, ADR-0017): a hand-built OTLP/HTTP
// JSON export with every event type, merged into a journey the
// hooks recorded. No fixture here is captured telemetry.

const T0 = Date.parse("2026-10-24T10:00:00.000Z");

const daemons: RunningDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.shutdown("signal");
  await runCleanups();
});

const SETTINGS: Settings = defaultSettings();

function recordMergedJourney(storage: Storage): void {
  // The hook-recorded journey telemetry will correct and extend.
  recordHookEvent(
    storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-t",
      source: "startup",
      cwd: "/home/user/proj-a",
      version: "2.0.0",
    },
    T0,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-t",
      prompt_id: "p-1",
      prompt: "run the build",
    },
    T0 + 1000,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-t",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "make" },
    },
    T0 + 2000,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "PermissionRequest",
      session_id: "sess-t",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
    },
    T0 + 2100,
  );
  // The tool ran, so the hooks infer an accepted decision.
  recordHookEvent(
    storage,
    {
      hook_event_name: "PostToolUse",
      session_id: "sess-t",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_response: "ok",
    },
    T0 + 3000,
  );
  // A second step never closes; the turn's end closes it by
  // inference, and telemetry's failed result corrects it.
  recordHookEvent(
    storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-t",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_2",
      tool_input: { command: "make test" },
    },
    T0 + 4000,
  );
  recordHookEvent(
    storage,
    { hook_event_name: "Stop", session_id: "sess-t" },
    T0 + 5000,
  );
  // A branch for the subagent totals to land on.
  recordHookEvent(
    storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-t",
      prompt_id: "p-1",
      tool_name: "Agent",
      tool_use_id: "toolu_agent",
      tool_input: { subagent_type: "explore" },
    },
    T0 + 2500,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "SubagentStart",
      session_id: "sess-t",
      agent_id: "a1",
      agent_type: "explore",
    },
    T0 + 2600,
  );
}

function mergedRecords(): Record<string, unknown>[] {
  const base = { "session.id": "sess-t" };
  return [
    telemetryRecord(
      "claude_code.api_request",
      {
        ...base,
        "prompt.id": "p-1",
        request_id: "req-t1",
        model: "claude-sonnet",
        query_source: "repl_main_thread",
        input_tokens: 5000,
        output_tokens: 400,
        cache_read_tokens: 2000,
        cache_creation_tokens: 60,
        duration_ms: 800,
        cost_usd: 0.0042,
      },
      T0 + 2900,
      1,
    ),
    telemetryRecord(
      "claude_code.api_request",
      {
        ...base,
        request_id: "req-bg",
        model: "claude-haiku",
        query_source: "prompt_suggestion",
        input_tokens: 300,
        output_tokens: 25,
      },
      T0 + 3100,
      2,
    ),
    telemetryRecord(
      "claude_code.user_prompt",
      { ...base, "prompt.id": "p-2", prompt_length: "17" },
      T0 + 6000,
      3,
    ),
    telemetryRecord(
      "claude_code.tool_decision",
      {
        ...base,
        tool_use_id: "toolu_1",
        decision: "reject",
        source: "user_reject",
      },
      T0 + 2950,
      4,
    ),
    telemetryRecord(
      "claude_code.tool_result",
      {
        ...base,
        tool_use_id: "toolu_2",
        // A real export sends success as a string.
        success: "false",
        duration_ms: "120",
      },
      T0 + 5200,
      5,
    ),
    telemetryRecord(
      "claude_code.skill_activated",
      { ...base, "skill.name": "deep-research" },
      T0 + 1500,
      6,
    ),
    telemetryRecord(
      "claude_code.compaction",
      {
        ...base,
        pre_tokens: "9000",
        post_tokens: "3000",
        duration_ms: "2000",
      },
      T0 + 7000,
      7,
    ),
    telemetryRecord(
      "claude_code.subagent_completed",
      { ...base, agent_type: "explore", total_tokens: 4321 },
      T0 + 8000,
      8,
    ),
    telemetryRecord(
      "claude_code.hook_execution_complete",
      {
        ...base,
        hook_name: "flightpath",
        hook_event: "SessionStart",
        total_duration_ms: "30",
        num_hooks: "2",
      },
      T0 + 2200,
      9,
    ),
    telemetryRecord(
      "claude_code.hook_execution_complete",
      {
        ...base,
        hook_name: "other-plugin",
        hook_event: "SessionStart",
        total_duration_ms: "55",
        num_hooks: "2",
      },
      T0 + 2300,
      10,
    ),
  ];
}

function buildMergedJourney() {
  const { storage } = makeTelemetryWorld();
  recordMergedJourney(storage);
  const result = createTelemetryIntake().processExport(
    storage,
    telemetryExport(mergedRecords()),
    { settings: SETTINGS, receivedAt: T0 + 9000 },
  );
  return { storage, result };
}

describe("telemetry intake", () => {
  it("merges telemetry api requests into the journey", () => {
    const { storage, result } = buildMergedJourney();
    expect(result.accepted).toBe(10);
    expect(result.dropped).toBe(0);
    const requests = queryRows(
      storage.dbPath,
      "SELECT * FROM requests WHERE session_id = 'sess-t' ORDER BY request_id",
    );
    expect(requests).toHaveLength(2);
    const background = rowAt(requests, 0, "the background request");
    const main = rowAt(requests, 1, "the main request");
    expect(main.request_id).toBe("req-t1");
    expect(main.token_source).toBe("telemetry");
    expect(main.duration_ms).toBe(800);
    expect(main.cache_write_5m_tokens).toBe(60);
    const turn = queryRows(
      storage.dbPath,
      "SELECT id FROM turns WHERE session_id = 'sess-t' AND prompt_id = 'p-1'",
    ) as { id: number }[];
    expect(main.turn_id).toBe(firstRow(turn, "the turn").id);
    expect(background.request_id).toBe("req-bg");
    expect(background.query_source).toBe("suggestion");
    expect(background.turn_id).toBeNull();
  });

  it("turns a telemetry-only prompt into a turn with its event", () => {
    const { storage } = buildMergedJourney();
    const turns = queryRows(
      storage.dbPath,
      "SELECT prompt_id FROM turns WHERE session_id = 'sess-t' ORDER BY sequence",
    ) as { prompt_id: string }[];
    expect(turns.map((row) => row.prompt_id)).toEqual(["p-1", "p-2"]);
    const promptEvents = queryRows(
      storage.dbPath,
      "SELECT detail FROM human_events WHERE kind = 'prompt' AND session_id = 'sess-t'",
    ) as { detail: string }[];
    expect(promptEvents).toHaveLength(2);
    expect(promptEvents.map((row) => row.detail)).toContain(
      JSON.stringify({ prompt_length: 17 }),
    );
  });

  it("corrects the inferred permission decision and step outcome from telemetry", () => {
    const { storage } = buildMergedJourney();
    // The inferred decision was corrected to telemetry's.
    const decisions = queryRows(
      storage.dbPath,
      "SELECT decision, decision_source FROM human_events WHERE kind = 'permission_decision' AND session_id = 'sess-t'",
    );
    expect(decisions).toHaveLength(1);
    const decision = firstRow(decisions, "the permission decision");
    expect(decision.decision).toBe("reject");
    expect(decision.decision_source).toBe("user_reject");
    // The inferred step outcome was corrected to failed.
    const steps = queryRows(
      storage.dbPath,
      "SELECT outcome, outcome_source, duration_ms FROM steps WHERE session_id = 'sess-t' AND tool_use_id = 'toolu_2'",
    );
    const step = firstRow(steps, "the corrected step");
    expect(step.outcome).toBe("failed");
    expect(step.outcome_source).toBe("telemetry");
    expect(step.duration_ms).toBe(120);
  });

  it("merges skill loads, compaction segments and subagent totals", () => {
    const { storage } = buildMergedJourney();
    const loads = queryRows(
      storage.dbPath,
      "SELECT name, source FROM loads WHERE session_id = 'sess-t' AND kind = 'skill'",
    );
    expect(loads).toEqual([{ name: "deep-research", source: "telemetry" }]);
    const segments = queryRows(
      storage.dbPath,
      "SELECT kind, context_tokens FROM segments WHERE session_id = 'sess-t' AND kind = 'compact'",
    );
    expect(segments).toEqual([{ kind: "compact", context_tokens: 3000 }]);
    const branches = queryRows(
      storage.dbPath,
      "SELECT total_tokens, token_source FROM branches WHERE session_id = 'sess-t' AND agent_id = 'a1'",
    );
    const branch = firstRow(branches, "the subagent branch");
    expect(branch.total_tokens).toBe(4321);
    expect(branch.token_source).toBe("telemetry");
  });

  it("records hook execution stats in the session conditions", () => {
    const { storage } = buildMergedJourney();
    const conditions = queryRows(
      storage.dbPath,
      "SELECT sources_seen, hook_stats FROM session_conditions WHERE session_id = 'sess-t'",
    ) as { sources_seen: string; hook_stats: string }[];
    const condition = firstRow(conditions, "the session conditions");
    expect(JSON.parse(condition.sources_seen)).toContain("telemetry");
    expect(JSON.parse(condition.hook_stats)).toEqual({
      executions: 2,
      total_ms: 85,
      max_ms: 55,
      by_hook: {
        flightpath: { count: 1, total_ms: 30, max_ms: 30, num_hooks: 2 },
        "other-plugin": { count: 1, total_ms: 55, max_ms: 55, num_hooks: 2 },
      },
    });
  });

  it("stores no identity and no dollars from telemetry", () => {
    const { storage } = buildMergedJourney();
    const stored = allStoredText(storage);
    expect(stored).not.toContain("PLANTED-EMAIL");
    expect(stored).not.toContain("PLANTED-ACCOUNT");
    expect(stored).not.toContain("cost_usd");
    expect(stored).not.toContain("0.0042");
  });

  it("gives the same single row whichever source arrives second, split intact", () => {
    const outcomes: Record<string, unknown>[] = [];
    for (const telemetryFirst of [false, true]) {
      const { storage } = makeTelemetryWorld();
      recordHookEvent(
        storage,
        {
          hook_event_name: "SessionStart",
          session_id: "sess-o",
          source: "startup",
          cwd: "/home/user/proj-a",
        },
        T0,
      );
      const fromTranscript = (): void => {
        storage.upsertRequest({
          sessionId: "sess-o",
          requestId: "req-o",
          turnId: null,
          branchId: null,
          model: "claude-sonnet",
          querySource: "main",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWrite5mTokens: 40,
          cacheWrite1hTokens: 10,
          tokenSource: "transcript",
          startedAt: T0,
          durationMs: null,
        });
      };
      const fromTelemetry = (): void => {
        createTelemetryIntake().processExport(
          storage,
          telemetryExport([
            telemetryRecord(
              "claude_code.api_request",
              {
                "session.id": "sess-o",
                request_id: "req-o",
                model: "claude-sonnet",
                query_source: "repl_main_thread",
                input_tokens: 100,
                output_tokens: 10,
                cache_read_tokens: 5,
                cache_creation_tokens: 50,
                duration_ms: 700,
              },
              T0,
              1,
            ),
          ]),
          { settings: SETTINGS, receivedAt: T0 + 1000 },
        );
      };
      if (telemetryFirst) {
        fromTelemetry();
        fromTranscript();
      } else {
        fromTranscript();
        fromTelemetry();
      }
      const rows = queryRows(
        storage.dbPath,
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, duration_ms FROM requests WHERE session_id = 'sess-o'",
      );
      expect(rows).toHaveLength(1);
      outcomes.push(firstRow(rows, "the request row"));
    }
    const firstOutcome = firstRow(outcomes, "the first outcome");
    expect(firstOutcome).toEqual(rowAt(outcomes, 1, "the second outcome"));
    expect(firstOutcome.token_source).toBe("telemetry");
    expect(firstOutcome.cache_write_5m_tokens).toBe(40);
    expect(firstOutcome.cache_write_1h_tokens).toBe(10);
    expect(firstOutcome.duration_ms).toBe(700);
  });

  it("drops records for forgotten sessions, excluded folders and paused periods", () => {
    const { storage } = makeTelemetryWorld();
    recordHookEvent(
      storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-x",
        source: "startup",
        cwd: "/home/user/secret-project",
      },
      T0,
    );
    storage.recordPause("sess-x", T0 + 1000);
    storage.recordResume("sess-x", T0 + 5000);
    storage.forgetSession("sess-gone", T0);
    const apiRequest = (sessionId: string, at: number, sequence: number) =>
      telemetryRecord(
        "claude_code.api_request",
        {
          "session.id": sessionId,
          request_id: `req-${sessionId}-${at}`,
          input_tokens: 1,
          output_tokens: 1,
        },
        at,
        sequence,
      );
    const intake = createTelemetryIntake();
    const result = intake.processExport(
      storage,
      telemetryExport([
        apiRequest("sess-gone", T0 + 2000, 1),
        apiRequest("sess-x", T0 + 2000, 2), // inside the pause
        apiRequest("sess-x", T0 + 6000, 3), // after the pause
      ]),
      {
        settings: { ...SETTINGS, excludedFolders: [] },
        receivedAt: T0 + 9000,
      },
    );
    // The excluded-folder check needs the folder in the settings:
    // sess-x is only dropped for its paused record here.
    expect(result.dropped).toBe(2);
    const requests = queryRows(
      storage.dbPath,
      "SELECT request_id FROM requests WHERE session_id = 'sess-x'",
    ) as { request_id: string }[];
    expect(requests.map((row) => row.request_id)).toEqual([
      `req-sess-x-${T0 + 6000}`,
    ]);
    const excluded = intake.processExport(
      storage,
      telemetryExport([apiRequest("sess-x", T0 + 7000, 4)]),
      {
        settings: {
          ...SETTINGS,
          excludedFolders: ["/home/user/secret-project"],
        },
        receivedAt: T0 + 9000,
      },
    );
    expect(excluded.dropped).toBe(1);
    expect(excluded.accepted).toBe(0);
  });

  it("never creates a session the hooks have not admitted", () => {
    const { storage } = makeTelemetryWorld();
    const intake = createTelemetryIntake();
    const apiRequest = (sessionId: string, sequence: number) =>
      telemetryRecord(
        "claude_code.api_request",
        {
          "session.id": sessionId,
          request_id: `req-${sessionId}`,
          input_tokens: 5,
          output_tokens: 2,
        },
        T0 + 1000,
        sequence,
      );
    // Telemetry outruns the hook: held, and nothing is stored —
    // no session, no request, not even the raw record.
    const early = intake.processExport(
      storage,
      telemetryExport([apiRequest("sess-late", 1)]),
      { settings: SETTINGS, receivedAt: T0 + 1000 },
    );
    expect(early.held).toBe(1);
    expect(early.accepted).toBe(0);
    expect(
      queryRows(
        storage.dbPath,
        "SELECT id FROM sessions WHERE id = 'sess-late'",
      ),
    ).toHaveLength(0);
    expect(storage.countRawEvents("sess-late")).toBe(0);
    // The hook admits the session; the held record lands.
    recordHookEvent(
      storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-late",
        source: "startup",
        cwd: "/home/user/proj-a",
      },
      T0 + 1100,
    );
    const flushed = intake.flushSession(storage, "sess-late", {
      settings: SETTINGS,
    });
    expect(flushed.accepted).toBe(1);
    expect(
      queryRows(
        storage.dbPath,
        "SELECT request_id FROM requests WHERE session_id = 'sess-late'",
      ),
    ).toEqual([{ request_id: "req-sess-late" }]);
    // A session that never arrives — an excluded folder, or one
    // that started paused — loses its held records, and still
    // has no row.
    const never = intake.processExport(
      storage,
      telemetryExport([apiRequest("sess-never", 2)]),
      { settings: SETTINGS, receivedAt: T0 + 1000 },
    );
    expect(never.held).toBe(1);
    expect(intake.dropStale(T0 + 1000 + 16_000)).toBe(1);
    expect(
      queryRows(
        storage.dbPath,
        "SELECT id FROM sessions WHERE id = 'sess-never'",
      ),
    ).toHaveLength(0);
    expect(
      intake.flushSession(storage, "sess-never", { settings: SETTINGS })
        .accepted,
    ).toBe(0);
  });

  it("does not guess a branch for a request when parallel subagents of one type are open", () => {
    const { storage, result } = buildParallelSubagents();
    expect(result.accepted).toBe(2);
    // Neither the request nor the totals may land on a guessed
    // branch: two of the type are open.
    const requests = queryRows(
      storage.dbPath,
      "SELECT branch_id FROM requests WHERE session_id = 'sess-par'",
    );
    expect(requests).toHaveLength(1);
    expect(firstRow(requests, "the request").branch_id).toBeNull();
  });

  it("leaves parallel subagent totals to their transcripts", () => {
    const { storage } = buildParallelSubagents();
    const branches = queryRows(
      storage.dbPath,
      "SELECT total_tokens FROM branches WHERE session_id = 'sess-par' ORDER BY agent_id",
    );
    expect(branches.map((row) => row.total_tokens)).toEqual([null, null]);
  });

  it("gives a compaction one segment in either arrival order", () => {
    for (const telemetryFirst of [false, true]) {
      const { storage } = makeTelemetryWorld();
      const intake = createTelemetryIntake();
      recordHookEvent(
        storage,
        {
          hook_event_name: "SessionStart",
          session_id: "sess-c",
          source: "startup",
          cwd: "/home/user/proj-a",
        },
        T0,
      );
      const fromHook = (): void =>
        recordHookEvent(
          storage,
          {
            hook_event_name: "SessionStart",
            session_id: "sess-c",
            source: "compact",
            cwd: "/home/user/proj-a",
          },
          T0 + 5000,
        );
      const fromTelemetry = (): void => {
        intake.processExport(
          storage,
          telemetryExport([
            telemetryRecord(
              "claude_code.compaction",
              {
                "session.id": "sess-c",
                pre_tokens: "9000",
                post_tokens: "3000",
                duration_ms: "2000",
              },
              T0 + 5100,
              1,
            ),
          ]),
          { settings: SETTINGS, receivedAt: T0 + 6000 },
        );
      };
      if (telemetryFirst) {
        fromTelemetry();
        fromHook();
      } else {
        fromHook();
        fromTelemetry();
      }
      const segments = queryRows(
        storage.dbPath,
        "SELECT context_tokens FROM segments WHERE session_id = 'sess-c' AND kind = 'compact'",
      );
      expect(segments).toEqual([{ context_tokens: 3000 }]);
    }
  });
});

function buildParallelSubagents() {
  const { storage } = makeTelemetryWorld();
  const intake = createTelemetryIntake();
  recordHookEvent(
    storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-par",
      source: "startup",
      cwd: "/home/user/proj-a",
    },
    T0,
  );
  for (const [agentId, toolUseId, at] of [
    ["a1", "toolu_a1", T0 + 1000],
    ["a2", "toolu_a2", T0 + 1100],
  ] as const) {
    recordHookEvent(
      storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-par",
        prompt_id: "p-1",
        tool_name: "Agent",
        tool_use_id: toolUseId,
        tool_input: { subagent_type: "explore" },
      },
      at,
    );
    recordHookEvent(
      storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-par",
        agent_id: agentId,
        agent_type: "explore",
      },
      at + 100,
    );
  }
  const result = intake.processExport(
    storage,
    telemetryExport([
      telemetryRecord(
        "claude_code.api_request",
        {
          "session.id": "sess-par",
          request_id: "req-par",
          query_source: "agent:custom",
          agent_type: "explore",
          input_tokens: 10,
          output_tokens: 5,
        },
        T0 + 2000,
        1,
      ),
      telemetryRecord(
        "claude_code.subagent_completed",
        {
          "session.id": "sess-par",
          agent_type: "explore",
          total_tokens: 999,
        },
        T0 + 3000,
        2,
      ),
    ]),
    { settings: SETTINGS, receivedAt: T0 + 4000 },
  );
  return { storage, result };
}

describe("the /v1/logs endpoint", () => {
  async function startLogsDaemon() {
    const world = makeTelemetryWorld();
    const { dataDir, storage } = world;
    storage.close();
    // The daemon owns the folder now, so the world's storage
    // cleanup is released and only the tree removal stays.
    world.releaseStorageCleanup();
    registerCleanup(() => removeTree(world.root));
    const { daemon, token } = await startTelemetryDaemon(dataDir);
    daemons.push(daemon);
    const body = JSON.stringify(
      telemetryExport([
        telemetryRecord(
          "claude_code.api_request",
          {
            "session.id": "sess-http",
            request_id: "req-http",
            input_tokens: 11,
            output_tokens: 3,
          },
          T0,
          1,
        ),
      ]),
    );
    return { daemon, token, body, dataDir };
  }

  it("requires the token for /v1/logs", async () => {
    const { daemon, body } = await startLogsDaemon();
    const noToken = await callDaemon(daemon.port, {
      method: "POST",
      path: "/v1/logs",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(noToken.status).toBe(401);
  });

  it("refuses protobuf exports on /v1/logs", async () => {
    const { daemon, token } = await startLogsDaemon();
    const protobuf = await callDaemon(daemon.port, {
      method: "POST",
      path: "/v1/logs",
      token,
      headers: { "content-type": "application/x-protobuf" },
      body: "not json",
    });
    expect(protobuf.status).toBe(415);
  });

  it("stores JSON exports on /v1/logs once the session is admitted", async () => {
    const { daemon, token, body, dataDir } = await startLogsDaemon();
    // Telemetry applies only once the hooks have admitted the
    // session, so admit it first, as Claude Code's hooks do.
    const admit = await callDaemon(daemon.port, {
      method: "POST",
      path: "/events/hook",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "env-http-1",
        received_at: T0,
        event: {
          hook_event_name: "SessionStart",
          session_id: "sess-http",
          source: "startup",
          cwd: "/home/user/proj-a",
        },
      }),
    });
    expect(admit.status).toBe(204);
    const ok = await callDaemon(daemon.port, {
      method: "POST",
      path: "/v1/logs",
      token,
      headers: { "content-type": "application/json" },
      body,
    });
    expect(ok.status).toBe(200);
    const check = openStorage({ dataDir });
    try {
      const rows = queryRows(
        check.dbPath,
        "SELECT request_id, token_source FROM requests WHERE session_id = 'sess-http'",
      );
      expect(rows).toEqual([
        { request_id: "req-http", token_source: "telemetry" },
      ]);
    } finally {
      check.close();
    }
  });
});
