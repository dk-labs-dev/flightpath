import { describe, expect, it } from "vitest";

import {
  buildRows,
  contextAt,
  nearestStepId,
  rowAction,
  turnContextRange,
  type RowChoices,
} from "../src/session/rows.js";
import type { SessionData, StepRow } from "../src/session/types.js";
import { fixtureSnapshot } from "./fixtures.js";

// The store's maps, built the way the store builds them, so the
// pure row builder can be tested on its own.
function fixtureData(): SessionData {
  const snapshot = fixtureSnapshot();
  const turns = new Map(
    snapshot.turns.map((turn) => [
      turn.id,
      {
        id: turn.id,
        sequence: turn.sequence,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        failures: turn.failures,
        steppedIn: turn.steppedIn,
        images: turn.images,
        files: turn.files,
        promptSentence:
          turn.humanMoments.find((moment) => moment.kind === "prompt")
            ?.sentence ?? null,
      },
    ]),
  );
  const steps = new Map(
    snapshot.turns.flatMap((turn) =>
      turn.steps.map(
        (step) => [step.id, { ...step, turnId: turn.id }] as const,
      ),
    ),
  );
  const humans = new Map(
    snapshot.turns.flatMap((turn) =>
      turn.humanMoments.map(
        (moment) => [moment.id, { ...moment, turnId: turn.id }] as const,
      ),
    ),
  );
  const stepsByTurn = new Map(
    snapshot.turns.map((turn) => [
      turn.id,
      turn.steps.map((step) => ({ ...step, turnId: turn.id })),
    ]),
  );
  const humansByTurn = new Map(
    snapshot.turns.map((turn) => [
      turn.id,
      turn.humanMoments.map((moment) => ({ ...moment, turnId: turn.id })),
    ]),
  );
  const stepsByBranch = new Map<number, StepRow[]>();
  for (const step of steps.values()) {
    if (step.branchId === null) continue;
    const list = stepsByBranch.get(step.branchId) ?? [];
    list.push(step);
    stepsByBranch.set(step.branchId, list);
  }
  for (const list of stepsByBranch.values()) {
    list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id);
  }
  const branches = new Map(
    snapshot.branches.map((branch) => [branch.id, branch]),
  );
  const events = new Map(
    snapshot.sessionEvents.map((event) => [`${event.kind}:${event.id}`, event]),
  );
  return {
    turns,
    steps,
    humans,
    branches,
    events,
    samples: snapshot.contextSamples,
    stepsByTurn,
    humansByTurn,
    stepsByBranch,
    openStepIds: new Set(
      [...steps.values()]
        .filter((step) => step.outcome === "open")
        .map((step) => step.id),
    ),
  };
}

const OPEN: RowChoices = {
  collapsedTurns: new Set(),
  collapsedBranches: new Set(),
  failuresOnly: false,
  steppedInOnly: false,
  search: "",
  waiting: null,
};

describe("buildRows", () => {
  it("orders turns, moments, steps, branches and events by time", () => {
    const rows = buildRows(fixtureData(), OPEN);
    expect(rows.map((row) => row.key)).toEqual([
      "turn-11",
      "step-101",
      "human-22",
      "step-102",
      "event-segment:41",
      "turn-12",
      "step-103",
      "step-105",
      "step-106",
      "human-23",
      "step-104",
    ]);
  });

  it("counts each row among its siblings, not the whole list", () => {
    const rows = buildRows(fixtureData(), OPEN);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const counts = (key: string) => {
      const row = byKey.get(key);
      return row === undefined ? null : [row.posInSet, row.setSize];
    };
    // The turns and the event share the top level: three.
    expect(counts("turn-11")).toEqual([1, 3]);
    expect(counts("event-segment:41")).toEqual([2, 3]);
    expect(counts("turn-12")).toEqual([3, 3]);
    // A turn's rows count inside their turn.
    expect(counts("step-101")).toEqual([1, 3]);
    expect(counts("human-22")).toEqual([2, 3]);
    expect(counts("step-102")).toEqual([3, 3]);
    expect(counts("step-103")).toEqual([1, 3]);
    expect(counts("human-23")).toEqual([2, 3]);
    expect(counts("step-104")).toEqual([3, 3]);
    // A branch's steps count inside the branch.
    expect(counts("step-105")).toEqual([1, 2]);
    expect(counts("step-106")).toEqual([2, 2]);
  });

  it("never shows the prompt as its own row", () => {
    const keys = buildRows(fixtureData(), OPEN).map((row) => row.key);
    expect(keys).not.toContain("human-21");
  });

  it("refuses a launch step listed under two turns", () => {
    const data = fixtureData();
    const launch = data.steps.get(103);
    if (launch === undefined) throw new Error("fixture lost step 103");
    // A stale index: the launch step is still listed under
    // the turn it left as well as the turn that holds it, so
    // its subagent's row would be placed twice under one key.
    data.stepsByTurn.set(11, [
      ...(data.stepsByTurn.get(11) ?? []),
      { ...launch, turnId: 11 },
    ]);
    expect(() => buildRows(data, OPEN)).toThrow("step-103");
  });

  it("hides a collapsed turn's children", () => {
    const rows = buildRows(fixtureData(), {
      ...OPEN,
      collapsedTurns: new Set([11]),
    });
    const keys = rows.map((row) => row.key);
    expect(keys).not.toContain("step-101");
    expect(keys).not.toContain("human-22");
    expect(keys).toContain("turn-12");
  });

  it("hides a collapsed branch's steps but keeps the branch row", () => {
    const rows = buildRows(fixtureData(), {
      ...OPEN,
      collapsedBranches: new Set([31]),
    });
    const keys = rows.map((row) => row.key);
    expect(keys).toContain("step-103");
    expect(keys).not.toContain("step-105");
    expect(keys).toContain("step-104");
  });

  it("the failures filter keeps failed steps and their turns only", () => {
    const rows = buildRows(fixtureData(), { ...OPEN, failuresOnly: true });
    expect(rows.map((row) => row.key)).toEqual(["turn-11", "step-102"]);
  });

  it("the stepped-in filter keeps the moments the person stepped in", () => {
    const rows = buildRows(fixtureData(), { ...OPEN, steppedInOnly: true });
    expect(rows.map((row) => row.key)).toEqual([
      "turn-11",
      "human-22",
      "turn-12",
      "human-23",
    ]);
  });

  it("search matches sentences, case-insensitively", () => {
    const data = fixtureData();
    expect(
      buildRows(data, { ...OPEN, search: "NPM" }).map((row) => row.key),
    ).toEqual(["turn-11", "step-101"]);
    expect(
      buildRows(data, { ...OPEN, search: "guide.md" }).map((row) => row.key),
    ).toEqual(["turn-12", "step-104"]);
  });

  it("combines the failures filter with a search: both have to hold", () => {
    const data = fixtureData();
    // The failed step is the Edit; a search for the test run
    // matches only a step that passed, so nothing survives
    // both filters — the search is not ignored, and neither
    // is the toggle.
    expect(
      buildRows(data, { ...OPEN, failuresOnly: true, search: "npm" }).map(
        (row) => row.key,
      ),
    ).toEqual([]);
    expect(
      buildRows(data, { ...OPEN, failuresOnly: true, search: "app.ts" }).map(
        (row) => row.key,
      ),
    ).toEqual(["turn-11", "step-102"]);
  });

  it("combines the stepped-in filter with a search: both have to hold", () => {
    const data = fixtureData();
    expect(
      buildRows(data, { ...OPEN, steppedInOnly: true, search: "answered" }).map(
        (row) => row.key,
      ),
    ).toEqual(["turn-12", "human-23"]);
    expect(
      buildRows(data, { ...OPEN, steppedInOnly: true, search: "npm" }).map(
        (row) => row.key,
      ),
    ).toEqual([]);
  });

  it("a waiting line ends the list when the screen passes one", () => {
    const rows = buildRows(fixtureData(), {
      ...OPEN,
      waiting: "Waiting for you",
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "waiting",
      text: "Waiting for you",
    });
  });
});

describe("row helpers", () => {
  it("reads a turn's context range from the samples around it", () => {
    const data = fixtureData();
    const turn = data.turns.get(11);
    expect(turn).toBeDefined();
    expect(
      turnContextRange(data.stepsByTurn.get(11) ?? [], data.samples, turn!),
    ).toEqual({
      before: 9000,
      after: 20000,
    });
  });

  it("finds the step nearest a point on the curve", () => {
    const data = fixtureData();
    expect(nearestStepId(data.steps, 3000)).toBe(102);
    expect(nearestStepId(data.steps, 500)).toBe(101);
  });

  it("reads the context at a moment from the last sample before it", () => {
    const { samples } = fixtureData();
    expect(contextAt(samples, 4000)).toBe(20000);
    expect(contextAt(samples, 500)).toBeNull();
    expect(contextAt(samples, null)).toBeNull();
  });

  it("says what activating each kind of row does", () => {
    const rows = buildRows(fixtureData(), {
      collapsedTurns: new Set(),
      collapsedBranches: new Set(),
      failuresOnly: false,
      steppedInOnly: false,
      search: "",
      waiting: "Waiting for you",
    });
    const byKind = new Map(rows.map((row) => [row.kind, rowAction(row)]));
    expect(byKind.get("step")).toBe("open");
    expect(byKind.get("turn")).toBe("toggle");
    expect(byKind.get("branch")).toBe("open");
    expect(byKind.get("human")).toBeNull();
    expect(byKind.get("event")).toBeNull();
    expect(byKind.get("waiting")).toBeNull();
  });

  it("opens the snapshot from a turn that ran no step, and folds one that did", () => {
    const data = fixtureData();
    data.stepsByTurn.set(11, []);
    const turns = buildRows(data, OPEN).filter((row) => row.kind === "turn");
    expect(turns.map((row) => [row.turnId, rowAction(row)])).toEqual([
      [11, "open"],
      [12, "toggle"],
    ]);
  });

  it("opens a compaction's row and no other event's", () => {
    const data = fixtureData();
    data.events = new Map([
      [
        "segment:41",
        {
          kind: "segment",
          id: 41,
          at: 4500,
          sentence: "Compacted the conversation",
          segmentKind: "compact",
        },
      ],
      [
        "segment:42",
        {
          kind: "segment",
          id: 42,
          at: 4600,
          sentence: "Session resumed",
          segmentKind: "resume",
        },
      ],
      [
        "pause:7",
        { kind: "pause", id: 7, at: 4700, sentence: "Recording paused" },
      ],
    ]);
    const actions = buildRows(data, OPEN)
      .filter((row) => row.kind === "event")
      .map((row) => [row.key, rowAction(row)]);
    expect(actions).toEqual([
      ["event-segment:41", "open"],
      ["event-segment:42", null],
      ["event-pause:7", null],
    ]);
  });
});

describe("a subagent's row", () => {
  function branchRows(data: SessionData, choices: RowChoices = OPEN) {
    return buildRows(data, choices).filter((row) => row.kind === "branch");
  }

  it("stands for the step that started it, so the subagent shows once", () => {
    const rows = buildRows(fixtureData(), OPEN);
    expect(rows).toHaveLength(11);
    const [branch] = branchRows(fixtureData());
    expect(branch).toMatchObject({ key: "step-103", spawningStepId: 103 });
    expect(rows.filter((row) => row.key === "step-103")).toHaveLength(1);
  });

  it("still shows when the subagent has taken no steps yet", () => {
    const data = fixtureData();
    for (const id of [105, 106]) data.steps.delete(id);
    data.stepsByTurn.set(
      12,
      (data.stepsByTurn.get(12) ?? []).filter((step) => step.branchId === null),
    );
    expect(branchRows(data).map((row) => row.key)).toEqual(["step-103"]);
  });

  it("keeps its own key and folds when no step started it", () => {
    const data = fixtureData();
    const branch = data.branches.get(31);
    if (branch !== undefined)
      data.branches.set(31, { ...branch, spawningStepId: null });
    const [row] = branchRows(data);
    expect(row).toMatchObject({ key: "branch-31", spawningStepId: null });
    expect(row === undefined ? null : rowAction(row)).toBe("toggle");
    expect(buildRows(data, OPEN).map((r) => r.key)).toContain("step-103");
  });

  it("shows under the failures filter when the starting step failed", () => {
    const data = fixtureData();
    const starter = data.steps.get(103);
    if (starter !== undefined)
      data.steps.set(103, { ...starter, outcome: "failed" });
    data.stepsByTurn.set(
      12,
      (data.stepsByTurn.get(12) ?? []).map((step) =>
        step.id === 103 ? { ...step, outcome: "failed" } : step,
      ),
    );
    const keys = buildRows(data, { ...OPEN, failuresOnly: true }).map(
      (row) => row.key,
    );
    expect(keys).toEqual(["turn-11", "step-102", "turn-12", "step-103"]);
  });

  it("is found by a search for the starting step's words", () => {
    const keys = buildRows(fixtureData(), {
      ...OPEN,
      search: "a subagent",
    }).map((row) => row.key);
    expect(keys).toEqual(["turn-12", "step-103"]);
  });

  it("shows once under its starting turn when its steps are stamped across turns", () => {
    const data = fixtureData();
    // The steps' own stamps disagree with their branch's
    // home: 105 is stamped with turn 11 and 106 with a later
    // turn 13, though both belong to the branch turn 12
    // started.
    const step105 = data.steps.get(105);
    const step106 = data.steps.get(106);
    if (step105 === undefined || step106 === undefined)
      throw new Error("the fixture's branch steps");
    data.steps.set(105, { ...step105, turnId: 11 });
    data.steps.set(106, { ...step106, turnId: 13 });
    data.stepsByTurn.set(11, [
      ...(data.stepsByTurn.get(11) ?? []),
      { ...step105, turnId: 11 },
    ]);
    data.stepsByTurn.set(
      12,
      (data.stepsByTurn.get(12) ?? []).filter(
        (step) => step.id !== 105 && step.id !== 106,
      ),
    );
    data.stepsByTurn.set(13, [{ ...step106, turnId: 13 }]);
    data.turns.set(13, {
      id: 13,
      sequence: 3,
      startedAt: 9500,
      endedAt: 9900,
      failures: 0,
      steppedIn: 0,
      images: 0,
      files: 0,
      promptSentence: null,
    });
    data.humansByTurn.set(13, []);
    const rows = buildRows(data, OPEN);
    const keys = rows.map((row) => row.key);
    expect(keys).toEqual([
      "turn-11",
      "step-101",
      "human-22",
      "step-102",
      "event-segment:41",
      "turn-12",
      "step-103",
      "step-105",
      "step-106",
      "human-23",
      "step-104",
      "turn-13",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(branchRows(data)).toHaveLength(1);
  });

  it("nests a subagent started inside another under its parent", () => {
    const data = fixtureData();
    data.branches.set(32, {
      id: 32,
      agentId: "agent-2",
      agentType: "Plan",
      kind: "user",
      spawningStepId: 105,
      startedAt: 5500,
      endedAt: 5900,
      totalTokens: 100,
      steps: 1,
      requests: 0,
      sentence: "Plan · 1 step",
    });
    const child = {
      id: 107,
      toolName: "Read",
      outcome: "succeeded" as const,
      startedAt: 5600,
      endedAt: 5700,
      durationMs: 100,
      branchId: 32,
      resultRequestId: null,
      sentence: "Read plan.md",
      turnId: 12,
    };
    data.steps.set(107, child);
    data.stepsByTurn.set(12, [...(data.stepsByTurn.get(12) ?? []), child]);
    data.stepsByBranch.set(32, [child]);
    const rows = buildRows(data, OPEN);
    expect(rows.map((row) => row.key)).toEqual([
      "turn-11",
      "step-101",
      "human-22",
      "step-102",
      "event-segment:41",
      "turn-12",
      "step-103",
      "step-105",
      "step-107",
      "step-106",
      "human-23",
      "step-104",
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // The nested subagent's row stands in its starting step's
    // place, one level deeper than its parent's steps, and
    // its own steps sit one deeper still.
    expect(byKey.get("step-105")).toMatchObject({
      kind: "branch",
      branchId: 32,
      depth: 2,
      spawningStepId: 105,
    });
    expect(byKey.get("step-107")).toMatchObject({ kind: "step", depth: 3 });
    expect(byKey.get("step-106")).toMatchObject({ kind: "step", depth: 2 });
    // Sibling counts stay within each level: the nested row
    // counts with the parent's steps, its step alone.
    const counts = (key: string) => {
      const row = byKey.get(key);
      return row === undefined ? null : [row.posInSet, row.setSize];
    };
    expect(counts("step-105")).toEqual([1, 2]);
    expect(counts("step-106")).toEqual([2, 2]);
    expect(counts("step-107")).toEqual([1, 1]);
  });
});
