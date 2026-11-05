// The tokens curve: one session's context over its main
// requests, drawn to the design's proportions — the base as
// a band, the limit and the auto-compact point as dashed
// lines, a hatched band where the session sat idle past its
// cache's lifetime, a diamond on each cache rebuild, and a
// tick where a compaction dropped the line. Moving over it
// reads the nearest point; a click, or the arrow keys with
// the curve focused, selects the step that point stands
// for, as the steps lens's curve selects its steps. The
// points are the daemon's own, reduced for drawing by the
// curve's math, never for reading.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { rebuildCauseText } from "@flightpath/flightpath/api/rebuild-cause";
import type {
  Drop,
  Rebuild,
  TokenHistory,
  TokenPoint,
} from "@flightpath/flightpath/api/payloads";
import { formatClock, formatTokens } from "@flightpath/flightpath/format";

import { momentAtX, xFor, yFor, type CurveScale } from "./curve-math.js";
import { nearestStepId } from "./rows.js";
import {
  BASE_LABEL_FLOOR_GAP,
  BASE_LABEL_MIN_BAND_HEIGHT,
  BASE_LABEL_TOP_OFFSET,
  COMPACTION_LABEL_HALF_WIDTH,
  COMPACTION_LABEL_HEIGHT,
  COMPACTION_LABEL_LIFT,
  downsamplePoints,
  IDLE_LABEL_HALF_WIDTH,
  IDLE_LABEL_MIN_WIDTH,
  idleGaps,
  lineLevelUnderSpan,
  mainScale,
  nearestPointIndex,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  POINT_DOTS_UP_TO,
  stepIdsForPoints,
  timeLabelBox,
  TOKENS_CURVE_HEIGHT,
  TOKENS_CURVE_WIDTH,
  TOOLTIP_WIDTH,
  type ChartMarks,
  type IdleGap,
  type TimeLabelAnchor,
} from "./tokens-curve-math.js";
import type { StepRow } from "./types.js";

/**
 * A rebuild in plain words with its cause, for the legend,
 * the marks' titles, and the cursor's note. The cause is
 * worded beside the payload types and shared with the
 * daemon, so every reader sees the same words.
 */
function rebuildLabel(rebuild: Rebuild): string {
  if (rebuild.cause?.kind === "compaction") {
    return `Cache rebuilt ${rebuildCauseText(rebuild.cause)}`;
  }
  return `Cache rebuilt: ${rebuildCauseText(rebuild.cause)}`;
}

/** How far a label shifts across the point it stands on,
 * by the edge of its text that stands there: a start label
 * begins at the point, an end label finishes there, and a
 * middle label centres on it. */
const ACROSS: Record<"start" | "middle" | "end", string> = {
  start: "0",
  middle: "-50%",
  end: "-100%",
};

/**
 * A label drawn as HTML over the curve: at phone width the
 * viewBox shrinks until SVG text is unreadable, while HTML
 * keeps its CSS size. Positioned in percent of the frame so
 * it tracks the drawing; the anchor says which edge of the
 * text stands on the point across, and the stand says where
 * the text stands against its line: above it, centred on
 * it, or below it.
 */
function CurveLabel({
  x,
  y,
  width,
  anchor,
  stand = "centre",
  className,
  children,
  ref,
}: {
  x: number;
  y: number;
  width: number;
  anchor: "start" | "middle" | "end";
  stand?: "above" | "centre" | "below";
  className: string;
  children: ReactNode;
  ref?: RefObject<HTMLSpanElement | null>;
}) {
  const across = ACROSS[anchor];
  let down = "-50%";
  if (stand === "above") down = "-100%";
  else if (stand === "below") down = "0";
  return (
    <span
      ref={ref}
      className={className}
      style={{
        left: `${(x / width) * 100}%`,
        top: `${(y / TOKENS_CURVE_HEIGHT) * 100}%`,
        transform: `translate(${across}, ${down})`,
      }}
    >
      {children}
    </span>
  );
}

/**
 * What the cursor says about its point: the time and token
 * count, plus the rebuild's cause when a rebuild landed at
 * the point and the idle minutes when the point ends a gap
 * — so the slider's spoken value carries what the eye
 * gets from the marks, not only the numbers.
 */
function cursorNote(
  point: TokenPoint,
  rebuild: Rebuild | undefined,
  gap: IdleGap | undefined,
): string {
  const parts = [`${formatClock(point.at)} · ${formatTokens(point.tokens)}`];
  if (rebuild !== undefined) parts.push(rebuildLabel(rebuild));
  if (gap !== undefined) parts.push(`idle ${gap.minutes} min`);
  return parts.join(" · ");
}

function GridLines({ scale }: { scale: CurveScale }) {
  const fractions = [0, 0.25, 0.5, 0.75, 1];
  return (
    <>
      {fractions.map((fraction) => {
        const y = yFor(scale, scale.scaleMax * fraction);
        return (
          <line
            key={fraction}
            x1={PLOT_LEFT}
            x2={scale.box.right}
            y1={y}
            y2={y}
            className="tokens-grid-line"
          />
        );
      })}
    </>
  );
}

function GridLabels({ scale, width }: { scale: CurveScale; width: number }) {
  const fractions = [0, 0.25, 0.5, 0.75, 1];
  return (
    <>
      {fractions.map((fraction) => {
        const tokens = scale.scaleMax * fraction;
        return (
          <CurveLabel
            key={fraction}
            x={PLOT_LEFT}
            y={yFor(scale, tokens) - 8}
            width={width}
            anchor="end"
            className="tokens-axis-label"
          >
            {formatTokens(tokens, { axis: true })}
          </CurveLabel>
        );
      })}
    </>
  );
}

function BaseBand({ scale, base }: { scale: CurveScale; base: TokenPoint }) {
  const top = yFor(scale, base.tokens);
  return (
    <rect
      x={PLOT_LEFT}
      y={top}
      width={scale.box.right - PLOT_LEFT}
      height={PLOT_BOTTOM - top}
      className="tokens-base-band"
    />
  );
}

/** Half a label's rendered width, read off the label before
 * it is first drawn and again whenever its box changes: a
 * web font swapping in, or a wider fallback font, resizes
 * the text with no change to `text`. Where nothing measures
 * it stays 0, which leaves the label centred on its point. */
function useLabelHalfWidth(ref: RefObject<HTMLSpanElement | null>): number {
  const [half, setHalf] = useState(0);
  useLayoutEffect(() => {
    const label = ref.current;
    if (label === null) return;
    const measure = (): void => {
      setHalf(label.getBoundingClientRect().width / 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [ref]);
  return half;
}

/** A centred label keeps its whole box inside the plot: its
 * centre never stands closer than half the label to either
 * edge, the left edge winning when the plot is narrower
 * than the label. */
function keepInPlot(x: number, scale: CurveScale, half: number): number {
  const { left, right } = scale.box;
  return Math.max(left + half, Math.min(x, right - half));
}

function BaseLabel({
  scale,
  width,
  base,
  points,
}: {
  scale: CurveScale;
  width: number;
  base: TokenPoint;
  points: TokenPoint[];
}) {
  const top = yFor(scale, base.tokens);
  const labelRef = useRef<HTMLSpanElement>(null);
  const half = useLabelHalfWidth(labelRef);
  // The label stands centred on the peak point: there the
  // line stands farthest from the floor, so the label in or
  // just above the band stays clear of the line where it
  // would cross it at the band's left, where the line still
  // hugs the base.
  const peak = points.reduce(
    (highest, point) => (point.tokens > highest.tokens ? point : highest),
    base,
  );
  const x = keepInPlot(xFor(scale, peak.at), scale, half);
  // A band too thin to hold its label: the label stands
  // just above the band instead, clear of the floor labels
  // below.
  if (PLOT_BOTTOM - top < BASE_LABEL_MIN_BAND_HEIGHT) {
    return (
      <CurveLabel
        x={x}
        y={top - 4}
        width={width}
        anchor="middle"
        stand="above"
        className="tokens-base-label"
        ref={labelRef}
      >
        base · {formatTokens(base.tokens)}
      </CurveLabel>
    );
  }
  // The label rides inside the band; a base small against
  // the scale would push it under the plot's floor, so it
  // stops clear of the floor and the time strip below.
  const labelY = Math.min(
    top + BASE_LABEL_TOP_OFFSET,
    PLOT_BOTTOM - BASE_LABEL_FLOOR_GAP,
  );
  return (
    <CurveLabel
      x={x}
      y={labelY}
      width={width}
      anchor="middle"
      className="tokens-base-label"
      ref={labelRef}
    >
      base · {formatTokens(base.tokens)}
    </CurveLabel>
  );
}

function LimitLines({
  scale,
  marks,
}: {
  scale: CurveScale;
  marks: ChartMarks;
}) {
  return (
    <>
      {marks.limit !== null && (
        <line
          x1={PLOT_LEFT}
          x2={scale.box.right}
          y1={yFor(scale, marks.limit)}
          y2={yFor(scale, marks.limit)}
          className="tokens-limit-line"
        />
      )}
      {marks.autoCompact !== null && (
        <line
          x1={PLOT_LEFT}
          x2={scale.box.right}
          y1={yFor(scale, marks.autoCompact)}
          y2={yFor(scale, marks.autoCompact)}
          className="tokens-autocompact-line"
        />
      )}
    </>
  );
}

function LimitLabels({
  scale,
  width,
  marks,
}: {
  scale: CurveScale;
  width: number;
  marks: ChartMarks;
}) {
  return (
    <>
      {marks.limit !== null && (
        <CurveLabel
          x={scale.box.right}
          y={yFor(scale, marks.limit) - 3}
          width={width}
          anchor="end"
          stand="above"
          className="tokens-limit-label"
        >
          limit · {formatTokens(marks.limit, { axis: true })}
        </CurveLabel>
      )}
      {marks.autoCompact !== null && (
        <CurveLabel
          x={scale.box.right}
          y={yFor(scale, marks.autoCompact) + 3}
          width={width}
          anchor="end"
          stand="below"
          className="tokens-autocompact-label"
        >
          auto-compact · {formatTokens(marks.autoCompact, { axis: true })}
        </CurveLabel>
      )}
    </>
  );
}

/** The marks that stand above the chart, named on one line
 * in a strip of its own above the plot, in the axis labels'
 * style: the reader still learns where they are, without
 * the curve flattening against the floor to reach them,
 * and the line never runs through the words. */
function AboveChartNote({ marks }: { marks: ChartMarks }) {
  if (marks.above.length === 0) return null;
  const names = marks.above.map((mark) =>
    mark.kind === "limit"
      ? `the limit at ${formatTokens(mark.tokens, { axis: true })}`
      : `auto-compact at ${formatTokens(mark.tokens, { axis: true })}`,
  );
  return (
    <p className="tokens-above-note">Above the chart: {names.join(", ")}</p>
  );
}

interface IdleSpan {
  gap: IdleGap;
  from: number;
  to: number;
}

/** Each gap's span on the time axis, worked out once: the
 * bands below and their labels both stand on the same span. */
function idleSpans(scale: CurveScale, gaps: IdleGap[]): IdleSpan[] {
  return gaps.map((gap) => ({
    gap,
    from: xFor(scale, gap.from.at),
    to: xFor(scale, gap.to.at),
  }));
}

function IdleBands({ scale, gaps }: { scale: CurveScale; gaps: IdleGap[] }) {
  return (
    <>
      {idleSpans(scale, gaps).map(({ gap, from, to }) => (
        <rect
          key={gap.from.requestId}
          x={from}
          y={PLOT_TOP}
          width={to - from}
          height={PLOT_BOTTOM - PLOT_TOP}
          fill="url(#tokens-idle-hatch)"
        >
          <title>idle {gap.minutes} min</title>
        </rect>
      ))}
    </>
  );
}

function IdleLabels({
  scale,
  width,
  gaps,
}: {
  scale: CurveScale;
  width: number;
  gaps: IdleGap[];
}) {
  return (
    <>
      {idleSpans(scale, gaps).map(({ gap, from, to }) => {
        if (to - from < IDLE_LABEL_MIN_WIDTH) return null;
        return (
          <CurveLabel
            key={gap.from.requestId}
            x={clampLabelX((from + to) / 2, scale, IDLE_LABEL_HALF_WIDTH)}
            y={PLOT_TOP + 14}
            width={width}
            anchor="middle"
            className="tokens-idle-label"
          >
            idle {gap.minutes} min
          </CurveLabel>
        );
      })}
    </>
  );
}

/** The history's compaction drops: the ticks on the
 * floor and their labels both stand on these. */
function compactionDrops(history: TokenHistory): TokenHistory["drops"] {
  return history.drops.filter((drop) => drop.cause === "compaction");
}

function CompactionTicks({
  scale,
  history,
}: {
  scale: CurveScale;
  history: TokenHistory;
}) {
  const drops = compactionDrops(history);
  return (
    <>
      {drops.map((drop) => {
        const x = xFor(scale, drop.at);
        return (
          <line
            key={drop.id}
            x1={x}
            x2={x}
            y1={PLOT_BOTTOM - 8}
            y2={PLOT_BOTTOM}
            className="tokens-compaction-tick"
          >
            <title>Compacted the conversation</title>
          </line>
        );
      })}
    </>
  );
}

/** A centred label keeps its whole box inside the frame:
 * its centre never stands closer than half the label to
 * the frame's edges, so its words are never cut at the
 * card's edge. */
function clampLabelX(x: number, scale: CurveScale, halfWidth: number): number {
  const frameRight = scale.box.right + (TOKENS_CURVE_WIDTH - PLOT_RIGHT);
  return Math.min(
    Math.max(x, PLOT_LEFT + halfWidth),
    Math.max(PLOT_LEFT + halfWidth, frameRight - halfWidth),
  );
}

/** Where a compaction's label stands: to the right of the
 * drop, clear of the fall, which arrives from the left,
 * lifted above the highest line under its span; over the
 * drop when that lift would leave the plot's top, with the
 * floor keeping the label's top inside the plot either way. */
function compactionLabelPlace(
  scale: CurveScale,
  drop: Drop,
  points: TokenPoint[],
  landing: TokenPoint | undefined,
  falling: TokenPoint | undefined,
): { x: number; y: number; anchor: "start" | "middle" } {
  const dropX = xFor(scale, drop.at);
  if (landing === undefined) {
    return {
      x: clampLabelX(dropX, scale, COMPACTION_LABEL_HALF_WIDTH),
      y: PLOT_BOTTOM - 12,
      anchor: "middle",
    };
  }
  const highest = PLOT_TOP + COMPACTION_LABEL_HEIGHT;
  const aboveLevel = (tokens: number): number =>
    Math.max(yFor(scale, tokens) - COMPACTION_LABEL_LIFT, highest);
  const frameRight = scale.box.right + (TOKENS_CURVE_WIDTH - PLOT_RIGHT);
  if (dropX + COMPACTION_LABEL_HALF_WIDTH * 2 <= frameRight) {
    const level = lineLevelUnderSpan(
      points,
      scale,
      dropX,
      dropX + COMPACTION_LABEL_HALF_WIDTH * 2,
    );
    const lifted = yFor(scale, level) - COMPACTION_LABEL_LIFT;
    if (lifted >= highest) {
      return { x: dropX, y: lifted, anchor: "start" };
    }
  }
  return {
    x: clampLabelX(dropX, scale, COMPACTION_LABEL_HALF_WIDTH),
    y: aboveLevel(falling?.tokens ?? landing.tokens),
    anchor: "middle",
  };
}

function CompactionLabels({
  scale,
  width,
  history,
}: {
  scale: CurveScale;
  width: number;
  history: TokenHistory;
}) {
  const drops = compactionDrops(history);
  const byRequest = new Map(
    history.main.map((point) => [point.requestId, point]),
  );
  return (
    <>
      {drops.map((drop) => {
        const place = compactionLabelPlace(
          scale,
          drop,
          history.main,
          byRequest.get(drop.toRequestId),
          byRequest.get(drop.fromRequestId),
        );
        return (
          <CurveLabel
            key={drop.id}
            x={place.x}
            y={place.y}
            width={width}
            anchor={place.anchor}
            stand="above"
            className="tokens-compaction-label"
          >
            compacted
          </CurveLabel>
        );
      })}
    </>
  );
}

function RebuildMarks({
  scale,
  history,
}: {
  scale: CurveScale;
  history: TokenHistory;
}) {
  const byRequest = new Map(
    history.main.map((point) => [point.requestId, point]),
  );
  return (
    <>
      {history.rebuilds.map((rebuild) => {
        const point = byRequest.get(rebuild.requestId);
        if (point === undefined) return null;
        const expected = rebuild.cause?.kind === "compaction";
        const size = expected ? 10 : 12;
        const x = xFor(scale, point.at);
        const y = yFor(scale, point.tokens);
        return (
          <g key={rebuild.id} role="img" aria-label={rebuildLabel(rebuild)}>
            <title>{rebuildLabel(rebuild)}</title>
            <rect
              x={x - size / 2}
              y={y - size / 2}
              width={size}
              height={size}
              transform={`rotate(45 ${x} ${y})`}
              className={
                expected ? "tokens-rebuild-expected" : "tokens-rebuild"
              }
            />
          </g>
        );
      })}
    </>
  );
}

function CursorMark({
  scale,
  point,
}: {
  scale: CurveScale;
  point: TokenPoint;
}) {
  const x = xFor(scale, point.at);
  const y = yFor(scale, point.tokens);
  return (
    <g>
      <line
        x1={x}
        x2={x}
        y1={PLOT_TOP}
        y2={PLOT_BOTTOM}
        className="tokens-cursor-line"
      />
      <circle cx={x} cy={y} r="5" className="tokens-cursor-dot" />
    </g>
  );
}

/** The cursor's note as HTML beside its point: the same
 * words the slider speaks, flipped to the point's left when
 * they would run past the plot's right edge. */
function CursorTooltip({
  scale,
  width,
  point,
  note,
}: {
  scale: CurveScale;
  width: number;
  point: TokenPoint;
  note: string;
}) {
  const x = xFor(scale, point.at);
  const y = yFor(scale, point.tokens);
  const flip = x + 10 + TOOLTIP_WIDTH > scale.box.right;
  const left = flip ? x - 10 : x + 10;
  const top = Math.max(PLOT_TOP, y - 42);
  return (
    <div
      className="tokens-tooltip"
      style={
        {
          left: `${(left / width) * 100}%`,
          top: `${(top / TOKENS_CURVE_HEIGHT) * 100}%`,
          transform: `translate(${flip ? "-100%" : "0"}, 0)`,
          "--tokens-tooltip-width": `${TOOLTIP_WIDTH}px`,
        } as CSSProperties
      }
    >
      {note}
    </div>
  );
}

function labelAnchor(index: number, count: number): TimeLabelAnchor {
  if (index === 0) return "start";
  if (index === count - 1) return "end";
  return "middle";
}

function TimeLabels({
  scale,
  width,
  points,
}: {
  scale: CurveScale;
  width: number;
  points: TokenPoint[];
}) {
  const picks = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    Math.round(fraction * (points.length - 1)),
  );
  const shown = [...new Set(picks)];
  // Drop a pick that repeats the label before it, or
  // whose box runs into the kept box before it. The last
  // pick always stands, replacing the label it crowds.
  const candidates = shown.flatMap((index) => {
    const point = points[index];
    if (point === undefined) return [];
    const anchor = labelAnchor(index, points.length);
    const box = timeLabelBox(anchor, xFor(scale, point.at), scale.box);
    return [{ point, text: formatClock(point.at), anchor, ...box }];
  });
  const kept: typeof candidates = [];
  for (const candidate of candidates) {
    const before = kept[kept.length - 1];
    if (before === undefined) {
      kept.push(candidate);
      continue;
    }
    if (candidate.text === before.text) continue;
    if (candidate.left >= before.right) {
      kept.push(candidate);
      continue;
    }
    if (candidate === candidates[candidates.length - 1]) {
      kept[kept.length - 1] = candidate;
    }
  }
  return (
    <>
      {kept.map(({ point, text, anchor, x }) => (
        <CurveLabel
          key={point.requestId}
          x={x}
          y={TOKENS_CURVE_HEIGHT - 4}
          width={width}
          anchor={anchor}
          stand="above"
          className="tokens-axis-label"
        >
          {text}
        </CurveLabel>
      ))}
    </>
  );
}

/** The legend under the curve: only the marks this session
 * actually carries, so no key explains an absent mark. */
function Legend({ history, gaps }: { history: TokenHistory; gaps: IdleGap[] }) {
  const expected = history.rebuilds.find(
    (rebuild) => rebuild.cause?.kind === "compaction",
  );
  const unexpected = history.rebuilds.find(
    (rebuild) => rebuild.cause?.kind !== "compaction",
  );
  if (history.rebuilds.length === 0 && gaps.length === 0) return null;
  return (
    <div className="tokens-legend">
      {unexpected !== undefined && (
        <span>
          <svg width="12" height="12" aria-hidden="true">
            <rect
              x="2"
              y="2"
              width="8"
              height="8"
              transform="rotate(45 6 6)"
              className="tokens-rebuild"
            />
          </svg>{" "}
          cache rebuilt
        </span>
      )}
      {expected !== undefined && (
        <span>
          <svg width="12" height="12" aria-hidden="true">
            <rect
              x="2"
              y="2"
              width="8"
              height="8"
              transform="rotate(45 6 6)"
              className="tokens-rebuild-expected"
            />
          </svg>{" "}
          rebuilt {rebuildCauseText(expected.cause)}
        </span>
      )}
      {gaps.length > 0 && (
        <span>
          <svg width="16" height="10" aria-hidden="true">
            <rect width="16" height="10" className="tokens-idle-swatch" />
          </svg>{" "}
          idle longer than the cache lasts
        </span>
      )}
    </div>
  );
}

interface CurveSelection {
  cursor: number | null;
  cursorPoint: TokenPoint | null;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerLeave: () => void;
  onClick: (event: MouseEvent<SVGSVGElement>) => void;
  onKeyDown: (event: KeyboardEvent<SVGSVGElement>) => void;
}

/** The curve's reading place: the point the pointer or the
 * arrow keys stand on, and the selection a click or a key
 * makes — the step whose result landed at the point, else
 * the step nearest it in time. */
function useCurveSelection(
  points: TokenPoint[],
  scale: CurveScale,
  stepIds: (number | null)[],
  selectedIndex: number | null,
  steps: Map<number, StepRow>,
  onSelectStep: (stepId: number) => void,
  onPointClick: (point: TokenPoint) => void,
): CurveSelection {
  const [cursor, setCursor] = useState<number | null>(null);
  const selectPoint = (index: number): void => {
    const point = points[index];
    if (point === undefined) return;
    const stepId = stepIds[index] ?? nearestStepId(steps, point.at);
    if (stepId !== null) onSelectStep(stepId);
    onPointClick(point);
  };
  const indexAtEvent = (
    event: MouseEvent<SVGSVGElement> | PointerEvent<SVGSVGElement>,
  ): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    // One unit is one pixel: the position across the frame
    // is the position in the viewBox.
    const viewX = event.clientX - rect.left;
    return nearestPointIndex(points, momentAtX(scale, viewX));
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const index = indexAtEvent(event);
    if (index !== null) setCursor(index);
  };
  const onClick = (event: MouseEvent<SVGSVGElement>): void => {
    const index = indexAtEvent(event);
    if (index === null) return;
    setCursor(index);
    selectPoint(index);
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    let from = cursor ?? selectedIndex;
    if (from === null || from < 0) from = direction === 1 ? -1 : points.length;
    const next = Math.min(points.length - 1, Math.max(0, from + direction));
    setCursor(next);
    selectPoint(next);
  };
  return {
    cursor,
    cursorPoint: cursor === null ? null : (points[cursor] ?? null),
    onPointerMove,
    onPointerLeave: () => setCursor(null),
    onClick,
    onKeyDown,
  };
}

function CurveLine({
  scale,
  drawn,
}: {
  scale: CurveScale;
  drawn: TokenPoint[];
}) {
  const line = drawn
    .map(
      (point) =>
        `${xFor(scale, point.at).toFixed(1)},${yFor(scale, point.tokens).toFixed(1)}`,
    )
    .join(" ");
  const first = drawn[0];
  const last = drawn[drawn.length - 1];
  if (first === undefined || last === undefined) return null;
  return (
    <>
      <polygon
        points={`${xFor(scale, first.at)},${PLOT_BOTTOM} ${line} ${xFor(scale, last.at)},${PLOT_BOTTOM}`}
        className="tokens-curve-area"
      />
      <polyline points={line} fill="none" className="tokens-curve-line" />
      {drawn.length <= POINT_DOTS_UP_TO &&
        drawn.map((point) => (
          <circle
            key={point.requestId}
            cx={xFor(scale, point.at)}
            cy={yFor(scale, point.tokens)}
            r="2.4"
            className="tokens-point"
          />
        ))}
    </>
  );
}

/** The selected rise's two points on the main line: the
 * point it started from and the point it landed on, marked
 * together while the rise is selected. */
export interface CurveHighlight {
  from: TokenPoint;
  to: TokenPoint;
}

export interface TokensCurveProps {
  history: TokenHistory;
  steps: Map<number, StepRow>;
  selectedStepId: number | null;
  onSelectStep: (stepId: number) => void;
  highlight: CurveHighlight | null;
  onPointClick: (point: TokenPoint) => void;
}

interface CurveSvgProps {
  history: TokenHistory;
  scale: CurveScale;
  width: number;
  marks: ChartMarks;
  frameRef: RefObject<HTMLDivElement | null>;
  drawn: TokenPoint[];
  gaps: IdleGap[];
  selectedPoint: TokenPoint | undefined;
  selection: CurveSelection;
  highlight: CurveHighlight | null;
}

function IdleHatchDef() {
  return (
    <pattern
      id="tokens-idle-hatch"
      width="6"
      height="6"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect width="6" height="6" className="tokens-hatch-bg" />
      <line x1="0" y1="0" x2="0" y2="6" className="tokens-hatch-line" />
    </pattern>
  );
}

/** The marks over the line: the ticks and rebuild diamonds,
 * the selected step's line, the cursor where it stands. */
function CurveMarks({
  history,
  scale,
  selectedPoint,
  selection,
  highlight,
}: CurveSvgProps) {
  return (
    <>
      <CompactionTicks scale={scale} history={history} />
      <RebuildMarks scale={scale} history={history} />
      {highlight !== null &&
        [highlight.from, highlight.to].map((point) => (
          <circle
            key={point.requestId}
            cx={xFor(scale, point.at)}
            cy={yFor(scale, point.tokens)}
            r="6.5"
            className="tokens-rise-point"
          />
        ))}
      {selectedPoint !== undefined && (
        <line
          x1={xFor(scale, selectedPoint.at)}
          x2={xFor(scale, selectedPoint.at)}
          y1={PLOT_TOP}
          y2={PLOT_BOTTOM}
          className="tokens-selected-line"
        />
      )}
      {selection.cursorPoint !== null && (
        <CursorMark scale={scale} point={selection.cursorPoint} />
      )}
    </>
  );
}

/** The drawing itself, as one focusable slider: the grid
 * and bands under the line, the marks on it, the cursor
 * over it — and its words as HTML over the drawing, so
 * they stay readable at phone width: the frame keeps a
 * fixed height at every width, so the words keep their
 * spacing as the screen narrows. The slider speaks the
 * cursor's whole note: the rebuild's cause and the idle
 * minutes ride along with the time and the count. */
function CurveSvg(props: CurveSvgProps) {
  const { history, scale, width, marks, frameRef, drawn, gaps, selection } =
    props;
  const points = history.main;
  const cursorPoint = selection.cursorPoint;
  const note =
    cursorPoint === null
      ? null
      : cursorNote(
          cursorPoint,
          history.rebuilds.find(
            (rebuild) => rebuild.requestId === cursorPoint.requestId,
          ),
          gaps.find((gap) => gap.to.requestId === cursorPoint.requestId),
        );
  return (
    <div className="tokens-curve-frame" ref={frameRef}>
      <svg
        viewBox={`0 0 ${width} ${TOKENS_CURVE_HEIGHT}`}
        role="slider"
        aria-label="Context per request"
        aria-valuemin={0}
        aria-valuemax={points.length}
        {...(selection.cursor === null
          ? {}
          : { "aria-valuenow": selection.cursor + 1 })}
        aria-valuetext={note ?? "No point chosen"}
        tabIndex={0}
        className="tokens-curve-svg"
        onPointerMove={selection.onPointerMove}
        onPointerLeave={selection.onPointerLeave}
        onClick={selection.onClick}
        onKeyDown={selection.onKeyDown}
      >
        <defs>
          <IdleHatchDef />
        </defs>
        <GridLines scale={scale} />
        <IdleBands scale={scale} gaps={gaps} />
        {history.base !== null && (
          <BaseBand scale={scale} base={history.base} />
        )}
        <LimitLines scale={scale} marks={marks} />
        <CurveLine scale={scale} drawn={drawn} />
        <CurveMarks {...props} />
      </svg>
      <CurveLabels
        history={history}
        scale={scale}
        width={width}
        marks={marks}
        points={points}
        gaps={gaps}
        selection={selection}
        note={note}
      />
    </div>
  );
}

/** The curve's words, over the drawing: the axis, band,
 * limit, idle and compaction labels, the time strip, and
 * the cursor's note where it stands. */
function CurveLabels({
  history,
  scale,
  width,
  marks,
  points,
  gaps,
  selection,
  note,
}: {
  history: TokenHistory;
  scale: CurveScale;
  width: number;
  marks: ChartMarks;
  points: TokenPoint[];
  gaps: IdleGap[];
  selection: CurveSelection;
  note: string | null;
}) {
  return (
    <div className="tokens-curve-labels" aria-hidden="true">
      <GridLabels scale={scale} width={width} />
      <IdleLabels scale={scale} width={width} gaps={gaps} />
      {history.base !== null && (
        <BaseLabel
          scale={scale}
          width={width}
          base={history.base}
          points={points}
        />
      )}
      <LimitLabels scale={scale} width={width} marks={marks} />
      <CompactionLabels scale={scale} width={width} history={history} />
      <TimeLabels scale={scale} width={width} points={points} />
      {selection.cursorPoint !== null && note !== null && (
        <CursorTooltip
          scale={scale}
          width={width}
          point={selection.cursorPoint}
          note={note}
        />
      )}
    </div>
  );
}

/** The frame's measured width, followed as it changes: the
 * viewBox takes it, so one unit is one pixel at every
 * screen width and the marks keep their shape. Before the
 * first measure — and where nothing measures — the design
 * width stands. */
export function useFrameWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(TOKENS_CURVE_WIDTH);
  useEffect(() => {
    const frame = ref.current;
    if (frame === null) return;
    const measure = (): void => {
      const measured = Math.round(frame.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

interface CurveModel {
  scale: CurveScale;
  marks: ChartMarks;
  drawn: TokenPoint[];
  stepIds: (number | null)[];
  gaps: IdleGap[];
}

/** The curve's model for one history at one frame width:
 * the scale and where its marks stand, the drawn set, the
 * step each point stands for, and the idle gaps — each
 * worked out once per history, steps map and width. */
function useCurveModel(
  history: TokenHistory,
  steps: Map<number, StepRow>,
  width: number,
): CurveModel {
  const points = history.main;
  const { scale, marks } = useMemo(
    () => mainScale(points, history.room, width),
    [points, history.room, width],
  );
  const drawn = useMemo(
    () =>
      downsamplePoints(points, history.rebuilds, history.rises, history.drops),
    [points, history.rebuilds, history.rises, history.drops],
  );
  const stepIds = useMemo(
    () => stepIdsForPoints(points, steps.values()),
    [points, steps],
  );
  const gaps = useMemo(() => idleGaps(points), [points]);
  return { scale, marks, drawn, stepIds, gaps };
}

export function TokensCurve({
  history,
  steps,
  selectedStepId,
  onSelectStep,
  highlight,
  onPointClick,
}: TokensCurveProps) {
  const points = history.main;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const width = useFrameWidth(frameRef);
  const { scale, marks, drawn, stepIds, gaps } = useCurveModel(
    history,
    steps,
    width,
  );
  const selectedIndex =
    selectedStepId === null ? null : stepIds.indexOf(selectedStepId);
  const selection = useCurveSelection(
    points,
    scale,
    stepIds,
    selectedIndex,
    steps,
    onSelectStep,
    onPointClick,
  );
  const selectedPoint =
    selectedIndex !== null && selectedIndex >= 0
      ? points[selectedIndex]
      : undefined;

  return (
    <div className="tokens-curve">
      <AboveChartNote marks={marks} />
      <CurveSvg
        history={history}
        scale={scale}
        width={width}
        marks={marks}
        frameRef={frameRef}
        drawn={drawn}
        gaps={gaps}
        selectedPoint={selectedPoint}
        selection={selection}
        highlight={highlight}
      />
      <Legend history={history} gaps={gaps} />
    </div>
  );
}
