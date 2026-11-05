import { afterEach, describe, expect, it } from "vitest";

import {
  CONTEXT_AT_STEP_4,
  CONTEXT_AT_STEP_6,
} from "../../view/test/context-fixture.js";
import {
  contextAtStep,
  loadSessionData,
  mergeSessionData,
  sessionContext,
  stepDetail,
} from "../src/api/index.js";
import type { ContextAtStep, ContextItem } from "../src/api/payloads.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { seedHandback, seedLaunch } from "./support/background-subagent.js";
import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import {
  BETWEEN,
  ESTIMATE_KEPT,
  RISE_READ,
  RISE_SESSION,
  RISE_TOO_SMALL,
  seedRiseRead,
} from "./support/measured-rise.js";
import { startupSplit } from "./support/startup.js";
import {
  seedBranch,
  seedCompactionFile,
  seedLoad,
  seedMoment,
  seedPlantedSession,
  seedPromptAttachment,
  seedRawEvent,
  seedRealisticSession,
  seedRequestExact,
  seedRequestShape,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// Context at a step, over hand-written fixtures: the
// planted session the token lenses share, and small sessions
// planted row by row so each rule's expected answer can be
// checked exactly.

afterEach(async () => {
  await runCleanups();
});

function makeWorld(): { storage: Storage; db: DatabaseSync } {
  const storage = openStorage({ dataDir: makeTempRoot("flightpath-context-") });
  const db = new DatabaseSync(storage.dbPath);
  registerCleanup(() => db.close());
  registerCleanup(() => storage.close());
  return { storage, db };
}

function seedFirstTurn(db: DatabaseSync, sessionId: string): void {
  seedSession(db, { id: sessionId });
  seedTurn(db, {
    id: 1,
    sessionId,
    sequence: 1,
    startedAt: 0,
    endedAt: 9_000,
    promptChars: 40,
  });
}

function seedMainRequest(
  db: DatabaseSync,
  sessionId: string,
  id: number,
  startedAt: number,
  input: number,
  shapeHash?: string | null,
): void {
  seedRequestExact(db, {
    id,
    sessionId,
    turnId: 1,
    model: "claude-sonnet-4-6",
    startedAt,
    input,
    output: 100,
    shapeHash: shapeHash ?? null,
  });
}

/** Two main requests in the first turn, the second
 * measuring more than the first. */
function seedBaseAndNext(db: DatabaseSync, sessionId: string): void {
  seedMainRequest(db, sessionId, 1, 1_000, 10_000);
  seedMainRequest(db, sessionId, 2, 5_000, 20_000);
}

/** A lone read step in the first turn, its path named. */
function seedLoneRead(db: DatabaseSync, sessionId: string): void {
  seedStep(db, {
    id: 1,
    sessionId,
    turnId: 1,
    toolName: "Read",
    input: { file_path: "src/none.ts" },
    startedAt: 2_000,
    endedAt: 3_000,
    resultSize: 4_000,
  });
}

/** A step in the first turn, measured by its only request. */
function seedMeasuredStep(
  db: DatabaseSync,
  sessionId: string,
  shapeHash?: string | null,
): void {
  seedFirstTurn(db, sessionId);
  seedMainRequest(db, sessionId, 1, 1_000, 10_000, shapeHash);
  seedStep(db, {
    id: 1,
    sessionId,
    turnId: 1,
    toolName: "Bash",
    startedAt: 2_000,
    endedAt: 3_000,
    resultSize: 1_000,
    resultRequestId: 1,
  });
}

/** The planted session's first step after its compaction. */
function seedStepAfterCompaction(db: DatabaseSync, sessionId: string): void {
  seedStep(db, {
    id: 8,
    sessionId,
    turnId: 3,
    toolName: "Bash",
    startedAt: 77_000,
    endedAt: 78_000,
    resultSize: 2_000,
    resultRequestId: 14,
  });
}

/** A read step inside the planted session's branch. */
function seedBranchRead(db: DatabaseSync, sessionId: string): void {
  seedStep(db, {
    id: 101,
    sessionId,
    turnId: 2,
    branchId: 1,
    toolName: "Read",
    startedAt: 13_500,
    endedAt: 14_500,
    resultSize: 4_000,
    resultRequestId: 102,
  });
}

/** The planted session with the subagent's own request shape
 * recorded, and a read step inside the subagent. */
function seedBranchShapeWorld(): {
  storage: Storage;
  db: DatabaseSync;
  S: string;
} {
  const { storage, db } = makeWorld();
  seedRequestShape(db, {
    hash: "shape-branch",
    systemBytes: 12_000,
    tools: [{ name: "Read", bytes: 2_000, mcp: false }],
  });
  const S = seedPlantedSession(db, { branchShapeHash: "shape-branch" });
  seedBranchRead(db, S);
  return { storage, db, S };
}

/** A session whose one turn is cut by a compaction at
 * 50,000, with a step after it measured by the second
 * request: the world the compaction view is read in. */
function seedCompactedWorld(db: DatabaseSync, sessionId: string): void {
  seedSession(db, { id: sessionId });
  seedTurn(db, {
    id: 1,
    sessionId,
    sequence: 1,
    startedAt: 0,
    endedAt: 90_000,
    promptChars: 40,
  });
  seedSegment(db, {
    id: 9,
    sessionId,
    kind: "compact",
    startedAt: 50_000,
  });
  seedRequestExact(db, {
    id: 1,
    sessionId,
    turnId: 1,
    startedAt: 1_000,
    input: 10_000,
    output: 100,
  });
  seedRequestExact(db, {
    id: 2,
    sessionId,
    turnId: 1,
    startedAt: 50_500,
    input: 5_000,
    output: 100,
  });
  seedStep(db, {
    id: 20,
    sessionId,
    turnId: 1,
    toolName: "Bash",
    startedAt: 51_000,
    endedAt: 52_000,
    resultSize: 400,
    resultRequestId: 2,
  });
}

function atStep(
  storage: Storage,
  sessionId: string,
  stepId: number,
): ContextAtStep {
  const data = loadSessionData(storage, sessionId);
  if (data === undefined) throw new Error("session did not seed");
  const result = contextAtStep(data, stepId);
  if (result === null) throw new Error("step not in the session");
  return result;
}

describe("context at a step, on the planted fixture", () => {
  it("matches the fixture checked in for the view's tests", () => {
    // The view package's lens tests run against a checked-in
    // copy of these two answers; if the seed or the read
    // moves, this fails here rather than letting the copy
    // drift from what the server gives.
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    expect(atStep(storage, S, 4)).toEqual(CONTEXT_AT_STEP_4);
    expect(atStep(storage, S, 6)).toEqual(CONTEXT_AT_STEP_6);
  });

  it("lists what had been given by step 4, in the order it entered", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const result = atStep(storage, S, 4);
    expect(result.scope).toEqual({ kind: "main" });
    expect(result.states).toEqual({
      telemetry: true,
      tokensPartial: true,
      joinedPartway: true,
    });
    expect(result.epoch).toEqual({
      startedAt: 0,
      afterCompactionSegmentId: null,
    });
    // Step 4's result first counted in request 5.
    expect(result.measured).toEqual({
      requestId: 5,
      tokens: 85_000,
      window: { tokens: 1_000_000, source: "model-list", reportedAt: null },
      share: 0.085,
    });
    // The planted steps carry no input summary, so a read's
    // path is the describer's fallback name for one.
    expect(result.items).toEqual([
      { kind: "prompt", turnId: 1, sequence: 1, chars: 17, tokens: 6 },
      { kind: "reply", requestId: 1, tokens: 300 },
      {
        kind: "file-read",
        stepId: 1,
        path: "a file",
        chars: 101_500,
        tokens: 34_700,
        measured: true,
      },
      { kind: "reply", requestId: 2, tokens: 400 },
      {
        kind: "tool-result",
        stepId: 2,
        label: "Ran a command",
        chars: 5_800,
        tokens: 2_000,
        measured: false,
      },
      {
        kind: "file-read",
        stepId: 3,
        path: "a file",
        chars: 46_400,
        tokens: 16_000,
        measured: false,
      },
      { kind: "reply", requestId: 3, tokens: 500 },
      { kind: "prompt", turnId: 2, sequence: 2, chars: 23, tokens: 8 },
      { kind: "reply", requestId: 4, tokens: 200 },
      {
        kind: "subagent-result",
        stepId: 4,
        branchId: 1,
        label: "Started a subagent",
        chars: 34_800,
        tokens: 12_000,
      },
    ]);
    expect(result.totals).toEqual({
      measured: 85_000,
      items: 66_114,
      named: 66_114,
      other: 18_886,
    });
  });

  it("starts a new epoch at the compaction, and lists nothing from before it", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    // The planted steps all end before the compaction at
    // 76,000; this one lands after it.
    seedStepAfterCompaction(db, S);
    const result = atStep(storage, S, 8);
    expect(result.epoch).toEqual({
      startedAt: 76_000,
      afterCompactionSegmentId: 2,
    });
    expect(result.measured).toEqual({
      requestId: 14,
      tokens: 27_000,
      window: { tokens: 1_000_000, source: "model-list", reportedAt: null },
      share: 0.027,
    });
    expect(result.items).toEqual([
      { kind: "reply", requestId: 13, tokens: 300 },
      {
        kind: "tool-result",
        stepId: 8,
        label: "Ran a command",
        chars: 2_000,
        tokens: 1_700,
        measured: true,
      },
    ]);
    expect(result.totals).toEqual({
      measured: 27_000,
      items: 2_000,
      named: 2_000,
      other: 25_000,
    });
  });

  it("lists only the branch's own rows for a branch step", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    seedBranchRead(db, S);
    seedStep(db, {
      id: 102,
      sessionId: S,
      turnId: 2,
      branchId: 1,
      toolName: "Bash",
      startedAt: 15_000,
      endedAt: 15_500,
      resultSize: 800,
    });
    const result = atStep(storage, S, 102);
    expect(result.scope).toEqual({
      kind: "branch",
      branchId: 1,
      agentType: "Explore",
    });
    expect(result.epoch).toEqual({
      startedAt: 0,
      afterCompactionSegmentId: null,
    });
    // No link on the step: the branch's first request after
    // it, request 102 at 47,000.
    expect(result.measured).toEqual({
      requestId: 102,
      tokens: 47_000,
      window: { tokens: 1_000_000, source: "model-list", reportedAt: null },
      share: 0.047,
    });
    // The branch's requests recorded no output, so there are
    // no replies; prompts and loads are the main thread's.
    expect(result.items).toEqual([
      {
        kind: "file-read",
        stepId: 101,
        path: "a file",
        chars: 4_000,
        tokens: 1_380,
        measured: false,
      },
      {
        kind: "tool-result",
        stepId: 102,
        label: "Ran a command",
        chars: 800,
        tokens: 276,
        measured: false,
      },
    ]);
    expect(result.totals).toEqual({
      measured: 47_000,
      items: 1_656,
      named: 1_656,
      other: 45_344,
    });
  });
});

describe("the measured context", () => {
  it("uses the result link before the time rule", () => {
    const { storage, db } = makeWorld();
    const S = "sess-link";
    seedFirstTurn(db, S);
    seedMainRequest(db, S, 1, 1_000, 10_000);
    seedMainRequest(db, S, 2, 5_000, 20_000);
    seedMainRequest(db, S, 3, 8_000, 30_000);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 3_000,
      endedAt: 4_000,
      resultSize: 1_000,
      resultRequestId: 3,
    });
    // The time rule would choose request 2, the first after
    // the step; the link names request 3.
    expect(atStep(storage, S, 1).measured).toEqual({
      requestId: 3,
      tokens: 30_000,
      window: { tokens: 200_000, source: "model-list", reportedAt: null },
      share: 0.15,
    });
  });

  it("falls back to the first request after the step, then the latest before it", () => {
    const { storage, db } = makeWorld();
    const S = "sess-fallback";
    seedFirstTurn(db, S);
    seedBaseAndNext(db, S);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 3_000,
      endedAt: 4_000,
      resultSize: 1_000,
    });
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 6_000,
      endedAt: 7_000,
      resultSize: 1_000,
    });
    expect(atStep(storage, S, 1).measured?.requestId).toBe(2);
    expect(atStep(storage, S, 2).measured?.requestId).toBe(2);
  });

  it("is null when the thread has no requests, and so is the remainder", () => {
    const { storage, db } = makeWorld();
    const S = "sess-none";
    seedFirstTurn(db, S);
    seedLoneRead(db, S);
    const result = atStep(storage, S, 1);
    expect(result.measured).toBeNull();
    expect(result.totals).toEqual({
      measured: null,
      items: 1_394,
      named: 1_394,
      other: null,
    });
  });

  it("answers null for a step that is not in the session", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    const data = loadSessionData(storage, S);
    if (data === undefined) throw new Error("session did not seed");
    expect(contextAtStep(data, 999)).toBeNull();
  });
});

function seedSizesWorld(): { storage: Storage; S: string } {
  const { storage, db } = makeWorld();
  const S = "sess-sizes";
  seedSession(db, { id: S });
  seedTurn(db, {
    id: 1,
    sessionId: S,
    sequence: 1,
    startedAt: 0,
    endedAt: 9_000,
    promptChars: null,
  });
  seedPromptAttachment(db, {
    sessionId: S,
    turnId: 1,
    kind: "image",
    name: "image/png",
    sizeBytes: 5_000,
  });
  seedPromptAttachment(db, {
    sessionId: S,
    turnId: 1,
    kind: "file",
    name: "notes.md",
    sizeBytes: 58,
  });
  // The prompt's own text as an attachment row is already
  // counted in the prompt item: no second item for it.
  seedPromptAttachment(db, {
    sessionId: S,
    turnId: 1,
    kind: "prompt",
    sizeBytes: 40,
  });
  seedStep(db, {
    id: 1,
    sessionId: S,
    turnId: 1,
    toolName: "Read",
    input: { file_path: "src/a.ts" },
    startedAt: 2_000,
    endedAt: 3_000,
    resultSize: 4_000,
    contextChars: 10,
  });
  seedStep(db, {
    id: 2,
    sessionId: S,
    turnId: 1,
    toolName: "Bash",
    startedAt: 3_500,
    endedAt: 4_000,
  });
  seedRequestExact(db, {
    id: 1,
    sessionId: S,
    turnId: 1,
    startedAt: 1_000,
    input: 100,
    output: 50,
  });
  return { storage, S };
}

describe("a result sized by its rise", () => {
  function readItem(
    storage: Storage,
    sessionId: string,
    stepId = 1,
  ): ContextItem | undefined {
    return atStep(storage, sessionId, stepId).items.find(
      (item) => item.kind === "file-read" && item.stepId === 1,
    );
  }

  function measuredRead(tokens: number): ContextItem {
    return {
      kind: "file-read",
      stepId: 1,
      path: RISE_READ.path,
      chars: 36_807,
      tokens,
      measured: true,
    };
  }

  function estimatedRead(): ContextItem {
    return {
      kind: "file-read",
      stepId: 1,
      path: RISE_READ.path,
      chars: 36_807,
      tokens: RISE_READ.estimatedTokens,
      measured: false,
    };
  }

  const S = RISE_SESSION;

  function setup(): { storage: Storage; db: DatabaseSync } {
    const world = makeWorld();
    seedRiseRead(world.db, S);
    return world;
  }

  it("reads the rise less the reply as the result's own size", () => {
    const { storage } = setup();
    expect(readItem(storage, S)).toEqual(
      measuredRead(RISE_READ.measuredTokens),
    );
  });

  it.each(ESTIMATE_KEPT)("keeps the estimate after $name", ({ change }) => {
    const { storage, db } = setup();
    change(db, S);
    expect(readItem(storage, S)).toEqual(estimatedRead());
  });

  it.each(RISE_TOO_SMALL)("keeps the estimate for $name", ({ change }) => {
    const { storage, db } = setup();
    change(db);
    expect(readItem(storage, S)).toEqual(estimatedRead());
  });

  it("measures a rise of exactly 10 tokens past the reply", () => {
    const { storage, db } = setup();
    db.prepare(
      "UPDATE requests SET cache_write_5m_tokens = 77 WHERE id = 2",
    ).run();
    expect(readItem(storage, S)).toEqual(measuredRead(10));
  });

  it("measures an error result the same way", () => {
    const { storage, db } = setup();
    db.prepare("UPDATE steps SET outcome = 'failed' WHERE id = 1").run();
    expect(readItem(storage, S)).toMatchObject({
      tokens: 23_578,
      measured: true,
    });
  });

  it("measures a tool result that is not a file read", () => {
    const { storage, db } = setup();
    db.prepare(
      "UPDATE steps SET tool_name = 'Bash', input_summary = NULL WHERE id = 1",
    ).run();
    expect(
      atStep(storage, S, 1).items.find((item) => item.kind === "tool-result"),
    ).toMatchObject({ stepId: 1, tokens: 23_578, measured: true });
  });

  it("leaves a subagent result an estimate", () => {
    const { storage, db } = setup();
    db.prepare("UPDATE steps SET tool_name = 'Agent' WHERE id = 1").run();
    expect(
      atStep(storage, S, 1).items.find(
        (item) => item.kind === "subagent-result",
      ),
    ).toMatchObject({ tokens: RISE_READ.estimatedTokens });
  });

  it("is not disqualified by a permission decision in between", () => {
    const { storage, db } = setup();
    seedMoment(db, {
      sessionId: S,
      turnId: 1,
      kind: "permission_decision",
      decision: "allow",
      occurredAt: BETWEEN,
    });
    expect(readItem(storage, S)).toEqual(
      measuredRead(RISE_READ.measuredTokens),
    );
  });

  it("measures a branch request against that branch's own previous request", () => {
    const { storage, db } = setup();
    seedBranch(db, {
      id: 1,
      sessionId: S,
      agentType: "Explore",
      startedAt: 500,
    });
    db.prepare("UPDATE requests SET branch_id = 1").run();
    db.prepare("UPDATE steps SET branch_id = 1").run();
    // The main thread's request lands between the branch's
    // two, at a context far above either.
    seedRequestExact(db, {
      id: 3,
      sessionId: S,
      turnId: 1,
      startedAt: BETWEEN,
      input: 2,
      cacheRead: 150_000,
      output: 5,
    });
    expect(readItem(storage, S)).toEqual(
      measuredRead(RISE_READ.measuredTokens),
    );
  });
});

describe("sizes and totals", () => {
  it("counts an unknown size as null, never zero, and a file's bytes as an estimate", () => {
    const { storage, S } = seedSizesWorld();
    const result = atStep(storage, S, 2);
    expect(result.items).toEqual([
      { kind: "prompt", turnId: 1, sequence: 1, chars: null, tokens: null },
      {
        kind: "image",
        turnId: 1,
        name: "image/png",
        bytes: 5_000,
        tokens: null,
      },
      {
        kind: "file",
        turnId: 1,
        name: "notes.md",
        bytes: 58,
        tokens: 20,
      },
      { kind: "reply", requestId: 1, tokens: 50 },
      {
        kind: "file-read",
        stepId: 1,
        path: "src/a.ts",
        chars: 10,
        tokens: 4,
        measured: false,
      },
      {
        kind: "tool-result",
        stepId: 2,
        label: "Ran a command",
        chars: null,
        tokens: null,
        measured: false,
      },
    ]);
  });

  it("leaves the unaccounted remainder as other", () => {
    const { storage, S } = seedSizesWorld();
    const result = atStep(storage, S, 2);
    expect(result.totals).toEqual({
      measured: 100,
      items: 74,
      named: 74,
      other: 26,
    });
  });

  it("never stretches the items to cover the measured total", () => {
    const { storage, db } = makeWorld();
    const S = "sess-overshoot";
    seedFirstTurn(db, S);
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 10,
      output: 5,
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_000,
      endedAt: 3_000,
      resultSize: 4_000,
      resultRequestId: 1,
    });
    const result = atStep(storage, S, 1);
    // The estimates overshoot the measured total; the
    // remainder is null rather than a negative share.
    expect(result.totals).toEqual({
      measured: 10,
      items: 1_399,
      named: 10,
      other: null,
    });
  });
});

describe("no contents anywhere", () => {
  it("keeps prompt text and raw events out of the answer", () => {
    const { storage, db } = makeWorld();
    const S = "sess-marker";
    const MARKER = "MARKER-CONTEXT-9e1b";
    seedSession(db, { id: S });
    seedTurn(db, {
      id: 1,
      sessionId: S,
      sequence: 1,
      startedAt: 0,
      endedAt: 9_000,
      promptText: `please ${MARKER} thanks`,
      promptChars: 40,
    });
    seedRawEvent(db, { sessionId: S, body: { note: MARKER } });
    // The raw entry's tool description carries the marker
    // too; the recorded shape keeps name and size only.
    seedRawEvent(db, {
      sessionId: S,
      source: "transcript",
      body: {
        type: "api-request-shape",
        shapeHash: "shape-marker",
        shape: {
          system: [{ type: "text", text: "sys" }],
          tools: [
            {
              name: "Read",
              description: `reads ${MARKER} aloud`,
              input_schema: {},
            },
          ],
        },
      },
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Read",
      input: { file_path: "src/plain.ts" },
      startedAt: 2_000,
      endedAt: 3_000,
      resultSize: 4_000,
    });
    seedRequestShape(db, {
      hash: "shape-marker",
      systemBytes: 100,
      tools: [{ name: "Read", bytes: 400, mcp: false }],
    });
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 1_000,
      output: 10,
      shapeHash: "shape-marker",
    });
    const data = loadSessionData(storage, S);
    if (data === undefined) throw new Error("session did not seed");
    // The marker is in the data the function reads, and stays out.
    expect(data.turns[0]?.promptText).toContain(MARKER);
    const raw = db.prepare("SELECT body FROM raw_events").all();
    expect(JSON.stringify(raw)).toContain(MARKER);
    const result = contextAtStep(data, 1);
    // The shape is read for its sizes; the description stays out.
    expect(result?.fixedLoad).toEqual({
      kind: "split",
      requestId: 1,
      total: 173,
      system: { chars: 100, tokens: 35, fromContext: false },
      tools: [{ name: "Read", chars: 400, tokens: 138 }],
      toolsReported: null,
      mcp: [],
      instructions: [],
      startup: [],
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });
});

describe("a live session's held data", () => {
  it("equals a fresh load after the follower's pass and after a compaction", () => {
    const { storage, db } = makeWorld();
    const S = "sess-held";
    seedFirstTurn(db, S);
    seedMainRequest(db, S, 1, 1_000, 10_000);
    seedMainRequest(db, S, 2, 6_000, 20_000);
    seedMainRequest(db, S, 3, 8_500, 30_000);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_000,
      endedAt: 5_000,
      resultSize: 8_000,
    });
    const held = loadSessionData(storage, S);
    if (held === undefined) throw new Error("session did not seed");
    // Before the pass, the fallbacks answer: the time rule
    // measures (request 2) and the size is the result's.
    const before = contextAtStep(held, 1);
    expect(before?.measured?.requestId).toBe(2);
    expect(before?.items.find((item) => item.kind === "tool-result")).toEqual({
      kind: "tool-result",
      stepId: 1,
      label: "Ran a command",
      chars: 8_000,
      tokens: 2_759,
      measured: false,
    });
    // The follower's pass: the transcript names the request
    // the result first counted in, and its context size.
    db.prepare(
      "UPDATE steps SET result_request_id = ?, context_chars = ? WHERE id = ?",
    ).run(3, 6_000, 1);
    const fresh = loadSessionData(storage, S);
    if (fresh === undefined) throw new Error("session did not reload");
    const linked = fresh.steps.find((step) => step.id === 1);
    if (linked === undefined) throw new Error("step did not reload");
    const merged = mergeSessionData(held, { steps: [linked] });
    expect(contextAtStep(merged, 1)).toEqual(contextAtStep(fresh, 1));
    const after = contextAtStep(fresh, 1);
    expect(after?.measured?.requestId).toBe(3);
    expect(after?.items.find((item) => item.kind === "tool-result")).toEqual({
      kind: "tool-result",
      stepId: 1,
      label: "Ran a command",
      chars: 6_000,
      tokens: 9_900,
      measured: true,
    });
    // A compaction lands: the epoch moves, and the held
    // data still reads as a fresh load does.
    const segmentId = seedSegment(db, {
      sessionId: S,
      kind: "compact",
      startedAt: 4_500,
    });
    const fresh2 = loadSessionData(storage, S);
    if (fresh2 === undefined) throw new Error("session did not reload");
    const merged2 = mergeSessionData(merged, { segments: fresh2.segments });
    expect(contextAtStep(merged2, 1)).toEqual(contextAtStep(fresh2, 1));
    const compacted = contextAtStep(fresh2, 1);
    expect(compacted?.epoch).toEqual({
      startedAt: 4_500,
      afterCompactionSegmentId: segmentId,
    });
    expect(compacted?.items.map((item) => item.kind)).toEqual(["tool-result"]);
  });
});

describe("loads in the epoch", () => {
  function seedWithLoads(
    sessionId: string,
    loads: Omit<Parameters<typeof seedLoad>[1], "sessionId">[],
  ): ContextAtStep {
    const { storage, db } = makeWorld();
    seedFirstTurn(db, sessionId);
    seedMainRequest(db, sessionId, 1, 1_000, 10_000);
    for (const load of loads) seedLoad(db, { ...load, sessionId });
    seedStep(db, {
      id: 1,
      sessionId,
      turnId: 1,
      toolName: "Bash",
      startedAt: 3_500,
      endedAt: 4_000,
      resultSize: 1_000,
    });
    return atStep(storage, sessionId, 1);
  }

  const beforeLoads: ContextItem[] = [
    { kind: "prompt", turnId: 1, sequence: 1, chars: 40, tokens: 14 },
    { kind: "reply", requestId: 1, tokens: 100 },
  ];
  const stepResult: ContextItem = {
    kind: "tool-result",
    stepId: 1,
    label: "Ran a command",
    chars: 1_000,
    tokens: 345,
    measured: false,
  };

  it("names an instructions load by its file and a skill load by its name", () => {
    const result = seedWithLoads("sess-loads", [
      {
        id: 1,
        kind: "instructions",
        name: "guide",
        filePath: "docs/guide.md",
        occurredAt: 2_000,
        sizeBytes: 400,
      },
      {
        id: 2,
        kind: "skill",
        name: "deep-research",
        occurredAt: 2_500,
        sizeBytes: 800,
      },
    ]);
    expect(result.items).toEqual([
      ...beforeLoads,
      {
        kind: "instructions",
        loadId: 1,
        name: "docs/guide.md",
        bytes: 400,
        tokens: 138,
        files: null,
      },
      {
        kind: "skill",
        loadId: 2,
        name: "deep-research",
        bytes: 800,
        tokens: 276,
        files: null,
      },
      stepResult,
    ]);
  });

  it("lists a skill with the files it attached, counted once in the totals", () => {
    const result = seedWithLoads("sess-skill-files", [
      {
        id: 1,
        kind: "skill",
        name: "code-style",
        occurredAt: 2_000,
        sizeBytes: 1_160,
      },
      {
        id: 2,
        kind: "skill-file",
        filePath: "docs/a.md",
        parentLoadId: 1,
        lineCount: 600,
        occurredAt: 2_000,
        sizeBytes: 2_900,
      },
      {
        id: 3,
        kind: "skill-file",
        filePath: "docs/b.md",
        parentLoadId: 1,
        lineCount: 40,
        occurredAt: 2_000,
        sizeBytes: 5_800,
      },
    ]);
    expect(result.items).toEqual([
      ...beforeLoads,
      {
        kind: "skill",
        loadId: 1,
        name: "code-style",
        bytes: 1_160,
        tokens: 400,
        files: {
          tokens: 3_000,
          items: [
            {
              loadId: 2,
              path: "docs/a.md",
              bytes: 2_900,
              lines: 600,
              tokens: 1_000,
            },
            {
              loadId: 3,
              path: "docs/b.md",
              bytes: 5_800,
              lines: 40,
              tokens: 2_000,
            },
          ],
        },
      },
      stepResult,
    ]);
    // 14 + 100 + 400 + 3,000 + 345 of the measured 10,000.
    expect(result.totals).toMatchObject({ items: 3_859, other: 6_141 });
  });

  it("lists a /context report by its command, sized by its length", () => {
    const result = seedWithLoads("sess-loads-report", [
      {
        id: 1,
        kind: "command-output",
        name: "/context",
        source: "transcript",
        occurredAt: 2_000,
        sizeBytes: 9_662,
      },
    ]);
    expect(result.items).toEqual([
      ...beforeLoads,
      {
        kind: "command-output",
        loadId: 1,
        name: "/context",
        bytes: 9_662,
        tokens: 3_332,
        files: null,
      },
      stepResult,
    ]);
  });

  it("reads an unnamed load as its kind, and leaves out one that entered after the step", () => {
    const result = seedWithLoads("sess-loads-late", [
      { id: 1, kind: "skill", occurredAt: 3_000, sizeBytes: 100 },
      {
        id: 2,
        kind: "skill",
        name: "late-skill",
        occurredAt: 5_000,
        sizeBytes: 100,
      },
    ]);
    expect(result.items).toEqual([
      ...beforeLoads,
      {
        kind: "skill",
        loadId: 1,
        name: "skill",
        bytes: 100,
        tokens: 35,
        files: null,
      },
      stepResult,
    ]);
  });
});

describe("context at a request", () => {
  function atRequest(
    storage: Storage,
    sessionId: string,
    requestId: number,
  ): ContextAtStep | undefined {
    return sessionContext(storage, sessionId, { request: requestId });
  }

  it("reads the first request after a compaction in the stretch the compaction opened", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-compacted";
    seedCompactedWorld(db, S);
    const result = atRequest(storage, S, 2);
    expect(result?.stepId).toBeNull();
    expect(result?.epoch).toEqual({
      startedAt: 50_000,
      afterCompactionSegmentId: 9,
    });
    expect(result?.measured?.requestId).toBe(2);
    expect(result?.measured?.tokens).toBe(5_000);
    expect(result?.compaction?.before).toEqual([
      { kind: "prompt", turnId: 1, sequence: 1, chars: 40, tokens: 14 },
      { kind: "reply", requestId: 1, tokens: 100 },
    ]);
  });

  it("counts only what entered before the request was sent", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-before";
    seedCompactedWorld(db, S);
    // The step ended after request 2 started, so the request
    // carried neither its result nor request 2's own reply.
    expect(atRequest(storage, S, 2)?.items).toEqual([]);
  });

  it("measures the same request a step's read does", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-same";
    seedCompactedWorld(db, S);
    const byStep = atStep(storage, S, 20);
    expect(atRequest(storage, S, 2)?.measured).toEqual(byStep.measured);
  });

  it("measures nothing from a request that recorded no context count", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-uncounted";
    seedFirstTurn(db, S);
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      output: 100,
    });
    expect(atRequest(storage, S, 1)?.measured).toBeNull();
  });

  it("answers nothing for a request that recorded no start", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-unstarted";
    seedFirstTurn(db, S);
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: null,
      input: 5_000,
      output: 100,
    });
    expect(atRequest(storage, S, 1)).toBeUndefined();
  });

  it("lists the image a prompt carried in a session that ran no step", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-image";
    seedFirstTurn(db, S);
    seedPromptAttachment(db, {
      sessionId: S,
      turnId: 1,
      kind: "image",
      name: "image/png",
      sizeBytes: 218_732,
    });
    seedRequestExact(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      startedAt: 1_000,
      input: 51_300,
      output: 100,
    });
    const result = atRequest(storage, S, 1);
    expect(result?.measured?.tokens).toBe(51_300);
    expect(result?.items).toContainEqual({
      kind: "image",
      turnId: 1,
      name: "image/png",
      bytes: 218_732,
      tokens: null,
    });
  });

  it("answers nothing for a request the session does not hold", () => {
    const { storage, db } = makeWorld();
    const S = "sess-request-missing";
    seedCompactedWorld(db, S);
    expect(atRequest(storage, S, 999)).toBeUndefined();
  });
});

describe("a branch's epoch", () => {
  it("starts at the branch's own start, not the main thread's last compaction", () => {
    const { storage, db } = makeWorld();
    const S = "sess-branch-epoch";
    seedFirstTurn(db, S);
    seedSegment(db, { sessionId: S, kind: "compact", startedAt: 4_500 });
    seedBranch(db, {
      id: 1,
      sessionId: S,
      agentType: "Explore",
      kind: "user",
      startedAt: 6_000,
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      toolName: "Bash",
      startedAt: 7_000,
      endedAt: 8_000,
      resultSize: 800,
    });
    const result = atStep(storage, S, 1);
    expect(result.scope).toEqual({
      kind: "branch",
      branchId: 1,
      agentType: "Explore",
    });
    expect(result.epoch).toEqual({
      startedAt: 6_000,
      afterCompactionSegmentId: null,
    });
    expect(result.measured).toBeNull();
    expect(result.items).toEqual([
      {
        kind: "tool-result",
        stepId: 1,
        label: "Ran a command",
        chars: 800,
        tokens: 276,
        measured: false,
      },
    ]);
  });
});

describe("speed", () => {
  it.skipIf(process.env.FLIGHTPATH_LONG_TESTS !== "1")(
    "answers a step late in a 5,000-step session in under 200 ms",
    () => {
      const { storage, db } = makeWorld();
      db.exec("BEGIN");
      seedRealisticSession(db, { base: 1_700_000_000_000 });
      db.exec("COMMIT");
      const data = loadSessionData(storage, "sess-big");
      if (data === undefined) throw new Error("session did not seed");
      const started = performance.now();
      const result = contextAtStep(data, 5000);
      const elapsed = performance.now() - started;
      console.log(
        `context at step 5000 of ${data.steps.length} steps: ${elapsed.toFixed(1)} ms, ${result?.items.length} items`,
      );
      if (result === null) throw new Error("step not in the session");
      // The pass walked the whole epoch: every step, prompt
      // and reply of the session is an item at the last step.
      expect(result.items.length).toBeGreaterThan(10_000);
      expect(elapsed).toBeLessThan(200);
    },
    60_000,
  );
});

describe("the fixed load", () => {
  it("splits the measured request's shape, MCP tools grouped by server", () => {
    const { storage, db } = makeWorld();
    const S = "sess-shape";
    seedRequestShape(db, {
      hash: "shape-1",
      systemBytes: 34_000,
      tools: [
        { name: "Read", bytes: 2_000, mcp: false },
        { name: "Task", bytes: 36_700, mcp: false },
        { name: "Bash", bytes: 4_000, mcp: false },
        { name: "mcp__notes__save", bytes: 1_200, mcp: true },
        { name: "mcp__notes__load", bytes: 800, mcp: true },
        { name: "mcp__notes__list", bytes: 400, mcp: true },
        { name: "mcp__files__stat", bytes: 600, mcp: false },
      ],
    });
    seedMeasuredStep(db, S, "shape-1");
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "instructions",
      filePath: "CLAUDE.md",
      occurredAt: 500,
      sizeBytes: 2_400,
    });
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "instructions",
      filePath: "team.md",
      occurredAt: 600,
    });
    expect(atStep(storage, S, 1).fixedLoad).toEqual({
      kind: "split",
      requestId: 1,
      total: 28_314,
      system: { chars: 34_000, tokens: 11_725, fromContext: false },
      tools: [
        { name: "Task", chars: 36_700, tokens: 12_656 },
        { name: "Bash", chars: 4_000, tokens: 1_380 },
        { name: "Read", chars: 2_000, tokens: 690 },
      ],
      toolsReported: null,
      mcp: [
        { server: "files", tools: 1, chars: 600, tokens: 207 },
        { server: "notes", tools: 3, chars: 2_400, tokens: 828 },
      ],
      instructions: [
        { loadId: 1, name: "CLAUDE.md", bytes: 2_400, tokens: 828 },
        { loadId: 2, name: "team.md", bytes: null, tokens: null },
      ],
      startup: [],
    });
  });

  it("reads as one total from the base when no shape was recorded", () => {
    const { storage, db } = makeWorld();
    const S = "sess-total";
    seedFirstTurn(db, S);
    seedBaseAndNext(db, S);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_000,
      endedAt: 4_000,
      resultSize: 1_000,
      resultRequestId: 2,
    });
    // The measured request is the second; the total is the
    // first one's context — the base, not the step's count.
    expect(atStep(storage, S, 1).fixedLoad).toEqual({
      kind: "total",
      tokens: 10_000,
    });
  });

  it("falls back to the total when the shape recorded no system size", () => {
    const { storage, db } = makeWorld();
    const S = "sess-shape-nosys";
    seedRequestShape(db, {
      hash: "shape-2",
      systemBytes: null,
      tools: [{ name: "Read", bytes: 2_000, mcp: false }],
    });
    seedMeasuredStep(db, S, "shape-2");
    expect(atStep(storage, S, 1).fixedLoad).toEqual({
      kind: "total",
      tokens: 10_000,
    });
  });

  it("is null when the thread recorded no context at all", () => {
    const { storage, db } = makeWorld();
    const S = "sess-no-load";
    seedFirstTurn(db, S);
    seedLoneRead(db, S);
    expect(atStep(storage, S, 1).fixedLoad).toBeNull();
  });

  it("splits a branch step's own request shape, with no instructions", () => {
    const { storage, S } = seedBranchShapeWorld();
    expect(atStep(storage, S, 101).fixedLoad).toEqual({
      kind: "split",
      requestId: 102,
      total: 4_828,
      system: { chars: 12_000, tokens: 4_138, fromContext: false },
      tools: [{ name: "Read", chars: 2_000, tokens: 690 }],
      toolsReported: null,
      mcp: [],
      instructions: [],
      startup: [],
    });
  });
});

describe("the compaction view", () => {
  it("shows the stretch before it and what the rule restored", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    seedStepAfterCompaction(db, S);
    // The stretch before the compaction is the item list
    // the last step of that stretch reads: no second builder.
    expect(atStep(storage, S, 8).compaction).toEqual({
      segmentId: 2,
      at: 76_000,
      before: atStep(storage, S, 7).items,
      // The planted reads all name the describer's fallback
      // path, so one path comes back, from its latest read.
      restored: [
        { kind: "file-read", ref: 5, name: "a file" },
        { kind: "skill", ref: 1, name: "deep-research" },
      ],
      restoredNote: "restored by Claude Code (per its docs)",
    });
  });

  it("restores at most five distinct read paths, latest first", () => {
    const { storage, db } = makeWorld();
    const S = "sess-restored";
    seedCompactedWorld(db, S);
    const paths = ["a.ts", "b.ts", "c.ts", "a.ts", "d.ts", "e.ts", "f.ts"];
    paths.forEach((path, index) => {
      seedStep(db, {
        id: index + 1,
        sessionId: S,
        turnId: 1,
        toolName: "Read",
        input: { file_path: path },
        startedAt: (index + 2) * 1_000,
        endedAt: (index + 2) * 1_000 + 500,
        resultSize: 400,
      });
    });
    const result = atStep(storage, S, 20);
    expect(
      result.compaction?.before.filter((item) => item.kind === "file-read"),
    ).toHaveLength(7);
    expect(result.compaction?.restored).toEqual([
      { kind: "file-read", ref: 7, name: "f.ts" },
      { kind: "file-read", ref: 6, name: "e.ts" },
      { kind: "file-read", ref: 5, name: "d.ts" },
      { kind: "file-read", ref: 4, name: "a.ts" },
      { kind: "file-read", ref: 3, name: "c.ts" },
    ]);
  });

  it("restores every skill the stretch loaded, and no instruction file", () => {
    const { storage, db } = makeWorld();
    const S = "sess-restored-skills";
    seedCompactedWorld(db, S);
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Read",
      input: { file_path: "a.ts" },
      startedAt: 2_000,
      endedAt: 2_500,
      resultSize: 400,
    });
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "skill",
      name: "alpha",
      occurredAt: 1_500,
    });
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "skill",
      name: "beta",
      occurredAt: 2_500,
    });
    seedLoad(db, {
      id: 3,
      sessionId: S,
      kind: "instructions",
      filePath: "CLAUDE.md",
      occurredAt: 1_200,
      sizeBytes: 800,
    });
    const result = atStep(storage, S, 20);
    expect(result.compaction?.restored).toEqual([
      { kind: "file-read", ref: 1, name: "a.ts" },
      { kind: "skill", ref: 1, name: "alpha" },
      { kind: "skill", ref: 2, name: "beta" },
    ]);
    expect(result.compaction?.restoredNote).toBe(
      "restored by Claude Code (per its docs)",
    );
  });

  it("lists the files recorded after the compaction, and no file the docs' rule would guess", () => {
    const { storage, db } = makeWorld();
    const S = "sess-restored-record";
    seedCompactedWorld(db, S);
    seedStep(db, {
      id: 7,
      sessionId: S,
      turnId: 1,
      toolName: "Read",
      input: { file_path: "report.ts" },
      startedAt: 3_000,
      endedAt: 3_400,
      resultSize: 900,
    });
    seedLoad(db, {
      id: 5,
      sessionId: S,
      kind: "skill",
      name: "gamma",
      occurredAt: 2_500,
    });
    seedCompactionFile(db, {
      id: 1,
      sessionId: S,
      at: 50_000,
      name: "data\\orders.csv",
      reread: false,
    });
    seedCompactionFile(db, {
      id: 2,
      sessionId: S,
      at: 50_000,
      name: "src\\totals.js",
      sizeBytes: 694,
    });
    const result = atStep(storage, S, 20);
    // 694 bytes at 2.9 per token is 239.3, rounded up.
    expect(result.compaction?.restored).toEqual([
      {
        kind: "file",
        ref: 1,
        name: "data\\orders.csv",
        reread: false,
        tokens: null,
      },
      {
        kind: "file",
        ref: 2,
        name: "src\\totals.js",
        reread: true,
        tokens: 240,
      },
      { kind: "skill", ref: 5, name: "gamma" },
    ]);
  });

  it("gives each file to the compaction nearest its moment, and none to a far one", () => {
    const { storage, db } = makeWorld();
    const S = "sess-restored-nearest";
    seedCompactedWorld(db, S);
    seedSegment(db, {
      id: 10,
      sessionId: S,
      kind: "compact",
      startedAt: 56_000,
    });
    const files = [
      { name: "near-first.js", at: 50_200 },
      { name: "near-second.js", at: 55_500 },
      { name: "far.js", at: 120_000 },
    ];
    files.forEach((file, index) => {
      seedCompactionFile(db, { id: index + 1, sessionId: S, ...file });
    });
    const result = atStep(storage, S, 20);
    expect(result.compaction?.restored.map((item) => item.name)).toEqual([
      "near-first.js",
    ]);
  });

  it("is null at a step with no compaction behind it", () => {
    const { storage, db } = makeWorld();
    const S = seedPlantedSession(db);
    expect(atStep(storage, S, 4).compaction).toBeNull();
  });
});

describe("startup additions and the fixed load counted once", () => {
  // A session shaped around the startup additions at their
  // full sizes (the skills listing's 24,851 characters, 49
  // skills; the deferred tools' 4,160 over 132 names; two
  // servers' instructions, 3,715; the agent listing's
  // 2,527; one hook's 1,207; the instruction file's 6,474),
  // and the step is measured at 75,800 tokens.
  function seedStartupWorld(
    measuredTokens: number,
    instructionBytes: number | null = 6_474,
  ): {
    storage: Storage;
    db: DatabaseSync;
    S: string;
  } {
    const { storage, db } = makeWorld();
    const S = "sess-startup";
    seedRequestShape(db, {
      hash: "shape-startup",
      systemBytes: 40_000,
      tools: [
        { name: "Read", bytes: 4_000, mcp: false },
        { name: "Bash", bytes: 2_000, mcp: false },
      ],
    });
    seedFirstTurn(db, S);
    seedMainRequest(db, S, 1, 1_000, measuredTokens, "shape-startup");
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "instructions",
      filePath: "/home/example/.claude/CLAUDE.md",
      occurredAt: 500,
      sizeBytes: instructionBytes,
    });
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "hook-output",
      name: "SessionStart:startup",
      occurredAt: 400,
      source: "transcript",
      sizeBytes: 1_207,
    });
    seedLoad(db, {
      id: 3,
      sessionId: S,
      kind: "skill-listing",
      occurredAt: 500,
      source: "transcript",
      sizeBytes: 24_851,
      itemCount: 49,
    });
    seedLoad(db, {
      id: 4,
      sessionId: S,
      kind: "mcp-instructions",
      occurredAt: 600,
      source: "transcript",
      sizeBytes: 3_715,
      itemCount: 2,
    });
    seedLoad(db, {
      id: 5,
      sessionId: S,
      kind: "agent-listing",
      occurredAt: 700,
      source: "transcript",
      sizeBytes: 2_527,
    });
    seedLoad(db, {
      id: 6,
      sessionId: S,
      kind: "deferred-tool-names",
      occurredAt: 800,
      source: "transcript",
      sizeBytes: 4_160,
      itemCount: 132,
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_000,
      endedAt: 3_000,
      resultSize: 123_943,
    });
    return { storage, db, S };
  }

  // What a subagent's own transcript adds: the same kinds
  // again, the deferred tools fewer, between the main
  // thread's start and its step.
  function seedSubagentStartup(db: DatabaseSync, sessionId: string): void {
    const branchId = seedBranch(db, { sessionId, agentId: "a1" });
    const listings = [
      { kind: "skill-listing", sizeBytes: 24_851, itemCount: 49 },
      { kind: "mcp-instructions", sizeBytes: 3_715, itemCount: 2 },
      { kind: "agent-listing", sizeBytes: 2_527, itemCount: null },
      { kind: "deferred-tool-names", sizeBytes: 3_000, itemCount: 24 },
    ];
    listings.forEach((listing, index) => {
      seedLoad(db, {
        id: 7 + index,
        sessionId,
        occurredAt: 1_100 + index,
        source: "transcript",
        branchId,
        ...listing,
      });
    });
  }

  it("lists the epoch's startup additions in the split, largest first", () => {
    const { storage, S } = seedStartupWorld(75_800);
    const result = atStep(storage, S, 1);
    expect(result.fixedLoad).toEqual(
      startupSplit({
        instructions: 1,
        skill: 3,
        deferred: 6,
        mcp: 4,
        agent: 5,
        hook: 2,
        instructionsName: "/home/example/.claude/CLAUDE.md",
      }),
    );
  });

  it("lists each kind once when a subagent re-sent its own listings", () => {
    const { storage, db, S } = seedStartupWorld(75_800);
    seedSubagentStartup(db, S);
    expect(atStep(storage, S, 1).fixedLoad).toEqual(
      startupSplit({
        instructions: 1,
        skill: 3,
        deferred: 6,
        mcp: 4,
        agent: 5,
        hook: 2,
        instructionsName: "/home/example/.claude/CLAUDE.md",
      }),
    );
  });

  it("counts the fixed load once: other is what neither the items nor the panel explain", () => {
    const { storage, S } = seedStartupWorld(75_800);
    const result = atStep(storage, S, 1);
    // Items: the prompt (14), the reply (100) and the step's
    // result (42,739) — 42,853. The panel holds the instruction
    // file (2,233) with the rest of the shape (13,794 + 2,070)
    // and the startup additions (12,576) — 30,673 — and the
    // item list names the file without a size. What is left is
    // history Flightpath can't name,
    // 75,800 − 42,853 − 30,673 = 2,274.
    expect(result.totals).toEqual({
      measured: 75_800,
      items: 42_853,
      named: 73_526,
      other: 2_274,
    });
    // The named share of the measured context: on the
    // recorded session this clears three fifths, where the
    // unnamed remainder once stood at 62.7K of 75.8K.
    const named =
      (result.totals.measured! - result.totals.other!) /
      result.totals.measured!;
    expect(named).toBeGreaterThan(0.6);
  });

  it("counts the file once when its size is unknown, too", () => {
    const { storage, S } = seedStartupWorld(75_800, null);
    const result = atStep(storage, S, 1);
    // The file's size was never recorded, so it stands in
    // neither sum: the items are 42,853 (the counted-once
    // seed's 45,086 less the file's 2,233), the panel's
    // total is 28,440, and the remainder grows by the
    // file's whole estimate: 75,800 − 42,853 − 28,440.
    expect(result.fixedLoad).toMatchObject({
      kind: "split",
      total: 28_440,
      instructions: [
        {
          loadId: 1,
          name: "/home/example/.claude/CLAUDE.md",
          bytes: null,
          tokens: null,
        },
      ],
    });
    expect(result.totals).toEqual({
      measured: 75_800,
      items: 42_853,
      named: 71_293,
      other: 4_507,
    });
  });

  it("never lets the remainder go below nothing", () => {
    const { storage, S } = seedStartupWorld(20_000);
    const result = atStep(storage, S, 1);
    // The estimates overshoot the measured total; the
    // remainder is null rather than a negative share.
    expect(result.totals.measured).toBe(20_000);
    expect(result.totals.other).toBeNull();
  });

  // One skills listing before a compaction at 4,500 and its
  // re-send after; a step in each stretch.
  function seedEpochsWorld(): {
    storage: Storage;
    db: DatabaseSync;
    S: string;
  } {
    const { storage, db } = makeWorld();
    const S = "sess-startup-epochs";
    seedRequestShape(db, {
      hash: "shape-epochs",
      systemBytes: 12_000,
      tools: [{ name: "Read", bytes: 2_000, mcp: false }],
    });
    seedFirstTurn(db, S);
    seedMainRequest(db, S, 1, 1_000, 10_000, "shape-epochs");
    seedLoad(db, {
      id: 1,
      sessionId: S,
      kind: "skill-listing",
      occurredAt: 500,
      source: "transcript",
      sizeBytes: 24_851,
      itemCount: 49,
    });
    seedStep(db, {
      id: 1,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_000,
      endedAt: 3_000,
      resultSize: 1_000,
      resultRequestId: 1,
    });
    seedSegment(db, { sessionId: S, kind: "compact", startedAt: 4_500 });
    // The compaction re-sends the listing: a load of its own
    // in the new epoch, at the re-send's moment.
    seedLoad(db, {
      id: 2,
      sessionId: S,
      kind: "skill-listing",
      occurredAt: 5_000,
      source: "transcript",
      sizeBytes: 24_851,
      itemCount: 49,
    });
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 6_000,
      endedAt: 7_000,
      resultSize: 1_000,
    });
    return { storage, db, S };
  }

  it("reads a compaction's repeat in the new epoch, not twice in one", () => {
    const { storage, S } = seedEpochsWorld();
    const listing = {
      kind: "skill-listing",
      name: null,
      count: 49,
      chars: 24_851,
      tokens: 8_570,
      fromContext: false,
    };
    const before = atStep(storage, S, 1);
    expect(before.fixedLoad).toMatchObject({
      kind: "split",
      startup: [{ ...listing, loadId: 1 }],
    });
    const after = atStep(storage, S, 2);
    expect(after.epoch.startedAt).toBe(4_500);
    expect(after.fixedLoad).toMatchObject({
      kind: "split",
      startup: [{ ...listing, loadId: 2 }],
    });
  });

  describe("with a /context report", () => {
    // The sizes of the report in the recorded start, as it
    // wrote them (system prompt 2.8k, skills 8.3k, MCP server
    // instructions 1.3k).
    function recordReport(
      storage: Storage,
      sessionId: string,
      at: number,
      model = "claude-sonnet-4-6",
      systemTools: number | null = null,
    ): void {
      storage.recordContextReport(
        sessionId,
        {
          model,
          window: 1_000_000,
          autocompactBuffer: 33_000,
          systemPrompt: 2_800,
          systemTools,
          mcpInstructions: 1_300,
          memoryFiles: 2_300,
          skills: 8_300,
        },
        at,
      );
    }

    const REPORTED_STARTUP = [
      { loadId: 3, tokens: 8_300, fromContext: true },
      { loadId: 6, tokens: 1_435, fromContext: false },
      { loadId: 4, tokens: 1_300, fromContext: true },
      { loadId: 5, tokens: 872, fromContext: false },
      { loadId: 2, tokens: 417, fromContext: false },
    ];

    function skillsRow(result: ContextAtStep): unknown {
      if (result.fixedLoad?.kind !== "split") throw new Error("not split");
      return result.fixedLoad.startup.map(
        ({ loadId, tokens, fromContext }) => ({
          loadId,
          tokens,
          fromContext,
        }),
      );
    }

    it("sizes the system prompt, the skills listing and the servers' instructions by the report, and the rest by estimate", () => {
      const { storage, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500);
      const result = atStep(storage, S, 1);
      expect(result.fixedLoad).toMatchObject({
        system: { chars: 40_000, tokens: 2_800, fromContext: true },
        tools: [
          { name: "Read", tokens: 1_380 },
          { name: "Bash", tokens: 690 },
        ],
        instructions: [{ tokens: 2_233 }],
      });
      expect(skillsRow(result)).toEqual(REPORTED_STARTUP);
    });

    it("keeps the report's figures when a subagent re-sent its own listings", () => {
      const { storage, db, S } = seedStartupWorld(75_800);
      seedSubagentStartup(db, S);
      recordReport(storage, S, 1_500);
      expect(skillsRow(atStep(storage, S, 1))).toEqual(REPORTED_STARTUP);
    });

    it("adds the report's sizes into the panel's total and the remainder", () => {
      const { storage, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500);
      const result = atStep(storage, S, 1);
      // 2,800 + 1,380 + 690 + 2,233 + (8,300 + 1,435 + 1,300 +
      // 872 + 417) = 19,427, so the remainder is
      // 75,800 − 42,853 − 19,427.
      expect(result.fixedLoad).toMatchObject({ total: 19_427 });
      expect(result.totals).toEqual({
        measured: 75_800,
        items: 42_853,
        named: 62_280,
        other: 13_520,
      });
    });

    function toolsOf(result: ContextAtStep): unknown {
      if (result.fixedLoad?.kind !== "split") throw new Error("not split");
      const { tools, toolsReported, mcp } = result.fixedLoad;
      return { tools, toolsReported, mcp };
    }

    it("shares the report's system tools out so the definitions sum to it exactly", () => {
      const { storage, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500, "claude-sonnet-4-6", 25_300);
      const result = atStep(storage, S, 1);
      expect(toolsOf(result)).toMatchObject({
        toolsReported: 25_300,
        tools: [
          { name: "Read", tokens: 16_867 },
          { name: "Bash", tokens: 8_433 },
        ],
      });
    });

    it("leaves a server's tools unscaled and shares the rest of the total among the others", () => {
      const { storage, db, S } = seedStartupWorld(75_800);
      seedRequestShape(db, {
        hash: "shape-mcp",
        systemBytes: 40_000,
        tools: [
          { name: "Read", bytes: 4_000, mcp: false },
          { name: "Bash", bytes: 2_000, mcp: false },
          { name: "mcp__example__lookup", bytes: 3_000, mcp: true },
        ],
      });
      db.prepare("UPDATE requests SET shape_hash = 'shape-mcp'").run();
      recordReport(storage, S, 1_500, "claude-sonnet-4-6", 25_300);
      expect(toolsOf(atStep(storage, S, 1))).toMatchObject({
        toolsReported: 25_300,
        tools: [{ tokens: 16_867 }, { tokens: 8_433 }],
        mcp: [{ server: "example", tokens: 1_035 }],
      });
    });

    it("keeps the estimates when no report gave the tools", () => {
      const { storage, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500);
      expect(toolsOf(atStep(storage, S, 1))).toMatchObject({
        toolsReported: null,
        tools: [{ tokens: 1_380 }, { tokens: 690 }],
      });
    });

    it("keeps the estimates when the report came before a compaction behind the step", () => {
      const { storage, db, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500, "claude-sonnet-4-6", 25_300);
      seedSegment(db, { sessionId: S, kind: "compact", startedAt: 2_500 });
      expect(toolsOf(atStep(storage, S, 1))).toMatchObject({
        toolsReported: null,
      });
    });

    it("leaves every size an estimate when the report is another model's", () => {
      const { storage, S } = seedStartupWorld(75_800);
      recordReport(storage, S, 1_500, "claude-opus-5-5");
      const result = atStep(storage, S, 1);
      expect(result.fixedLoad).toMatchObject({
        system: { tokens: 13_794, fromContext: false },
      });
      expect(skillsRow(result)).toContainEqual({
        loadId: 3,
        tokens: 8_570,
        fromContext: false,
      });
    });

    it("leaves the steps before a compaction on estimates when the report comes after it", () => {
      const { storage, S } = seedEpochsWorld();
      recordReport(storage, S, 6_500);
      expect(skillsRow(atStep(storage, S, 1))).toEqual([
        { loadId: 1, tokens: 8_570, fromContext: false },
      ]);
      expect(skillsRow(atStep(storage, S, 2))).toEqual([
        { loadId: 2, tokens: 8_300, fromContext: true },
      ]);
    });

    it("leaves the steps after a compaction on estimates when the report came before it", () => {
      const { storage, S } = seedEpochsWorld();
      recordReport(storage, S, 2_500);
      expect(skillsRow(atStep(storage, S, 1))).toEqual([
        { loadId: 1, tokens: 8_300, fromContext: true },
      ]);
      expect(skillsRow(atStep(storage, S, 2))).toEqual([
        { loadId: 2, tokens: 8_570, fromContext: false },
      ]);
    });

    it("keeps the estimates of a kind that several loads made up", () => {
      const { storage, db, S } = seedEpochsWorld();
      seedLoad(db, {
        id: 3,
        sessionId: S,
        kind: "skill-listing",
        occurredAt: 5_500,
        source: "transcript",
        sizeBytes: 2_900,
        itemCount: 4,
      });
      recordReport(storage, S, 6_500);
      expect(skillsRow(atStep(storage, S, 2))).toEqual([
        { loadId: 2, tokens: 8_570, fromContext: false },
        { loadId: 3, tokens: 1_000, fromContext: false },
      ]);
    });

    it("leaves a subagent's own request shape on estimates", () => {
      const { storage, S } = seedBranchShapeWorld();
      recordReport(storage, S, 14_000, "claude-sonnet-5-5");
      expect(atStep(storage, S, 101).fixedLoad).toMatchObject({
        system: { tokens: 4_138, fromContext: false },
      });
    });
  });
});

// What a subagent started with, named in its own Snapshot: its
// task, the skills it preloads, the instruction files it
// loaded and its own listings. The planted session's subagent (an Explore
// from the main conversation) reads at its step 101.
describe("a subagent's start in its Snapshot", () => {
  const SUBAGENT = 1;

  function seedStartWorld(): { storage: Storage; db: DatabaseSync; S: string } {
    const { storage, db, S } = seedBranchShapeWorld();
    seedRequestShape(db, {
      hash: "shape-main",
      systemBytes: 40_000,
      tools: [{ name: "Read", bytes: 4_000, mcp: false }],
    });
    db.prepare("UPDATE requests SET shape_hash = ? WHERE id = 5").run(
      "shape-main",
    );
    seedLoad(db, {
      id: 10,
      sessionId: S,
      kind: "instructions",
      filePath: "/home/example/.claude/CLAUDE.md",
      occurredAt: 500,
      sizeBytes: 6_474,
    });
    seedLoad(db, {
      id: 11,
      sessionId: S,
      kind: "skill-listing",
      occurredAt: 600,
      source: "transcript",
      sizeBytes: 24_851,
      itemCount: 49,
    });
    return { storage, db, S };
  }

  /** The subagent's start as the follower records it: sizes
   * only, in the order its transcript carries them. */
  function seedSubagentStart(
    db: DatabaseSync,
    sessionId: string,
    branchId: number,
    firstId: number,
    startedAt: number,
  ): void {
    const start = [
      { kind: "task-prompt", sizeBytes: 2_000 },
      { kind: "preloaded-skill", name: "house-style", sizeBytes: 8_000 },
      { kind: "preloaded-skill", name: "release-notes", sizeBytes: 3_000 },
      {
        kind: "instructions",
        filePath: "/home/example/garden/CLAUDE.md",
        sizeBytes: 1_200,
      },
      {
        kind: "instructions",
        filePath: "/home/example/garden/beds/CLAUDE.md",
        sizeBytes: 6_474,
      },
      { kind: "skill-listing", sizeBytes: 5_000, itemCount: 8 },
    ];
    start.forEach((load, index) => {
      seedLoad(db, {
        id: firstId + index,
        sessionId,
        occurredAt: startedAt + index,
        source: "transcript",
        branchId,
        ...load,
      });
    });
  }

  it("lists its task, preloaded skills, instruction files and listings in its split", () => {
    const { storage, db, S } = seedStartWorld();
    seedSubagentStart(db, S, SUBAGENT, 20, 100);
    const split = atStep(storage, S, 101).fixedLoad;
    expect(split).toEqual({
      kind: "split",
      requestId: 102,
      total: 13_684,
      system: { chars: 12_000, tokens: 4_138, fromContext: false },
      tools: [{ name: "Read", chars: 2_000, tokens: 690 }],
      toolsReported: null,
      mcp: [],
      instructions: [
        {
          loadId: 23,
          name: "/home/example/garden/CLAUDE.md",
          bytes: 1_200,
          tokens: 414,
        },
        {
          loadId: 24,
          name: "/home/example/garden/beds/CLAUDE.md",
          bytes: 6_474,
          tokens: 2_233,
        },
      ],
      startup: [
        {
          loadId: 21,
          kind: "preloaded-skill",
          name: "house-style",
          count: null,
          chars: 8_000,
          tokens: 2_759,
          fromContext: false,
        },
        {
          loadId: 25,
          kind: "skill-listing",
          name: null,
          count: 8,
          chars: 5_000,
          tokens: 1_725,
          fromContext: false,
        },
        {
          loadId: 22,
          kind: "preloaded-skill",
          name: "release-notes",
          count: null,
          chars: 3_000,
          tokens: 1_035,
          fromContext: false,
        },
        {
          loadId: 20,
          kind: "task-prompt",
          name: null,
          count: null,
          chars: 2_000,
          tokens: 690,
          fromContext: false,
        },
      ],
    });
  });

  it("counts them as named: Named rises by their sum", () => {
    const { storage, db, S } = seedStartWorld();
    const before = atStep(storage, S, 101).totals;
    seedSubagentStart(db, S, SUBAGENT, 20, 100);
    const after = atStep(storage, S, 101).totals;
    // 414 + 2,233 + 2,759 + 1,035 + 1,725 + 690.
    expect(after.named - before.named).toBe(8_856);
    expect(after.measured).toBe(before.measured);
    expect(after.other).toBe((before.other ?? 0) - 8_856);
  });

  it("leaves the main conversation's Snapshot, split and items, as it was", () => {
    const { storage, db, S } = seedStartWorld();
    const before = atStep(storage, S, 4);
    seedSubagentStart(db, S, SUBAGENT, 20, 100);
    expect(atStep(storage, S, 4)).toEqual(before);
    expect(before.fixedLoad).toMatchObject({
      kind: "split",
      instructions: [{ loadId: 10 }],
      startup: [{ loadId: 11 }],
    });
  });

  it("names a nested subagent's task after the subagent that launched it", () => {
    const { storage, db, S } = seedStartWorld();
    const nested = seedBranch(db, {
      id: 2,
      sessionId: S,
      agentId: "agent-2",
      agentType: "reviewer",
      kind: "user",
      spawningStepId: 101,
      startedAt: 20_000,
    });
    seedRequestExact(db, {
      id: 201,
      sessionId: S,
      turnId: 2,
      branchId: nested,
      model: "claude-sonnet-5-5",
      querySource: "subagent",
      startedAt: 21_500,
      input: 3_000,
      shapeHash: "shape-branch",
    });
    seedStep(db, {
      id: 201,
      sessionId: S,
      turnId: 2,
      branchId: nested,
      toolName: "Read",
      startedAt: 20_500,
      endedAt: 21_000,
      resultSize: 1_000,
      resultRequestId: 201,
    });
    seedSubagentStart(db, S, nested, 30, 20_000);
    expect(atStep(storage, S, 201).fixedLoad).toMatchObject({
      kind: "split",
      startup: expect.arrayContaining([
        expect.objectContaining({
          kind: "preloaded-skill",
          name: "house-style",
        }),
        expect.objectContaining({ kind: "task-prompt", name: "Explore" }),
      ]),
    });
  });
  describe("when its transcript is written before its start event", () => {
    const STARTED = 13_000;

    function startedWorld(): { storage: Storage; db: DatabaseSync; S: string } {
      const world = seedStartWorld();
      world.db
        .prepare("UPDATE branches SET started_at = ? WHERE id = ?")
        .run(STARTED, SUBAGENT);
      seedLoad(world.db, {
        id: 33,
        sessionId: world.S,
        kind: "instructions",
        filePath: "/home/example/garden/main-only/CLAUDE.md",
        occurredAt: 11_650,
        sizeBytes: 900,
      });
      return world;
    }

    /** The task, a preloaded skill and an instruction file,
     * stamped before the start event. */
    function seedEarlyStart(db: DatabaseSync, sessionId: string): void {
      const early = [
        { id: 30, occurredAt: 11_600, kind: "task-prompt", sizeBytes: 2_000 },
        {
          id: 31,
          occurredAt: 11_700,
          kind: "preloaded-skill",
          name: "house-style",
          sizeBytes: 8_000,
        },
        {
          id: 32,
          occurredAt: 11_800,
          kind: "instructions",
          filePath: "/home/example/garden/CLAUDE.md",
          sizeBytes: 1_200,
        },
      ];
      for (const load of early) {
        seedLoad(db, {
          sessionId,
          source: "transcript",
          branchId: SUBAGENT,
          ...load,
        });
      }
    }

    it("lists the task, the skill and the instruction file stamped before its start", () => {
      const { storage, db, S } = startedWorld();
      seedEarlyStart(db, S);
      expect(atStep(storage, S, 101).fixedLoad).toMatchObject({
        kind: "split",
        instructions: [{ loadId: 32, name: "/home/example/garden/CLAUDE.md" }],
        startup: [
          { loadId: 31, kind: "preloaded-skill", name: "house-style" },
          { loadId: 30, kind: "task-prompt", chars: 2_000 },
        ],
      });
    });

    it("counts them as named: Named rises by their sum", () => {
      const { storage, db, S } = startedWorld();
      const before = atStep(storage, S, 101).totals;
      seedEarlyStart(db, S);
      const after = atStep(storage, S, 101).totals;
      // 690 + 2,759 + 414.
      expect(after.named - before.named).toBe(3_863);
      expect(after.other).toBe((before.other ?? 0) - 3_863);
    });

    it("keeps the main conversation's files out of its split", () => {
      const { storage, db, S } = startedWorld();
      seedEarlyStart(db, S);
      const split = atStep(storage, S, 101).fixedLoad;
      const files = split?.kind === "split" ? split.instructions : [];
      expect(files.map((file) => file.loadId)).not.toContain(33);
    });

    it("leaves the main conversation's step as it was", () => {
      const { storage, db, S } = startedWorld();
      const before = atStep(storage, S, 4);
      seedEarlyStart(db, S);
      expect(atStep(storage, S, 4)).toEqual(before);
    });

    it("reads the same from held data that gains the loads in a delta as from a fresh load", () => {
      const { storage, db, S } = startedWorld();
      const held = loadSessionData(storage, S);
      seedEarlyStart(db, S);
      const fresh = loadSessionData(storage, S);
      if (held === undefined || fresh === undefined) {
        throw new Error("session did not load");
      }
      const merged = mergeSessionData(held, { loads: fresh.loads });
      expect(contextAtStep(merged, 101)).toEqual(contextAtStep(fresh, 101));
      expect(contextAtStep(merged, 101)?.epoch.startedAt).toBe(11_600);
    });

    it("starts its epoch at its first load, and the main thread's where it did", () => {
      const { storage, db, S } = startedWorld();
      seedEarlyStart(db, S);
      expect(atStep(storage, S, 101).epoch.startedAt).toBe(11_600);
      expect(atStep(storage, S, 4).epoch).toEqual({
        startedAt: 0,
        afterCompactionSegmentId: null,
      });
    });
  });
});

// Claude Code starts a subagent in the background: the launch
// returns a short notice, the subagent runs on its own thread,
// and its report reaches the main thread later as a hand-back.
describe("a subagent that runs in the background", () => {
  const S = "sess-background";
  const GENERAL = "a0000000000000001";
  const EXPLORE = "a0000000000000002";

  /**
   * Two subagents launched at 1,100 and 1,300. The first's
   * thread has one request (37,800 tokens) and ends with its
   * hand-back step; the second reports back first. Main
   * requests measure 60,000 before and 75,300 after, and a
   * main step runs while the first subagent works.
   */
  function seedBackground(db: DatabaseSync, asyncLaunch: number = 1): void {
    seedSession(db, { id: S });
    seedTurn(db, { id: 1, sessionId: S, sequence: 1, startedAt: 0 });
    seedRequestExact(db, { id: 1, sessionId: S, turnId: 1, startedAt: 1_000 });
    seedSample(db, {
      sessionId: S,
      requestId: 1,
      sampledAt: 1_000,
      contextTokens: 60_000,
    });
    seedLaunch(db, {
      id: 1,
      sessionId: S,
      subagentType: "general-purpose",
      startedAt: 1_100,
      asyncLaunch,
    });
    seedLaunch(db, {
      id: 5,
      sessionId: S,
      subagentType: "Explore",
      startedAt: 1_300,
      asyncLaunch,
    });
    seedBranch(db, {
      id: 1,
      sessionId: S,
      agentId: GENERAL,
      agentType: "general-purpose",
      spawningStepId: 1,
      startedAt: 1_500,
    });
    seedBranch(db, {
      id: 2,
      sessionId: S,
      agentId: EXPLORE,
      agentType: "Explore",
      spawningStepId: 5,
      startedAt: 1_600,
    });
    seedRequestExact(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      querySource: "subagent",
      startedAt: 2_000,
    });
    seedSample(db, {
      sessionId: S,
      requestId: 2,
      sampledAt: 2_000,
      contextTokens: 37_800,
    });
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      branchId: 1,
      toolName: "SubagentHandback",
      startedAt: 2_500,
      endedAt: 2_600,
      resultSize: 97,
    });
    seedStep(db, {
      id: 4,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 2_700,
      endedAt: 2_800,
    });
    seedRequestExact(db, { id: 3, sessionId: S, turnId: 1, startedAt: 3_100 });
    seedSample(db, {
      sessionId: S,
      requestId: 3,
      sampledAt: 3_100,
      contextTokens: 75_300,
    });
    seedStep(db, {
      id: 3,
      sessionId: S,
      turnId: 1,
      toolName: "Bash",
      startedAt: 3_200,
      endedAt: 3_300,
    });
    seedHandback(db, {
      sessionId: S,
      occurredAt: 3_000,
      agentType: "general-purpose",
      agentId: GENERAL,
      chars: 4_447,
    });
    seedHandback(db, {
      sessionId: S,
      occurredAt: 2_900,
      agentType: "Explore",
      agentId: EXPLORE,
      chars: 2_000,
    });
  }

  function contextFact(storage: Storage, stepId: number): string | undefined {
    return stepDetail(storage, stepId)?.facts.find(
      (fact) => fact.label === "Context",
    )?.value;
  }

  it("shows a subagent's last step the context before it and no after", () => {
    const { storage, db } = makeWorld();
    seedBackground(db);
    expect(contextFact(storage, 2)).toBe("37.8K tokens before");
  });

  it("brackets a main-thread step by main requests, though a subagent sampled between them", () => {
    const { storage, db } = makeWorld();
    seedBackground(db);
    expect(contextFact(storage, 4)).toBe(
      "60.0K tokens before, 75.3K tokens after (+15.3K tokens from this step)",
    );
  });

  it("names the hand-back step in words", () => {
    const { storage, db } = makeWorld();
    seedBackground(db);
    expect(stepDetail(storage, 2)?.sentence).toBe("Handed its report back");
  });

  it("lists the launch notice as a tool result and each report as a subagent result", () => {
    const { storage, db } = makeWorld();
    seedBackground(db);
    const { items } = atStep(storage, S, 3);
    expect(
      items.find((item) => item.kind === "tool-result" && item.stepId === 1),
    ).toMatchObject({
      label: "Started a subagent: general-purpose",
      chars: 1_132,
    });
    // The reports are matched to their subagents by agent id,
    // and stand in the order they arrived: the second
    // subagent's hand-back came first.
    expect(items.filter((item) => item.kind === "subagent-result")).toEqual([
      {
        kind: "subagent-result",
        stepId: 5,
        branchId: 2,
        label: "Explore reported back",
        chars: 2_000,
        tokens: 690,
      },
      {
        kind: "subagent-result",
        stepId: 1,
        branchId: 1,
        label: "general-purpose reported back",
        chars: 4_447,
        tokens: 1_534,
      },
    ]);
  });

  it("leaves a report out of the context a step had before it arrived", () => {
    const { storage, db } = makeWorld();
    seedBackground(db);
    const { items } = atStep(storage, S, 4);
    expect(items.some((item) => item.kind === "subagent-result")).toBe(false);
    expect(
      items.some((item) => item.kind === "tool-result" && item.stepId === 1),
    ).toBe(true);
  });

  it("counts a synchronous result once, though a hand-back row names the same subagent", () => {
    const { storage, db } = makeWorld();
    seedBackground(db, 0);
    const results = atStep(storage, S, 3).items.filter(
      (item) => item.kind === "subagent-result",
    );
    expect(results).toEqual([
      expect.objectContaining({
        stepId: 1,
        label: "Started a subagent: general-purpose",
        chars: 1_132,
      }),
      expect.objectContaining({
        stepId: 5,
        label: "Started a subagent: Explore",
        chars: 1_132,
      }),
    ]);
  });
});

describe("a saved tool output", () => {
  const S = "sess-saved-output";
  const SAVED_PATH =
    "/home/user/.claude/projects/proj-a/sess-saved-output/tool-results/toolu_made_up.txt";

  function seedSavedOutput(recordSource: boolean): Storage {
    const { storage, db } = makeWorld();
    seedFirstTurn(db, S);
    if (recordSource) {
      seedStep(db, {
        id: 1,
        sessionId: S,
        turnId: 1,
        toolName: "Bash",
        input: { command: "npm test" },
        toolUseId: "toolu_made_up",
        savedOutputBytes: 31_000,
        startedAt: 2_000,
        endedAt: 2_500,
      });
    }
    seedStep(db, {
      id: 2,
      sessionId: S,
      turnId: 1,
      toolName: "Read",
      input: { file_path: SAVED_PATH },
      toolUseId: "toolu_read",
      startedAt: 3_000,
      endedAt: 3_500,
    });
    return storage;
  }

  it("reads as the output of the step that printed it, and links to that step", () => {
    const detail = stepDetail(seedSavedOutput(true), 2);
    expect(detail?.sentence).toBe("Read the saved output of Ran `npm test`");
    expect(detail?.savedOutputStepId).toBe(1);
  });

  it("reads as a saved tool output when that step is not recorded", () => {
    const detail = stepDetail(seedSavedOutput(false), 2);
    expect(detail?.sentence).toBe("Read a saved tool output");
    expect(detail?.savedOutputStepId).toBeNull();
  });

  it("marks the step whose output was saved, and links nothing from it", () => {
    const detail = stepDetail(seedSavedOutput(true), 1);
    expect(detail?.facts).toContainEqual({
      label: "Saved output",
      value:
        "Output saved to a file (31.0 KB); only a short notice entered the context",
    });
    expect(detail?.savedOutputStepId).toBeNull();
  });
});
