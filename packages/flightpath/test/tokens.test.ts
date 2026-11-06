import { afterEach, describe, expect, it } from "vitest";

import {
  loadSessionData,
  rebuildCauseText,
  sessionSnapshot,
  tokenHistory,
} from "../src/api/index.js";
import { defaultSettings } from "../src/settings/index.js";
import type { Rise, TokenHistory } from "../src/api/payloads.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  LAUNCH_NOTICE_CHARS,
  seedHandback,
  seedLaunch,
} from "./support/background-subagent.js";
import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import { NO_CATEGORIES } from "./support/context-report.js";
import {
  ESTIMATE_KEPT,
  RISE_READ,
  RISE_SESSION,
  seedRiseRead,
} from "./support/measured-rise.js";
import { seedWarmPair } from "./support/rebuild-pair.js";
import {
  seedBranch,
  seedGrowthSession,
  seedLoad,
  seedMoment,
  seedOneTurn,
  seedPlantedSession,
  seedPromptAttachment,
  seedRealisticSession,
  seedRequestExact,
  seedRequestShape,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";
import { plantedTokenHistory } from "../../view/test/tokens-history-fixture.js";

// The token history over hand-written fixtures: each session
// below is planted row by row with numbers chosen so the
// expected history can be checked exactly.

afterEach(async () => {
  await runCleanups();
});

function makeWorld(): { storage: Storage; db: DatabaseSync } {
  const dir = makeTempRoot("flightpath-tokens-");
  const storage = openStorage({ dataDir: dir });
  const db = new DatabaseSync(storage.dbPath);
  registerCleanup(() => {
    db.close();
    storage.close();
  });
  return { storage, db };
}

function history(
  storage: Storage,
  sessionId: string,
  autoCompactWindow: number | null = null,
  storePromptText: boolean = true,
): TokenHistory {
  const data = loadSessionData(storage, sessionId);
  if (data === undefined) throw new Error("session did not seed");
  return tokenHistory(data, { autoCompactWindow, storePromptText });
}

/** Seed one request on a model, with the sample measured on it. */
function seedMeasuredRequest(
  db: DatabaseSync,
  sessionId: string,
  fields: { id: number; model: string; startedAt: number; tokens: number },
): void {
  seedRequestExact(db, {
    id: fields.id,
    sessionId,
    turnId: 1,
    model: fields.model,
    startedAt: fields.startedAt,
    input: fields.tokens,
  });
  seedSample(db, {
    sessionId,
    requestId: fields.id,
    sampledAt: fields.startedAt,
    contextTokens: fields.tokens,
  });
}

/** A 200K session holding one 50,000-token request and its sample. */
function seedRoomSession(db: DatabaseSync, id: string): void {
  seedOneTurn(db, id, "claude-sonnet-4-6");
  seedRequestExact(db, {
    id: 1,
    sessionId: id,
    turnId: 1,
    model: "claude-sonnet-4-6",
    startedAt: 1_000,
    input: 50_000,
  });
  seedSample(db, {
    sessionId: id,
    requestId: 1,
    sampledAt: 1_000,
    contextTokens: 50_000,
  });
}

describe("the token history of the planted session", () => {
  it("matches the view's planted fixture exactly, so the two cannot drift", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    expect(history(storage, S)).toEqual(plantedTokenHistory);
  });

  it("gives the 14 main points in order, and the title request never appears", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    expect(result.sessionId).toBe(S);
    expect(result.states).toEqual({
      telemetry: true,
      tokensPartial: true,
      joinedPartway: true,
    });
    expect(result.main.map((point) => point.requestId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(result.main.map((point) => point.tokens)).toEqual([
      20_000, 55_000, 73_000, 73_000, 85_000, 85_000, 93_000, 193_000, 197_000,
      202_000, 202_000, 202_000, 25_000, 27_000,
    ]);
    expect(result.main.map((point) => point.at)).toEqual([
      1_000, 6_000, 10_000, 15_000, 21_000, 23_000, 31_000, 36_000, 39_000,
      46_000, 55_000, 70_000, 76_000, 80_000,
    ]);
    expect(result.base).toEqual(result.main[0]);
    // Request 2 wrote 5-minute cache; no other request wrote
    // any, so its lifetime carries to the end of the series.
    expect(result.main.map((point) => point.cacheLifetime)).toEqual([
      null,
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
      "5m",
    ]);
  });

  it("measures the branch from its own requests, never its stored total", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    expect(result.branches).toHaveLength(1);
    const branch = result.branches[0];
    expect(branch?.branchId).toBe(1);
    expect(branch?.agentType).toBe("Explore");
    expect(branch?.spawningStepId).toBe(4);
    expect(branch?.points.map((point) => point.tokens)).toEqual([
      8_000, 47_000,
    ]);
    // 8,000 + 47,000 from the requests; the stored total is 61,000.
    expect(branch?.tokensProcessed).toBe(55_000);
    expect(branch?.returnedChars).toBeNull();
    expect(result.background).toEqual([]);
  });

  it("names the parent of a nested subagent's lane, and none for a main-launched one", () => {
    const { storage, db } = makeWorld();
    seedOneTurn(db, "sess-nested");
    // The planner was launched from the turn; the explorer
    // was launched from inside the planner — its spawning
    // step sits in the planner's branch.
    const plannerLaunch = seedStep(db, {
      sessionId: "sess-nested",
      turnId: 1,
      toolName: "Agent",
    });
    seedBranch(db, {
      id: 1,
      sessionId: "sess-nested",
      agentId: "a0000000000000001",
      agentType: "planner",
      spawningStepId: plannerLaunch,
    });
    const explorerLaunch = seedStep(db, {
      sessionId: "sess-nested",
      turnId: 1,
      branchId: 1,
      toolName: "Agent",
    });
    seedBranch(db, {
      id: 2,
      sessionId: "sess-nested",
      agentId: "a0000000000000002",
      agentType: "explorer",
      spawningStepId: explorerLaunch,
    });
    const lanes = history(storage, "sess-nested").branches;
    expect(lanes.map((lane) => [lane.branchId, lane.parentAgentType])).toEqual([
      [1, null],
      [2, "planner"],
    ]);
  });

  it("says what each lane's subagent started with, from its own loads and in the order it received them", () => {
    const { storage, db } = makeWorld();
    seedOneTurn(db, "sess-start");
    seedBranch(db, { id: 1, sessionId: "sess-start", agentId: "a1" });
    seedBranch(db, { id: 2, sessionId: "sess-start", agentId: "a2" });
    // A main-thread listing, which belongs to no lane.
    seedLoad(db, {
      sessionId: "sess-start",
      kind: "skill-listing",
      source: "transcript",
      sizeBytes: 20_000,
    });
    const start = [
      { kind: "skill-listing", sizeBytes: 5_000 },
      { kind: "instructions", sizeBytes: 1_200 },
      { kind: "task-prompt", sizeBytes: 2_000 },
      { kind: "preloaded-skill", name: "house-style", sizeBytes: 8_000 },
      { kind: "preloaded-skill", name: "release-notes", sizeBytes: 3_000 },
    ];
    for (const load of start) {
      seedLoad(db, {
        sessionId: "sess-start",
        source: "transcript",
        branchId: 1,
        ...load,
      });
    }
    const lanes = history(storage, "sess-start").branches;
    // 690 + 2,759 + 1,035 + 414 + 1,725 tokens.
    expect(lanes.map((lane) => lane.startedWith)).toEqual([
      {
        tokens: 6_623,
        parts: ["task", "skills", "CLAUDE.md", "listings"],
      },
      null,
    ]);
  });

  it("sizes each lane by its own subagent's hand-back, matched by agent id", () => {
    const { storage, db } = makeWorld();
    seedOneTurn(db, "sess-lanes");
    const handback = (agentId: string, chars: number, at: number): void => {
      seedMoment(db, {
        sessionId: "sess-lanes",
        turnId: 1,
        kind: "handback",
        occurredAt: at,
        detail: JSON.stringify({
          agent_type: "general-purpose",
          agent_id: agentId,
          chars,
        }),
      });
    };
    // Three subagents ran; the second reported back first,
    // the third never did, and one report names a subagent
    // whose transcript never arrived.
    for (const [id, agentId] of [
      [1, "a0000000000000001"],
      [2, "a0000000000000002"],
      [3, "a0000000000000003"],
    ] as const) {
      seedBranch(db, { id, sessionId: "sess-lanes", agentId });
    }
    handback("a0000000000000002", 2_000, 1_000);
    handback("a0000000000000001", 4_447, 2_000);
    handback("a0000000000000009", 777, 3_000);
    const lanes = history(storage, "sess-lanes").branches;
    expect(lanes.map((lane) => [lane.branchId, lane.returnedChars])).toEqual([
      [1, 4_447],
      [2, 2_000],
      [3, null],
    ]);
  });

  it("sums each turn over its main requests, with its context change", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    // The title request and the branch's requests count for
    // no turn.
    expect(result.turns).toEqual([
      {
        turnId: 1,
        sequence: 1,
        input: 25_000,
        output: 1_200,
        cacheRead: 120_000,
        cacheWrite: 3_000,
        contextStart: 20_000,
        contextEnd: 73_000,
        contextChange: 53_000,
        promptLine: null,
        promptChars: 17,
      },
      {
        turnId: 2,
        sequence: 2,
        input: 7_000,
        output: 600,
        cacheRead: 236_000,
        cacheWrite: 0,
        contextStart: 73_000,
        contextEnd: 85_000,
        contextChange: 12_000,
        promptLine: null,
        promptChars: 23,
      },
      {
        turnId: 3,
        sequence: 3,
        input: 21_000,
        output: 3_100,
        cacheRead: 1_120_000,
        cacheWrite: 0,
        contextStart: 93_000,
        contextEnd: 27_000,
        contextChange: -66_000,
        promptLine: null,
        promptChars: 145,
      },
    ]);
  });

  it("measures the room from the latest point, with no turns-left under three grown turns", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    // The planted model is listed with a 1M window, and the
    // model default sets the compact point. Two ended turns
    // grew, so no turns-left estimate yet.
    expect(result.room).toEqual({
      window: { tokens: 1_000_000, source: "model-list", reportedAt: null },
      autoCompact: { tokens: 967_000, source: "model-default" },
      toLimit: 973_000,
      toAutoCompact: 940_000,
      turnsLeft: null,
    });
  });
});

describe("the token history", () => {
  it("carries the cache lifetime from a request's own write, then the previous point's", () => {
    const { storage, db } = makeWorld();
    const S = "sess-lifetime";
    seedOneTurn(db, S);
    // A reported cache split stores both buckets, the
    // unwritten one as zero: a write is an amount, not a
    // present column.
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 1_000,
      cacheWrite5m: 0,
      cacheWrite1h: 5_000,
    });
    seedRequestExact(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      startedAt: 2_000,
      input: 1_000,
      cacheRead: 6_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    seedRequestExact(db, {
      id: 3,
      sessionId: S,
      turnId: 1,
      startedAt: 3_000,
      input: 1_000,
      cacheRead: 6_000,
      cacheWrite5m: 3_000,
      cacheWrite1h: 0,
    });
    const result = history(storage, S);
    expect(result.main.map((point) => point.cacheLifetime)).toEqual([
      "1h",
      "1h",
      "5m",
    ]);
  });

  it("sums a user branch from its own requests and sends every other kind to background", () => {
    const { storage, db } = makeWorld();
    const S = "sess-branches";
    seedOneTurn(db, S);
    seedBranch(db, { id: 1, sessionId: S, agentType: "Explore", kind: "user" });
    seedBranch(db, { id: 2, sessionId: S, agentType: null, kind: "internal" });
    seedBranch(db, { id: 3, sessionId: S, agentType: "probe", kind: null });
    seedRequestExact(db, {
      id: 11,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      querySource: "subagent",
      startedAt: 1_000,
      input: 1_000,
      output: 100,
    });
    seedRequestExact(db, {
      id: 12,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      querySource: "subagent",
      startedAt: 2_000,
      input: 2_000,
      cacheRead: 500,
      output: 100,
    });
    // Recorded counts but no start: no point, still processed.
    seedRequestExact(db, {
      id: 13,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      querySource: "subagent",
      startedAt: null,
      input: 4_000,
      output: 100,
    });
    seedRequestExact(db, {
      id: 31,
      sessionId: S,
      turnId: 1,
      branchId: 3,
      querySource: "subagent",
      startedAt: 1_500,
      input: 700,
      output: 30,
    });

    const result = history(storage, S);
    expect(result.branches).toHaveLength(1);
    const branch = result.branches[0];
    expect(branch?.points.map((point) => point.requestId)).toEqual([11, 12]);
    expect(branch?.tokensProcessed).toBe(1_100 + 2_600 + 4_100);
    // The internal branch has no requests: null, never zero.
    // The kindless branch's requests are summed in background.
    expect(result.background).toEqual([
      { branchId: 2, agentType: null, tokensProcessed: null },
      { branchId: 3, agentType: "probe", tokensProcessed: 730 },
    ]);
  });

  it("leaves a turn with no main requests at zero sums and null context", () => {
    const { storage, db } = makeWorld();
    const S = "sess-turns";
    seedOneTurn(db, S);
    seedTurn(db, {
      id: 2,
      sessionId: S,
      sequence: 2,
      startedAt: 10_000,
      endedAt: 20_000,
    });
    seedBranch(db, { id: 1, sessionId: S, agentType: "Explore", kind: "user" });
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 5_000,
      output: 100,
      cacheRead: 1_000,
      cacheWrite5m: 500,
    });
    seedRequestExact(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      startedAt: 2_000,
      input: 1_000,
      output: 100,
      cacheRead: 6_500,
    });
    // Turn 2 holds only the branch's request: no main sums.
    seedRequestExact(db, {
      id: 3,
      sessionId: S,
      turnId: 2,
      branchId: 1,
      querySource: "subagent",
      startedAt: 11_000,
      input: 9_000,
      output: 900,
    });

    const result = history(storage, S);
    expect(result.turns).toEqual([
      {
        turnId: 1,
        sequence: 1,
        input: 6_000,
        output: 200,
        cacheRead: 7_500,
        cacheWrite: 500,
        contextStart: 6_500,
        contextEnd: 7_500,
        contextChange: 1_000,
        promptLine: null,
        promptChars: null,
      },
      {
        turnId: 2,
        sequence: 2,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextStart: null,
        contextEnd: null,
        contextChange: null,
        promptLine: null,
        promptChars: null,
      },
    ]);
  });

  it("takes the room's compact point from the setting before the model default", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-setting";
    seedRoomSession(db, S);

    const result = history(storage, S, 80_000);
    expect(result.room.window.tokens).toBe(200_000);
    expect(result.room.autoCompact).toEqual({
      tokens: 80_000,
      source: "setting",
    });
    expect(result.room.toLimit).toBe(150_000);
    expect(result.room.toAutoCompact).toBe(30_000);
  });

  it("knows no compact point for a 200K session with no setting", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-none";
    seedRoomSession(db, S);

    const result = history(storage, S);
    expect(result.room).toEqual({
      window: { tokens: 200_000, source: "model-list", reportedAt: null },
      autoCompact: null,
      toLimit: 150_000,
      toAutoCompact: null,
      turnsLeft: null,
    });
  });

  it("follows the latest main request's model, not the session's first", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-switch";
    // The session opened on a 200K model; its latest main
    // request ran on Sonnet 5.5, so the room and the summary
    // both read the 1M window from the list.
    seedSession(db, { id: S, model: "claude-sonnet-4-6" });
    seedTurn(db, {
      id: 1,
      sessionId: S,
      sequence: 1,
      startedAt: 0,
      endedAt: 9_000,
    });
    seedMeasuredRequest(db, S, {
      id: 1,
      model: "claude-sonnet-4-6",
      startedAt: 1_000,
      tokens: 10_000,
    });
    seedMeasuredRequest(db, S, {
      id: 2,
      model: "claude-sonnet-5-5",
      startedAt: 2_000,
      tokens: 20_000,
    });

    expect(history(storage, S).room.window).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
    const snapshot = sessionSnapshot(storage, defaultSettings(), S);
    expect(snapshot?.summary.window).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
  });

  it("drops to the 200K window when the session switches down to Haiku", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-switch-down";
    // The session ran Sonnet 5.5 past 200K, then switched to
    // Haiku 4.5: the earlier model's sample does not raise
    // the window the room and the summary now read.
    seedSession(db, { id: S, model: "claude-sonnet-5-5" });
    seedTurn(db, {
      id: 1,
      sessionId: S,
      sequence: 1,
      startedAt: 0,
      endedAt: 9_000,
    });
    seedMeasuredRequest(db, S, {
      id: 1,
      model: "claude-sonnet-5-5",
      startedAt: 1_000,
      tokens: 300_000,
    });
    seedMeasuredRequest(db, S, {
      id: 2,
      model: "claude-haiku-4-5",
      startedAt: 2_000,
      tokens: 50_000,
    });

    expect(history(storage, S).room.window).toEqual({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
    const snapshot = sessionSnapshot(storage, defaultSettings(), S);
    expect(snapshot?.summary.window).toEqual({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
  });

  it("takes the compact point from a report's buffer", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-report";
    seedRoomSession(db, S);
    storage.recordContextReport(
      S,
      {
        model: "claude-sonnet-4-6",
        window: 200_000,
        autocompactBuffer: 33_000,
        ...NO_CATEGORIES,
      },
      5_000,
    );

    const result = history(storage, S);
    expect(result.room.window).toEqual({
      tokens: 200_000,
      source: "context-command",
      reportedAt: 5000,
    });
    expect(result.room.autoCompact).toEqual({
      tokens: 167_000,
      source: "context-command",
    });
    expect(result.room.toAutoCompact).toBe(117_000);
  });

  it("estimates turns left from the median growth of the last five ended turns", () => {
    const { storage, db } = makeWorld();
    const S = seedGrowthSession(db);

    const result = history(storage, S);
    expect(result.room.window.tokens).toBe(1_000_000);
    expect(result.room.autoCompact).toEqual({
      tokens: 967_000,
      source: "model-default",
    });
    // Latest point 290,000; the last five growths are
    // 30K..70K, median 50K: floor(677,000 / 50,000) = 13.
    expect(result.room.toAutoCompact).toBe(677_000);
    expect(result.room.turnsLeft).toEqual({ value: 13, estimated: true });
  });

  it("counts zero turns left once the series is past the compact point", () => {
    const { storage, db } = makeWorld();
    const S = "sess-room-past";
    seedSession(db, { id: S, model: "claude-sonnet[1m]" });
    // Three ended turns, each growing; the last point lands
    // past the 1M models' compact point.
    const points: [number, number][] = [
      [900_000, 920_000],
      [930_000, 950_000],
      [960_000, 990_000],
    ];
    points.forEach(([first, last], index) => {
      const turnId = index + 1;
      const at = index * 10_000;
      seedTurn(db, {
        id: turnId,
        sessionId: S,
        sequence: turnId,
        startedAt: at,
        endedAt: at + 9_000,
      });
      seedRequestExact(db, {
        id: turnId * 2 - 1,
        sessionId: S,
        turnId,
        model: "claude-sonnet[1m]",
        startedAt: at + 1_000,
        input: first,
      });
      seedRequestExact(db, {
        id: turnId * 2,
        sessionId: S,
        turnId,
        model: "claude-sonnet[1m]",
        startedAt: at + 2_000,
        input: last,
      });
    });

    const result = history(storage, S);
    expect(result.room.toAutoCompact).toBe(-23_000);
    expect(result.room.turnsLeft).toEqual({ value: 0, estimated: true });
  });

  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "builds the history of a 5,000-request session in under 200 ms",
    () => {
      const { storage, db } = makeWorld();
      db.exec("BEGIN");
      seedRealisticSession(db, { base: 1_700_000_000_000 });
      // Grow the recorded context by 3,000 every five
      // requests, link every fifth request's own step to
      // it, and land a load in every fifth rise's window:
      // the walk under the bound then builds rises by the
      // hundred, with their step and load lookups.
      db.exec(
        "UPDATE requests SET cache_read_tokens = 40000 + (id / 5) * 3000",
      );
      db.exec(
        "UPDATE steps SET result_request_id = id WHERE branch_id IS NULL AND id % 5 = 0",
      );
      for (let k = 1; k <= 200; k += 1) {
        const requestId = k * 25;
        const turn = Math.floor((requestId - 1) / 10) + 1;
        const step = (requestId - 1) % 10;
        seedLoad(db, {
          sessionId: "sess-big",
          kind: "skill",
          name: `skill-${k}`,
          occurredAt: 1_700_000_000_000 + turn * 60_000 + step * 1_000,
          sizeBytes: 4_000,
        });
      }
      db.exec("COMMIT");
      const data = loadSessionData(storage, "sess-big");
      if (data === undefined) throw new Error("session did not seed");
      const started = performance.now();
      const result = tokenHistory(data, {
        autoCompactWindow: null,
        storePromptText: true,
      });
      const elapsed = performance.now() - started;
      console.log(
        `token history of ${data.requests.length} requests: ${elapsed.toFixed(1)} ms, ${result.main.length} main points, ${result.rises.length} rises`,
      );
      expect(result.main.length).toBeGreaterThan(0);
      // A rise at every fifth request — 999, the branch's
      // two requests set aside — and the context never
      // falls, so there are no drops.
      expect(result.rises.length).toBeGreaterThan(900);
      expect(result.rises.length).toBeLessThan(1_100);
      expect(
        result.rises.filter((rise) => rise.link === "exact").length,
      ).toBeGreaterThan(900);
      const loadItems = result.rises.reduce(
        (sum, rise) =>
          sum + rise.items.filter((item) => item.kind === "load").length,
        0,
      );
      expect(loadItems).toBe(200);
      expect(result.drops).toEqual([]);
      expect(elapsed).toBeLessThan(200);
    },
    60_000,
  );
});

describe("the token history's rises and drops", () => {
  function riseTo(result: TokenHistory, toRequestId: number): Rise {
    const rise = result.rises.find((r) => r.toRequestId === toRequestId);
    if (rise === undefined) {
      throw new Error(`no rise to request ${toRequestId}`);
    }
    return rise;
  }

  function stepIds(rise: Rise): number[] {
    return rise.items.flatMap((item) =>
      item.kind === "step" || item.kind === "branch-return"
        ? [item.stepId]
        : [],
    );
  }

  // Seeds one turn's main requests from compact specs, so a
  // test states its request series in a few lines.
  function seedMainRun(
    db: DatabaseSync,
    sessionId: string,
    turnId: number,
    specs: readonly {
      id: number;
      startedAt: number;
      input: number;
      output?: number;
    }[],
  ): void {
    for (const spec of specs) {
      seedRequestExact(db, { sessionId, turnId, ...spec });
    }
  }

  // A 30,000-token rise to request 2 with a `code-style` skill
  // loaded between the two requests.
  function seedSkillRise(
    db: DatabaseSync,
    sessionId: string,
    sizeBytes: number,
  ): void {
    seedOneTurn(db, sessionId);
    seedMainRun(db, sessionId, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 40_000 },
    ]);
    seedLoad(db, {
      id: 1,
      sessionId,
      kind: "skill",
      name: "code-style",
      occurredAt: 1_500,
      sizeBytes,
    });
  }

  it("ranks the planted rises by delta, each with its planted link kind", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    expect(result.rises.map((rise) => rise.toRequestId)).toEqual([
      8, 2, 3, 5, 7, 10, 9, 14,
    ]);
    expect(result.rises.map((rise) => rise.delta)).toEqual([
      100_000, 35_000, 18_000, 12_000, 8_000, 5_000, 4_000, 2_000,
    ]);
    const links = new Map(
      result.rises.map((rise) => [rise.toRequestId, rise.link]),
    );
    expect(links.get(2)).toBe("exact");
    expect(links.get(3)).toBe("exact");
    expect(links.get(5)).toBe("exact");
    expect(links.get(7)).toBe("none");
    expect(links.get(8)).toBe("exact");
    expect(links.get(9)).toBe("exact");
    expect(links.get(10)).toBe("none");
    expect(links.get(14)).toBe("none");
  });

  it("gives each planted rise the item its ground truth names", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);

    const first = riseTo(result, 2);
    expect(first).toMatchObject({
      id: "rise-2",
      fromRequestId: 1,
      at: 6_000,
    });
    expect(first.items[0]).toMatchObject({
      kind: "step",
      stepId: 1,
      label: "Read a file",
      chars: 101_500,
      tokens: 34_700,
      estimated: false,
    });

    const pair = riseTo(result, 3);
    expect(stepIds(pair).sort()).toEqual([2, 3]);
    // The larger step ranks first; the two estimates
    // overshoot the measured rise and stand as they are.
    expect(pair.items.map((item) => item.tokens)).toEqual([16_000, 2_000, 400]);
    expect(pair.items.some((item) => item.kind === "other")).toBe(false);

    const returned = riseTo(result, 5);
    expect(returned.items[0]).toMatchObject({
      kind: "branch-return",
      stepId: 4,
      branchId: 1,
      tokens: 12_000,
    });

    const pasted = riseTo(result, 7);
    expect(stepIds(pasted)).toEqual([]);
    expect(pasted.items).toContainEqual(
      expect.objectContaining({
        kind: "prompt",
        turnId: 3,
        chars: 145,
        tokens: 50,
      }),
    );

    expect(riseTo(result, 8).items[0]).toMatchObject({
      kind: "step",
      stepId: 5,
      tokens: 99_400,
      estimated: false,
    });
    expect(stepIds(riseTo(result, 9))).toEqual([6]);
    expect(riseTo(result, 10).items).toContainEqual(
      expect.objectContaining({
        kind: "load",
        name: "deep-research",
        tokens: null,
      }),
    );
  });

  it("lists the planted drop as a compaction, never a step's fault", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = history(storage, S);
    expect(result.drops).toEqual([
      {
        id: "drop-13",
        fromRequestId: 12,
        toRequestId: 13,
        at: 76_000,
        before: 202_000,
        after: 25_000,
        cause: "compaction",
        segmentId: 2,
      },
    ]);
  });

  it("leaves a drop's cause unknown when no compaction sits between its requests", () => {
    const { storage, db } = makeWorld();
    const S = "sess-drop-unknown";
    seedOneTurn(db, S);
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 50_000,
    });
    seedRequestExact(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      startedAt: 2_000,
      input: 20_000,
    });
    const result = history(storage, S);
    expect(result.drops).toEqual([
      {
        id: "drop-2",
        fromRequestId: 1,
        toRequestId: 2,
        at: 2_000,
        before: 50_000,
        after: 20_000,
        cause: "unknown",
        segmentId: null,
      },
    ]);
  });

  it("changes nothing under the exact link when step 5 slips 2 ms late", () => {
    const base = makeWorld();
    const baseId = seedPlantedSession(base.db);
    const expected = history(base.storage, baseId);
    const slipped = makeWorld();
    const slippedId = seedPlantedSession(slipped.db);
    slipped.db
      .prepare("UPDATE steps SET ended_at = ? WHERE id = ?")
      .run(36_001, 5);
    const result = history(slipped.storage, slippedId);
    expect(result.rises).toEqual(expected.rises);
    expect(result.drops).toEqual(expected.drops);
  });

  it("finds rises by the time rule when no step carries the link", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    db.exec("UPDATE steps SET result_request_id = NULL");
    const result = history(storage, S);
    const links = new Map(
      result.rises.map((rise) => [rise.toRequestId, rise.link]),
    );
    expect(links.get(2)).toBe("by_time");
    expect(links.get(3)).toBe("by_time");
    expect(links.get(5)).toBe("by_time");
    expect(links.get(7)).toBe("none");
    expect(links.get(8)).toBe("by_time");
    expect(links.get(9)).toBe("by_time");
    expect(links.get(10)).toBe("none");
    expect(links.get(14)).toBe("none");
    expect(stepIds(riseTo(result, 2))).toEqual([1]);
    expect(stepIds(riseTo(result, 3)).sort()).toEqual([2, 3]);
    expect(stepIds(riseTo(result, 5))).toEqual([4]);
    expect(stepIds(riseTo(result, 8))).toEqual([5]);
    expect(stepIds(riseTo(result, 9))).toEqual([6]);
  });

  it("never falls back to the time rule for one rise when the session has the link", () => {
    const { storage, db } = makeWorld();
    const S = "sess-link-choice";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 30_000 },
      { id: 3, startedAt: 3_000, input: 50_000 },
    ]);
    // A step the link never names, ending inside the rise
    // to request 2's window: the time rule would name it,
    // the per-session choice must not.
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_200,
      endedAt: 1_500,
      resultSize: 40_000,
    });
    // The link itself, naming the rise to request 3.
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      startedAt: 2_200,
      endedAt: 2_500,
      resultSize: 40_000,
      resultRequestId: 3,
    });
    const result = history(storage, S);
    const unnamed = riseTo(result, 2);
    expect(unnamed.link).toBe("none");
    expect(stepIds(unnamed)).toEqual([]);
    const named = riseTo(result, 3);
    expect(named.link).toBe("exact");
    expect(stepIds(named)).toEqual([2]);
  });

  it("loses step 5 from the +100,000 rise under the time rule when it slips 2 ms late", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    db.exec("UPDATE steps SET result_request_id = NULL");
    db.prepare("UPDATE steps SET ended_at = ? WHERE id = ?").run(36_001, 5);
    const result = history(storage, S);
    const rise = riseTo(result, 8);
    expect(rise.link).toBe("none");
    expect(stepIds(rise)).toEqual([]);
  });

  // Two turns; the second turn's first request sits 60,000
  // over the first turn's reply, so request 2 carries a rise
  // whose items the two tests below read.
  const seedItemsWorld = (db: DatabaseSync, sessionId: string): void => {
    seedSession(db, { id: sessionId });
    seedTurn(db, {
      id: 1,
      sessionId: sessionId,
      sequence: 1,
      startedAt: 0,
      endedAt: 900,
    });
    seedTurn(db, {
      id: 2,
      sessionId: sessionId,
      sequence: 2,
      startedAt: 1_000,
      endedAt: 9_000,
      promptChars: 40,
    });
    seedMainRun(db, sessionId, 1, [
      { id: 1, startedAt: 100, input: 10_000, output: 250 },
    ]);
    seedMainRun(db, sessionId, 2, [
      { id: 2, startedAt: 2_000, input: 70_000, output: 100 },
    ]);
  };

  it("marks the reply as measured, and the step and prompt items as estimates", () => {
    const { storage, db } = makeWorld();
    const S = "sess-items";
    seedItemsWorld(db, S);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 2,
      startedAt: 1_200,
      endedAt: 1_500,
      resultSize: 4_000,
      resultRequestId: 2,
    });
    const rise = riseTo(history(storage, S), 2);
    expect(rise.items.find((item) => item.kind === "reply")).toMatchObject({
      requestId: 1,
      tokens: 250,
      estimated: false,
    });
    expect(rise.items.find((item) => item.kind === "step")).toMatchObject({
      stepId: 1,
      tokens: 1_380,
      estimated: true,
    });
    expect(rise.items.find((item) => item.kind === "prompt")).toMatchObject({
      tokens: 14,
      estimated: true,
    });
  });

  it("gives an image null tokens, a file its estimate, and zero tokens only to an empty result", () => {
    const { storage, db } = makeWorld();
    const S = "sess-items-null";
    seedItemsWorld(db, S);
    seedPromptAttachment(db, {
      sessionId: S,
      turnId: 2,
      kind: "image",
      name: "image/png",
      sizeBytes: 5_000,
    });
    seedPromptAttachment(db, {
      sessionId: S,
      turnId: 2,
      kind: "file",
      name: "notes.md",
      sizeBytes: 2_000,
    });
    seedPromptAttachment(db, {
      sessionId: S,
      turnId: 2,
      kind: "prompt",
      sizeBytes: 40,
      lineCount: 1,
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 2,
      startedAt: 1_200,
      endedAt: 1_500,
      resultSize: 0,
      contextChars: 0,
      resultRequestId: 2,
    });
    const rise = riseTo(history(storage, S), 2);
    const attachments = rise.items.filter((item) => item.kind === "attachment");
    // The prompt-kind row is the prompt's own text, already
    // counted in the prompt item: no second item for it.
    expect(attachments).toHaveLength(2);
    expect(
      attachments.find((item) => item.attachmentKind === "image"),
    ).toMatchObject({
      attachmentKind: "image",
      bytes: 5_000,
      tokens: null,
    });
    expect(
      attachments.find((item) => item.attachmentKind === "file"),
    ).toMatchObject({
      attachmentKind: "file",
      name: "notes.md",
      bytes: 2_000,
      tokens: 690,
    });
    expect(rise.items.some((item) => item.tokens === 0)).toBe(true);
    for (const item of rise.items) {
      if (item.tokens === 0) expect(item).toMatchObject({ chars: 0 });
    }
  });

  it("sizes a step by what entered context, with the raw size beside it", () => {
    const { storage, db } = makeWorld();
    const S = "sess-entered";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 110_000 },
    ]);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_200,
      endedAt: 1_500,
      resultSize: 234_000,
      contextChars: 180,
      resultRequestId: 2,
    });
    const rise = riseTo(history(storage, S), 2);
    const step = rise.items.find((item) => item.kind === "step");
    expect(step).toMatchObject({
      stepId: 1,
      chars: 180,
      rawChars: 234_000,
      tokens: 63,
    });
  });

  it("names the gap as other and never scales items to fit", () => {
    const { storage, db } = makeWorld();
    const seedGap = (
      id: string,
      turnId: number,
      firstId: number,
      second: number,
    ): void => {
      seedSession(db, { id });
      seedTurn(db, {
        id: turnId,
        sessionId: id,
        sequence: 1,
        startedAt: 0,
        endedAt: 9_000,
      });
      seedRequestExact(db, {
        id: firstId,
        sessionId: id,
        turnId,
        startedAt: 1_000,
        input: 10_000,
      });
      seedRequestExact(db, {
        id: firstId + 1,
        sessionId: id,
        turnId,
        startedAt: 2_000,
        input: second,
      });
      seedStep(db, {
        id: turnId,
        sessionId: id,
        turnId,
        startedAt: 1_200,
        endedAt: 1_500,
        resultSize: 24_000,
        resultRequestId: firstId + 1,
      });
    };
    seedGap("sess-gap-wide", 1, 1, 20_000);
    seedGap("sess-gap-narrow", 2, 3, 13_000);

    const wide = riseTo(history(storage, "sess-gap-wide"), 2);
    expect(wide.items).toContainEqual(
      expect.objectContaining({ kind: "other", tokens: 1_724 }),
    );
    const narrow = riseTo(history(storage, "sess-gap-narrow"), 4);
    expect(narrow.items.some((item) => item.kind === "other")).toBe(false);
    expect(narrow.items).toContainEqual(
      expect.objectContaining({ kind: "step", stepId: 2, tokens: 8_276 }),
    );
  });

  it("keeps a rise's and a drop's id when an unrelated request is added before them", () => {
    const build = (extra: boolean): TokenHistory => {
      const { storage, db } = makeWorld();
      const S = "sess-ids";
      seedOneTurn(db, S);
      if (extra) {
        seedMainRun(db, S, 1, [{ id: 40, startedAt: 500, input: 10_000 }]);
      }
      seedMainRun(db, S, 1, [
        { id: 1, startedAt: 1_000, input: 10_000 },
        { id: 2, startedAt: 2_000, input: 90_000 },
        { id: 3, startedAt: 3_000, input: 20_000 },
      ]);
      return history(storage, S);
    };
    const plain = build(false);
    const extended = build(true);
    expect(plain.rises[0]?.id).toBe("rise-2");
    expect(plain.drops[0]?.id).toBe("drop-3");
    expect(extended.rises.map((rise) => rise.id)).toEqual(
      plain.rises.map((rise) => rise.id),
    );
    expect(extended.drops.map((drop) => drop.id)).toEqual(
      plain.drops.map((drop) => drop.id),
    );
  });

  it("takes a rise at exactly 2,000 and not at 1,999", () => {
    const { storage, db } = makeWorld();
    const S = "sess-floor";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 11_999 },
      { id: 3, startedAt: 3_000, input: 13_999 },
    ]);
    const result = history(storage, S);
    expect(result.rises).toHaveLength(1);
    expect(result.rises[0]).toMatchObject({ id: "rise-3", delta: 2_000 });
  });

  it("sizes a load by its bytes and names an instructions load by its file", () => {
    const { storage, db } = makeWorld();
    const S = "sess-load-items";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 30_000 },
    ]);
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "skill",
      name: "deep-dive",
      occurredAt: 1_200,
      sizeBytes: 10_001,
    });
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "instructions",
      filePath: "/home/user/project/CLAUDE.md",
      occurredAt: 1_400,
      sizeBytes: 2_000,
    });
    seedLoad(db, {
      id: 3,
      sessionId: S,
      kind: "skill",
      occurredAt: 1_600,
      sizeBytes: 400,
    });
    const rise = riseTo(history(storage, S), 2);
    const loads = rise.items.filter((item) => item.kind === "load");
    expect(loads).toHaveLength(3);
    // 10,001 bytes is 3,449 tokens: the ceiling runs on the
    // byte size, not only on character counts.
    expect(loads).toContainEqual(
      expect.objectContaining({
        loadId: 1,
        loadKind: "skill",
        name: "deep-dive",
        bytes: 10_001,
        tokens: 3_449,
      }),
    );
    expect(loads).toContainEqual(
      expect.objectContaining({
        loadId: 2,
        loadKind: "instructions",
        name: "/home/user/project/CLAUDE.md",
        bytes: 2_000,
        tokens: 690,
      }),
    );
    // No recorded name: the load reads as its kind.
    expect(loads).toContainEqual(
      expect.objectContaining({ loadId: 3, name: "skill", tokens: 138 }),
    );
  });

  it("leaves a subagent's instruction file out of the main thread's rise", () => {
    const { storage, db } = makeWorld();
    const S = "sess-subagent-file";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 30_000 },
    ]);
    const branchId = seedBranch(db, { sessionId: S, agentId: "a1" });
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "instructions",
      filePath: "/home/user/project/beds/CLAUDE.md",
      source: "transcript",
      occurredAt: 1_400,
      sizeBytes: 2_000,
      branchId,
    });
    const rise = riseTo(history(storage, S), 2);
    expect(rise.items.filter((item) => item.kind === "load")).toEqual([]);
  });

  it("lists a skill with the files it attached, and leaves them out of other", () => {
    const { storage, db } = makeWorld();
    const S = "sess-skill-rise";
    seedSkillRise(db, S, 8_700);
    for (const [id, path, bytes, lines] of [
      [2, "docs/a.md", 29_000, 600],
      [3, "docs/b.md", 14_500, 300],
      [4, "docs/c.md", 8_700, 150],
    ] as const) {
      seedLoad(db, {
        id,
        sessionId: S,
        kind: "skill-file",
        filePath: path,
        parentLoadId: 1,
        lineCount: lines,
        occurredAt: 1_500,
        sizeBytes: bytes,
      });
    }
    const rise = riseTo(history(storage, S), 2);
    expect(rise.items).toContainEqual({
      kind: "load",
      loadId: 1,
      loadKind: "skill",
      name: "code-style",
      bytes: 8_700,
      tokens: 3_000,
      files: {
        tokens: 18_000,
        items: [
          {
            loadId: 2,
            path: "docs/a.md",
            bytes: 29_000,
            lines: 600,
            tokens: 10_000,
          },
          {
            loadId: 3,
            path: "docs/b.md",
            bytes: 14_500,
            lines: 300,
            tokens: 5_000,
          },
          {
            loadId: 4,
            path: "docs/c.md",
            bytes: 8_700,
            lines: 150,
            tokens: 3_000,
          },
        ],
      },
      estimated: true,
    });
    expect(rise.items.filter((item) => item.kind === "load")).toHaveLength(1);
    // The 30,000-token rise less the skill's 3,000 and its files' 18,000.
    expect(rise.items).toContainEqual({
      kind: "other",
      tokens: 9_000,
      estimated: true,
    });
  });

  it("ranks a skill by its text and its files together", () => {
    const { storage, db } = makeWorld();
    const S = "sess-skill-rank";
    seedSkillRise(db, S, 2_900);
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "skill-file",
      filePath: "docs/a.md",
      parentLoadId: 1,
      occurredAt: 1_500,
      sizeBytes: 29_000,
    });
    seedLoad(db, {
      id: 3,
      sessionId: S,
      kind: "command-output",
      name: "/context",
      source: "transcript",
      occurredAt: 1_500,
      sizeBytes: 14_500,
    });
    const kinds = riseTo(history(storage, S), 2).items.map((item) =>
      item.kind === "load" ? item.loadKind : item.kind,
    );
    expect(kinds.slice(0, 2)).toEqual(["other", "skill"]);
  });

  it("names a /context report as a load of its command, sized by its length", () => {
    const { storage, db } = makeWorld();
    const S = "sess-command-output";
    seedOneTurn(db, S);
    seedMainRun(db, S, 1, [
      { id: 1, startedAt: 1_000, input: 10_000 },
      { id: 2, startedAt: 2_000, input: 18_900 },
    ]);
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "command-output",
      name: "/context",
      source: "transcript",
      occurredAt: 1_500,
      sizeBytes: 9_662,
    });
    const rise = riseTo(history(storage, S), 2);
    expect(rise.items).toContainEqual({
      kind: "load",
      loadId: 1,
      loadKind: "command-output",
      name: "/context",
      bytes: 9_662,
      tokens: 3_332,
      files: null,
      estimated: true,
    });
  });
});

describe("a rise sized by its result", () => {
  const S = RISE_SESSION;

  function riseWorld(): { storage: Storage; db: DatabaseSync } {
    const world = makeWorld();
    seedRiseRead(world.db, S);
    return world;
  }

  it("reads the result as measured and leaves nothing as other", () => {
    const { storage } = riseWorld();
    const [rise] = history(storage, S).rises;
    expect(rise?.delta).toBe(23_645);
    expect(rise?.items).toEqual([
      expect.objectContaining({
        kind: "step",
        stepId: 1,
        tokens: RISE_READ.measuredTokens,
        estimated: false,
      }),
      expect.objectContaining({ kind: "reply", requestId: 1, tokens: 67 }),
    ]);
  });

  it("still reads the result as measured when only a subagent's listing entered between the requests", () => {
    const { storage, db } = riseWorld();
    const branchId = seedBranch(db, { sessionId: S, agentId: "a1" });
    seedLoad(db, {
      sessionId: S,
      kind: "skill-listing",
      occurredAt: 3_000,
      source: "transcript",
      sizeBytes: 20_000,
      branchId,
    });
    const items = history(storage, S).rises.flatMap((rise) => rise.items);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "step",
        stepId: 1,
        tokens: RISE_READ.measuredTokens,
        estimated: false,
      }),
    );
  });

  it.each(ESTIMATE_KEPT)("keeps the estimate after $name", ({ change }) => {
    const { storage, db } = riseWorld();
    change(db, S);
    const items = history(storage, S).rises.flatMap((rise) => rise.items);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "step",
        stepId: 1,
        tokens: RISE_READ.estimatedTokens,
        estimated: true,
      }),
    );
  });
});

// A background subagent's launch returns only a notice; its
// report enters the main thread's context later, with the
// request after the hand-back.
describe("a rise with a subagent that runs in the background", () => {
  const S = "sess-rise-background";
  const GENERAL = "a0000000000000001";
  const EXPLORE = "a0000000000000002";
  const NESTED = "a0000000000000003";
  const NO_BRANCH = "a0000000000000009";

  /**
   * Three main requests. The rise to the second carries the
   * launch notice and a file read; the rise to the third
   * carries one command result and, between the two requests
   * at 2,000 and 6,000, the first subagent's report. The
   * rises stand 5,000 and 4,000 above the request before.
   */
  function seedRises(db: DatabaseSync, reportAt: number = 5_000): void {
    seedSession(db, { id: S });
    seedTurn(db, { id: 1, sessionId: S, sequence: 1, startedAt: 0 });
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 2,
      cacheRead: 40_000,
      output: 100,
    });
    seedRequestExact(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      startedAt: 2_000,
      input: 2,
      cacheRead: 40_000,
      cacheWrite5m: 5_000,
      output: 80,
    });
    seedRequestExact(db, {
      id: 3,
      sessionId: S,
      turnId: 1,
      startedAt: 6_000,
      input: 2,
      cacheRead: 45_000,
      cacheWrite5m: 4_000,
    });
    seedLaunch(db, {
      id: 1,
      sessionId: S,
      subagentType: "general-purpose",
      startedAt: 1_100,
      asyncLaunch: 1,
      resultRequestId: 2,
    });
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      toolName: "Read",
      input: { file_path: "src/index.ts" },
      startedAt: 1_300,
      endedAt: 1_400,
      resultSize: 6_000,
      resultRequestId: 2,
    });
    seedStep(db, {
      id: 3,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 3_000,
      endedAt: 3_100,
      resultSize: 2_000,
      resultRequestId: 3,
    });
    seedBranch(db, {
      id: 1,
      sessionId: S,
      agentId: GENERAL,
      agentType: "general-purpose",
      spawningStepId: 1,
    });
    seedHandback(db, {
      sessionId: S,
      occurredAt: reportAt,
      agentType: "general-purpose",
      agentId: GENERAL,
      chars: 4_447,
    });
  }

  /** A second background subagent, launched in the first rise. */
  function seedExplore(
    db: DatabaseSync,
    options: { reportAt: number; spawningStepId: number | null },
  ): void {
    seedLaunch(db, {
      id: 4,
      sessionId: S,
      subagentType: "Explore",
      startedAt: 1_200,
      asyncLaunch: 1,
      resultRequestId: 2,
    });
    seedBranch(db, {
      id: 2,
      sessionId: S,
      agentId: EXPLORE,
      agentType: "Explore",
      spawningStepId: options.spawningStepId,
    });
    seedHandback(db, {
      sessionId: S,
      occurredAt: options.reportAt,
      agentType: "Explore",
      agentId: EXPLORE,
      chars: 2_000,
    });
  }

  function riseTo(storage: Storage, toRequestId: number): Rise {
    const rise = history(storage, S).rises.find(
      (r) => r.toRequestId === toRequestId,
    );
    if (rise === undefined) throw new Error(`no rise to ${toRequestId}`);
    return rise;
  }

  function reportsIn(rise: Rise): { label: string; branchId: number | null }[] {
    return rise.items.flatMap((item) =>
      item.kind === "branch-return"
        ? [{ label: item.label, branchId: item.branchId }]
        : [],
    );
  }

  function otherIn(rise: Rise): number | undefined {
    return (
      rise.items.find((item) => item.kind === "other")?.tokens ?? undefined
    );
  }

  it("lists a background launch as a plain step named for the subagent", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    expect(riseTo(storage, 2).items).toContainEqual({
      kind: "step",
      stepId: 1,
      label: "Started a subagent: general-purpose",
      chars: LAUNCH_NOTICE_CHARS,
      rawChars: null,
      tokens: 391,
      estimated: true,
    });
  });

  it("lists a report in the rise that carried it, sized from the hand-back", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    const rise = riseTo(storage, 3);
    expect(rise.items).toContainEqual({
      kind: "branch-return",
      stepId: 1,
      branchId: 1,
      label: "general-purpose reported back",
      chars: 4_447,
      tokens: 1_534,
      estimated: true,
    });
    expect(otherIn(rise)).toBe(1_696);
  });

  it("keeps a synchronous result a return, with no second item for its hand-back", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    db.prepare("UPDATE steps SET async_launch = 0 WHERE id = 1").run();
    expect(riseTo(storage, 2).items).toContainEqual(
      expect.objectContaining({
        kind: "branch-return",
        stepId: 1,
        label: "Started a subagent: general-purpose",
      }),
    );
    expect(reportsIn(riseTo(storage, 3))).toEqual([]);
  });

  it("keeps a rise estimated when a report entered with its one result", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    expect(riseTo(storage, 3).items).toContainEqual(
      expect.objectContaining({ kind: "step", stepId: 3, estimated: true }),
    );
  });

  it("measures that result when no report came in", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    db.prepare("DELETE FROM human_events WHERE kind = 'handback'").run();
    expect(riseTo(storage, 3).items).toContainEqual(
      expect.objectContaining({
        kind: "step",
        stepId: 3,
        tokens: 3_920,
        estimated: false,
      }),
    );
  });

  it("lists two reports in one rise, each matched to its subagent by agent id", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    seedExplore(db, { reportAt: 4_500, spawningStepId: 4 });
    expect(reportsIn(riseTo(storage, 3))).toEqual(
      expect.arrayContaining([
        { label: "general-purpose reported back", branchId: 1 },
        { label: "Explore reported back", branchId: 2 },
      ]),
    );
    expect(reportsIn(riseTo(storage, 3))).toHaveLength(2);
  });

  it("puts a report in the rise to the request at its moment, not the one after", () => {
    const { storage, db } = makeWorld();
    seedRises(db, 6_000);
    seedExplore(db, { reportAt: 2_000, spawningStepId: 4 });
    expect(reportsIn(riseTo(storage, 2))).toEqual([
      { label: "Explore reported back", branchId: 2 },
    ]);
    expect(reportsIn(riseTo(storage, 3))).toEqual([
      { label: "general-purpose reported back", branchId: 1 },
    ]);
  });

  it("adds no item for a report whose subagent has no branch row", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    seedHandback(db, {
      sessionId: S,
      occurredAt: 4_000,
      agentType: "Explore",
      agentId: NO_BRANCH,
      chars: 3_000,
    });
    const rise = riseTo(storage, 3);
    expect(reportsIn(rise)).toHaveLength(1);
    expect(otherIn(rise)).toBe(1_696);
  });

  it("adds no item for a report whose branch has no spawning step", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    seedExplore(db, { reportAt: 4_500, spawningStepId: null });
    const rise = riseTo(storage, 3);
    expect(reportsIn(rise)).toHaveLength(1);
    expect(otherIn(rise)).toBe(1_696);
  });

  it("leaves a report to a subagent's own subagent out of the main thread's rises", () => {
    const { storage, db } = makeWorld();
    seedRises(db);
    seedLaunch(db, {
      id: 5,
      sessionId: S,
      branchId: 1,
      subagentType: "Explore",
      startedAt: 2_500,
      asyncLaunch: 1,
    });
    seedBranch(db, {
      id: 3,
      sessionId: S,
      agentId: NESTED,
      agentType: "Explore",
      spawningStepId: 5,
    });
    seedHandback(db, {
      sessionId: S,
      occurredAt: 5_100,
      agentType: "Explore",
      agentId: NESTED,
      chars: 2_000,
    });
    const rise = riseTo(storage, 3);
    expect(reportsIn(rise)).toEqual([
      { label: "general-purpose reported back", branchId: 1 },
    ]);
    expect(otherIn(rise)).toBe(1_696);
  });
});

describe("the token history's cache rebuilds", () => {
  it("marks a rewrite after a warm read, with its measured write and context", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-plain";
    seedWarmPair(db, S, {}, {});
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(1);
    expect(result.rebuilds[0]).toEqual({
      id: "rebuild-2",
      requestId: 2,
      at: 61_000,
      written: 60_000,
      context: 66_000,
      cause: null,
    });
  });

  it("names a compaction between the two requests as the cause", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-compact";
    seedWarmPair(db, S, {}, {});
    seedSegment(db, {
      id: 7,
      sessionId: S,
      kind: "compact",
      startedAt: 30_000,
    });
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "compaction",
      expected: true,
      segmentId: 7,
    });
  });

  it("prefers the compaction when the model changed too", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-compact-first";
    seedWarmPair(db, S, {}, { model: "claude-opus" });
    seedSegment(db, {
      id: 7,
      sessionId: S,
      kind: "compact",
      startedAt: 30_000,
    });
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toMatchObject({ kind: "compaction" });
  });

  it("names an expired 1-hour cache after a 70-minute gap", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-expired";
    seedWarmPair(
      db,
      S,
      { cacheWrite1h: 5_000 },
      { startedAt: 1_000 + 70 * 60_000 },
    );
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "expired",
      expected: false,
      gapMinutes: 70,
      lifetime: "1h",
    });
  });

  it("names an expiry from the 1-hour lifetime a read-only request inherited", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-expired-inherited";
    // The middle request only reads, so the lifetime its
    // point carries is the first request's 1-hour write's.
    seedWarmPair(db, S, { cacheWrite1h: 5_000 }, { cacheWrite1h: 0 });
    seedRequestExact(db, {
      id: 3,
      sessionId: S,
      startedAt: 61_000 + 70 * 60_000,
      input: 1_000,
      cacheRead: 5_000,
      cacheWrite5m: 0,
      cacheWrite1h: 60_000,
    });
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(1);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "expired",
      expected: false,
      gapMinutes: 70,
      lifetime: "1h",
    });
  });

  it("leaves the cause unknown when a 1-hour cache is rejoined in 50 minutes", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-not-expired";
    seedWarmPair(
      db,
      S,
      { cacheWrite1h: 5_000 },
      { startedAt: 1_000 + 50 * 60_000 },
    );
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(1);
    expect(result.rebuilds[0]?.cause).toBeNull();
  });

  it("measures the gap from when the earlier request ended", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-gap-from-end";
    seedWarmPair(
      db,
      S,
      { startedAt: 0, durationMs: 600_000, cacheWrite5m: 5_000 },
      { startedAt: 960_000, cacheWrite5m: 60_000, cacheWrite1h: 0 },
    );
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "expired",
      expected: false,
      gapMinutes: 6,
      lifetime: "5m",
    });
  });

  it("names a model change as the cause", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-model";
    seedWarmPair(db, S, {}, { model: "claude-opus" });
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "model",
      expected: false,
      from: "claude-sonnet",
      to: "claude-opus",
    });
  });

  it("names an effort change as the cause", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-effort";
    seedWarmPair(db, S, { effort: "low" }, { effort: "high" });
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "effort",
      expected: false,
      from: "low",
      to: "high",
    });
  });

  it("names a change in the tools sent as the cause", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-tools";
    seedRequestShape(db, { hash: "shape-a" });
    seedRequestShape(db, { hash: "shape-b" });
    seedWarmPair(db, S, { shapeHash: "shape-a" }, { shapeHash: "shape-b" });
    const result = history(storage, S);
    expect(result.rebuilds[0]?.cause).toEqual({
      kind: "tools",
      expected: false,
    });
  });

  it("is not a rebuild when under half the context was written", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-under-half";
    seedWarmPair(
      db,
      S,
      {},
      {
        cacheRead: 45_000,
        cacheWrite1h: 20_000,
      },
    );
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(0);
  });

  it("is not a rebuild when the request before it read nothing from the cache", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-cold-before";
    seedWarmPair(db, S, { input: 81_000, cacheRead: 0 }, {});
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(0);
  });

  it("never calls a gap an expiry when no lifetime was recorded", () => {
    const { storage, db } = makeWorld();
    const S = "sess-rebuild-no-lifetime";
    seedWarmPair(
      db,
      S,
      { cacheWrite5m: null, cacheWrite1h: null },
      { startedAt: 1_000 + 120 * 60_000 },
    );
    const result = history(storage, S);
    expect(result.rebuilds).toHaveLength(1);
    expect(result.rebuilds[0]?.cause).toBeNull();
  });

  it("words each cause once, and an unknown cause as unknown", () => {
    expect(
      rebuildCauseText({ kind: "compaction", expected: true, segmentId: 3 }),
    ).toBe("after compaction (expected)");
    expect(
      rebuildCauseText({
        kind: "expired",
        expected: false,
        gapMinutes: 70,
        lifetime: "1h",
      }),
    ).toBe("the cache expired after 70 minutes");
    expect(
      rebuildCauseText({
        kind: "model",
        expected: false,
        from: "claude-sonnet",
        to: "claude-opus",
      }),
    ).toBe("the model changed (claude-sonnet → claude-opus)");
    expect(
      rebuildCauseText({
        kind: "effort",
        expected: false,
        from: "low",
        to: "high",
      }),
    ).toBe("effort changed (low → high)");
    expect(rebuildCauseText({ kind: "tools", expected: false })).toBe(
      "the tools sent to Claude changed",
    );
    expect(rebuildCauseText(null)).toBe("cause unknown");
  });
});

describe("a turn's prompt in the history", () => {
  function seedPromptTurn(
    db: DatabaseSync,
    id: string,
    promptText: string | null,
    promptChars: number | null,
  ): void {
    seedSession(db, { id });
    seedTurn(db, {
      id: 1,
      sessionId: id,
      sequence: 1,
      startedAt: 0,
      endedAt: 9_000,
      promptText,
      promptChars,
    });
  }

  it("carries the kept prompt's first line and its length", () => {
    const { storage, db } = makeWorld();
    seedPromptTurn(db, "sess-prompt-kept", "Fix the bug\nand the tests", 21);
    const result = history(storage, "sess-prompt-kept", null, true);
    expect(result.turns[0]?.promptLine).toBe("Fix the bug");
    expect(result.turns[0]?.promptChars).toBe(21);
  });

  it("hides the line when the keep-text setting is off, keeping the length", () => {
    const { storage, db } = makeWorld();
    seedPromptTurn(db, "sess-prompt-off", "Fix the bug\nand the tests", 21);
    const result = history(storage, "sess-prompt-off", null, false);
    expect(result.turns[0]?.promptLine).toBeNull();
    expect(result.turns[0]?.promptChars).toBe(21);
  });

  it("says no line when no text was kept, keeping the length", () => {
    const { storage, db } = makeWorld();
    seedPromptTurn(db, "sess-prompt-none", null, 21);
    const result = history(storage, "sess-prompt-none", null, true);
    expect(result.turns[0]?.promptLine).toBeNull();
    expect(result.turns[0]?.promptChars).toBe(21);
  });
});
