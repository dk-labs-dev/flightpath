// The tokens lens: where a session's context went, drawn as
// its curve over the main thread's requests, with the room
// left beside it. The history is one query, loaded when the
// lens opens and invalidated by the shell's stream as the
// session grows — the curve, the room, the lanes and the
// plain statements are all read from that one payload, so
// they can never disagree with each other.

import { useState } from "react";

import type {
  Room,
  TokenHistory,
  TokenPoint,
} from "@flightpath/flightpath/api/payloads";
import { formatCount, formatTokens } from "@flightpath/flightpath/format";

import { useTokenHistory } from "./api.js";
import { useSessionStore } from "./store.js";
import {
  TokensCurve,
  type CurveHighlight,
  type TokensCurveProps,
} from "./tokens-curve.js";
import { TokensLanes } from "./tokens-lanes.js";
import { RisesList } from "./tokens-rises.js";
import { TurnsTable } from "./tokens-turns.js";
import { WindowSourceLine } from "./window-source.js";

/** The plain statements: what this history cannot show,
 * said in as many lines as apply, above the curve. Each
 * shows only while its flag holds. */
function Statements({ history }: { history: TokenHistory }) {
  const states = history.states;
  return (
    <>
      {!states.telemetry && (
        <p className="tokens-note" role="note">
          Recorded without telemetry: Claude Code&rsquo;s background requests
          aren&rsquo;t included, so totals cover your own requests only.
        </p>
      )}
      {states.tokensPartial && (
        <p className="tokens-note" role="note">
          Part of this session&rsquo;s transcript couldn&rsquo;t be read, so
          some requests are missing from these figures.
        </p>
      )}
      {states.joinedPartway && (
        <p className="tokens-note" role="note">
          Flightpath started recording partway through this session; earlier
          context isn&rsquo;t shown.
        </p>
      )}
    </>
  );
}

/** The room's bar: base, growth since, and room to the
 * auto-compact point, each at its share of the limit; the
 * rest of the bar is the room to the limit itself. */
function RoomBar({ history }: { history: TokenHistory }) {
  const room = history.room;
  const base = history.base;
  const latest = history.main[history.main.length - 1];
  if (
    base === null ||
    latest === undefined ||
    room.toAutoCompact === null ||
    room.window.tokens === null
  ) {
    return null;
  }
  const limit = room.window.tokens;
  const share = (tokens: number): string =>
    `${Math.max(0, (tokens / limit) * 100).toFixed(1)}%`;
  return (
    <>
      <div className="tokens-bar" aria-hidden="true">
        <span
          className="tokens-bar-base"
          style={{ width: share(base.tokens) }}
        />
        <span
          className="tokens-bar-growth"
          style={{ width: share(latest.tokens - base.tokens) }}
        />
        <span
          className="tokens-bar-room"
          style={{ width: share(room.toAutoCompact) }}
        />
      </div>
      <p className="tokens-room-caption">
        base {formatTokens(base.tokens, { axis: true })} · since then{" "}
        {formatTokens(latest.tokens - base.tokens, { axis: true })} ·{" "}
        {room.toAutoCompact < 0
          ? `past auto-compact by ${formatTokens(-room.toAutoCompact, { axis: true })}`
          : `to auto-compact ${formatTokens(room.toAutoCompact, { axis: true })}`}
      </p>
    </>
  );
}

/** The auto-compact point's source, as the panel names it. */
function autoCompactSource(
  source: NonNullable<Room["autoCompact"]>["source"],
): string {
  if (source === "setting") return "your setting";
  if (source === "context-command") return "your /context";
  return "model default";
}

/** The auto-compact block: the measured room to the point,
 * or word that the point isn't known for this model. */
function AutoCompactRoom({ history }: { history: TokenHistory }) {
  const room = history.room;
  if (room.autoCompact === null) {
    return (
      <p className="tokens-room-unknown">
        Claude Code&rsquo;s auto-compact point for this model isn&rsquo;t known.
        Run <code>/context</code> to see it.
      </p>
    );
  }
  if (room.toAutoCompact === null) return null;
  const source = autoCompactSource(room.autoCompact.source);
  if (room.toAutoCompact < 0) {
    return (
      <div>
        <div className="tokens-room-big">
          {formatTokens(-room.toAutoCompact, { axis: true })}
        </div>
        <div className="tokens-room-label">
          tokens past auto-compact (
          {formatTokens(room.autoCompact.tokens, { axis: true })}, {source})
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="tokens-room-big">
        {formatTokens(room.toAutoCompact, { axis: true })}
      </div>
      <div className="tokens-room-label">
        tokens to auto-compact (
        {formatTokens(room.autoCompact.tokens, { axis: true })}, {source})
      </div>
    </div>
  );
}

/** How far the session can still go: the measured room to
 * the auto-compact point and to the limit, and — the one
 * estimate on the screen, tagged as one — the turns left
 * at the recent pace. */
function RoomPanel({ history }: { history: TokenHistory }) {
  const room = history.room;
  return (
    <section className="tokens-card" aria-labelledby="tokens-room-h">
      <div className="tokens-card-head">
        <h2 id="tokens-room-h">Room left</h2>
      </div>
      <div className="tokens-room">
        <AutoCompactRoom history={history} />
        <RoomBar history={history} />
        {room.toLimit !== null && room.window.tokens !== null && (
          <div>
            <div className="tokens-room-mid">
              {formatTokens(room.toLimit, { axis: true })}
            </div>
            <div className="tokens-room-label">
              tokens to the limit (
              {formatTokens(room.window.tokens, { axis: true })})
            </div>
          </div>
        )}
        {room.turnsLeft !== null && room.turnsLeft.value > 0 && (
          <div className="tokens-room-turns">
            <span>
              about <b>{formatCount(room.turnsLeft.value)}</b>{" "}
              {room.turnsLeft.value === 1 ? "turn" : "turns"} at this pace
            </span>
            <span className="tokens-est">estimate</span>
            <div className="tokens-room-sub">
              from the median growth of your recent turns
            </div>
          </div>
        )}
        <WindowSourceLine window={room.window} model={room.model} />
      </div>
    </section>
  );
}

/** The selected rise's two points on the main line, or
 * null when no rise is selected or either end is gone. */
function riseHighlight(
  history: TokenHistory,
  selectedRiseId: string | null,
): CurveHighlight | null {
  if (selectedRiseId === null) return null;
  const rise = history.rises.find(
    (candidate) => candidate.id === selectedRiseId,
  );
  if (rise === undefined) return null;
  const from = history.main.find(
    (point) => point.requestId === rise.fromRequestId,
  );
  const to = history.main.find((point) => point.requestId === rise.toRequestId);
  if (from === undefined || to === undefined) return null;
  return { from, to };
}

/** The rise a clicked point belongs to: the rise ending
 * there first, else the rise starting there. */
function riseForPoint(history: TokenHistory, point: TokenPoint) {
  return (
    history.rises.find(
      (candidate) => candidate.toRequestId === point.requestId,
    ) ??
    history.rises.find(
      (candidate) => candidate.fromRequestId === point.requestId,
    )
  );
}

function CurveCard({
  history,
  steps,
  selectedStepId,
  onSelectStep,
  highlight,
  onPointClick,
}: TokensCurveProps) {
  return (
    <section className="tokens-card" aria-labelledby="tokens-curve-h">
      <div className="tokens-card-head">
        <h2 id="tokens-curve-h">Context over time</h2>
        <span className="tokens-card-sub">
          main thread · each point is one request · click a point to select its
          step
        </span>
      </div>
      <TokensCurve
        history={history}
        steps={steps}
        selectedStepId={selectedStepId}
        onSelectStep={onSelectStep}
        highlight={highlight}
        onPointClick={onPointClick}
      />
      <TokensLanes history={history} onSelectStep={onSelectStep} />
    </section>
  );
}

function FailedHistory({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="tokens-failed">
      <p className="empty">Token history couldn&rsquo;t be loaded.</p>
      <button type="button" className="tokens-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function TokensLens() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useSessionStore((s) => s.token);
  const steps = useSessionStore((s) => s.steps);
  const selectedStepId = useSessionStore((s) => s.selectedStepId);
  const selectStep = useSessionStore((s) => s.selectStep);
  const [selectedRiseId, setSelectedRiseId] = useState<string | null>(null);
  const [riseScrollTick, setRiseScrollTick] = useState(0);
  const query = useTokenHistory(sessionId, token);

  if (query.isPending) {
    return <p className="empty">Loading token history…</p>;
  }
  if (query.isError || query.data === null || query.data === undefined) {
    return <FailedHistory onRetry={() => void query.refetch()} />;
  }
  const history = query.data;
  const highlight = riseHighlight(history, selectedRiseId);
  const handlePointClick = (point: TokenPoint): void => {
    const rise = riseForPoint(history, point);
    if (rise === undefined) return;
    setSelectedRiseId(rise.id);
    setRiseScrollTick((tick) => tick + 1);
  };
  return (
    <div className="tokens-lens">
      <Statements history={history} />
      {history.main.length === 0 ? (
        <p className="empty">No requests recorded yet for this session.</p>
      ) : (
        <>
          <div className="tokens-grid">
            <CurveCard
              history={history}
              steps={steps}
              selectedStepId={selectedStepId}
              onSelectStep={selectStep}
              highlight={highlight}
              onPointClick={handlePointClick}
            />
            <RoomPanel history={history} />
          </div>
          {history.rises.length > 0 && (
            <RisesList
              history={history}
              selectedRiseId={selectedRiseId}
              onSelectRise={setSelectedRiseId}
              scrollTick={riseScrollTick}
            />
          )}
          {history.turns.length > 0 && <TurnsTable history={history} />}
        </>
      )}
    </div>
  );
}
