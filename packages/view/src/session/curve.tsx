// The context curve: one SVG line over the snapshot's
// samples, drawn to scale, with the context limit as a
// dashed line, ticks for the session's recorded compactions,
// human moments and failures, a marker for the selected
// step, and the plane at the tip while the session is live.
// Clicking selects the nearest step; with the curve focused,
// the arrow keys step through the steps in time order — the
// curve is a slider, and its value text names the selected
// step and its context.
// No chart library — the samples are the daemon's own,
// already downsampled. The colours are the stylesheet's:
// classes here, palette there.

import { useMemo, type KeyboardEvent, type MouseEvent } from "react";

import type {
  ContextPoint,
  SessionEvent,
} from "@flightpath/flightpath/api/payloads";
import { formatTokens } from "@flightpath/flightpath/format";

import { PlaneIcon } from "../components/icons.js";
import {
  areaPoints,
  CURVE_HEIGHT,
  CURVE_WIDTH,
  curveScale,
  curveTicks,
  linePoints,
  nearestTick,
  selectedContext,
  TICK_HALF_WIDTH_PX,
  timeAtX,
  xFor,
  yFor,
  type CurveTick,
} from "./curve-math.js";
import { COMPACTION_EXPLANATION, Explain } from "./explain.js";
import { nearestStepId } from "./rows.js";
import type { HumanRow, StepRow } from "./types.js";

function PlaneTip({ x, y }: { x: number; y: number }) {
  return (
    <g
      transform={`translate(${x - 20} ${y - 10}) rotate(-12 10 10)`}
      aria-hidden="true"
    >
      <PlaneIcon size={20} />
    </g>
  );
}

export interface ContextCurveProps {
  /** The session's context limit, in tokens: the dashed line,
   * or null when the window isn't known and no line is drawn. */
  limit: number | null;
  samples: ContextPoint[];
  steps: Map<number, StepRow>;
  humans: Map<number, HumanRow>;
  events: SessionEvent[];
  live: boolean;
  selectedStep: StepRow | null;
  onSelectStep: (stepId: number) => void;
}

/** The steps in time order: the slider's positions. */
function orderedSteps(steps: Map<number, StepRow>): StepRow[] {
  return [...steps.values()]
    .filter((step) => step.startedAt !== null)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** The step an arrow key lands on: the next in time order, or an end. */
function steppedStep(
  ordered: StepRow[],
  selectedStep: StepRow | null,
  direction: 1 | -1,
): number | null {
  if (ordered.length === 0) return null;
  const current =
    selectedStep === null
      ? -1
      : ordered.findIndex((step) => step.id === selectedStep.id);
  const next =
    current === -1
      ? ordered[direction === 1 ? 0 : ordered.length - 1]
      : ordered[current + direction];
  return next?.id ?? null;
}

/** The ticks under the line: a session's human moments,
 * its failures, and the compactions the line itself shows. */
function CurveTicks({
  scale,
  ticks,
}: {
  scale: ReturnType<typeof curveScale>;
  ticks: CurveTick[];
}) {
  return (
    <>
      {ticks.map((tick) => (
        <line
          key={`${tick.kind}-${tick.at}-${tick.label}`}
          x1={xFor(scale, tick.at)}
          x2={xFor(scale, tick.at)}
          y1={CURVE_HEIGHT - 8}
          y2={CURVE_HEIGHT}
          className={`curve-tick curve-tick-${tick.kind}`}
          strokeWidth="3"
          vectorEffect="non-scaling-stroke"
        >
          <title>{tick.label}</title>
        </line>
      ))}
    </>
  );
}

function CurveMarks({
  scale,
  limit,
  ticks,
  selectedStep,
  live,
  last,
}: {
  scale: ReturnType<typeof curveScale>;
  limit: number | null;
  ticks: CurveTick[];
  selectedStep: StepRow | null;
  live: boolean;
  last: ContextPoint | undefined;
}) {
  return (
    <>
      {limit !== null && limit <= scale.scaleMax && (
        <line
          x1="0"
          x2={CURVE_WIDTH}
          y1={yFor(scale, limit)}
          y2={yFor(scale, limit)}
          className="curve-limit"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        >
          <title>Context limit: {formatTokens(limit)}</title>
        </line>
      )}
      <CurveTicks scale={scale} ticks={ticks} />
      {selectedStep?.startedAt != null && (
        <line
          x1={xFor(scale, selectedStep.startedAt)}
          x2={xFor(scale, selectedStep.startedAt)}
          y1="0"
          y2={CURVE_HEIGHT}
          className="curve-selected"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        ></line>
      )}
      {live && last !== undefined && (
        <PlaneTip
          x={xFor(scale, last.at)}
          y={yFor(scale, last.contextTokens)}
        />
      )}
    </>
  );
}

function limitWords(limit: number | null, scaleMax: number): string | null {
  if (limit === null) return null;
  if (limit <= scaleMax) return "dashed line: the context limit";
  return `the limit, ${formatTokens(limit, { axis: true })}, is above the strip`;
}

function CurveCaption({
  selectedValue,
  limit,
  scaleMax,
}: {
  selectedValue: number | null;
  limit: number | null;
  scaleMax: number;
}) {
  const words = limitWords(limit, scaleMax);
  return (
    <div className="curve-caption">
      <span>
        Context size per request
        {words !== null && <> · {words}</>} · ticks:{" "}
        <span className="tick-human">you</span>,{" "}
        <span className="tick-failure">failure</span>, compaction
        <Explain term="compaction" text={COMPACTION_EXPLANATION} /> · click to
        jump to a step
      </span>
      {selectedValue !== null && (
        <span>selected step: {formatTokens(selectedValue)} in context</span>
      )}
    </div>
  );
}

/** The line itself: the filled area under it and the
 * stroke over the samples. */
function CurveLine({
  samples,
  scale,
}: {
  samples: ContextPoint[];
  scale: ReturnType<typeof curveScale>;
}) {
  return (
    <>
      <polygon
        points={areaPoints(samples, scale)}
        className="curve-area"
      ></polygon>
      <polyline
        points={linePoints(samples, scale)}
        fill="none"
        className="curve-line"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      ></polyline>
    </>
  );
}

function CurveSvg({
  scale,
  samples,
  limit,
  ticks,
  selectedStep,
  live,
  last,
  label,
  valueText,
  valueNow,
  valueMax,
  onClick,
  onKeyDown,
}: {
  scale: ReturnType<typeof curveScale>;
  samples: ContextPoint[];
  limit: number | null;
  ticks: CurveTick[];
  selectedStep: StepRow | null;
  live: boolean;
  last: ContextPoint | undefined;
  label: string;
  valueText: string;
  valueNow: number;
  valueMax: number;
  onClick: (event: MouseEvent<SVGSVGElement>) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  return (
    <svg
      viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
      preserveAspectRatio="none"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={valueText}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="curve-svg"
    >
      <CurveLine samples={samples} scale={scale} />
      <CurveMarks
        scale={scale}
        limit={limit}
        ticks={ticks}
        selectedStep={selectedStep}
        live={live}
        last={last}
      />
    </svg>
  );
}

/** The slider's spoken shape: its label, its value text
 * naming the selected step and its context, and its value. */
function sliderText(
  ordered: StepRow[],
  selectedStep: StepRow | null,
  selectedValue: number | null,
  scaleMax: number,
): { label: string; valueText: string; valueNow: number } {
  const selectedIndex =
    selectedStep === null
      ? -1
      : ordered.findIndex((step) => step.id === selectedStep.id);
  const label =
    `Context size per request, up to ${formatTokens(scaleMax)}` +
    (selectedValue !== null
      ? `. Selected step: ${formatTokens(selectedValue)} in context`
      : "");
  const valueText =
    selectedIndex === -1
      ? "No step selected"
      : `Step ${selectedIndex + 1} of ${ordered.length}` +
        (selectedValue !== null
          ? `: ${formatTokens(selectedValue)} in context`
          : "");
  return { label, valueText, valueNow: selectedIndex + 1 };
}

/** A tick's click target: the step the tick stands for, or
 * the step nearest the tick's own moment when the tick is a
 * moment's or a compaction's mark. */
function tickTarget(props: ContextCurveProps, tick: CurveTick): number | null {
  if (tick.stepId !== null) return tick.stepId;
  return nearestStepId(props.steps, tick.at);
}

/** Choosing a step on the curve: a click within a tick's
 * hit area picks that tick; elsewhere, the nearest step.
 * Arrow keys walk the steps in time order. */
function curveHandlers(
  props: ContextCurveProps,
  scale: ReturnType<typeof curveScale>,
  ordered: StepRow[],
  ticks: CurveTick[],
) {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const stepId = steppedStep(
      ordered,
      props.selectedStep,
      event.key === "ArrowRight" ? 1 : -1,
    );
    if (stepId !== null) props.onSelectStep(stepId);
  };
  const onClick = (event: MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const at = timeAtX(scale, fraction);
    const tick = nearestTick(ticks, at);
    const hitWindow = scale.span * (TICK_HALF_WIDTH_PX / rect.width);
    const stepId =
      tick !== null && Math.abs(tick.at - at) <= hitWindow
        ? tickTarget(props, tick)
        : nearestStepId(props.steps, at);
    if (stepId !== null) props.onSelectStep(stepId);
  };
  return { onClick, onKeyDown };
}

export function ContextCurve(props: ContextCurveProps) {
  const { samples, selectedStep } = props;
  const scale = useMemo(() => curveScale(samples), [samples]);
  const ticks = useMemo(
    () =>
      curveTicks(
        [...props.steps.values()],
        [...props.humans.values()],
        props.events,
      ),
    [props.steps, props.humans, props.events],
  );
  const ordered = useMemo(() => orderedSteps(props.steps), [props.steps]);
  const selectedValue = selectedContext(samples, selectedStep);
  const last = samples[samples.length - 1];
  const { onClick, onKeyDown } = curveHandlers(props, scale, ordered, ticks);

  if (samples.length === 0) {
    return (
      <p className="curve-empty">
        No context samples yet — the curve draws as requests are recorded.
      </p>
    );
  }

  const { label, valueText, valueNow } = sliderText(
    ordered,
    selectedStep,
    selectedValue,
    scale.scaleMax,
  );

  return (
    <div className="curve">
      <CurveSvg
        scale={scale}
        samples={samples}
        limit={props.limit}
        ticks={ticks}
        selectedStep={selectedStep}
        live={props.live}
        last={last}
        label={label}
        valueText={valueText}
        valueNow={valueNow}
        valueMax={ordered.length}
        onClick={onClick}
        onKeyDown={onKeyDown}
      />
      <CurveCaption
        selectedValue={selectedValue}
        limit={props.limit}
        scaleMax={scale.scaleMax}
      />
    </div>
  );
}
