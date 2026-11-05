import { describe, expect, it } from "vitest";

import {
  areaPoints,
  curveScale,
  curveTicks,
  linePoints,
  nearestTick,
  scaleMaxFor,
  selectedContext,
  timeAtX,
  xFor,
  yFor,
} from "../src/session/curve-math.js";
import type { SessionEvent } from "@flightpath/flightpath/api/payloads";

import type { HumanRow, StepRow } from "../src/session/types.js";

function step(partial: Partial<StepRow>): StepRow {
  return {
    id: 1,
    toolName: "Read",
    outcome: "succeeded",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    branchId: null,
    resultRequestId: null,
    sentence: "Read a file",
    turnId: 11,
    ...partial,
  };
}

function human(partial: Partial<HumanRow>): HumanRow {
  return {
    id: 1,
    kind: "prompt",
    occurredAt: 0,
    sentence: "You asked: hi",
    turnId: 11,
    ...partial,
  };
}

describe("the curve's scale", () => {
  it("rounds the top of the scale up to a round number", () => {
    expect(scaleMaxFor(0)).toBe(1000);
    expect(scaleMaxFor(9500)).toBe(10000);
    expect(scaleMaxFor(10001)).toBe(12500);
    expect(scaleMaxFor(55000)).toBe(80000);
    expect(scaleMaxFor(210000)).toBe(250000);
    expect(scaleMaxFor(999999)).toBe(1000000);
  });

  it("scales to the peak alone, so a small session on a big window fills the strip", () => {
    const scale = curveScale([{ at: 1000, contextTokens: 82_000 }]);
    expect(scale.scaleMax).toBe(100_000);
    // The peak stands at 82% of the plot's height, not at
    // 8% of a scale raised to a 1M limit.
    expect(yFor(scale, 82_000)).toBeLessThan(15);
  });

  it("maps time and context into the box, and back", () => {
    const scale = curveScale([
      { at: 1000, contextTokens: 9000 },
      { at: 11000, contextTokens: 20000 },
    ]);
    expect(scale).toEqual({
      startAt: 1000,
      span: 10000,
      scaleMax: 20000,
      box: { left: 0, right: 1000, top: 3, bottom: 57 },
    });
    expect(xFor(scale, 1000)).toBe(0);
    expect(xFor(scale, 11000)).toBe(1000);
    expect(yFor(scale, 0)).toBe(57);
    expect(yFor(scale, 20000)).toBe(3);
    expect(timeAtX(scale, 0.5)).toBe(6000);
  });

  it("reads a step's context from the samples at or before it", () => {
    const samples = [
      { at: 1000, contextTokens: 9000 },
      { at: 3000, contextTokens: 20000 },
    ];
    expect(selectedContext(samples, step({ startedAt: 2500 }))).toBe(9000);
    expect(selectedContext(samples, step({ startedAt: 500 }))).toBeNull();
    expect(selectedContext(samples, null)).toBeNull();
  });
});

describe("the curve of one request", () => {
  const only = [{ at: 5_000, contextTokens: 40_000 }];

  it("draws a flat line across the strip at the request's level", () => {
    const scale = curveScale(only);
    const y = yFor(scale, 40_000).toFixed(1);
    expect(linePoints(only, scale)).toBe(`0,${y} 1000,${y}`);
  });

  it("fills under the level, not down to zero at the right edge", () => {
    const scale = curveScale(only);
    const y = yFor(scale, 40_000).toFixed(1);
    expect(areaPoints(only, scale)).toBe(`0,60 0,${y} 1000,${y} 1000,60`);
  });

  it("draws two or more requests as before", () => {
    const pair = [...only, { at: 9_000, contextTokens: 10_000 }];
    const scale = curveScale(pair);
    expect(linePoints(pair, scale).split(" ")).toHaveLength(2);
    expect(linePoints(pair, scale).startsWith("0.0,")).toBe(true);
  });
});

describe("curve ticks", () => {
  it("marks human moments and failures", () => {
    const ticks = curveTicks(
      [step({ outcome: "failed", startedAt: 1500, sentence: "Edited a file" })],
      [
        human({ id: 1, kind: "prompt", occurredAt: 100 }),
        human({
          id: 2,
          kind: "permission_decision",
          occurredAt: 1200,
          sentence: "You approved this step",
        }),
      ],
      [],
    );
    expect(ticks.map((tick) => tick.kind)).toEqual(["human", "failure"]);
    expect(ticks.every((tick) => tick.label.length > 0)).toBe(true);
  });

  it("marks a compaction only where one was recorded", () => {
    // Only a recorded compaction draws a tick, and it draws
    // it at its own moment.
    const events: SessionEvent[] = [
      {
        kind: "segment",
        id: 1,
        at: 0,
        sentence: "Session started",
        segmentKind: "startup",
      },
      {
        kind: "segment",
        id: 2,
        at: 2000,
        sentence: "Context was compacted",
        segmentKind: "compact",
      },
    ];
    const ticks = curveTicks([], [], events);
    expect(ticks).toEqual([
      {
        kind: "compaction",
        at: 2000,
        label: "Compacted the conversation",
        stepId: null,
      },
    ]);
    expect(curveTicks([], [], events.slice(0, 1))).toEqual([]);
  });
});

describe("the curve's tick targets", () => {
  it("marks a failure tick with the step it stands for", () => {
    const ticks = curveTicks(
      [step({ id: 7, outcome: "failed", startedAt: 2000 })],
      [],
      [],
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.stepId).toBe(7);
  });

  it("picks the nearest tick where ticks stand close together", () => {
    const ticks = curveTicks(
      [
        step({ id: 1, outcome: "failed", startedAt: 3000 }),
        step({ id: 2, outcome: "failed", startedAt: 3400 }),
        step({ id: 3, outcome: "failed", startedAt: 3800 }),
      ],
      [],
      [],
    );
    expect(nearestTick(ticks, 3450)?.stepId).toBe(2);
    expect(nearestTick(ticks, 3050)?.stepId).toBe(1);
    expect(nearestTick(ticks, 3900)?.stepId).toBe(3);
    expect(nearestTick([], 1000)).toBeNull();
  });
});
