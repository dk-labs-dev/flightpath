// The tokens lens's subagent lanes: under the curve, one
// lane per subagent the user ran — its own small curve on
// the main curve's time axis, so it sits under the moment
// it ran, with the tokens it used beside the much smaller
// amount it handed back. Claude Code's own background work
// is one line under the lanes, counted apart. Nothing here
// is stored or sent: the lanes read the one history the
// lens already holds.

import { useMemo, useRef, useState } from "react";

import type {
  BackgroundWork,
  BranchSeries,
  BranchStart,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";
import {
  estimatedTokens,
  formatCount,
  formatTokens,
} from "@flightpath/flightpath/format";

import { EstimateTag } from "../components/EstimateTag.js";
import { plotScale, xFor, yFor, type CurveScale } from "./curve-math.js";
import { useFrameWidth } from "./tokens-curve.js";
import { mainScale } from "./tokens-curve-math.js";

/** A lane's height: the sparkline's box, in the units its
 * viewBox shares with the curve's frame. */
const LANE_HEIGHT = 32;

/** How many lanes show before the rest are asked for. */
const SHOWN_FIRST = 6;

/** The pad at a sparkline's top and bottom, so its line
 * never touches the lane's edges. */
const LANE_PAD = 3;

/** A lane's least drawn width: a short run on a long axis
 * would otherwise shrink to a flick of a line, so its
 * points spread over this width, centred on the moment
 * the run started. */
const LANE_MIN_WIDTH = 24;

/** The lanes in the order the subagents started — by their
 * first point's time. A branch with no points stands last;
 * ties break by branch id. */
function lanesInStartOrder(branches: BranchSeries[]): BranchSeries[] {
  const startedAt = (branch: BranchSeries): number =>
    branch.points[0]?.at ?? Number.POSITIVE_INFINITY;
  return [...branches].sort((a, b) => {
    const byStart = startedAt(a) - startedAt(b);
    return byStart !== 0 ? byStart : a.branchId - b.branchId;
  });
}

/** What a lane says came back: the spawning step's returned
 * context, counted by the one estimate the daemon counts
 * with and tagged as an estimate; a return the record
 * doesn't carry says so, never a figure. */
function ReturnedWords({ branch }: { branch: BranchSeries }) {
  const returned = estimatedTokens(branch.returnedChars);
  if (returned === null) {
    return (
      <span>
        returned: <span className="tokens-lane-unknown">not recorded</span>
      </span>
    );
  }
  return (
    <span>
      returned{" "}
      <span className="tokens-lane-est">
        about {formatTokens(returned, { axis: true })}
      </span>{" "}
      <EstimateTag className="tokens-est" />
    </span>
  );
}

/** What a subagent started with, for the lane's hover; nothing
 * when none of its start was recorded. */
function startedWithHint(start: BranchStart | null): string | undefined {
  if (start === null) return undefined;
  const size = formatTokens(start.tokens, { axis: true });
  return `started with about ${size}: ${start.parts.join(", ")}`;
}

interface LaneProps {
  branch: BranchSeries;
  /** The main curve's scale: the lane's x stands on it. */
  scale: CurveScale;
  width: number;
  onSelectStep: (stepId: number) => void;
}

/** A lane's sparkline: the branch's points on the main
 * scale's x, at the branch's own height. A branch of one
 * request draws a dot — a line of one point shows nothing.
 * A run whose span falls under the least width has its
 * points spread over that width, centred on its start; a
 * run whose points share one moment spreads them evenly,
 * so it never draws as a zero-width line. */
function LaneSpark({ branch, scale, width }: Omit<LaneProps, "onSelectStep">) {
  const peak = branch.points.reduce(
    (max, point) => Math.max(max, point.tokens),
    0,
  );
  const laneScale = plotScale(scale.startAt, scale.span, peak, {
    left: scale.box.left,
    right: scale.box.right,
    top: LANE_PAD,
    bottom: LANE_HEIGHT - LANE_PAD,
  });
  const first = branch.points[0];
  const lastPoint = branch.points[branch.points.length - 1];
  const startX = first === undefined ? 0 : xFor(laneScale, first.at);
  const endX = lastPoint === undefined ? startX : xFor(laneScale, lastPoint.at);
  const span = endX - startX;
  const spread = branch.points.length >= 2 && span < LANE_MIN_WIDTH;
  const drawX = (at: number, index: number): number => {
    const x = xFor(laneScale, at);
    if (!spread) return x;
    const fraction =
      span > 0 ? (x - startX) / span : index / (branch.points.length - 1);
    return startX - LANE_MIN_WIDTH / 2 + fraction * LANE_MIN_WIDTH;
  };
  const drawn = branch.points
    .map(
      (point, index) =>
        `${drawX(point.at, index).toFixed(1)},${yFor(laneScale, point.tokens).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className="tokens-lane-spark"
      viewBox={`0 0 ${width} ${LANE_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {branch.points.length === 1 && first !== undefined ? (
        <circle
          cx={xFor(laneScale, first.at)}
          cy={yFor(laneScale, first.tokens)}
          r="2.5"
          className="tokens-lane-dot"
        />
      ) : (
        <polyline points={drawn} className="tokens-lane-line" />
      )}
    </svg>
  );
}

/** One subagent's lane: its type, its sparkline, and its
 * figures. The sparkline spans the lane's whole width on
 * the main scale. Its points stand at the x the main
 * curve gives their moments, except that a run shorter
 * than the least width is spread over it, centred on its
 * start. Its height is its own, scaled to the branch's
 * own peak. A lane whose branch names its spawning step
 * is a button that selects it; without the step there is
 * nothing to select, and the lane is plain. */
function Lane({ branch, scale, width, onSelectStep }: LaneProps) {
  const body = (
    <>
      <span className="tokens-lane-words">
        <span className="tokens-lane-type">
          {branch.agentType ?? "subagent"}
          {branch.parentAgentType !== null &&
            ` (from ${branch.parentAgentType})`}
        </span>
        <span className="tokens-lane-figures">
          used <b>{formatTokens(branch.tokensProcessed, { axis: true })}</b> ·{" "}
          <ReturnedWords branch={branch} />
        </span>
      </span>
      <LaneSpark branch={branch} scale={scale} width={width} />
    </>
  );
  const stepId = branch.spawningStepId;
  const hint = startedWithHint(branch.startedWith);
  if (stepId === null) {
    return (
      <div className="tokens-lane" title={hint}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="tokens-lane"
      title={hint}
      onClick={() => onSelectStep(stepId)}
    >
      {body}
    </button>
  );
}

/** The helper line: every helper branch is
 * counted, the total is summed from the branches whose
 * tokens are known, and branches without are said — the
 * total is never shown as zero for work that went
 * unrecorded. */
function BackgroundLine({ background }: { background: BackgroundWork[] }) {
  const known = background.filter(
    (work): work is BackgroundWork & { tokensProcessed: number } =>
      work.tokensProcessed !== null,
  );
  const total = known.reduce((sum, work) => sum + work.tokensProcessed, 0);
  const agents =
    background.length === 1
      ? "1 agent"
      : `${formatCount(background.length)} agents`;
  return (
    <p className="tokens-background">
      Claude Code helpers: {agents}
      {known.length > 0 && <>, {formatTokens(total)}</>}
      {known.length === 0 && <> (tokens not recorded)</>}
      {known.length > 0 && known.length < background.length && (
        <> (some not recorded)</>
      )}
    </p>
  );
}

export interface TokensLanesProps {
  history: TokenHistory;
  onSelectStep: (stepId: number) => void;
}

/** The lanes block under the curve: the heading, the lanes
 * in start order (six, then the rest on request), and the
 * background line. With no subagents of either kind,
 * nothing is drawn. */
export function TokensLanes({ history, onSelectStep }: TokensLanesProps) {
  const [showAll, setShowAll] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const width = useFrameWidth(frameRef);
  const branches = useMemo(
    () => lanesInStartOrder(history.branches),
    [history.branches],
  );
  const scale = useMemo(
    () => mainScale(history.main, history.room, width).scale,
    [history.main, history.room, width],
  );
  if (branches.length === 0 && history.background.length === 0) {
    return null;
  }
  const visible = showAll ? branches : branches.slice(0, SHOWN_FIRST);
  return (
    <div className="tokens-lanes" ref={frameRef}>
      {branches.length > 0 && <h3 className="tokens-lanes-head">Subagents</h3>}
      {visible.map((branch) => (
        <Lane
          key={branch.branchId}
          branch={branch}
          scale={scale}
          width={width}
          onSelectStep={onSelectStep}
        />
      ))}
      {branches.length > SHOWN_FIRST && (
        <div className="tokens-show-more">
          <button
            type="button"
            className="tokens-show-all"
            aria-expanded={showAll}
            onClick={() => setShowAll((was) => !was)}
          >
            {showAll
              ? `Show the first ${SHOWN_FIRST}`
              : `Show all ${formatCount(branches.length)}`}
          </button>
        </div>
      )}
      {history.background.length > 0 && (
        <BackgroundLine background={history.background} />
      )}
    </div>
  );
}
