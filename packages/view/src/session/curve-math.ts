// The context curve's geometry, kept pure so it is testable
// without a browser: the scale, the point positions, the
// ticks, and the step a click or a position stands for.

import { contextAt, nearestInTime } from "./rows.js";
import type {
  ContextPoint,
  SessionEvent,
} from "@flightpath/flightpath/api/payloads";

import type { HumanRow, StepRow } from "./types.js";

export const CURVE_WIDTH = 1_000;
export const CURVE_HEIGHT = 60;

/** Half the width of a tick's click target, in screen
 * pixels: a click this close to a tick picks the tick. */
export const TICK_HALF_WIDTH_PX = 12;

const PLOT_TOP = 3;
const PLOT_HEIGHT = 54;

/** The smallest round scale that holds the peak, so the line reads to scale. */
export function scaleMaxFor(peak: number): number {
  if (peak <= 0) return 1_000;
  const steps = [1, 1.25, 2, 2.5, 4, 5, 8, 10];
  let magnitude = 10;
  while (magnitude < peak) {
    magnitude *= 10;
  }
  for (const step of steps) {
    const candidate = (magnitude / 10) * step;
    if (candidate >= peak) return candidate;
  }
  return magnitude;
}

/** The plot's box inside the viewBox, in its units: the
 * scales map time and tokens into it, each curve with its
 * own margins. */
export interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CurveScale {
  startAt: number;
  span: number;
  scaleMax: number;
  box: PlotBox;
}

const CONTEXT_BOX: PlotBox = {
  left: 0,
  right: CURVE_WIDTH,
  top: PLOT_TOP,
  bottom: PLOT_TOP + PLOT_HEIGHT,
};

/** A scale over a span of time: the smallest round top that
 * holds the peak, drawn inside the given box. */
export function plotScale(
  startAt: number,
  span: number,
  peak: number,
  box: PlotBox,
): CurveScale {
  return {
    startAt,
    span: Math.max(1, span),
    scaleMax: scaleMaxFor(peak),
    box,
  };
}

/** The scale follows the session's peak, so a session far
 * under its window doesn't draw as a flat line. */
export function curveScale(samples: ContextPoint[]): CurveScale {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const peak = samples.reduce(
    (max, sample) => Math.max(max, sample.contextTokens),
    0,
  );
  return plotScale(
    first?.at ?? 0,
    (last?.at ?? 0) - (first?.at ?? 0),
    peak,
    CONTEXT_BOX,
  );
}

export function xFor(scale: CurveScale, at: number): number {
  const { left, right } = scale.box;
  return left + ((at - scale.startAt) / scale.span) * (right - left);
}

/** The moment a position across the plot stands for:
 * xFor read backwards. */
export function momentAtX(scale: CurveScale, x: number): number {
  const { left, right } = scale.box;
  return scale.startAt + ((x - left) / (right - left)) * scale.span;
}

export function yFor(scale: CurveScale, tokens: number): number {
  const { top, bottom } = scale.box;
  return top + (1 - tokens / scale.scaleMax) * (bottom - top);
}

/** The time a position across the curve stands for. */
export function timeAtX(scale: CurveScale, fraction: number): number {
  return scale.startAt + fraction * scale.span;
}

/** One request is one level: a flat line across the strip,
 * not a point that the area under it would slope away from. */
function levelPoints(sample: ContextPoint, scale: CurveScale): string {
  const y = yFor(scale, sample.contextTokens).toFixed(1);
  return `${scale.box.left},${y} ${scale.box.right},${y}`;
}

export function linePoints(samples: ContextPoint[], scale: CurveScale): string {
  const only = samples.length === 1 ? samples[0] : undefined;
  if (only !== undefined) return levelPoints(only, scale);
  return samples
    .map(
      (sample) =>
        `${xFor(scale, sample.at).toFixed(1)},${yFor(scale, sample.contextTokens).toFixed(1)}`,
    )
    .join(" ");
}

export function areaPoints(samples: ContextPoint[], scale: CurveScale): string {
  if (samples.length === 0) return "";
  const bottom = CURVE_HEIGHT;
  return `0,${bottom} ${linePoints(samples, scale)} ${CURVE_WIDTH},${bottom}`;
}

type TickKind = "human" | "failure" | "compaction";

export interface CurveTick {
  kind: TickKind;
  at: number;
  label: string;
  /** The step the tick stands for, when the tick is a step's own mark. */
  stepId: number | null;
}

export function curveTicks(
  steps: StepRow[],
  humans: HumanRow[],
  events: SessionEvent[],
): CurveTick[] {
  const ticks: CurveTick[] = [];
  for (const human of humans) {
    if (human.kind === "prompt") continue;
    ticks.push({
      kind: "human",
      at: human.occurredAt,
      label: human.sentence,
      stepId: null,
    });
  }
  for (const step of steps) {
    if (step.outcome === "failed" && step.startedAt !== null) {
      ticks.push({
        kind: "failure",
        at: step.startedAt,
        label: step.sentence,
        stepId: step.id,
      });
    }
  }
  // A compaction tick stands where a compaction was recorded,
  // never where the line merely falls: a fall can be another
  // thread's smaller context, which is no compaction.
  for (const event of events) {
    if (event.segmentKind === "compact") {
      ticks.push({
        kind: "compaction",
        at: event.at,
        label: "Compacted the conversation",
        stepId: null,
      });
    }
  }
  return ticks.sort((a, b) => a.at - b.at);
}

/** The tick nearest in time to `at`: where ticks stand
 * closer together than a click can separate, the nearest
 * one is the click's target. */
export function nearestTick(ticks: CurveTick[], at: number): CurveTick | null {
  return nearestInTime(ticks, at, (tick) => tick.at);
}

/** The context a step stood in: the last sample at or before it started. */
export function selectedContext(
  samples: ContextPoint[],
  step: StepRow | null,
): number | null {
  if (step === null || step.startedAt === null) return null;
  return contextAt(samples, step.startedAt);
}
