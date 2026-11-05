// The tokens curve's geometry and reductions, kept pure so
// they are testable without a browser: the scales, the time
// labels' boxes, the drawn set, the idle gaps, and the step
// each point stands for.

import type {
  Drop,
  Rebuild,
  Rise,
  Room,
  TokenPoint,
} from "@flightpath/flightpath/api/payloads";

import { momentAtX, plotScale, type CurveScale } from "./curve-math.js";
import type { StepRow } from "./types.js";

export const TOKENS_CURVE_WIDTH = 1_000;
export const TOKENS_CURVE_HEIGHT = 220;

/** The plot's box inside the viewBox: the left margin holds
 * the axis labels, the bottom strip the time labels, and the
 * top leaves room for the limit's label above its line. */
export const PLOT_LEFT = 96;
export const PLOT_RIGHT = 992;
export const PLOT_TOP = 16;
export const PLOT_BOTTOM = 200;

/** The label layout numbers, each named once beside the
 * plot's box: the time labels' half-width (the measure
 * their boxes are kept apart by), an idle band's least
 * labelled width, the idle and compaction labels'
 * half-widths (the clamp measure for a centred label),
 * the tooltip's width, and the base label's band, offset
 * and floor measures. */
const TIME_LABEL_HALF_WIDTH = 30;
export const IDLE_LABEL_MIN_WIDTH = 70;
export const IDLE_LABEL_HALF_WIDTH = 40;
export const COMPACTION_LABEL_HALF_WIDTH = 32;
export const TOOLTIP_WIDTH = 260;
export const BASE_LABEL_MIN_BAND_HEIGHT = 26;
export const BASE_LABEL_TOP_OFFSET = 14;
export const BASE_LABEL_FLOOR_GAP = 10;

/** The compaction label's lift above the point its drop
 * landed on: a label's height and a clear gap over the
 * lowered line and the base label at the floor. */
export const COMPACTION_LABEL_LIFT = 24;

/** A compaction label's height in plot units; fixed because the frame's height is. */
export const COMPACTION_LABEL_HEIGHT = 16;

/** The buckets a long series is drawn through: at two points
 * a bucket (its lowest and its highest), a 20,000-point series
 * draws under the test's 2,000-point bound. */
const DRAW_BUCKETS = 800;

const DOWNSAMPLE_OVER = 1_000;

/** The drawn points carry a dot only when there are few
 * enough that the dots read as points, not as a texture. */
export const POINT_DOTS_UP_TO = 150;

/** A mark this far above the peak, as a multiple of it, still
 * stands on the plot; a mark further out would flatten the
 * curve against the floor, so it is named above the chart
 * instead of drawn. */
const MARK_REACH = 1.5;

/** Whether a mark stands on the plot beside a peak: at or
 * below the reach, drawn; above it, named instead. */
function markOnChart(tokens: number, peak: number): boolean {
  return tokens <= peak * MARK_REACH;
}

interface AboveMark {
  kind: "limit" | "auto-compact";
  tokens: number;
}

export interface ChartMarks {
  /** The limit's line position, or null when it stands above the chart. */
  limit: number | null;
  /** The auto-compact point's line position, or null as above. */
  autoCompact: number | null;
  /** The marks above the chart, in the order the note names them. */
  above: AboveMark[];
}

/** Where the room's marks stand beside the session's peak:
 * each either drawn on the plot or named above it. */
export function chartMarks(room: Room, peak: number): ChartMarks {
  const autoCompact = room.autoCompact?.tokens ?? null;
  const limit = room.window.tokens;
  const above: AboveMark[] = [];
  if (autoCompact !== null && !markOnChart(autoCompact, peak)) {
    above.push({ kind: "auto-compact", tokens: autoCompact });
  }
  if (limit !== null && !markOnChart(limit, peak)) {
    above.push({ kind: "limit", tokens: limit });
  }
  return {
    limit: limit !== null && markOnChart(limit, peak) ? limit : null,
    autoCompact:
      autoCompact !== null && markOnChart(autoCompact, peak)
        ? autoCompact
        : null,
    above,
  };
}

/** The scale: the smallest round top that holds the peak
 * point and every mark chartMarks drew beside it — its
 * decision taken as given, so the two can never disagree.
 * The box follows the frame's measured width. */
export function tokensScale(
  points: TokenPoint[],
  marks: ChartMarks,
  width: number = TOKENS_CURVE_WIDTH,
): CurveScale {
  const first = points[0];
  const last = points[points.length - 1];
  const peak = points.reduce((max, point) => Math.max(max, point.tokens), 0);
  const drawn = [marks.limit, marks.autoCompact].filter(
    (mark): mark is number => mark !== null,
  );
  return plotScale(
    first?.at ?? 0,
    (last?.at ?? 0) - (first?.at ?? 0),
    Math.max(peak, ...drawn),
    {
      left: PLOT_LEFT,
      right: width - (TOKENS_CURVE_WIDTH - PLOT_RIGHT),
      top: PLOT_TOP,
      bottom: PLOT_BOTTOM,
    },
  );
}

/** A time label's anchor on its point: the first label
 * stands on the plot's left edge, the last on its right. */
export type TimeLabelAnchor = "start" | "middle" | "end";

/** A time label's box, in plot units. */
export interface TimeLabelBox {
  x: number;
  left: number;
  right: number;
}

/** A time label's box, from its anchor, its point's x and
 * the plot's box: a centred label reaches half a width each
 * way; an edge label a full width inward, its x the edge. */
export function timeLabelBox(
  anchor: TimeLabelAnchor,
  pointX: number,
  box: { left: number; right: number },
): TimeLabelBox {
  let x = pointX;
  if (anchor === "start") x = box.left;
  if (anchor === "end") x = box.right;
  const reach =
    anchor === "middle" ? TIME_LABEL_HALF_WIDTH : 2 * TIME_LABEL_HALF_WIDTH;
  return {
    x,
    left: anchor === "start" ? x : x - reach,
    right: anchor === "end" ? x : x + reach,
  };
}

/** The line's tokens at a moment between two points,
 * interpolated; 0 when the moment stands outside the
 * series, where the span's own points speak for it. */
function tokensAtMoment(points: TokenPoint[], at: number): number {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined) continue;
    if (at < point.at || at > next.at || next.at === point.at) continue;
    return (
      point.tokens +
      ((next.tokens - point.tokens) * (at - point.at)) / (next.at - point.at)
    );
  }
  return 0;
}

/** The drawn line's level under a span of the plot: the
 * highest of its points between the span's edges, with the
 * line read at each edge itself — a label's level comes
 * from the data under its whole box, not from one point. */
export function lineLevelUnderSpan(
  points: TokenPoint[],
  scale: CurveScale,
  left: number,
  right: number,
): number {
  const from = momentAtX(scale, left);
  const to = momentAtX(scale, right);
  let level = Math.max(
    tokensAtMoment(points, from),
    tokensAtMoment(points, to),
  );
  for (const point of points) {
    if (point.at >= from && point.at <= to) {
      level = Math.max(level, point.tokens);
    }
  }
  return level;
}

/** The main scale for one history at one frame width: the
 * marks beside the points' peak, and the scale they shape. */
export function mainScale(
  points: TokenPoint[],
  room: Room,
  width: number = TOKENS_CURVE_WIDTH,
): { scale: CurveScale; marks: ChartMarks } {
  const peak = points.reduce((max, point) => Math.max(max, point.tokens), 0);
  const marks = chartMarks(room, peak);
  return { scale: tokensScale(points, marks, width), marks };
}

export function nearestPointIndex(points: TokenPoint[], at: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((points[mid]?.at ?? 0) < at) low = mid + 1;
    else high = mid;
  }
  const after = points[low];
  const before = points[low - 1];
  if (before === undefined || after === undefined) return low;
  return at - before.at <= after.at - at ? low - 1 : low;
}

const LIFETIME_MS: Record<"5m" | "1h", number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

export interface IdleGap {
  from: TokenPoint;
  to: TokenPoint;
  minutes: number;
}

/** The gaps worth shading: between consecutive points, a
 * silence longer than the earlier point's cache lifetime.
 * A point with no lifetime recorded judges nothing. */
export function idleGaps(points: TokenPoint[]): IdleGap[] {
  const gaps: IdleGap[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from === undefined || to === undefined) continue;
    if (from.cacheLifetime === null) continue;
    const gap = to.at - from.at;
    if (gap <= LIFETIME_MS[from.cacheLifetime]) continue;
    gaps.push({ from, to, minutes: Math.round(gap / 60_000) });
  }
  return gaps;
}

/** The step each point stands for, by index: the main-thread
 * step whose result the point's request first carried — the
 * link the daemon records on the step — or null when no
 * step's result landed at that point. Several steps can land
 * in one request; the point stands for the one that ended
 * last. The link, not the clock, decides. */
export function stepIdsForPoints(
  points: TokenPoint[],
  steps: Iterable<StepRow>,
): (number | null)[] {
  const landed = new Map<number, StepRow>();
  for (const step of steps) {
    if (step.branchId !== null || step.resultRequestId === null) continue;
    const held = landed.get(step.resultRequestId);
    if (held === undefined || endsLater(step, held)) {
      landed.set(step.resultRequestId, step);
    }
  }
  return points.map((point) => landed.get(point.requestId)?.id ?? null);
}

function endsLater(a: StepRow, b: StepRow): boolean {
  const ended = (a.endedAt ?? 0) - (b.endedAt ?? 0);
  if (ended !== 0) return ended > 0;
  const started = (a.startedAt ?? 0) - (b.startedAt ?? 0);
  if (started !== 0) return started > 0;
  return a.id > b.id;
}

/** The points the curve draws. A series of at most a thousand
 * points draws whole. A longer one draws, per pixel bucket,
 * its lowest and highest points — and always every point the
 * payload's own rises and drops start or end on, and every
 * rebuild point, so no event the lens marks is smoothed
 * away. The cursor never reads from this set: it reads the
 * real points. */
export function downsamplePoints(
  points: TokenPoint[],
  rebuilds: Rebuild[],
  rises: Rise[],
  drops: Drop[],
): TokenPoint[] {
  if (points.length <= DOWNSAMPLE_OVER) return points;
  const keep = new Set<number>([0, points.length - 1]);
  const indexByRequest = new Map(
    points.map((point, index) => [point.requestId, index]),
  );
  for (const edge of [...rises, ...drops]) {
    const from = indexByRequest.get(edge.fromRequestId);
    const to = indexByRequest.get(edge.toRequestId);
    if (from !== undefined) keep.add(from);
    if (to !== undefined) keep.add(to);
  }
  const rebuildIds = new Set(rebuilds.map((rebuild) => rebuild.requestId));
  points.forEach((point, index) => {
    if (rebuildIds.has(point.requestId)) keep.add(index);
  });
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return points;
  const span = Math.max(1, last.at - first.at);
  const buckets = new Map<number, { low: number; high: number }>();
  points.forEach((point, index) => {
    const bucket = Math.min(
      DRAW_BUCKETS - 1,
      Math.floor(((point.at - first.at) / span) * DRAW_BUCKETS),
    );
    const cell = buckets.get(bucket);
    if (cell === undefined) {
      buckets.set(bucket, { low: index, high: index });
      return;
    }
    if (point.tokens < (points[cell.low]?.tokens ?? 0)) cell.low = index;
    if (point.tokens > (points[cell.high]?.tokens ?? 0)) cell.high = index;
  });
  for (const cell of buckets.values()) {
    keep.add(cell.low);
    keep.add(cell.high);
  }
  return [...keep]
    .sort((a, b) => a - b)
    .map((index) => points[index])
    .filter((point) => point !== undefined);
}
