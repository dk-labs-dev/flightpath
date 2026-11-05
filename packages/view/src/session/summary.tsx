// The session summary: the title and where it ran, the
// counts, and the context curve. Every number comes from the
// snapshot's summary or the samples, formatted by the one
// formatter.

import { useMemo } from "react";

import {
  formatCount,
  formatDuration,
  formatTokens,
} from "@flightpath/flightpath/format";

import { countWord } from "../counts.js";
import { sessionStateLabel } from "../sessions/model.js";
import { CacheClockLine } from "./cache-clock-line.js";
import { useClockStore } from "./clock.js";
import { ContextCurve } from "./curve.js";
import { CONTEXT_EXPLANATION, Explain } from "./explain.js";
import { useSessionStore } from "./store.js";
import { SummaryWindowSource } from "./window-source.js";
import type { SnapshotSummary } from "@flightpath/flightpath/api/payloads";

/** The session's own state as a badge beside its title, on
 * its own subscription to the clock; the badge is text, not
 * a control, so it takes no tab stop. */
function SessionBadge({
  summary,
  runningStep,
}: {
  summary: SnapshotSummary;
  runningStep: boolean;
}) {
  const nowMs = useClockStore((s) => s.nowMs);
  const label = sessionStateLabel(
    {
      status: summary.status,
      hasOpenStep: runningStep,
      lastActivityAt: summary.lastActivityAt,
      endedAt: summary.endedAt,
      endSeen: summary.endSeen,
    },
    nowMs,
  );
  return (
    <span className={`session-badge session-badge-${label.tone}`}>
      {label.tone !== "ended" ? (
        <span className="session-badge-dot" aria-hidden="true"></span>
      ) : null}
      {label.text}
    </span>
  );
}

/** The elapsed line, on its own subscription to the clock:
 * a tick re-renders this line and nothing else. */
function Elapsed({ summary }: { summary: SnapshotSummary }) {
  const nowMs = useClockStore((s) => s.nowMs);
  const end =
    summary.status === "live"
      ? nowMs
      : (summary.endedAt ?? summary.lastActivityAt);
  return <b>{formatDuration(Math.max(0, end - summary.startedAt))}</b>;
}

/** The header's branch counts: a subagent is a branch the
 * person launched (kind `user`); Claude Code's own internal
 * branches are Claude Code helpers, counted apart. */
function branchCounts(branches: ReadonlyMap<number, { kind: string | null }>): {
  subagents: number;
  background: number;
} {
  let subagents = 0;
  let background = 0;
  for (const branch of branches.values()) {
    if (branch.kind === "user") subagents += 1;
    else background += 1;
  }
  return { subagents, background };
}

function SummaryCounts({
  summary,
  branches,
}: {
  summary: SnapshotSummary;
  branches: ReadonlyMap<number, { kind: string | null }>;
}) {
  const counts = branchCounts(branches);
  return (
    <div className="summary-counts">
      <span>
        <Elapsed summary={summary} /> elapsed
      </span>
      <span>
        <b>{formatCount(summary.counts.turns)}</b>{" "}
        {countWord(summary.counts.turns, "turn", "turns")}
      </span>
      <span>
        <b>{formatCount(summary.counts.steps)}</b>{" "}
        {countWord(summary.counts.steps, "step", "steps")}
      </span>
      <span>
        <b>{formatCount(counts.subagents)}</b>{" "}
        {countWord(counts.subagents, "subagent", "subagents")}
      </span>
      {counts.background > 0 && (
        <span>
          <b>{formatCount(counts.background)}</b>{" "}
          {countWord(
            counts.background,
            "Claude Code helper",
            "Claude Code helpers",
          )}
        </span>
      )}
      <span>
        <b>{formatCount(summary.steppedIn)}</b>{" "}
        {countWord(summary.steppedIn, "time", "times")} you stepped in
      </span>
      <span className="summary-context">
        context{" "}
        <b>
          {summary.contextNow === null
            ? "not recorded"
            : formatTokens(summary.contextNow, { axis: true })}
        </b>
        {summary.window.tokens !== null && (
          <> of {formatTokens(summary.window.tokens, { axis: true })} tokens</>
        )}
        <Explain term="context" text={CONTEXT_EXPLANATION} />
        <SummaryWindowSource window={summary.window} />
      </span>
      <span>
        flightpath overhead <b>{formatTokens(summary.overheadTokens)}</b>
      </span>
    </div>
  );
}

export function SessionSummary({
  onCurveSelect,
}: {
  onCurveSelect: (stepId: number) => void;
}) {
  const summary = useSessionStore((s) => s.sessionSummary);
  const samples = useSessionStore((s) => s.samples);
  const steps = useSessionStore((s) => s.steps);
  const humans = useSessionStore((s) => s.humans);
  const eventsByKey = useSessionStore((s) => s.events);
  // The curve memoises on the events array, so the array is
  // built here, once per change of the map it comes from —
  // a fresh spread on every render would rebuild the curve's
  // ticks every time the summary renders.
  const events = useMemo(() => [...eventsByKey.values()], [eventsByKey]);
  const branches = useSessionStore((s) => s.branches);
  const selectedStep = useSessionStore((s) =>
    s.selectedStepId === null ? null : (s.steps.get(s.selectedStepId) ?? null),
  );
  if (summary === null) return null;
  const live = summary.status === "live";
  const runningStep = [...steps.values()].some(
    (step) => step.startedAt !== null && step.endedAt === null,
  );
  const meta = [
    summary.project,
    summary.model,
    summary.permissionModes.join(", "),
  ].filter((part) => part !== null && part !== "");
  return (
    <section aria-label="Session summary" className="summary">
      <div className="summary-head">
        <h1 className="summary-title">{summary.title}</h1>
        <SessionBadge summary={summary} runningStep={runningStep} />
        <span className="summary-meta">{meta.join(" · ")}</span>
        <CacheClockLine
          cache={summary.cache}
          live={live}
          stepRunning={runningStep}
        />
      </div>
      {summary.note !== "" && <p className="summary-note">{summary.note}</p>}
      <SummaryCounts summary={summary} branches={branches} />
      <ContextCurve
        limit={summary.window.tokens}
        samples={samples}
        steps={steps}
        humans={humans}
        events={events}
        live={live}
        selectedStep={selectedStep}
        onSelectStep={onCurveSelect}
      />
    </section>
  );
}
