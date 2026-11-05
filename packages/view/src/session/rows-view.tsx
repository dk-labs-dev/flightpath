// One row of the step tree. Each row subscribes to its own
// data in the store by id, so a stream change re-renders the
// row it touched and its turn's header — never the whole
// tree. The tile's glyph and tone say the kind at a glance;
// the sentence is the row's headline, as the brief asks.

import { memo, useEffect } from "react";

import {
  formatClock,
  formatCount,
  formatDuration,
  formatTimeLabel,
  formatTokens,
} from "@flightpath/flightpath/format";

import type { BranchSummary } from "@flightpath/flightpath/api/payloads";

import { ChevronIcon, PlaneIcon } from "../components/icons.js";
import { countLine } from "../counts.js";
import { useClockStore } from "./clock.js";
import { markerName, type RowMarker } from "./findings.js";
import { GradeMarker } from "./GradeMarker.js";
import { rowAction, turnContextRange } from "./rows.js";
import type { Row } from "./rows.js";
import { useSessionStore } from "./store.js";
import { requestTurnName } from "./words.js";
import { STEPPED_IN_KINDS, type StepRow, type TurnShell } from "./types.js";

interface RowChrome {
  tile: string;
  tone: string;
  name: string;
  detail?: string | undefined;
  /** The meta line's facts, one per part: the line lays them
   * out with the separator between, so no part carries its
   * own spacing. */
  meta: string[];
  pill?: { text: string; tone: string } | undefined;
  toggle?: boolean | undefined;
  running?: boolean | undefined;
}

/** What every row view is handed: the row — which carries
 * its own set size and position for a screen reader — its
 * keyboard place, and the activation callback. */
interface RowViewProps {
  row: Row;
  tabIndex?: number | undefined;
  /** Whether a turn or branch row stands open, when the
   * reader keeps its own folds (the snapshot lens's
   * picker); otherwise the store's folds answer. */
  expanded?: boolean | undefined;
  /** The request a turn that ran no step stands for, in the
   * reader that picks requests (the snapshot lens's picker). */
  requestId?: number | undefined;
  /** The suggestions pinned to this row, which the steps tree
   * passes and the snapshot lens's picker does not. */
  marker?: RowMarker | undefined;
  onActivate: (row: Row) => void;
  /** Fold or unfold a row that opens details as well as
   * folding: the chevron's job, since the row itself opens. */
  onToggle: (row: Row) => void;
}

/** The frame props a view passes on unchanged, with its
 * expanded state when it has children. */
function frameProps(props: RowViewProps, expanded?: boolean) {
  return {
    row: props.row,
    tabIndex: props.tabIndex,
    marker: props.marker,
    onActivate: props.onActivate,
    onToggle: props.onToggle,
    ...(expanded === undefined ? {} : { expanded }),
  };
}

function rowClasses(
  row: Row,
  chrome: RowChrome,
  selected: boolean,
  fresh: boolean | undefined,
  marked: boolean,
): string {
  const action = rowAction(row);
  return [
    "trow",
    `trow-${row.kind}`,
    action === "open" ? "trow-openable" : "",
    chrome.toggle !== undefined ? "trow-parent" : "",
    action === null ? "trow-static" : "",
    chrome.running === true ? "trow-running" : "",
    selected ? "trow-selected" : "",
    fresh ? "trow-fresh" : "",
    marked ? "trow-marked" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
}

/** The toggle's place at a row's left: the chevron, in its
 * own target-sized box, on the rows that expand. On a row
 * that opens details too, pressing it folds and does not
 * open. */
function RowToggle({
  row,
  chrome,
  onToggle,
}: {
  row: Row;
  chrome: RowChrome;
  onToggle: (row: Row) => void;
}) {
  const foldsApart = rowAction(row) === "open" && chrome.toggle !== undefined;
  return (
    <span
      className="trow-toggle"
      aria-hidden="true"
      onClick={
        foldsApart
          ? (event) => {
              event.stopPropagation();
              onToggle(row);
            }
          : undefined
      }
    >
      {chrome.toggle !== undefined && (
        <ChevronIcon open={chrome.toggle} size={16} />
      )}
    </span>
  );
}

/** The open cue at a row's right edge, on the rows that open the panel. */
function RowOpenCue({ row }: { row: Row }) {
  return (
    <span className="trow-open" aria-hidden="true">
      {rowAction(row) === "open" && <ChevronIcon open={false} size={14} />}
    </span>
  );
}

/** A row's meta line. Its facts stand as phrases, each
 * followed by a separator that is its own piece, spaced by
 * the stylesheet's gap — a space inside a part's text would
 * collapse at the join. A phrase and its separator form one
 * unit, so the line wraps only at a join: a narrow row
 * never cuts a phrase in two, and a wrapped line starts
 * with a phrase, not a separator. */
function MetaLine({ parts }: { parts: string[] }) {
  return (
    <span className="trow-meta">
      {parts.map((part, index) => (
        <span className="trow-meta-unit" key={index}>
          <span className="trow-meta-part">{part}</span>
          {index < parts.length - 1 && (
            <span className="trow-meta-sep" aria-hidden="true">
              ·
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function RowFrame({
  row,
  chrome,
  selected,
  expanded,
  fresh,
  tabIndex,
  marker,
  onActivate,
  onToggle,
}: {
  row: Row;
  chrome: RowChrome;
  selected: boolean;
  expanded?: boolean | undefined;
  fresh?: boolean | undefined;
  tabIndex?: number | undefined;
  marker?: RowMarker | undefined;
  onActivate: (row: Row) => void;
  onToggle: (row: Row) => void;
}) {
  return (
    <div
      role="treeitem"
      data-row-key={row.key}
      aria-selected={selected}
      aria-expanded={expanded}
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      tabIndex={tabIndex ?? -1}
      className={rowClasses(row, chrome, selected, fresh, marker !== undefined)}
      style={{ paddingLeft: 14 + row.depth * 22 }}
      onClick={() => onActivate(row)}
    >
      <RowToggle row={row} chrome={chrome} onToggle={onToggle} />
      <span className={`trow-tile tile-${chrome.tone}`} aria-hidden="true">
        {chrome.tile === "plane" ? <PlaneIcon size={15} /> : chrome.tile}
      </span>
      <div className="trow-text">
        <div className="trow-line">
          <span className="trow-name">{chrome.name}</span>
          {chrome.detail !== undefined && (
            <span className="trow-detail">{chrome.detail}</span>
          )}
          {chrome.pill !== undefined && (
            <span className={`pill pill-${chrome.pill.tone}`}>
              {chrome.pill.text}
            </span>
          )}
          {marker !== undefined && (
            <GradeMarker grade={marker.grade} name={markerName(marker)} />
          )}
        </div>
        {chrome.meta.length > 0 && <MetaLine parts={chrome.meta} />}
      </div>
      <RowOpenCue row={row} />
    </div>
  );
}

function promptQuote(sentence: string | null): string | undefined {
  if (sentence === null) return undefined;
  const text = sentence.startsWith("You asked: ")
    ? sentence.slice("You asked: ".length)
    : sentence;
  return `“${text}”`;
}

/** The branches whose spawning step is one of the turn's steps. */
function useTurnBranches(turnId: number): BranchSummary[] {
  const branchMap = useSessionStore((s) => s.branches);
  const turnSteps = useSessionStore((s) => s.stepsByTurn.get(turnId));
  const ownSteps = new Set((turnSteps ?? []).map((step) => step.id));
  return [...branchMap.values()].filter(
    (branch) =>
      branch.spawningStepId !== null && ownSteps.has(branch.spawningStepId),
  );
}

function useTurnContextRange(turnId: number): string {
  return useSessionStore((s) => {
    const shell = s.turns.get(turnId);
    if (shell === undefined) return "";
    const found = turnContextRange(
      s.stepsByTurn.get(turnId) ?? [],
      s.samples,
      shell,
    );
    return found === null
      ? ""
      : `${formatTokens(found.before)} → ${formatTokens(found.after)}`;
  });
}

function TurnRowView(props: RowViewProps) {
  const { row } = props;
  const turnId = row.kind === "turn" ? row.turnId : 0;
  const turn = useSessionStore((s) => s.turns.get(turnId));
  const collapsed = useSessionStore((s) => s.collapsedTurns.has(turnId));
  const filteringNow = useSessionStore(
    (s) => s.failuresOnly || s.steppedInOnly || s.search !== "",
  );
  const stepCount = useSessionStore(
    (s) => s.stepsByTurn.get(turnId)?.length ?? 0,
  );
  const branches = useTurnBranches(turnId);
  const selectedRequest = useSessionStore(
    (s) =>
      props.requestId !== undefined && s.selectedRequestId === props.requestId,
  );
  const range = useTurnContextRange(turnId);
  if (turn === undefined) return null;
  // A turn standing for its request has no children to fold.
  if (props.requestId !== undefined) {
    return (
      <RowFrame
        {...frameProps(props)}
        selected={selectedRequest}
        chrome={{
          tile: String(turn.sequence),
          tone: "turn",
          name: requestTurnName(turn.sequence, stepCount),
          detail: promptQuote(turn.promptSentence),
          meta: turnMeta(turn, stepCount, range, branches),
        }}
      />
    );
  }
  // A turn with no steps opens the snapshot and has nothing to fold.
  const foldable = !(row.kind === "turn" && row.stepless);
  const expanded = props.expanded ?? (filteringNow ? true : !collapsed);
  return (
    <RowFrame
      {...frameProps(props, foldable ? expanded : undefined)}
      selected={false}
      chrome={{
        tile: String(turn.sequence),
        tone: "turn",
        name: `Turn ${turn.sequence}`,
        detail: promptQuote(turn.promptSentence),
        meta: turnMeta(turn, stepCount, range, branches),
        ...(foldable ? { toggle: expanded } : {}),
      }}
    />
  );
}

/**
 * What the turn's subagents add to its time, if anything:
 * while one still runs, that it runs; once the last has ended
 * past the turn's own end, how long they ran on. The turn's
 * own time keeps its meaning — when Claude handed back.
 */
function subagentTime(
  turn: TurnShell,
  branches: readonly BranchSummary[],
): string | null {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  const running = branches.some(
    (branch) => branch.startedAt !== null && branch.endedAt === null,
  );
  if (running) return "subagents running";
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  for (const branch of branches) {
    if (branch.endedAt === null || branch.endedAt <= turn.endedAt) continue;
    if (
      branch.startedAt !== null &&
      (firstStart === null || branch.startedAt < firstStart)
    ) {
      firstStart = branch.startedAt;
    }
    if (lastEnd === null || branch.endedAt > lastEnd) {
      lastEnd = branch.endedAt;
    }
  }
  if (lastEnd === null) return null;
  const span = lastEnd - (firstStart ?? turn.startedAt);
  return span > 0 ? `subagents ran ${formatDuration(span)}` : null;
}

function turnMeta(
  turn: TurnShell,
  stepCount: number,
  range: string,
  branches: readonly BranchSummary[],
): string[] {
  const parts: string[] = [
    stepCount === 1 ? "1 step" : `${formatCount(stepCount)} steps`,
  ];
  if (turn.endedAt !== null && turn.startedAt !== null) {
    parts.push(formatDuration(turn.endedAt - turn.startedAt));
  } else if (turn.endedAt === null) {
    parts[0] = `${parts[0]} so far`;
  }
  const subagents = subagentTime(turn, branches);
  if (subagents !== null) parts.push(subagents);
  if (range !== "") parts.push(`context ${range}`);
  if (turn.failures > 0) {
    parts.push(turn.failures === 1 ? "1 failure" : `${turn.failures} failures`);
  }
  if (turn.steppedIn > 0) parts.push("you stepped in");
  if (turn.images > 0) parts.push(countLine(turn.images, "image", "images"));
  if (turn.files > 0) parts.push(countLine(turn.files, "file", "files"));
  return parts;
}

function stepGlyph(toolName: string): string {
  if (toolName === "Bash") return "$";
  // The subagent's closing step is the report that completes
  // the Agent step, so it carries the Agent step's letter.
  if (toolName === "SubagentHandback") return "A";
  return toolName.charAt(0).toUpperCase() || "?";
}

/** A step row's meta line: its running time while it runs,
 * else its duration and when it started, and its failure. */
function stepMeta(
  step: StepRow,
  clock: { runTick: number; minuteTick: number; live: boolean },
): { running: boolean; meta: string[] } {
  const running = step.outcome === "open";
  const parts: string[] = [];
  if (running && step.startedAt !== null) {
    const elapsed = Math.max(0, clock.runTick - step.startedAt);
    parts.push(`running for ${formatDuration(elapsed)}`);
  } else {
    if (step.durationMs !== null) parts.push(formatDuration(step.durationMs));
    if (step.startedAt !== null) {
      parts.push(
        formatTimeLabel(step.startedAt, {
          nowMs: clock.minuteTick * 30_000,
          live: clock.live,
        }),
      );
    }
  }
  if (step.outcome === "failed") parts.push("failed");
  return { running, meta: parts };
}

/** A step's meta line, current with the clock. The clock
 * lives in its own store, so a tick re-renders only the rows
 * whose words it changes: a running step's elapsed line every
 * second, a time label every half minute. */
function useStepMeta(
  step: StepRow | undefined,
): { running: boolean; meta: string[] } | null {
  const live = useSessionStore((s) => s.sessionSummary?.status === "live");
  const minuteTick = useClockStore((s) => Math.floor(s.nowMs / 30_000));
  const runTick = useClockStore((s) =>
    step?.outcome === "open" ? s.nowMs : 0,
  );
  return step === undefined
    ? null
    : stepMeta(step, { runTick, minuteTick, live });
}

function StepRowView(props: RowViewProps) {
  const { row } = props;
  const stepId = row.kind === "step" ? row.stepId : 0;
  const step = useSessionStore((s) => s.steps.get(stepId));
  const selected = useSessionStore((s) => s.selectedStepId === stepId);
  const fresh = useSessionStore((s) => s.freshStepIds.has(stepId));
  const consumeFresh = useSessionStore((s) => s.consumeFresh);
  const facts = useStepMeta(step);
  useEffect(() => {
    if (fresh) consumeFresh(stepId);
  }, [fresh, consumeFresh, stepId]);
  if (step === undefined || facts === null) return null;
  const { running, meta } = facts;
  let tone = "step";
  if (step.outcome === "failed") tone = "failure";
  else if (running) tone = "live";
  return (
    <RowFrame
      {...frameProps(props)}
      selected={selected}
      fresh={fresh}
      chrome={{
        tile: running ? "plane" : stepGlyph(step.toolName),
        tone,
        name: step.sentence,
        meta,
        pill: running ? { text: "Running", tone: "live" } : undefined,
        running,
      }}
    />
  );
}

// A message from a subagent or Claude Code carries its source
// as a tag; the person's own stepping in carries "You".
const SAID_BY: Record<string, { tile: string; tone: string; tag: string }> = {
  handback: { tile: "A", tone: "branch", tag: "From a subagent" },
  notice: { tile: "C", tone: "event", tag: "From Claude Code" },
};

function humanPill(kind: string): RowChrome["pill"] {
  const said = SAID_BY[kind];
  if (said !== undefined) return { text: said.tag, tone: said.tone };
  return STEPPED_IN_KINDS.has(kind)
    ? { text: "You", tone: "human" }
    : undefined;
}

function HumanRowView(props: RowViewProps) {
  const { row } = props;
  const humanId = row.kind === "human" ? row.humanId : 0;
  const human = useSessionStore((s) => s.humans.get(humanId));
  if (human === undefined) return null;
  const said = SAID_BY[human.kind];
  return (
    <RowFrame
      {...frameProps(props)}
      selected={false}
      chrome={{
        tile: said?.tile ?? "Y",
        tone: said?.tone ?? "human",
        name: human.sentence,
        meta: [formatClock(human.occurredAt)],
        pill: humanPill(human.kind),
      }}
    />
  );
}

function BranchRowView(props: RowViewProps) {
  const { row } = props;
  const branchId = row.kind === "branch" ? row.branchId : 0;
  const starterId = row.kind === "branch" ? row.spawningStepId : null;
  const branch = useSessionStore((s) => s.branches.get(branchId));
  const collapsed = useSessionStore((s) => s.collapsedBranches.has(branchId));
  const starter = useSessionStore((s) =>
    starterId === null ? undefined : s.steps.get(starterId),
  );
  const selected = useSessionStore(
    (s) => starterId !== null && s.selectedStepId === starterId,
  );
  const filteringNow = useSessionStore(
    (s) => s.failuresOnly || s.steppedInOnly || s.search !== "",
  );
  const facts = useStepMeta(starter);
  if (branch === undefined) return null;
  const parts: string[] = [
    branch.steps === 1 ? "1 step" : `${formatCount(branch.steps)} steps`,
    branch.requests === 1
      ? "1 request"
      : `${formatCount(branch.requests)} requests`,
  ];
  if (facts !== null) {
    parts.push(...facts.meta);
  } else if (branch.startedAt !== null && branch.endedAt !== null) {
    parts.push(formatDuration(branch.endedAt - branch.startedAt));
  }
  const running = facts?.running === true;
  let tone = "branch";
  if (starter?.outcome === "failed") tone = "failure";
  const expanded = props.expanded ?? (filteringNow ? true : !collapsed);
  return (
    <RowFrame
      {...frameProps(props, expanded)}
      selected={selected}
      chrome={{
        tile: running ? "plane" : "A",
        tone,
        name: branch.sentence,
        meta: parts,
        pill: running ? { text: "Running", tone: "live" } : undefined,
        running,
        toggle: expanded,
      }}
    />
  );
}

function EventRowView(props: RowViewProps) {
  const { row } = props;
  const eventKey = row.kind === "event" ? row.eventKey : "";
  const event = useSessionStore((s) => s.events.get(eventKey));
  if (event === undefined) return null;
  return (
    <RowFrame
      {...frameProps(props)}
      selected={false}
      chrome={{
        tile: event.kind === "segment" ? "↧" : "Ⅱ",
        tone: "event",
        name: event.sentence,
        meta: [formatClock(event.at)],
      }}
    />
  );
}

export const RowView = memo(function RowView(props: RowViewProps) {
  const { row } = props;
  const shared = frameProps(props);
  switch (row.kind) {
    case "turn":
      return (
        <TurnRowView
          {...shared}
          expanded={props.expanded}
          requestId={props.requestId}
        />
      );
    case "step":
      return <StepRowView {...shared} />;
    case "human":
      return <HumanRowView {...shared} />;
    case "branch":
      return <BranchRowView {...shared} expanded={props.expanded} />;
    case "event":
      return <EventRowView {...shared} />;
    case "waiting":
      // The waiting line is not a tree item: it stands out of
      // the tree's roles, and its words live in a status
      // region so they are announced as status, not as a row.
      return (
        <div className="trow trow-waiting" data-row-key={row.key} role="none">
          <span className="waiting-dot" aria-hidden="true"></span>
          <span role="status">{row.text}</span>
        </div>
      );
  }
});
