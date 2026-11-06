import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readProcessStartTimes } from "../src/util/host-process.js";
import { defaultSettings } from "../src/settings/index.js";
import {
  listSessions,
  sessionFindings,
  sessionSnapshot,
  stepDetail,
} from "../src/api/index.js";
import {
  ATTACHMENT_ROWS_SQL,
  BRANCH_ROWS_SQL,
  COMPACTION_FILES_SQL,
  DISMISSALS_SQL,
  HUMAN_ROWS_SQL,
  LIVE_SESSION_HOSTS_SQL,
  LIVE_SESSIONS_SQL,
  LOAD_ROWS_SQL,
  PAUSE_ROWS_SQL,
  REQUEST_ROWS_SQL,
  SAMPLE_ROWS_SQL,
  SEGMENT_ROWS_SQL,
  SESSION_LIST_SQL,
  SESSION_ROW_SQL,
  SESSION_SHAPES_SQL,
  STEP_BY_ID_SQL,
  STEP_ROWS_SQL,
  TURN_FOR_PROMPT_SQL,
  TURN_ROWS_SQL,
  openStorage,
  type Storage,
} from "../src/storage/index.js";
import { OVERHEAD_SQL } from "../src/storage/request-tokens.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  makeRoot,
  startTestDaemon,
  stopDaemon,
  type DaemonReply,
  type StartedDaemon,
} from "./support/daemon.js";
import { seedWarmPair } from "./support/rebuild-pair.js";
import {
  seedBranch,
  seedConditions,
  seedMoment,
  seedPause,
  seedPromptAttachment,
  seedRawEvent,
  seedRealisticSession,
  seedRequest,
  seedRequestExact,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// The read API, exercised on a database seeded row by row in
// the shapes the recorder writes: the endpoint, prompt-text
// and findings sections go through the built daemon over
// HTTP, the later ones call the read functions in-process.
// The fixture's numbers are chosen so the expected
// aggregates can be checked exactly.
const BASE = Date.now() - 7_200_000;
const MARKER = "MARKER-TOOL-OUTPUT-7f3a";

/** GET every path with the token, in order. */
async function getAll(
  port: number,
  token: string,
  paths: string[],
): Promise<DaemonReply[]> {
  const replies: DaemonReply[] = [];
  for (const path of paths) {
    replies.push(await callDaemon(port, { method: "GET", path, token }));
  }
  return replies;
}

async function seedFixture(dataDir: string): Promise<void> {
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    seedSession(db, {
      id: "sess-main",
      firstSeenAt: BASE,
      lastSeenAt: BASE + 3_000_000,
    });
    seedConditions(db, "sess-main", {
      permissionModes: ["default", "acceptEdits"],
      sources: ["hook", "transcript"],
      updatedAt: BASE,
    });
    seedSegment(db, { id: 51, sessionId: "sess-main", startedAt: BASE });
    seedSegment(db, {
      id: 52,
      sessionId: "sess-main",
      kind: "compact",
      startedAt: BASE + 900_000,
      contextTokens: 30000,
    });
    seedTurn(db, {
      id: 11,
      sessionId: "sess-main",
      sequence: 1,
      startedAt: BASE,
      endedAt: BASE + 600_000,
      promptText: "Fix the rounding bug\nplease",
    });
    seedTurn(db, {
      id: 12,
      sessionId: "sess-main",
      sequence: 2,
      startedAt: BASE + 700_000,
      endedAt: BASE + 1_200_000,
      promptText: "Add tests for it",
    });
    // Branches and steps point at each other, so the branch is
    // seeded unlinked and linked once its spawning step exists.
    seedBranch(db, {
      id: 21,
      sessionId: "sess-main",
      agentId: "agent-1",
      agentType: "module-reviewer",
      startedAt: BASE + 80_000,
      endedAt: BASE + 200_000,
      totalTokens: 5000,
    });
    // Requests 31 and 32 are seeded before the steps: step
    // 102 names request 32 as its result, and the steps'
    // result link is a foreign key.
    seedRequest(db, {
      id: 31,
      sessionId: "sess-main",
      turnId: 11,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 40_000,
      cacheWrite5mTokens: 1_000,
      startedAt: BASE + 5_000,
    });
    seedRequest(db, {
      id: 32,
      sessionId: "sess-main",
      turnId: 11,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 45_000,
      cacheWrite5mTokens: 2_000,
      cacheWrite1hTokens: null,
      startedAt: BASE + 55_000,
    });
    seedStep(db, {
      id: 101,
      sessionId: "sess-main",
      turnId: 11,
      toolName: "Bash",
      input: { command: "npm test", description: "Run the test suite" },
      startedAt: BASE + 10_000,
      durationMs: 30_000,
      resultSize: 14_602,
    });
    seedStep(db, {
      id: 102,
      sessionId: "sess-main",
      turnId: 11,
      toolName: "Read",
      input: { file_path: "src/tip.js" },
      startedAt: BASE + 50_000,
      durationMs: 100,
      resultSize: 2_048,
      resultRequestId: 32,
    });
    seedStep(db, {
      id: 103,
      sessionId: "sess-main",
      turnId: 11,
      toolName: "Edit",
      input: {
        file_path: "bin/tip.js",
        old_string: { chars: 10 },
        new_string: { chars: 25 },
      },
      startedAt: BASE + 60_000,
      durationMs: 200,
    });
    seedStep(db, {
      id: 104,
      sessionId: "sess-main",
      turnId: 11,
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "How big?",
            options: [{ label: "Short ton" }, { label: "Long ton" }],
          },
        ],
      },
      startedAt: BASE + 70_000,
      durationMs: 100,
    });
    seedStep(db, {
      id: 105,
      sessionId: "sess-main",
      turnId: 11,
      toolName: "Agent",
      input: {
        subagent_type: "module-reviewer",
        description: "Review the module",
      },
      startedAt: BASE + 80_000,
      durationMs: 120_000,
    });
    seedStep(db, {
      id: 107,
      sessionId: "sess-main",
      turnId: 11,
      branchId: 21,
      toolName: "Read",
      input: { file_path: "src/mod.js" },
      startedAt: BASE + 90_000,
      durationMs: 100,
      resultSize: 500,
    });
    seedStep(db, {
      id: 106,
      sessionId: "sess-main",
      turnId: 12,
      toolName: "Bash",
      input: { command: "npm run build" },
      outcome: "failed",
      startedAt: BASE + 710_000,
      durationMs: 5_000,
      resultSize: 300,
    });
    db.prepare(
      "UPDATE branches SET spawning_step_id = 105 WHERE id = 21",
    ).run();

    seedRequest(db, {
      id: 33,
      sessionId: "sess-main",
      turnId: 11,
      branchId: 21,
      querySource: "subagent",
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 4_000,
      startedAt: BASE + 85_000,
    });
    seedRequest(db, {
      id: 34,
      sessionId: "sess-main",
      turnId: 12,
      inputTokens: 900,
      outputTokens: 150,
      cacheReadTokens: 46_000,
      cacheWrite5mTokens: 0,
      startedAt: BASE + 705_000,
    });
    seedRequest(db, {
      id: 35,
      sessionId: "sess-main",
      querySource: "compact",
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 25_000,
      cacheWrite5mTokens: 2_000,
      startedAt: BASE + 895_000,
    });

    seedSample(db, {
      id: 41,
      sessionId: "sess-main",
      requestId: 31,
      sampledAt: BASE + 5_000,
      contextTokens: 42_000,
    });
    seedSample(db, {
      id: 42,
      sessionId: "sess-main",
      requestId: 32,
      sampledAt: BASE + 55_000,
      contextTokens: 48_200,
    });
    seedSample(db, {
      id: 43,
      sessionId: "sess-main",
      requestId: 34,
      sampledAt: BASE + 705_000,
      contextTokens: 46_900,
    });
    seedSample(db, {
      id: 44,
      sessionId: "sess-main",
      sampledAt: BASE + 900_000,
      contextTokens: 30_000,
    });

    seedMoment(db, {
      id: 71,
      sessionId: "sess-main",
      turnId: 11,
      kind: "prompt",
      occurredAt: BASE,
    });
    seedMoment(db, {
      id: 72,
      sessionId: "sess-main",
      turnId: 11,
      stepId: 103,
      kind: "permission_decision",
      occurredAt: BASE + 59_000,
      decision: "accept",
    });
    seedMoment(db, {
      id: 73,
      sessionId: "sess-main",
      turnId: 11,
      stepId: 104,
      kind: "question_answered",
      occurredAt: BASE + 75_000,
      detail: JSON.stringify({ "How big?": "Short ton" }),
    });
    seedMoment(db, {
      id: 74,
      sessionId: "sess-main",
      turnId: 12,
      kind: "prompt",
      occurredAt: BASE + 700_000,
    });
    seedPause(db, {
      id: 61,
      sessionId: "sess-main",
      pausedAt: BASE + 300_000,
      resumedAt: BASE + 360_000,
    });

    // The model id is the captured SessionStart id,
    // claude-opus-5-5 (named in the context-limit test below),
    // with the "[1m]" suffix Claude Code reports for a
    // 1M-context session — the form the snapshot's
    // context-limit rule reads.
    // A live session is one whose process is still running:
    // the fixture notes this test process itself, the way the
    // hook notes a Claude Code session's, so the daemon's session-end
    // watch leaves it live however old its timestamps are.
    const hostStartedAt = (await readProcessStartTimes([process.pid])).get(
      process.pid,
    );
    seedSession(db, {
      id: "sess-live",
      projectPath: "/home/user/other",
      model: "claude-opus-5-5[1m]",
      status: "live",
      firstSeenAt: BASE + 3_500_000,
      lastSeenAt: BASE + 3_590_000,
      hostPid: process.pid,
      ...(hostStartedAt === undefined ? {} : { hostStartedAt }),
    });
    seedConditions(db, "sess-live", { updatedAt: BASE });
    seedSegment(db, {
      id: 53,
      sessionId: "sess-live",
      startedAt: BASE + 3_500_000,
    });
    seedTurn(db, {
      id: 13,
      sessionId: "sess-live",
      sequence: 1,
      startedAt: BASE + 3_500_000,
      promptText: "Live prompt",
    });
    seedStep(db, {
      id: 108,
      sessionId: "sess-live",
      turnId: 13,
      toolName: "Bash",
      input: '{"command":"ls"}',
      outcome: "open",
      startedAt: BASE + 3_570_000,
      endedAt: null,
    });
    seedMoment(db, {
      id: 75,
      sessionId: "sess-live",
      turnId: 13,
      kind: "prompt",
      occurredAt: BASE + 3_500_000,
    });
    seedMoment(db, {
      id: 76,
      sessionId: "sess-live",
      kind: "waiting",
      occurredAt: BASE + 3_585_000,
    });
    seedPause(db, {
      id: 62,
      sessionId: "sess-live",
      pausedAt: BASE + 3_580_000,
    });

    seedSession(db, {
      id: "sess-other",
      projectPath: "/home/user/proj-two",
      model: null,
      firstSeenAt: BASE - 10_000_000,
      lastSeenAt: BASE - 9_000_000,
      joinedPartway: true,
    });
    seedConditions(db, "sess-other", {
      permissionModes: null,
      sources: ["transcript"],
      updatedAt: BASE,
    });
    seedTurn(db, {
      id: 14,
      sessionId: "sess-other",
      sequence: 1,
      startedAt: BASE - 10_000_000,
      endedAt: BASE - 9_500_000,
    });

    seedSession(db, {
      id: "sess-marker",
      projectPath: "/home/user/marker",
      model: null,
      firstSeenAt: BASE - 20_000_000,
      lastSeenAt: BASE - 19_000_000,
    });
    seedTurn(db, {
      id: 15,
      sessionId: "sess-marker",
      sequence: 1,
      startedAt: BASE - 20_000_000,
      endedAt: BASE - 19_500_000,
      promptText: "A prompt about things",
    });
    seedStep(db, {
      id: 109,
      sessionId: "sess-marker",
      turnId: 15,
      toolName: "Edit",
      input: {
        file_path: "src/x.js",
        // Stored the way the recorder stores an edit's old
        // text: a character count, never the text (ADR-0004).
        // The marker itself rides in the raw event and the
        // waiting moment's detail below.
        old_string: { chars: 40 },
        new_string: { chars: 3 },
      },
      startedAt: BASE - 19_900_000,
      endedAt: BASE - 19_900_000,
      durationMs: 10,
    });
    seedMoment(db, {
      id: 77,
      sessionId: "sess-marker",
      turnId: 15,
      kind: "waiting",
      occurredAt: BASE - 19_800_000,
      detail: JSON.stringify({ notification_type: MARKER }),
    });
    seedRawEvent(db, {
      sessionId: "sess-marker",
      receivedAt: BASE - 19_900_000,
      eventAt: BASE - 19_900_000,
      body: { tool_response: { content: MARKER } },
    });
  } finally {
    db.close();
    storage.close();
  }
}

async function bootDaemon(
  settings?: Record<string, unknown>,
): Promise<StartedDaemon> {
  const { root, dataDir } = makeRoot("flightpath-read-api-test-");
  mkdirSync(dataDir, { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(settings));
  }
  await seedFixture(dataDir);
  // The idle window is stretched so the daemon never exits
  // mid-file; the support starter's drain timing already
  // matches what these tests were written against.
  return startTestDaemon(root, { startOptions: { idleMs: "600000" } });
}

interface SessionListBody {
  sessions: Record<string, unknown>[];
}

interface SnapshotBody {
  summary: Record<string, unknown> & {
    counts: Record<string, number>;
  };
  turns: {
    sequence: number;
    failures: number;
    steppedIn: number;
    steps: { id: number; sentence: string; resultRequestId: number | null }[];
    humanMoments: { kind: string; sentence: string }[];
  }[];
  branches: Record<string, unknown>[];
  sessionEvents: { kind: string; sentence: string; segmentKind?: string }[];
  contextSamples: { at: number; contextTokens: number }[];
}

describe("read api endpoints", () => {
  let daemon: StartedDaemon;

  beforeAll(async () => {
    daemon = await bootDaemon();
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    await runCleanups();
  });

  /** The main session's snapshot, fetched and parsed: the
   * reply is a 200, and its body is the snapshot shape. */
  async function snapshotBody(): Promise<SnapshotBody> {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/snapshot",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    return JSON.parse(reply.body) as SnapshotBody;
  }

  it("answers 401 without the token, and with a wrong one, on every read endpoint", async () => {
    const paths = [
      "/api/sessions",
      "/api/sessions/sess-main/snapshot",
      "/api/sessions/sess-main/tokens",
      "/api/sessions/sess-main/findings",
      "/api/sessions/sess-main/context?step=102",
      "/api/steps/101",
      "/api/storage",
    ];
    for (const path of paths) {
      const noToken = await callDaemon(daemon.port, { method: "GET", path });
      expect(noToken.status).toBe(401);
      const wrong = await callDaemon(daemon.port, {
        method: "GET",
        path,
        token: "not-the-token",
      });
      expect(wrong.status).toBe(401);
    }
  });

  it("lists sessions live first, with titles, counts, sources and notes", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as SessionListBody;
    expect(body.sessions.map((s) => s.id)).toEqual([
      "sess-live",
      "sess-main",
      "sess-other",
      "sess-marker",
    ]);
    const main = body.sessions[1] as Record<string, unknown>;
    expect(main.title).toBe("Fix the rounding bug");
    expect(main.project).toBe("/home/user/proj");
    expect(main.status).toBe("ended");
    expect(main.turns).toBe(2);
    expect(main.steps).toBe(7);
    expect(main.tokensProcessed).toBe(169_600);
    expect(main.sources).toEqual(["hook", "transcript"]);
    expect(main.note).toBe("No telemetry · Paused once");
    expect(main.lastActivityAt).toBe(BASE + 3_000_000);
    expect(main.endedAt).toBe(BASE + 3_000_000);
    const other = body.sessions[2] as Record<string, unknown>;
    expect(other.title).toBe("Untitled session");
    expect(other.note).toBe(
      "Joined partway · Imported from transcript · No telemetry",
    );
    const live = body.sessions[0] as Record<string, unknown>;
    expect(live.endedAt).toBeNull();
    expect(live.note).toBe("Paused once");
  });

  it("filters the session list by q over titles and projects", async () => {
    const byTitle = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions?q=rounding",
      token: daemon.token,
    });
    expect(
      (JSON.parse(byTitle.body) as SessionListBody).sessions.map((s) => s.id),
    ).toEqual(["sess-main"]);
    const byProject = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions?q=proj-two",
      token: daemon.token,
    });
    expect(
      (JSON.parse(byProject.body) as SessionListBody).sessions.map((s) => s.id),
    ).toEqual(["sess-other"]);
    const none = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions?q=zzz-no-match",
      token: daemon.token,
    });
    expect((JSON.parse(none.body) as SessionListBody).sessions).toEqual([]);
  });

  it("returns a snapshot whose summary carries counts, context and waiting state", async () => {
    const body = await snapshotBody();
    expect(body.summary.model).toBe("claude-sonnet-4-5");
    expect(body.summary.permissionModes).toEqual(["default", "acceptEdits"]);
    expect(body.summary.counts).toEqual({
      turns: 2,
      steps: 7,
      requests: 5,
      branches: 1,
      humanMoments: 4,
    });
    expect(body.summary.failures).toBe(1);
    expect(body.summary.steppedIn).toBe(2);
    expect(body.summary.tokensProcessed).toBe(169_600);
    expect(body.summary.contextNow).toBe(30_000);
    expect(body.summary.window).toEqual({
      tokens: null,
      source: "unknown",
      reportedAt: null,
    });
    expect(body.summary.overheadTokens).toBe(0);
    expect(body.summary.waitingSince).toBeNull();
    expect(body.summary.lastStepAt).toBe(BASE + 710_000);
    expect(body.contextSamples).toHaveLength(4);
  });

  it("carries the request that first carried each step's result", async () => {
    const body = await snapshotBody();
    const steps = body.turns.flatMap((turn) => turn.steps);
    expect(steps.find((step) => step.id === 102)?.resultRequestId).toBe(32);
    expect(steps.find((step) => step.id === 101)?.resultRequestId).toBeNull();
  });

  it("gives every snapshot row its sentence, with per-turn failures and stepped-in counts", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/snapshot",
      token: daemon.token,
    });
    const body = JSON.parse(reply.body) as SnapshotBody;
    const [first, second] = body.turns;
    expect(first?.failures).toBe(0);
    expect(first?.steppedIn).toBe(2);
    expect(second?.failures).toBe(1);
    expect(second?.steppedIn).toBe(0);
    const sentences = (first?.steps ?? []).map((s) => s.sentence);
    expect(sentences).toContain("Run the test suite");
    expect(sentences).toContain("Edited bin/tip.js");
    expect(sentences).toContain("Started a subagent: module-reviewer");
    for (const turn of body.turns) {
      for (const stepRow of turn.steps) {
        expect(stepRow.sentence.length).toBeGreaterThan(0);
      }
    }
    const moments = (first?.humanMoments ?? []).map((m) => m.sentence);
    expect(moments).toContain("You asked: Fix the rounding bug");
    expect(moments).toContain("You approved Edit bin/tip.js");
    expect(moments).toContain("You answered: Short ton");
    expect(body.branches[0]).toMatchObject({
      agentType: "module-reviewer",
      steps: 1,
      requests: 1,
      sentence: "Started a subagent: module-reviewer",
    });
    expect(body.sessionEvents.map((e) => e.sentence)).toEqual([
      "Session started",
      "Recording paused, then resumed",
      "Compacted the conversation",
    ]);
    // A segment says which kind it was recorded as; a pause is no segment.
    expect(body.sessionEvents.map((e) => e.segmentKind)).toEqual([
      "startup",
      undefined,
      "compact",
    ]);
  });

  it("reports waitingSince for a session whose last moment is a wait", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-live/snapshot",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as SnapshotBody;
    expect(body.summary.waitingSince).toBe(BASE + 3_585_000);
    expect(body.summary.window).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(body.sessionEvents.map((e) => e.sentence)).toContain(
      "Recording paused",
    );
  });

  it("returns a step's panel facts in words and the request that produced it", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/steps/103",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      sentence: string;
      facts: { label: string; value: string }[];
      requests: { id: number; inputTokens: number }[];
    };
    expect(body.sentence).toBe("Edited bin/tip.js");
    expect(body.facts).toContainEqual({
      label: "Characters",
      value: "replaced 10 characters with 25 characters",
    });
    expect(body.facts).toContainEqual({ label: "Approved by", value: "you" });
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.id).toBe(32);
    expect(body.requests[0]?.inputTokens).toBe(1_200);
  });

  it("links every step to the request that produced it", async () => {
    // Steps 101 and 102 follow request 31; 103, 104 and 105
    // follow request 32; the branch's step 107 follows the
    // branch's request 33; step 106 opens turn two after
    // request 34. Request 35 belongs to no turn and makes
    // nothing.
    const expected: [number, number][] = [
      [101, 31],
      [102, 31],
      [103, 32],
      [104, 32],
      [105, 32],
      [107, 33],
      [106, 34],
    ];
    for (const [stepId, requestId] of expected) {
      const reply = await callDaemon(daemon.port, {
        method: "GET",
        path: `/api/steps/${stepId}`,
        token: daemon.token,
      });
      expect(reply.status).toBe(200);
      const body = JSON.parse(reply.body) as {
        requests: { id: number }[];
      };
      expect(body.requests.map((request) => request.id)).toEqual([requestId]);
    }
  });

  it("shows a subagent step's cold start from its branch's first request", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/steps/105",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      facts: { label: string; value: string }[];
    };
    // The branch's first request is request 33, which wrote
    // 4,000 tokens of cache starting cold.
    expect(body.facts).toContainEqual({
      label: "Cold start",
      value: "4,000 tokens written to cache",
    });
  });

  it("answers a session's token history", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/tokens",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      sessionId: string;
      states: Record<string, boolean>;
      base: unknown;
      main: unknown[];
      branches: unknown[];
      background: unknown[];
      turns: unknown[];
      room: { window: { tokens: number | null; source: string } };
    };
    expect(body.sessionId).toBe("sess-main");
    expect(body.states).toEqual({
      telemetry: false,
      tokensPartial: false,
      joinedPartway: false,
    });
    expect(body.main.length).toBeGreaterThan(0);
    expect(body.base).toEqual(body.main[0]);
    expect(Array.isArray(body.branches)).toBe(true);
    expect(Array.isArray(body.background)).toBe(true);
    expect(body.turns.length).toBe(2);
    expect(body.room.window).toEqual({
      tokens: null,
      source: "unknown",
      reportedAt: null,
    });
  });

  it("answers one step's context, and refuses a missing or non-numeric step", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/context?step=102",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      stepId: number;
      scope: { kind: string };
      items: unknown[];
    };
    expect(body.stepId).toBe(102);
    expect(body.scope.kind).toBe("main");
    expect(Array.isArray(body.items)).toBe(true);
    const missing = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/context",
      token: daemon.token,
    });
    expect(missing.status).toBe(400);
    const notNumber = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/context?step=abc",
      token: daemon.token,
    });
    expect(notNumber.status).toBe(400);
    const unknownStep = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/context?step=999999",
      token: daemon.token,
    });
    expect(unknownStep.status).toBe(404);
    const unknownSession = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/nope/context?step=102",
      token: daemon.token,
    });
    expect(unknownSession.status).toBe(404);
  });

  it("answers the context at a request, refuses a read asked at both, at neither or at a non-number, and says no to a request that isn't there", async () => {
    const tokens = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/tokens",
      token: daemon.token,
    });
    const requestId = (
      JSON.parse(tokens.body) as { main: { requestId: number }[] }
    ).main[0]?.requestId;
    const asked = await callDaemon(daemon.port, {
      method: "GET",
      path: `/api/sessions/sess-main/context?request=${requestId}`,
      token: daemon.token,
    });
    expect(asked.status).toBe(200);
    const body = JSON.parse(asked.body) as {
      stepId: number | null;
      measured: { requestId: number } | null;
    };
    expect(body.stepId).toBeNull();
    expect(body.measured?.requestId).toBe(requestId);
    for (const [path, status] of [
      [`context?step=102&request=${requestId}`, 400],
      ["context", 400],
      ["context?request=abc", 400],
      ["context?request=999999", 404],
    ] as const) {
      const reply = await callDaemon(daemon.port, {
        method: "GET",
        path: `/api/sessions/sess-main/${path}`,
        token: daemon.token,
      });
      expect(reply.status).toBe(status);
    }
  });

  it("answers 404 for unknown sessions and steps", async () => {
    const session = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/nope/snapshot",
      token: daemon.token,
    });
    expect(session.status).toBe(404);
    const tokens = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/nope/tokens",
      token: daemon.token,
    });
    expect(tokens.status).toBe(404);
    const findings = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/nope/findings",
      token: daemon.token,
    });
    expect(findings.status).toBe(404);
    const stepReply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/steps/999999",
      token: daemon.token,
    });
    expect(stepReply.status).toBe(404);
  });

  it("reports how much is stored", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/storage",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      sessions: number;
      databaseBytes: number;
    };
    expect(body.sessions).toBe(4);
    expect(body.databaseBytes).toBeGreaterThan(0);
  });

  it("never lets tool output or response text reach any response", async () => {
    const replies = await getAll(daemon.port, daemon.token, [
      "/api/sessions",
      "/api/sessions/sess-marker/snapshot",
      "/api/steps/109",
      "/api/storage",
    ]);
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.body).not.toContain(MARKER);
    }
  });
});

describe("read api with prompt text off", () => {
  let daemon: StartedDaemon;

  beforeAll(async () => {
    daemon = await bootDaemon({ storePromptText: false });
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    await runCleanups();
  });

  it("keeps every prompt's text out of every endpoint", async () => {
    const replies = await getAll(daemon.port, daemon.token, [
      "/api/sessions",
      "/api/sessions/sess-main/snapshot",
      "/api/steps/103",
      "/api/storage",
    ]);
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.body).not.toContain("Fix the rounding bug");
      expect(reply.body).not.toContain("Add tests for it");
    }
    const list = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions",
      token: daemon.token,
    });
    const body = JSON.parse(list.body) as SessionListBody;
    const main = body.sessions.find((s) => s.id === "sess-main");
    expect(main?.title).toBe("Untitled session");
    const snapshot = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-main/snapshot",
      token: daemon.token,
    });
    const snap = JSON.parse(snapshot.body) as SnapshotBody;
    expect(snap.turns[0]?.humanMoments[0]?.sentence).toBe(
      "You asked a question (27 characters, wording not kept)",
    );
  });
});

// The same expiry twice: rebuild-2 is worth a look, rebuild-4 worth fixing.
async function bootFindingsDaemon(): Promise<StartedDaemon> {
  const { root, dataDir } = makeRoot("flightpath-read-api-test-");
  mkdirSync(dataDir, { recursive: true });
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    seedWarmPair(
      db,
      "sess-rebuilds",
      { cacheWrite1h: 5_000 },
      { startedAt: 4_289_800, cacheWrite1h: 62_380 },
    );
    seedRequestExact(db, {
      id: 3,
      sessionId: "sess-rebuilds",
      startedAt: 4_349_800,
      input: 1_000,
      cacheRead: 68_000,
      cacheWrite1h: 0,
    });
    seedRequestExact(db, {
      id: 4,
      sessionId: "sess-rebuilds",
      startedAt: 8_609_800,
      input: 1_000,
      cacheRead: 5_000,
      cacheWrite1h: 62_000,
    });
    // Retention would purge a session last seen at the epoch.
    db.prepare(
      "UPDATE sessions SET first_seen_at = ?, last_seen_at = ? WHERE id = ?",
    ).run(BASE, BASE, "sess-rebuilds");
  } finally {
    db.close();
    storage.close();
  }
  return startTestDaemon(root, { startOptions: { idleMs: "600000" } });
}

describe("read api findings", () => {
  let daemon: StartedDaemon;

  beforeAll(async () => {
    daemon = await bootFindingsDaemon();
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    await runCleanups();
  });

  const dismiss = (sessionId: string, findingId: string, token?: string) =>
    callDaemon(daemon.port, {
      method: "POST",
      path: `/api/sessions/${sessionId}/findings/${findingId}/dismiss`,
      ...(token === undefined ? {} : { token }),
    });

  async function listedIds(): Promise<string[]> {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-rebuilds/findings",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    return (JSON.parse(reply.body) as { id: string }[]).map((f) => f.id);
  }

  it("lists the session's findings as a bare array, worst first", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions/sess-rebuilds/findings",
      token: daemon.token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      id: string;
      grade: string;
      headline: string;
    }[];
    expect(body.map((f) => [f.id, f.grade])).toEqual([
      ["rebuild-4", "Worth fixing"],
      ["rebuild-2", "Worth a look"],
    ]);
    expect(body[1]?.headline).toBe(
      "Compact before a long break · 62.4K tokens written again after 1h 11m away",
    );
  });

  it("refuses a dismissal without the token, or with a wrong one", async () => {
    expect((await dismiss("sess-rebuilds", "rebuild-2")).status).toBe(401);
    expect(
      (await dismiss("sess-rebuilds", "rebuild-2", "not-the-token")).status,
    ).toBe(401);
    expect(await listedIds()).toEqual(["rebuild-4", "rebuild-2"]);
  });

  it("answers 404 for a finding the session does not produce, and for an unknown session", async () => {
    expect(
      (await dismiss("sess-rebuilds", "rebuild-9", daemon.token)).status,
    ).toBe(404);
    expect((await dismiss("sess-nope", "rebuild-2", daemon.token)).status).toBe(
      404,
    );
    expect(await listedIds()).toEqual(["rebuild-4", "rebuild-2"]);
  });

  it("drops a dismissed finding from the next read, and answers 200 when it is dismissed again", async () => {
    expect(
      (await dismiss("sess-rebuilds", "rebuild-4", daemon.token)).status,
    ).toBe(200);
    expect(await listedIds()).toEqual(["rebuild-2"]);
    expect(
      (await dismiss("sess-rebuilds", "rebuild-4", daemon.token)).status,
    ).toBe(200);
    expect(await listedIds()).toEqual(["rebuild-2"]);
  });
});

describe("read api query plans", () => {
  afterEach(async () => {
    await runCleanups();
  });

  it("runs the statements storage prepares, each on its index", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    const db = new DatabaseSync(storage.dbPath);
    try {
      const planFor = (sql: string, param?: string | number): string =>
        (
          db
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...(param === undefined ? [] : [param])) as {
            detail: string;
          }[]
        )
          .map((row) => row.detail)
          .join("\n");
      // The per-session statements: each reaches its rows
      // through the session index, never a table scan.
      const perSession = [
        TURN_ROWS_SQL,
        STEP_ROWS_SQL,
        HUMAN_ROWS_SQL,
        BRANCH_ROWS_SQL,
        SEGMENT_ROWS_SQL,
        PAUSE_ROWS_SQL,
        REQUEST_ROWS_SQL,
        SAMPLE_ROWS_SQL,
        LOAD_ROWS_SQL,
        ATTACHMENT_ROWS_SQL,
        COMPACTION_FILES_SQL,
        DISMISSALS_SQL,
        SESSION_SHAPES_SQL,
        OVERHEAD_SQL,
      ];
      for (const sql of perSession) {
        const plan = planFor(sql, "sess-main");
        expect(plan).toContain("SEARCH");
        expect(plan).not.toContain("SCAN");
      }
      expect(planFor(STEP_BY_ID_SQL, 103)).toContain("SEARCH");
      expect(planFor(TURN_FOR_PROMPT_SQL, "sess-main")).toContain(
        "turns_prompt",
      );
      // The two session statements read the sessions table
      // itself; every per-session lookup inside them must
      // still be a search, never a scan of a child table.
      const childScan =
        /SCAN (turns|steps|human_events|branches|segments|pauses|requests|context_samples|raw_events)\b/;
      for (const [sql, param] of [
        [SESSION_LIST_SQL, undefined],
        [SESSION_ROW_SQL, "sess-main"],
      ] as const) {
        const plan = planFor(sql, param);
        expect(plan).not.toMatch(childScan);
        expect(plan).toContain("SEARCH turns");
        expect(plan).toContain("SEARCH requests");
      }
      // The live-sessions statement: its first-prompt lookup
      // reaches turns through the session index, never a scan.
      const livePlan = planFor(LIVE_SESSIONS_SQL);
      expect(livePlan).not.toMatch(childScan);
      expect(livePlan).toContain("SEARCH turns");
      // The watch's live-hosts statement beside it: sessions
      // only, no child table touched at all.
      expect(planFor(LIVE_SESSION_HOSTS_SQL)).not.toMatch(childScan);
    } finally {
      db.close();
      storage.close();
    }
  });
});

/** Storage holding the realistic 5,000-request session. */
function openBigSession(): Storage {
  const { dataDir } = makeRoot("flightpath-read-api-test-");
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    db.exec("BEGIN");
    seedRealisticSession(db, { base: BASE });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return storage;
}

describe("read api snapshot timing", () => {
  afterEach(async () => {
    await runCleanups();
  });

  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "answers a realistic 5,000-step session's snapshot and step detail in under 300 ms each",
    () => {
      const storage = openBigSession();
      const snapshotStarted = performance.now();
      const snapshot = sessionSnapshot(storage, defaultSettings(), "sess-big");
      const snapshotMs = performance.now() - snapshotStarted;
      const json = JSON.stringify(snapshot);
      const detailStarted = performance.now();
      const detail = stepDetail(storage, 4_999);
      const detailMs = performance.now() - detailStarted;
      storage.close();
      expect(snapshot).toBeDefined();
      expect(detail).toBeDefined();
      console.log(
        `snapshot of 5,000 steps / 500 turns / 5,000 requests / 5,000 samples: ${snapshotMs.toFixed(1)} ms, ${json.length} bytes; step detail: ${detailMs.toFixed(1)} ms`,
      );
      expect(snapshotMs).toBeLessThan(300);
      expect(detailMs).toBeLessThan(300);
      expect(json.length).toBeLessThan(2_000_000);
    },
    60_000,
  );
});

describe("read api findings timing", () => {
  afterEach(async () => {
    await runCleanups();
  });

  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "reads a realistic 5,000-request session's findings in under 300 ms",
    () => {
      const storage = openBigSession();
      const started = performance.now();
      const findings = sessionFindings(storage, "sess-big");
      const findingsMs = performance.now() - started;
      storage.close();
      expect(findings).toBeDefined();
      console.log(`findings of 5,000 requests: ${findingsMs.toFixed(1)} ms`);
      expect(findingsMs).toBeLessThan(300);
    },
    60_000,
  );
});

describe("read api overhead and context limit", () => {
  afterEach(async () => {
    await runCleanups();
  });

  function seedOverhead(storage: Storage): void {
    const db = new DatabaseSync(storage.dbPath);
    try {
      seedSession(db, {
        id: "sess-overhead",
        firstSeenAt: BASE,
        lastSeenAt: BASE + 600_000,
      });
      // A turn marked as Flightpath's own: its requests are
      // the overhead.
      seedTurn(db, {
        id: 1,
        sessionId: "sess-overhead",
        sequence: 1,
        startedAt: BASE,
        endedAt: BASE + 60_000,
        promptText: "/flightpath:status",
        flightpathCommand: true,
      });
      seedTurn(db, {
        id: 2,
        sessionId: "sess-overhead",
        sequence: 2,
        startedAt: BASE + 120_000,
        endedAt: BASE + 300_000,
        promptText: "Fix the bug",
      });
      // The marked turn's two requests: 42,200 + 4,850 = 47,050.
      seedRequest(db, {
        id: 1,
        sessionId: "sess-overhead",
        turnId: 1,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 40_000,
        cacheWrite5mTokens: 1_000,
        startedAt: BASE + 1_000,
      });
      seedRequest(db, {
        id: 2,
        sessionId: "sess-overhead",
        turnId: 1,
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 4_000,
        cacheWrite1hTokens: 250,
        startedAt: BASE + 2_000,
      });
      // The normal turn's request, and one with no turn at all:
      // neither is Flightpath's cost.
      seedRequest(db, {
        id: 3,
        sessionId: "sess-overhead",
        turnId: 2,
        inputTokens: 9_000,
        outputTokens: 900,
        cacheReadTokens: 90_000,
        cacheWrite5mTokens: 9_000,
        cacheWrite1hTokens: 9_000,
        startedAt: BASE + 130_000,
      });
      seedRequest(db, {
        id: 4,
        sessionId: "sess-overhead",
        inputTokens: 7_000,
        outputTokens: 700,
        cacheReadTokens: 70_000,
        cacheWrite5mTokens: 7_000,
        cacheWrite1hTokens: 7_000,
        startedAt: BASE + 400_000,
      });
    } finally {
      db.close();
    }
  }

  it("counts only the marked turn's requests as the overhead", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      seedOverhead(storage);
      expect(storage.flightpathOverheadTokens("sess-overhead")).toBe(47_050);
      const snapshot = sessionSnapshot(
        storage,
        defaultSettings(),
        "sess-overhead",
      );
      expect(snapshot?.summary.counts.requests).toBe(4);
      expect(snapshot?.summary.overheadTokens).toBe(47_050);
    } finally {
      storage.close();
    }
  });

  it("counts no overhead for another command's turn", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      const db = new DatabaseSync(storage.dbPath);
      try {
        seedSession(db, {
          id: "sess-review",
          firstSeenAt: BASE,
          lastSeenAt: BASE + 600_000,
        });
        seedTurn(db, {
          id: 1,
          sessionId: "sess-review",
          sequence: 1,
          startedAt: BASE,
          endedAt: BASE + 60_000,
          promptText: "/review",
        });
        seedRequest(db, {
          id: 1,
          sessionId: "sess-review",
          turnId: 1,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 40_000,
          startedAt: BASE + 1_000,
        });
      } finally {
        db.close();
      }
      expect(storage.flightpathOverheadTokens("sess-review")).toBe(0);
      const snapshot = sessionSnapshot(
        storage,
        defaultSettings(),
        "sess-review",
      );
      expect(snapshot?.summary.overheadTokens).toBe(0);
    } finally {
      storage.close();
    }
  });

  it("sends only the main thread's samples to the snapshot's strip", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      const db = new DatabaseSync(storage.dbPath);
      try {
        seedSession(db, {
          id: "sess-strip",
          firstSeenAt: BASE,
          lastSeenAt: BASE + 600_000,
        });
        seedBranch(db, { id: 21, sessionId: "sess-strip" });
        // Main samples of 80K and 82K, a subagent's 30K between
        // them: the strip is the main conversation's, so the
        // subagent's sample is not among its points.
        seedRequest(db, {
          id: 31,
          sessionId: "sess-strip",
          startedAt: BASE + 1_000,
        });
        seedRequest(db, {
          id: 33,
          sessionId: "sess-strip",
          branchId: 21,
          querySource: "subagent",
          startedAt: BASE + 2_000,
        });
        seedRequest(db, {
          id: 34,
          sessionId: "sess-strip",
          startedAt: BASE + 3_000,
        });
        seedSample(db, {
          sessionId: "sess-strip",
          requestId: 31,
          sampledAt: BASE + 1_000,
          contextTokens: 80_000,
        });
        seedSample(db, {
          sessionId: "sess-strip",
          requestId: 33,
          sampledAt: BASE + 2_000,
          contextTokens: 30_000,
        });
        seedSample(db, {
          sessionId: "sess-strip",
          requestId: 34,
          sampledAt: BASE + 3_000,
          contextTokens: 82_000,
        });
      } finally {
        db.close();
      }
      const snapshot = sessionSnapshot(
        storage,
        defaultSettings(),
        "sess-strip",
      );
      expect(snapshot?.contextSamples).toEqual([
        { at: BASE + 1_000, contextTokens: 80_000 },
        { at: BASE + 3_000, contextTokens: 82_000 },
      ]);
    } finally {
      storage.close();
    }
  });

  it("reads the window from the model list, whatever the samples say", () => {
    // The model id is the one a captured SessionStart hook
    // payload reported on 2026-10-23: claude-opus-5-5, carrying
    // no "[1m]" suffix. It is listed with a 1M window, so a
    // session on it reads 1M from the list whether its samples
    // passed 200K or stayed at it.
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      const sample = (id: string, tokens: number): void => {
        const db = new DatabaseSync(storage.dbPath);
        try {
          seedSession(db, {
            id,
            model: "claude-opus-5-5",
            firstSeenAt: BASE,
            lastSeenAt: BASE + 600_000,
          });
          seedSample(db, {
            sessionId: id,
            sampledAt: BASE + 1_000,
            contextTokens: tokens,
          });
        } finally {
          db.close();
        }
      };
      sample("sess-wide", 250_000);
      sample("sess-narrow", 200_000);
      const wide = sessionSnapshot(storage, defaultSettings(), "sess-wide");
      const narrow = sessionSnapshot(storage, defaultSettings(), "sess-narrow");
      expect(wide?.summary.window).toEqual({
        tokens: 1_000_000,
        source: "model-list",
        reportedAt: null,
      });
      expect(narrow?.summary.window).toEqual({
        tokens: 1_000_000,
        source: "model-list",
        reportedAt: null,
      });
    } finally {
      storage.close();
    }
  });
});

describe("read api approval wording", () => {
  afterEach(async () => {
    await runCleanups();
  });

  function factsFor(
    decision: string | null,
    source: string | null,
  ): { label: string; value: string }[] | undefined {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      const db = new DatabaseSync(storage.dbPath);
      try {
        seedSession(db, {
          id: "sess-decision",
          firstSeenAt: BASE,
          lastSeenAt: BASE + 600_000,
        });
        seedConditions(db, "sess-decision", { updatedAt: BASE });
        seedTurn(db, {
          id: 1,
          sessionId: "sess-decision",
          sequence: 1,
          startedAt: BASE,
          endedAt: BASE + 60_000,
          promptText: "Do it",
        });
        seedStep(db, {
          id: 1,
          sessionId: "sess-decision",
          turnId: 1,
          toolName: "Edit",
          input: {
            file_path: "src/x.js",
            old_string: { chars: 1 },
            new_string: { chars: 2 },
          },
          startedAt: BASE + 1_000,
          durationMs: 10,
        });
        seedMoment(db, {
          id: 1,
          sessionId: "sess-decision",
          turnId: 1,
          stepId: 1,
          kind: "permission_decision",
          occurredAt: BASE + 900,
          decision,
          decisionSource: source,
        });
      } finally {
        db.close();
      }
      return stepDetail(storage, 1)?.facts;
    } finally {
      storage.close();
    }
  }

  /** The step's facts, with no approval among them: the
   * detail exists, and none of its facts credits one. */
  function expectNoApproval(decision: string, source: string): void {
    const facts = factsFor(decision, source);
    expect(facts).toBeDefined();
    expect((facts ?? []).some((fact) => fact.label === "Approved by")).toBe(
      false,
    );
  }

  it("credits an approval only to an accepted decision whose source names the user", () => {
    expect(factsFor("accept", "user_temporary")).toContainEqual({
      label: "Approved by",
      value: "you",
    });
    expect(factsFor("accept_permanent", "inferred")).toContainEqual({
      label: "Approved by",
      value: "you",
    });
  });

  it("never calls a rejected step approved", () => {
    expectNoApproval("reject", "user_reject");
  });

  it("makes no claim when the accepting source names no person", () => {
    expectNoApproval("accept", "config");
  });
});

describe("read api empty sessions", () => {
  afterEach(async () => {
    await runCleanups();
  });

  it("leaves sessions with nothing in them out of the list, and counts them", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    const db = new DatabaseSync(storage.dbPath);
    // A session with a turn, and one with only requests: both
    // have something in them and stay listed.
    seedSession(db, {
      id: "sess-turn",
      firstSeenAt: BASE + 1000,
      lastSeenAt: BASE + 2000,
    });
    seedTurn(db, {
      id: 1,
      sessionId: "sess-turn",
      sequence: 1,
      startedAt: BASE + 1000,
      endedAt: BASE + 2000,
      promptText: "a real prompt",
    });
    seedSession(db, {
      id: "sess-requests",
      firstSeenAt: BASE + 3000,
      lastSeenAt: BASE + 4000,
    });
    seedRequest(db, { id: 1, sessionId: "sess-requests" });
    // A live session with nothing in it is still listed: it
    // may be about to do something.
    seedSession(db, {
      id: "sess-live-empty",
      status: "live",
      firstSeenAt: BASE + 5000,
      lastSeenAt: BASE + 6000,
    });
    // One ended session with nothing in it: hidden, counted.
    seedSession(db, {
      id: "sess-empty-1",
      firstSeenAt: BASE + 7000,
      lastSeenAt: BASE + 8000,
    });

    const first = listSessions(storage, defaultSettings(), null);
    expect(first.sessions.map((session) => session.id)).toEqual([
      "sess-live-empty",
      "sess-requests",
      "sess-turn",
    ]);
    expect(first.emptyHidden).toBe(1);

    seedSession(db, {
      id: "sess-empty-2",
      firstSeenAt: BASE + 9000,
      lastSeenAt: BASE + 10_000,
    });
    seedSession(db, {
      id: "sess-empty-3",
      firstSeenAt: BASE + 11_000,
      lastSeenAt: BASE + 12_000,
    });
    const second = listSessions(storage, defaultSettings(), null);
    expect(second.sessions.map((session) => session.id)).toEqual(
      first.sessions.map((session) => session.id),
    );
    expect(second.emptyHidden).toBe(3);

    db.close();
    storage.close();
  });
});

describe("the times the person stepped in", () => {
  function seedTurnWithMoments(storage: Storage, kinds: string[]): void {
    const db = new DatabaseSync(storage.dbPath);
    try {
      seedSession(db, { id: "sess-said", firstSeenAt: BASE });
      seedTurn(db, {
        id: 1,
        sessionId: "sess-said",
        startedAt: BASE,
        endedAt: BASE + 10_000,
      });
      kinds.forEach((kind, index) => {
        seedMoment(db, {
          sessionId: "sess-said",
          turnId: 1,
          kind,
          occurredAt: BASE + 1000 * (index + 1),
          decision: kind === "permission_decision" ? "accept" : null,
          detail: JSON.stringify({
            name: "/context",
            agent_type: "Explore",
            chars: 497,
          }),
        });
      });
    } finally {
      db.close();
    }
  }

  it("counts a command with the approvals, and never a hand-back or a notice", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      seedTurnWithMoments(storage, [
        "permission_decision",
        "command",
        "handback",
        "notice",
      ]);
      const snapshot = sessionSnapshot(storage, defaultSettings(), "sess-said");
      expect(snapshot?.summary.steppedIn).toBe(2);
      expect(snapshot?.turns[0]?.steppedIn).toBe(2);
      expect(snapshot?.turns[0]?.humanMoments.map((m) => m.sentence)).toEqual([
        "You approved an action",
        "You ran `/context`",
        "Explore reported back · about 172 tokens est.",
        "Claude Code added a notice · 497 characters",
      ]);
    } finally {
      storage.close();
    }
  });
});

describe("a prompt whose wording was not kept", () => {
  it("says the prompt's length in its moment's sentence", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      const db = new DatabaseSync(storage.dbPath);
      try {
        seedSession(db, { id: "sess-length", firstSeenAt: BASE });
        seedTurn(db, {
          id: 1,
          sessionId: "sess-length",
          startedAt: BASE,
          endedAt: BASE + 10_000,
          promptChars: 20,
          promptLines: 1,
        });
        seedMoment(db, {
          sessionId: "sess-length",
          turnId: 1,
          kind: "prompt",
          occurredAt: BASE + 1000,
        });
      } finally {
        db.close();
      }
      const snapshot = sessionSnapshot(
        storage,
        defaultSettings(),
        "sess-length",
      );
      expect(snapshot?.turns[0]?.humanMoments.map((m) => m.sentence)).toEqual([
        "You asked a question (20 characters, wording not kept)",
      ]);
    } finally {
      storage.close();
    }
  });
});

describe("read api turn summaries", () => {
  afterEach(async () => {
    await runCleanups();
  });

  function seedPromptsWithAttachments(storage: Storage): void {
    const db = new DatabaseSync(storage.dbPath);
    try {
      seedSession(db, { id: "sess-carried", firstSeenAt: BASE });
      seedTurn(db, { id: 1, sessionId: "sess-carried", sequence: 1 });
      seedTurn(db, {
        id: 2,
        sessionId: "sess-carried",
        sequence: 2,
        imageCount: 2,
      });
      // An image count with no image row: the count is the turn's own.
      seedTurn(db, {
        id: 3,
        sessionId: "sess-carried",
        sequence: 3,
        imageCount: 1,
      });
      // The prompt's own size row is not a file it carried.
      seedPromptAttachment(db, {
        sessionId: "sess-carried",
        turnId: 1,
        kind: "prompt",
        sizeBytes: 40,
      });
      for (const kind of ["image", "image", "file", "file", "file"]) {
        seedPromptAttachment(db, {
          sessionId: "sess-carried",
          turnId: 2,
          kind,
          name: kind === "image" ? "image/png" : "notes.md",
        });
      }
    } finally {
      db.close();
    }
  }

  it("counts the images and attached files each prompt carried, and not the prompt itself", () => {
    const { dataDir } = makeRoot("flightpath-read-api-test-");
    const storage = openStorage({ dataDir });
    try {
      seedPromptsWithAttachments(storage);
      const snapshot = sessionSnapshot(
        storage,
        defaultSettings(),
        "sess-carried",
      );
      expect(
        snapshot?.turns.map(({ images, files }) => ({ images, files })),
      ).toEqual([
        { images: 0, files: 0 },
        { images: 2, files: 3 },
        { images: 1, files: 0 },
      ]);
    } finally {
      storage.close();
    }
  });
});
