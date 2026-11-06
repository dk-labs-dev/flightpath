import { describe, expect, it } from "vitest";

import type {
  Drop,
  Rebuild,
  Rise,
  Room,
  TokenPoint,
} from "@flightpath/flightpath/api/payloads";

import { xFor } from "../src/session/curve-math.js";
import {
  chartMarks,
  downsamplePoints,
  idleGaps,
  lineLevelUnderSpan,
  PLOT_LEFT,
  PLOT_RIGHT,
  stepIdsForPoints,
  timeLabelBox,
  tokensScale,
} from "../src/session/tokens-curve-math.js";
import type { StepRow } from "../src/session/types.js";

// The curve's math: which points a long session draws,
// where the session sat idle past its cache's lifetime, and
// which step each point stands for. All pure — the lens's
// drawing and its click both read from these.

const MINUTE = 60_000;

function point(
  requestId: number,
  at: number,
  tokens: number,
  cacheLifetime: TokenPoint["cacheLifetime"] = "5m",
): TokenPoint {
  return { requestId, at, tokens, turnId: null, cacheLifetime };
}

function step(overrides: Partial<StepRow>): StepRow {
  return {
    id: 1,
    toolName: "Read",
    outcome: "succeeded",
    startedAt: 0,
    endedAt: null,
    durationMs: null,
    branchId: null,
    resultRequestId: null,
    sentence: "",
    turnId: null,
    ...overrides,
  };
}

describe("tokensScale", () => {
  it("spans the points' times and covers the marks chartMarks drew", () => {
    const points = [point(1, 1_000, 10_000), point(2, 61_000, 40_000)];
    const scale = tokensScale(points, {
      limit: 50_000,
      autoCompact: null,
      above: [],
    });
    expect(scale.startAt).toBe(1_000);
    expect(scale.span).toBe(60_000);
    expect(scale.scaleMax).toBeGreaterThanOrEqual(50_000);
  });

  it("leaves a mark chartMarks named above the chart off the scale", () => {
    const points = [point(1, 1_000, 10_000), point(2, 61_000, 40_000)];
    const withMark = tokensScale(points, {
      limit: null,
      autoCompact: null,
      above: [{ kind: "limit", tokens: 200_000 }],
    });
    const peakOnly = tokensScale(points, {
      limit: null,
      autoCompact: null,
      above: [],
    });
    expect(withMark.scaleMax).toBe(peakOnly.scaleMax);
    expect(withMark.scaleMax).toBeLessThan(200_000);
  });

  it("gives a single point a span to draw on", () => {
    const scale = tokensScale([point(1, 5_000, 10_000)], {
      limit: null,
      autoCompact: null,
      above: [],
    });
    expect(scale.span).toBeGreaterThan(0);
    expect(scale.scaleMax).toBeGreaterThan(0);
  });
});

describe("timeLabelBox", () => {
  const plot = { left: PLOT_LEFT, right: PLOT_RIGHT };

  it("centres a middle label on its point, half a width each way", () => {
    expect(timeLabelBox("middle", 400, plot)).toEqual({
      x: 400,
      left: 370,
      right: 430,
    });
  });

  it("stands a start label on the left edge, a full width inward", () => {
    expect(timeLabelBox("start", 130, plot)).toEqual({
      x: PLOT_LEFT,
      left: PLOT_LEFT,
      right: PLOT_LEFT + 60,
    });
  });

  it("stands an end label on the right edge, a full width inward", () => {
    expect(timeLabelBox("end", 900, plot)).toEqual({
      x: PLOT_RIGHT,
      left: PLOT_RIGHT - 60,
      right: PLOT_RIGHT,
    });
  });
});

describe("chartMarks", () => {
  const room = (limit: number, autoCompact: number | null): Room => ({
    window: { tokens: limit, source: "model-list", reportedAt: null },
    autoCompact:
      autoCompact === null
        ? null
        : { tokens: autoCompact, source: "model-default" },
    toLimit: null,
    toAutoCompact: null,
    turnsLeft: null,
  });

  it("draws both marks beside a 150K peak under a 200K limit", () => {
    const marks = chartMarks(room(200_000, 193_000), 150_000);
    expect(marks.limit).toBe(200_000);
    expect(marks.autoCompact).toBe(193_000);
    expect(marks.above).toEqual([]);
  });

  it("names both marks above a 202K peak under a 1M limit", () => {
    const marks = chartMarks(room(1_000_000, 967_000), 202_000);
    expect(marks.limit).toBeNull();
    expect(marks.autoCompact).toBeNull();
    expect(marks.above).toEqual([
      { kind: "auto-compact", tokens: 967_000 },
      { kind: "limit", tokens: 1_000_000 },
    ]);
  });
});

describe("idleGaps", () => {
  it("finds a gap past a five-minute cache's lifetime", () => {
    const gaps = idleGaps([
      point(1, 0, 10_000),
      point(2, 10 * MINUTE, 12_000),
      point(3, 11 * MINUTE, 13_000),
    ]);
    expect(
      gaps.map((gap) => [gap.from.requestId, gap.to.requestId, gap.minutes]),
    ).toEqual([[1, 2, 10]]);
  });

  it("holds a one-hour cache to its own lifetime", () => {
    const gaps = idleGaps([
      point(1, 0, 10_000, "1h"),
      point(2, 30 * MINUTE, 12_000, "1h"),
      point(3, 100 * MINUTE, 13_000, "1h"),
    ]);
    expect(
      gaps.map((gap) => [gap.from.requestId, gap.to.requestId, gap.minutes]),
    ).toEqual([[2, 3, 70]]);
  });

  it("draws no gap when the lifetime is unknown", () => {
    expect(
      idleGaps([point(1, 0, 10_000, null), point(2, 600 * MINUTE, 1)]),
    ).toEqual([]);
  });
});

describe("stepIdsForPoints", () => {
  it("matches each point to the step its request first carried", () => {
    const steps = [
      step({ id: 5, startedAt: 900, endedAt: 1_500, resultRequestId: 2 }),
      step({ id: 6, startedAt: 1_600, endedAt: 2_500, resultRequestId: 3 }),
    ];
    const landed = stepIdsForPoints(
      [point(1, 1_000, 1), point(2, 2_000, 2), point(3, 3_000, 3)],
      steps,
    );
    expect(landed).toEqual([null, 5, 6]);
  });

  it("follows the link when it and the end time disagree", () => {
    const steps = [
      step({ id: 5, startedAt: 900, endedAt: 1_500, resultRequestId: 3 }),
      step({ id: 6, startedAt: 1_600, endedAt: 2_500, resultRequestId: 2 }),
    ];
    const landed = stepIdsForPoints(
      [point(1, 1_000, 1), point(2, 2_000, 2), point(3, 3_000, 3)],
      steps,
    );
    expect(landed).toEqual([null, 6, 5]);
  });

  it("takes the step that ended last when two land in one request", () => {
    const steps = [
      step({ id: 7, startedAt: 1_100, endedAt: 1_800, resultRequestId: 2 }),
      step({ id: 8, startedAt: 1_200, endedAt: 1_900, resultRequestId: 2 }),
    ];
    const landed = stepIdsForPoints(
      [point(1, 1_000, 1), point(2, 2_000, 2)],
      steps,
    );
    expect(landed).toEqual([null, 8]);
  });

  it("leaves branch steps and steps no request carried out", () => {
    const steps = [
      step({
        id: 9,
        startedAt: 100,
        endedAt: 1_500,
        branchId: 3,
        resultRequestId: 2,
      }),
      step({ id: 10, startedAt: 100, endedAt: null }),
    ];
    const landed = stepIdsForPoints(
      [point(1, 1_000, 1), point(2, 2_000, 2)],
      steps,
    );
    expect(landed).toEqual([null, null]);
  });

  it("lets the first point stand for a step", () => {
    const steps = [
      step({ id: 11, startedAt: 100, endedAt: 900, resultRequestId: 1 }),
    ];
    const landed = stepIdsForPoints(
      [point(1, 1_000, 1), point(2, 2_000, 2)],
      steps,
    );
    expect(landed).toEqual([11, null]);
  });
});

/** A 20,000-point series, flat but for ten planted
 * features — a rise onto a high point, a drop off it, and
 * the climb back, each named by the payload's own rises
 * and drops as the daemon's history names them — and ten
 * rebuilds on flat points of their own, clear of the
 * features and of their buckets' extremes. */
function plantedLongSeries(): {
  points: TokenPoint[];
  rebuilds: Rebuild[];
  rises: Rise[];
  drops: Drop[];
} {
  const points: TokenPoint[] = [];
  for (let i = 0; i < 20_000; i += 1) {
    points.push(point(i + 1, i * 1_000, 50_000));
  }
  const rebuilds: Rebuild[] = [];
  const rises: Rise[] = [];
  const drops: Drop[] = [];
  for (let k = 0; k < 10; k += 1) {
    const rise = 2_000 * k + 1_000;
    const landing = rise + 1;
    const risePoint = points[rise];
    const landingPoint = points[landing];
    if (risePoint === undefined || landingPoint === undefined) continue;
    risePoint.tokens = 90_000;
    landingPoint.tokens = 20_000;
    const before = points[rise - 1];
    const after = points[landing + 1];
    if (before === undefined || after === undefined) continue;
    rises.push({
      id: `rise-${k}`,
      fromRequestId: before.requestId,
      toRequestId: risePoint.requestId,
      at: risePoint.at,
      delta: 40_000,
      link: "exact",
      items: [],
    });
    drops.push({
      id: `drop-${k}`,
      fromRequestId: risePoint.requestId,
      toRequestId: landingPoint.requestId,
      at: landingPoint.at,
      before: 90_000,
      after: 20_000,
      cause: "unknown",
      segmentId: null,
    });
    rises.push({
      id: `rise-back-${k}`,
      fromRequestId: landingPoint.requestId,
      toRequestId: after.requestId,
      at: after.at,
      delta: 30_000,
      link: "exact",
      items: [],
    });
  }
  for (let k = 0; k < 10; k += 1) {
    const flat = points[1_513 + 2_000 * k];
    if (flat === undefined) continue;
    rebuilds.push({
      id: `rebuild-${k}`,
      requestId: flat.requestId,
      at: flat.at,
      written: 20_000,
      context: 50_000,
      cause: null,
    });
  }
  return { points, rebuilds, rises, drops };
}

describe("downsamplePoints", () => {
  it("keeps a short session whole", () => {
    const points = [point(1, 0, 5), point(2, 1_000, 6), point(3, 2_000, 7)];
    expect(downsamplePoints(points, [], [], [])).toEqual(points);
  });

  it("keeps every rise, drop and rebuild in a 20,000-point session", () => {
    const { points, rebuilds, rises, drops } = plantedLongSeries();
    const drawn = downsamplePoints(points, rebuilds, rises, drops);
    expect(drawn.length).toBeLessThanOrEqual(2_000);
    const drawnIds = new Set(drawn.map((p) => p.requestId));
    for (const planted of points) {
      if (planted.tokens !== 50_000) {
        expect(drawnIds.has(planted.requestId)).toBe(true);
      }
    }
    for (const rebuild of rebuilds) {
      expect(drawnIds.has(rebuild.requestId)).toBe(true);
    }
    // The rise's start and the drop's end ride along: the
    // points either side of each planted feature are kept.
    for (let k = 0; k < 10; k += 1) {
      const rise = 2_000 * k + 1_000;
      expect(drawnIds.has(rise)).toBe(true);
      expect(drawnIds.has(rise + 3)).toBe(true);
    }
  });

  it("leaves rises and drops the payload does not name to the buckets", () => {
    const points: TokenPoint[] = [];
    for (let i = 0; i < 8_000; i += 1) {
      points.push(point(i + 1, i * 1_000, 50_000));
    }
    // One bucket (indices 100–109) with a shape inside it:
    // a high point, and below it a rise the payload never
    // names — its two points are neither the bucket's low
    // nor its high, so only a re-derived rise could keep
    // them, and the drawn set does not re-derive.
    const shape: [number, number][] = [
      [100, 90_000],
      [101, 70_000],
      [102, 80_000],
    ];
    for (const [index, tokens] of shape) {
      const planted = points[index];
      if (planted !== undefined) planted.tokens = tokens;
    }
    const drawn = downsamplePoints(points, [], [], []);
    const drawnIds = new Set(drawn.map((p) => p.requestId));
    expect(drawnIds.has(101)).toBe(true);
    expect(drawnIds.has(102)).toBe(false);
    expect(drawnIds.has(103)).toBe(false);
  });
});

describe("lineLevelUnderSpan", () => {
  const points = [
    point(1, 0, 10_000),
    point(2, 10_000, 50_000),
    point(3, 20_000, 30_000),
    point(4, 30_000, 90_000),
  ];
  const scale = tokensScale(points, {
    limit: 100_000,
    autoCompact: null,
    above: [],
  });
  it("reads the highest point between the span's edges", () => {
    expect(
      lineLevelUnderSpan(
        points,
        scale,
        xFor(scale, 20_000),
        xFor(scale, 30_000),
      ),
    ).toBeCloseTo(90_000, 3);
  });

  it("reads the line at the span's edges, interpolated", () => {
    // No point inside the span stands above 30,000, but the
    // line crosses its right edge at 60,000, halfway up the
    // climb to the last point.
    expect(
      lineLevelUnderSpan(
        points,
        scale,
        xFor(scale, 15_000),
        xFor(scale, 25_000),
      ),
    ).toBeCloseTo(60_000, 3);
  });

  it("reads the edges when no point stands between them", () => {
    expect(
      lineLevelUnderSpan(
        points,
        scale,
        xFor(scale, 12_000),
        xFor(scale, 18_000),
      ),
    ).toBeCloseTo(46_000, 3);
  });
});
