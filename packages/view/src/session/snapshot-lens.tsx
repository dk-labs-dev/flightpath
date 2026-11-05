// The snapshot lens: pick a step, and see what the agent
// had been given by then — the items that had entered the
// step's thread since the session started or the last
// compaction, grouped and sized, never contents, against
// how full the context was — with what every request
// carries before any work, and, after a compaction, what
// was there before it and what was put back. A turn that
// ran no step is picked by its request. The list is one
// query, keyed by the step or the request; while the step
// shown is the session's latest, the stream's news
// refreshes it, and any other snapshot is fixed, because
// its context can't change.

import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  itemTokens,
  type CompactionView,
  type ContextAsk,
  type ContextAtStep,
  type ContextItem,
  type FixedLoad,
  type StartupLoad,
  type TokenHistory,
  type TokenPoint,
} from "@flightpath/flightpath/api/payloads";
import {
  formatClock,
  formatCount,
  formatSize,
  formatTokens,
} from "@flightpath/flightpath/format";

import { ChevronIcon } from "../components/icons.js";
import { EstimateTag } from "../components/EstimateTag.js";
import { MeasuredTag } from "../components/MeasuredTag.js";
import { SkillFilesList } from "../components/SkillFilesList.js";
import { countLine } from "../counts.js";
import { useContextAt, useTokenHistory } from "./api.js";
import { useSessionDataSlice } from "./data-slice.js";
import {
  ESTIMATE_EXPLANATION,
  Explain,
  FIXED_LOAD_EXPLANATION,
  MEASURED_EXPLANATION,
  NAMED_EXPLANATION,
  OTHER_EXPLANATION,
} from "./explain.js";
import { sessionLoadLine } from "./load-line.js";
import { buildRows, type Row } from "./rows.js";
import { RowView } from "./rows-view.js";
import { SessionStatements } from "./statements.js";
import { useSessionStore } from "./store.js";
import { handleTreeKey } from "./tree.js";
import type { StepRow, TurnShell } from "./types.js";
import { commandOutputName, requestTurnName } from "./words.js";

/** The groups in their fixed order, each with the item
 * kinds it gathers and the noun its count reads with,
 * singular and plural. */
const GROUPS: {
  title: string;
  kinds: ReadonlySet<string>;
  one: string;
  many: string;
}[] = [
  {
    title: "Your prompts",
    kinds: new Set(["prompt"]),
    one: "prompt",
    many: "prompts",
  },
  {
    title: "Images and files",
    kinds: new Set(["image", "file"]),
    one: "image or file",
    many: "images or files",
  },
  {
    title: "Instructions (CLAUDE.md)",
    kinds: new Set(["instructions"]),
    one: "instruction file",
    many: "instruction files",
  },
  {
    title: "Skills",
    kinds: new Set(["skill"]),
    one: "skill",
    many: "skills",
  },
  {
    title: "Command output",
    kinds: new Set(["command-output"]),
    one: "report",
    many: "reports",
  },
  {
    title: "Files read",
    kinds: new Set(["file-read"]),
    one: "file",
    many: "files",
  },
  {
    title: "Tool results",
    kinds: new Set(["tool-result"]),
    one: "tool result",
    many: "tool results",
  },
  {
    title: "Subagent results",
    kinds: new Set(["subagent-result"]),
    one: "subagent result",
    many: "subagent results",
  },
  {
    title: "Claude's replies",
    kinds: new Set(["reply"]),
    one: "reply",
    many: "replies",
  },
];

/** A measured size, in the lens's plain voice. A sum
 * carries its own class alongside. */
function Measured({
  tokens,
  className,
}: {
  tokens: number;
  className?: string;
}) {
  return (
    <span
      className={
        className === undefined
          ? "snapshot-measured"
          : `${className} snapshot-measured`
      }
    >
      {formatCount(tokens)} tokens
    </span>
  );
}

/** An estimated size, in the lens's estimate voice: the
 * value says "about" and the tag says "est." */
function Estimate({ tokens }: { tokens: number }) {
  return (
    <>
      <span className="snapshot-est-value">about {formatTokens(tokens)}</span>
      <EstimateTag className="snapshot-est" />
    </>
  );
}

/** A size Claude Code's own `/context` report gave: plain,
 * as a measured one is, and tagged with where it came from. */
function ReportedSize({ tokens }: { tokens: number }) {
  return (
    <>
      <span className="snapshot-measured">{formatTokens(tokens)}</span>
      <span className="snapshot-from-context">from /context</span>
    </>
  );
}

/** A tool result's size read off the context's rise: plain,
 * and tagged as measured. */
function MeasuredResultSize({ tokens }: { tokens: number }) {
  return (
    <>
      <span className="snapshot-measured">{formatTokens(tokens)}</span>
      <MeasuredTag className="snapshot-from-context" />
    </>
  );
}

/** An unknown size, named unknown: the one wording every
 * size voice falls back to. */
function UnknownSize() {
  return <span className="snapshot-unknown">size not known</span>;
}

/** An image's tokens are in no figure Claude Code reports:
 * its bytes are known, its tokens are not measured. */
function UnmeasuredTokens() {
  return <span className="snapshot-unknown">tokens not measured</span>;
}

/** One item's size: a reply's is measured and plain, a
 * result the rise measures is plain and tagged, every other
 * known size is an estimate and says so, and an unknown size
 * is named unknown. */
function ItemSize({ item }: { item: ContextItem }) {
  if (item.kind === "reply") {
    return <Measured tokens={item.tokens} />;
  }
  if (item.kind === "image") {
    return <UnmeasuredTokens />;
  }
  if (item.tokens === null) {
    return <UnknownSize />;
  }
  if (
    (item.kind === "file-read" || item.kind === "tool-result") &&
    item.measured
  ) {
    return (
      <span>
        <MeasuredResultSize tokens={item.tokens} />
      </span>
    );
  }
  return (
    <span>
      <Estimate tokens={item.tokens} />
    </span>
  );
}

/** One item's name: a path in the monospace face, a prompt
 * by its turn, the rest by what the record calls them. */
function itemName(item: ContextItem): { text: string; path: boolean } {
  switch (item.kind) {
    case "prompt":
      return { text: `Turn ${item.sequence} prompt`, path: false };
    case "image":
      return { text: item.name ?? "an image", path: item.name !== null };
    case "file":
      return { text: item.name ?? "a file", path: item.name !== null };
    case "instructions":
    case "skill":
      return { text: item.name, path: true };
    case "command-output":
      return { text: commandOutputName(item.name), path: false };
    case "file-read":
      return { text: item.path, path: true };
    case "tool-result":
    case "subagent-result":
      return { text: item.label, path: false };
    case "reply":
      return { text: "Claude's reply", path: false };
  }
}

/** An item the record measures: a reply by the API's own
 * count, a read or a result by the context's rise. */
function itemMeasured(item: ContextItem): boolean {
  if (item.kind === "reply") return true;
  if (item.kind === "file-read" || item.kind === "tool-result") {
    return item.measured;
  }
  return false;
}

/** A group's sum, in the same voices as its rows:
 * measured when every item in it is measured, an estimate
 * over the known sizes otherwise, and unknown when
 * nothing is known. An empty group shows a dash. */
function GroupSum({ items }: { items: ContextItem[] }) {
  if (items.length === 0) return <span className="snapshot-sum">—</span>;
  const known = items.reduce((sum, item) => sum + (itemTokens(item) ?? 0), 0);
  if (items.every((item) => itemTokens(item) === null)) {
    return items.every((item) => item.kind === "image") ? (
      <UnmeasuredTokens />
    ) : (
      <UnknownSize />
    );
  }
  if (items.every((item) => item.kind === "reply")) {
    return <Measured tokens={known} className="snapshot-sum" />;
  }
  if (items.every(itemMeasured)) {
    return (
      <span className="snapshot-sum">
        <MeasuredResultSize tokens={known} />
      </span>
    );
  }
  return (
    <span className="snapshot-sum">
      <Estimate tokens={known} />
    </span>
  );
}

function ItemRow({ item, sized }: { item: ContextItem; sized: boolean }) {
  const name = itemName(item);
  return (
    <>
      <div className="snapshot-row">
        <span className={name.path ? "snapshot-path" : undefined}>
          {name.text}
        </span>
        {item.kind === "image" && item.bytes !== null && (
          <span className="snapshot-detail">{formatSize(item.bytes)}</span>
        )}
        {sized && <ItemSize item={item} />}
      </div>
      {sized && "files" in item && item.files !== null && (
        <div className="snapshot-skill-files">
          <SkillFilesList
            files={item.files}
            valueClass="snapshot-est-value"
            tagClass="snapshot-est"
          />
        </div>
      )}
    </>
  );
}

/** An item's stable key, from the id the record gives it,
 * so a re-sorted group keeps each row's identity. Images
 * and files carry no id of their own, so theirs adds their
 * position among that turn's attachments in the payload. */
function itemKey(item: ContextItem, attachmentAt: number): string {
  switch (item.kind) {
    case "prompt":
      return `prompt-${item.turnId}`;
    case "image":
    case "file":
      return `${item.kind}-${item.turnId}-${attachmentAt}`;
    case "instructions":
    case "skill":
    case "command-output":
      return `${item.kind}-${item.loadId}`;
    case "file-read":
      return `file-read-${item.stepId}`;
    case "tool-result":
      return `tool-result-${item.stepId}`;
    case "subagent-result":
      return `subagent-result-${item.stepId}`;
    case "reply":
      return `reply-${item.requestId}`;
  }
}

/** Each item's key, worked out over the payload's own
 * order before any sorting moves the rows. */
function itemKeys(items: ContextItem[]): Map<ContextItem, string> {
  const keys = new Map<ContextItem, string>();
  const attachments = new Map<number, number>();
  for (const item of items) {
    let at = 0;
    if (item.kind === "image" || item.kind === "file") {
      at = attachments.get(item.turnId) ?? 0;
      attachments.set(item.turnId, at + 1);
    }
    keys.set(item, itemKey(item, at));
  }
  return keys;
}

/** One group: its header carries the count and the sum, and
 * its rows stand open or shut by the person's choice. The
 * first group starts open, the rest shut. */
function ItemGroup({
  title,
  items,
  one,
  many,
  countedAbove,
  startsOpen,
}: {
  title: string;
  items: ContextItem[];
  one: string;
  many: string;
  countedAbove: boolean;
  startsOpen: boolean;
}) {
  const [open, setOpen] = useState(startsOpen);
  const keys = useMemo(() => itemKeys(items), [items]);
  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => (itemTokens(b) ?? -1) - (itemTokens(a) ?? -1)),
    [items],
  );
  return (
    <div className="snapshot-group">
      <button
        type="button"
        className="snapshot-group-head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronIcon open={open} size={16} />
        <span className="snapshot-group-title">{title}</span>
        <span className="snapshot-group-count">
          {items.length === 0 ? "none" : countLine(items.length, one, many)}
          {countedAbove && " · counted above"}
        </span>
        {items.length > 0 && !countedAbove && <GroupSum items={items} />}
      </button>
      {open &&
        sorted.map((item) => (
          <ItemRow key={keys.get(item)} item={item} sized={!countedAbove} />
        ))}
    </div>
  );
}

/** The grouped list itself: the groups in their order,
 * each holding its share of the items. The step's own
 * list and a compaction's before stretch draw it alike.
 * Instruction files are sized in the fixed load above the
 * list when it is split, and the list only names them. */
function GroupedItems({
  items,
  instructionsCountedAbove = false,
}: {
  items: ContextItem[];
  instructionsCountedAbove?: boolean;
}) {
  return GROUPS.map((group, index) => (
    <ItemGroup
      key={group.title}
      title={group.title}
      items={items.filter((item) => group.kinds.has(item.kind))}
      one={group.one}
      many={group.many}
      countedAbove={instructionsCountedAbove && group.kinds.has("instructions")}
      startsOpen={index === 0}
    />
  ));
}

/** The measured context as a bar: the named share against
 * the rest, each of the window it was measured in. */
function SizeBar({
  named,
  tokens,
  limit,
}: {
  named: number;
  tokens: number;
  limit: number;
}) {
  return (
    <div className="snapshot-bar" aria-hidden="true">
      <span
        className="snapshot-bar-listed"
        style={{ width: `${(named / limit) * 100}%` }}
      />
      <span
        className="snapshot-bar-rest"
        style={{ width: `${((tokens - named) / limit) * 100}%` }}
      />
    </div>
  );
}

/** The size at the step: the measured context against the
 * limit as a bar and a line, or word that this step's size
 * wasn't recorded. The total line beneath names the
 * measured total and how much of it the list explains. */
function SizeCard({ context }: { context: ContextAtStep }) {
  const measured = context.measured;
  const named = context.totals.named;
  const limit = measured?.window.tokens ?? null;
  return (
    <section className="snapshot-size" aria-labelledby="snapshot-size-h">
      <div className="snapshot-size-head">
        <h2 id="snapshot-size-h">In context at this step</h2>
        {context.scope.kind === "branch" && (
          <span className="snapshot-scope">
            {context.scope.agentType === null
              ? "inside a subagent"
              : `inside the subagent ${context.scope.agentType.toLowerCase()}`}
          </span>
        )}
      </div>
      {measured === null ? (
        <p className="snapshot-not-recorded">
          Context size not recorded for this step.
        </p>
      ) : (
        <>
          <p className="snapshot-size-line">
            <b>{formatTokens(measured.tokens, { axis: true })}</b>
            {limit !== null && measured.share !== null && (
              <>
                {" "}
                of {formatTokens(limit, { axis: true })} (
                {Math.round(measured.share * 100)}
                %)
              </>
            )}
          </p>
          {limit !== null && (
            <SizeBar named={named} tokens={measured.tokens} limit={limit} />
          )}
        </>
      )}
      <p className="snapshot-total">
        Named: <Explain term="Named" text={NAMED_EXPLANATION} /> about{" "}
        {formatTokens(named, { axis: true })}
        {measured !== null && (
          <>
            {" "}
            of {formatCount(measured.tokens)} measured{" "}
            <Explain
              align="right"
              term="measured"
              text={MEASURED_EXPLANATION}
            />{" "}
            ({Math.round((named / measured.tokens) * 100)}%)
          </>
        )}
      </p>
    </section>
  );
}

function flipOpen(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function withOpen(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

interface PickerFolds {
  rows: Row[];
  isOpen: (row: Row) => boolean;
  toggle: (row: Row) => void;
  openShown: () => void;
}

/** What the picker stands on: the shown step's row, or the
 * turn the shown request was sent in. */
interface PickerAnchor {
  rowKey: string | null;
  turnId: number | null;
  branchId: number | null;
}

function stepAnchor(step: StepRow): PickerAnchor {
  return {
    rowKey: `step-${step.id}`,
    turnId: step.turnId,
    branchId: step.branchId,
  };
}

function requestAnchor(turnId: number | null): PickerAnchor {
  return {
    rowKey: turnId === null ? null : `turn-${turnId}`,
    turnId,
    branchId: null,
  };
}

/** The picker's folds, held as their exceptions: the open
 * turns and branches — the anchor's to start, plus what the
 * person opens. The shut sets are derived from the data on
 * each build, so a turn or branch that lands after the lens
 * opens takes the default and stands shut. */
function usePickerFolds(anchor: PickerAnchor): PickerFolds {
  const data = useSessionDataSlice();
  const [openTurns, setOpenTurns] = useState<ReadonlySet<number>>(() =>
    anchor.turnId === null ? new Set() : new Set([anchor.turnId]),
  );
  const [openBranches, setOpenBranches] = useState<ReadonlySet<number>>(() =>
    anchor.branchId === null ? new Set() : new Set([anchor.branchId]),
  );
  const shutTurns = useMemo(() => {
    const shut = new Set<number>();
    for (const turn of data.turns.values()) {
      if (!openTurns.has(turn.id)) shut.add(turn.id);
    }
    return shut;
  }, [data, openTurns]);
  const shutBranches = useMemo(() => {
    const shut = new Set<number>();
    for (const branch of data.branches.values()) {
      if (!openBranches.has(branch.id)) shut.add(branch.id);
    }
    return shut;
  }, [data, openBranches]);
  const rows = useMemo(
    () =>
      buildRows(data, {
        collapsedTurns: shutTurns,
        collapsedBranches: shutBranches,
        failuresOnly: false,
        steppedInOnly: false,
        search: "",
        waiting: null,
      }),
    [data, shutTurns, shutBranches],
  );
  const isOpen = (row: Row): boolean => {
    if (row.kind === "turn") return openTurns.has(row.turnId);
    if (row.kind === "branch") return openBranches.has(row.branchId);
    return false;
  };
  const toggle = (row: Row): void => {
    if (row.kind === "turn") setOpenTurns((was) => flipOpen(was, row.turnId));
    else if (row.kind === "branch") {
      setOpenBranches((was) => flipOpen(was, row.branchId));
    }
  };
  const openShown = (): void => {
    const { turnId, branchId } = anchor;
    if (turnId !== null) setOpenTurns((was) => withOpen(was, turnId));
    if (branchId !== null) setOpenBranches((was) => withOpen(was, branchId));
  };
  return { rows, isOpen, toggle, openShown };
}

/** The picker's keyboard: the active row and its focus,
 * worked by the tree's keys. One tab stop, on the active
 * row — the shown step until the keys move it. */
interface PickerKeys {
  activeKey: string | null;
  showRow: (key: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function usePickerKeys(
  rows: Row[],
  actions: {
    activate: (row: Row) => void;
    isOpen: (row: Row) => boolean;
    toggle: (row: Row) => void;
  },
): PickerKeys {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const moveActive = (key: string): void => {
    setActiveKey(key);
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row-key="${key}"]`,
    );
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    handleTreeKey(event, rows, activeKey, { moveActive, ...actions });
  };
  const showRow = (key: string): void => setActiveKey(key);
  return { activeKey, showRow, listRef, onKeyDown };
}

/** The folded list itself: the session's rows under the
 * picker's folds, each row's tab stop the picker's to give.
 * A turn that ran no step stands for the request it sent. */
function PickerList({
  folds,
  replied,
  tabStopKey,
  keys,
  onActivate,
}: {
  folds: PickerFolds;
  replied: ReadonlyMap<number, number>;
  tabStopKey: string;
  keys: PickerKeys;
  onActivate: (row: Row) => void;
}) {
  return (
    <div
      className="snapshot-picker-list"
      role="tree"
      aria-label="Steps"
      ref={keys.listRef}
      onKeyDown={keys.onKeyDown}
    >
      {folds.rows.map((row) => (
        <RowView
          key={row.key}
          row={row}
          tabIndex={row.key === tabStopKey ? 0 : -1}
          expanded={
            row.kind === "turn" || row.kind === "branch"
              ? folds.isOpen(row)
              : undefined
          }
          requestId={row.kind === "turn" ? replied.get(row.turnId) : undefined}
          onActivate={onActivate}
          onToggle={folds.toggle}
        />
      ))}
    </div>
  );
}

/** The request each step-less turn sent last, by turn: the
 * request that carried the turn's reply. */
function useRepliedTurns(
  history: TokenHistory | null,
): ReadonlyMap<number, number> {
  const stepsByTurn = useSessionStore((s) => s.stepsByTurn);
  return useMemo(() => {
    const replied = new Map<number, number>();
    for (const point of history?.main ?? []) {
      if (point.turnId === null) continue;
      if ((stepsByTurn.get(point.turnId)?.length ?? 0) > 0) continue;
      replied.set(point.turnId, point.requestId);
    }
    return replied;
  }, [history, stepsByTurn]);
}

interface PickerActions {
  folds: PickerFolds;
  replied: ReadonlyMap<number, number>;
  foldList: () => void;
}

/** Picking in the list: a step is selected — the
 * selection the lenses share — and so is the request of a
 * turn that ran no step; either folds the list. A turn or
 * branch folds or unfolds under the picker's folds. */
function pickerActivate(row: Row, actions: PickerActions): void {
  const { folds, replied, foldList } = actions;
  if (row.kind === "step") {
    useSessionStore.getState().selectStep(row.stepId);
    foldList();
    return;
  }
  if (row.kind === "branch" && row.spawningStepId !== null) {
    useSessionStore.getState().selectStep(row.spawningStepId);
    foldList();
    return;
  }
  const requestId = row.kind === "turn" ? replied.get(row.turnId) : undefined;
  if (requestId !== undefined) {
    useSessionStore.getState().selectRequest(requestId);
    foldList();
    return;
  }
  folds.toggle(row);
}

/** The row that holds the picker's one tab stop: the
 * active row while it stands in the list; when it has
 * folded away, the nearest row still shown — its branch
 * or its turn — and with neither, the first row. */
function pickerTabStop(
  rows: Row[],
  anchor: PickerAnchor,
  activeKey: string | null,
): string {
  const wanted = activeKey ?? anchor.rowKey;
  const shown = new Set(rows.map((row) => row.key));
  if (wanted !== null && shown.has(wanted)) return wanted;
  const branchRow = rows.find(
    (row) => row.kind === "branch" && row.branchId === anchor.branchId,
  );
  if (branchRow !== undefined) return branchRow.key;
  if (anchor.turnId !== null && shown.has(`turn-${anchor.turnId}`)) {
    return `turn-${anchor.turnId}`;
  }
  return rows[0]?.key ?? "";
}

/** What the snapshot lens is showing: a step, or the request
 * of a turn that ran none. */
type PickerShown =
  | { kind: "step"; step: StepRow; isLatest: boolean }
  | { kind: "request"; requestId: number };

/** The head's words for what is shown. A request is named
 * by its turn, and by its time once the token history says
 * when it started. */
function pickerWords(
  shown: PickerShown,
  turn: TurnShell | undefined,
  point: TokenPoint | undefined,
  stepCount: number,
): { label: string; name: string; meta: string } {
  if (shown.kind === "request") {
    return {
      label: "At request",
      name:
        turn === undefined
          ? "A request"
          : requestTurnName(turn.sequence, stepCount),
      meta: point === undefined ? "" : formatClock(point.at),
    };
  }
  const { step, isLatest } = shown;
  const parts: string[] = [];
  if (turn !== undefined) parts.push(`turn ${turn.sequence}`);
  if (step.startedAt !== null) parts.push(formatClock(step.startedAt));
  if (isLatest) parts.push("latest");
  return { label: "At step", name: step.sentence, meta: parts.join(" · ") };
}

function PickerHead({
  words,
  open,
  onToggle,
}: {
  words: { label: string; name: string; meta: string };
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="snapshot-picker-head">
      <span className="snapshot-picker-label">{words.label}</span>
      <span className="snapshot-picker-name">{words.name}</span>
      <span className="snapshot-picker-meta">{words.meta}</span>
      <button
        type="button"
        className="btn snapshot-picker-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? "Hide the step list" : "Pick another step"}
      </button>
    </div>
  );
}

/** What the token history adds to what is shown: the shown
 * request's point, the anchor the picker stands on, and the
 * turns that ran no step. */
function usePickerHistory(shown: PickerShown) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useSessionStore((s) => s.token);
  const history = useTokenHistory(sessionId, token).data ?? null;
  const point =
    shown.kind === "request"
      ? history?.main.find(
          (candidate) => candidate.requestId === shown.requestId,
        )
      : undefined;
  const anchor =
    shown.kind === "step"
      ? stepAnchor(shown.step)
      : requestAnchor(point?.turnId ?? null);
  return { point, anchor, replied: useRepliedTurns(history) };
}

/** The step or request the lens is showing, named at the
 * top, with the picker folded away until it's asked for —
 * the picker keeps its own folds, so stepping through it
 * never disturbs the steps tree. */
function StepPicker({ shown }: { shown: PickerShown }) {
  const [open, setOpen] = useState(false);
  const { point, anchor, replied } = usePickerHistory(shown);
  const folds = usePickerFolds(anchor);
  const activate = (row: Row): void =>
    pickerActivate(row, {
      folds,
      replied,
      foldList: () => setOpen(false),
    });
  const keys = usePickerKeys(folds.rows, {
    activate,
    isOpen: folds.isOpen,
    toggle: folds.toggle,
  });
  const selectedStepId = useSessionStore((s) => s.selectedStepId);
  const turn = useSessionStore((s) =>
    anchor.turnId === null ? undefined : s.turns.get(anchor.turnId),
  );
  const stepCount = useSessionStore((s) =>
    anchor.turnId === null
      ? 0
      : (s.stepsByTurn.get(anchor.turnId)?.length ?? 0),
  );
  const words = pickerWords(shown, turn, point, stepCount);
  const toggleList = (): void => {
    if (!open) {
      // The shown step or request stands open and holds the
      // tab stop whenever the list is asked for.
      folds.openShown();
      if (anchor.rowKey !== null) keys.showRow(anchor.rowKey);
    }
    setOpen((was) => !was);
  };
  return (
    <section className="snapshot-picker" aria-label="Step">
      <PickerHead words={words} open={open} onToggle={toggleList} />
      {shown.kind === "step" && selectedStepId === null && (
        <p className="snapshot-latest-line">
          Showing the latest step. Pick another in the list below or in Steps.
        </p>
      )}
      {open && (
        <PickerList
          folds={folds}
          replied={replied}
          tabStopKey={pickerTabStop(folds.rows, anchor, keys.activeKey)}
          keys={keys}
          onActivate={activate}
        />
      )}
    </section>
  );
}

/** The list itself: the groups in their order, the row for
 * what the items don't explain, and the plain line about
 * what Flightpath keeps. */
function ItemsCard({ context }: { context: ContextAtStep }) {
  return (
    <section className="snapshot-items" aria-labelledby="snapshot-items-h">
      <div className="snapshot-items-head">
        <h2 id="snapshot-items-h">What the agent had been given</h2>
        <span className="snapshot-items-sub">largest first in each group</span>
      </div>
      <GroupedItems
        items={context.items}
        instructionsCountedAbove={context.fixedLoad?.kind === "split"}
      />
      {context.totals.other !== null && (
        <div className="snapshot-row snapshot-other">
          <span>
            {context.fixedLoad !== null && context.fixedLoad.kind === "split"
              ? "Other (history Flightpath can’t name)"
              : "Other (system, tools, history)"}{" "}
            <Explain term="Other" text={OTHER_EXPLANATION} />
          </span>
          <span>
            <Estimate tokens={context.totals.other} />{" "}
            <Explain align="right" term="est." text={ESTIMATE_EXPLANATION} />
          </span>
        </div>
      )}
      <p className="snapshot-plain">
        Flightpath keeps names and sizes. File contents and tool output stay in
        Claude Code. For the categories of the current moment, run{" "}
        <code>/context</code>.
      </p>
    </section>
  );
}

/** One estimated size in the voices the item rows use: an
 * estimate with its tag, or unknown named unknown. */
function EstimatedSize({ tokens }: { tokens: number | null }) {
  if (tokens === null) {
    return <UnknownSize />;
  }
  return (
    <span>
      <Estimate tokens={tokens} />
    </span>
  );
}

/** One fixed-load row: its name — in the monospace face
 * where the record's name is a path or a tool's name — and
 * its estimated size. */
function FixedRow({
  name,
  mono,
  tokens,
  fromContext = false,
}: {
  name: string;
  mono: boolean;
  tokens: number | null;
  fromContext?: boolean;
}) {
  return (
    <div className="snapshot-row">
      <span className={mono ? "snapshot-path" : undefined}>{name}</span>
      <span />
      {fromContext && tokens !== null ? (
        <span>
          <ReportedSize tokens={tokens} />
        </span>
      ) : (
        <EstimatedSize tokens={tokens} />
      )}
    </div>
  );
}

/** The line over the tools when a `/context` report gave
 * their total: each row below is a share of it, so the rows
 * keep their estimate tags. */
function ToolsReported({ tokens }: { tokens: number }) {
  return (
    <p className="snapshot-tools-reported">
      Tools:{" "}
      <span className="snapshot-measured">
        {formatTokens(tokens, { axis: true })}
      </span>{" "}
      <span className="snapshot-from-context">from /context</span>, shared out
      by definition size
    </p>
  );
}

/** How many tools the fixed load lists before it offers
 * the rest. */
const FIXED_TOOLS_SHOWN = 5;

/** The row offering the tools past the first few: one
 * toggle naming how many tools there are in all. It stays
 * on the panel whichever way it stands, so the keyboard's
 * place survives the press — folded it offers all of
 * them, open it offers the top few again. */
function ShowAllToolsRow({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="snapshot-row">
      <span>
        <button
          type="button"
          className="btn snapshot-show-all"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded
            ? `Show the top ${FIXED_TOOLS_SHOWN}`
            : `Show all ${count} tools`}
        </button>
      </span>
      <span />
      <span />
    </div>
  );
}

/** The fixed load's panel: the section and its heading —
 * what every request carries, before any work — with the
 * split's sum at the head when the load is split. */
function FixedLoadSection({
  sum,
  children,
}: {
  sum?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="snapshot-fixed" aria-labelledby="snapshot-fixed-h">
      <div className="snapshot-items-head">
        <h2 id="snapshot-fixed-h">Sent on every request</h2>
        <Explain
          align="right"
          term="sent on every request"
          text={FIXED_LOAD_EXPLANATION}
        />
        <span className="snapshot-items-sub">before any work</span>
        {sum !== undefined && <span className="snapshot-fixed-sum">{sum}</span>}
      </div>
      {children}
    </section>
  );
}

/** The line one startup addition stands under: what it is,
 * with the count it names when it counts one, a hook's
 * output under its hook's name, a subagent's preloaded skills
 * under their names and its task under the agent type that
 * launched it. */
function startupName(load: StartupLoad): string {
  switch (load.kind) {
    case "skill-listing":
      return load.count === null
        ? "Skills listing"
        : `Skills listing · ${countLine(load.count, "skill", "skills")}`;
    case "mcp-instructions":
      return load.count === null
        ? "MCP server instructions"
        : `MCP server instructions · ${countLine(load.count, "server", "servers")}`;
    case "agent-listing":
      return "Subagent types listing";
    case "deferred-tool-names":
      return load.count === null
        ? "Names of tools loaded on demand"
        : `Names of tools loaded on demand · ${load.count}`;
    case "hook-output":
      return load.name === null ? "Hook output" : `Hook output · ${load.name}`;
    case "preloaded-skill":
      return load.name === null
        ? "Skill loaded at start"
        : `Skill loaded at start · ${load.name}`;
    case "task-prompt":
      return `Task from ${load.name ?? "your conversation"}`;
  }
}

/** The split fixed load: the system prompt, the tools
 * largest first with the rest behind one button, each MCP
 * server with its tool count, then the instruction files,
 * then what was added at session start — every size an
 * estimate from the recorded shape or the startup entries. */
function SplitFixedLoad({
  fixedLoad,
}: {
  fixedLoad: Extract<FixedLoad, { kind: "split" }>;
}) {
  const [allTools, setAllTools] = useState(false);
  const tools = allTools
    ? fixedLoad.tools
    : fixedLoad.tools.slice(0, FIXED_TOOLS_SHOWN);
  return (
    <FixedLoadSection sum={<EstimatedSize tokens={fixedLoad.total} />}>
      <FixedRow
        name="System prompt"
        mono={false}
        tokens={fixedLoad.system.tokens}
        fromContext={fixedLoad.system.fromContext}
      />
      {fixedLoad.toolsReported !== null && (
        <ToolsReported tokens={fixedLoad.toolsReported} />
      )}
      {tools.map((tool) => (
        <FixedRow key={tool.name} name={tool.name} mono tokens={tool.tokens} />
      ))}
      {fixedLoad.tools.length > FIXED_TOOLS_SHOWN && (
        <ShowAllToolsRow
          count={fixedLoad.tools.length}
          expanded={allTools}
          onToggle={() => setAllTools((was) => !was)}
        />
      )}
      {fixedLoad.mcp.map((server) => (
        <FixedRow
          key={server.server}
          name={`MCP · ${server.server} · ${countLine(server.tools, "tool", "tools")}`}
          mono={false}
          tokens={server.tokens}
        />
      ))}
      {fixedLoad.instructions.map((load) => (
        <FixedRow
          key={load.loadId}
          name={load.name}
          mono
          tokens={load.tokens}
        />
      ))}
      {fixedLoad.startup.map((load) => (
        <FixedRow
          key={load.loadId}
          name={startupName(load)}
          mono={false}
          tokens={load.tokens}
          fromContext={load.fromContext}
        />
      ))}
    </FixedLoadSection>
  );
}

/** What every request carried before any work, above the
 * item groups: split from the recorded shape when one was
 * recorded, one line naming the total when it wasn't, and
 * no panel at all when nothing was recorded. */
function FixedLoadPanel({ fixedLoad }: { fixedLoad: FixedLoad }) {
  if (fixedLoad === null) return null;
  if (fixedLoad.kind === "split") {
    return <SplitFixedLoad fixedLoad={fixedLoad} />;
  }
  return (
    <FixedLoadSection>
      <p className="snapshot-fixed-total">
        Fixed load: about {formatTokens(fixedLoad.tokens)}, not split (this
        Claude Code version doesn&rsquo;t record it).
      </p>
    </FixedLoadSection>
  );
}

/** What a restored item says of itself: a recorded file says
 * whether Claude Code read it in again, the rest carry the
 * payload's note about the docs' rule. */
function restoredNote(
  item: CompactionView["restored"][number],
  docsNote: string,
): string {
  if (item.kind !== "file") return docsNote;
  return item.reread ? "re-read by Claude Code" : "named only, not re-read";
}

/** What the compaction put back: each restored item with
 * its note, and the docs' account of the rule behind the
 * restoring. */
function RestoredGroup({ compaction }: { compaction: CompactionView }) {
  return (
    <div className="snapshot-group">
      <div className="snapshot-group-head snapshot-restored-head">
        <span className="snapshot-group-title">Restored after it</span>
        <span className="snapshot-group-count">
          {compaction.restored.length}
        </span>
      </div>
      {compaction.restored.map((item) => (
        <div
          className="snapshot-row snapshot-restored-row"
          key={`${item.kind}-${item.ref}`}
        >
          <span className="snapshot-path">
            {item.kind === "skill" ? `${item.name} (skill)` : item.name}
          </span>
          {item.kind === "file" && item.tokens !== null ? (
            <span>
              <Estimate tokens={item.tokens} />
            </span>
          ) : (
            <span />
          )}
          <span className="snapshot-restored-note">
            {restoredNote(item, compaction.restoredNote)}
          </span>
        </div>
      ))}
      <p className="snapshot-docs">
        After a compaction, Claude Code re-reads up to five recently used files
        and re-adds the skills it had used.{" "}
        <a
          href="https://code.claude.com/docs/en/context-window#what-survives-compaction"
          target="_blank"
          rel="noreferrer"
        >
          How compaction works
        </a>
      </p>
    </div>
  );
}

/** What a compaction dropped and what was put back, under
 * the item groups: the stretch before it, greyed, in the
 * same grouped list, folded until it's asked for. */
function CompactionPanel({ compaction }: { compaction: CompactionView }) {
  const [beforeOpen, setBeforeOpen] = useState(false);
  const before = compaction.before;
  return (
    <section
      className="snapshot-compaction"
      aria-labelledby="snapshot-compaction-h"
    >
      <div className="snapshot-items-head">
        <h2 id="snapshot-compaction-h">
          After the compaction at {formatClock(compaction.at)}
        </h2>
      </div>
      <div className="snapshot-before">
        <div className="snapshot-group">
          <button
            type="button"
            className="snapshot-group-head"
            aria-expanded={beforeOpen}
            onClick={() => setBeforeOpen((was) => !was)}
          >
            <ChevronIcon open={beforeOpen} size={16} />
            <span className="snapshot-group-title">Before the compaction</span>
            <span className="snapshot-group-count">
              {countLine(before.length, "item", "items")}
            </span>
            <GroupSum items={before} />
          </button>
          {beforeOpen && <GroupedItems items={before} />}
        </div>
      </div>
      <RestoredGroup compaction={compaction} />
    </section>
  );
}

/** The last main request that answered a prompt: one sent
 * before any turn began has no turn to be named by. */
function lastTurnRequestId(history: TokenHistory | null): number | null {
  const turnRequests = history?.main.filter((point) => point.turnId !== null);
  return turnRequests?.at(-1)?.requestId ?? null;
}

/** What the lens shows: the selected request, else the
 * selected step, else the latest step; in a session with no
 * step, the last request of the latest turn. Nothing when
 * the session has sent none; `loading` says that answer
 * still waits on the history. */
function usePickerShown(): {
  shown: PickerShown | null;
  ask: ContextAsk | null;
  loading: boolean;
} {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useSessionStore((s) => s.token);
  const selectedRequestId = useSessionStore((s) => s.selectedRequestId);
  const selectedStepId = useSessionStore((s) => s.selectedStepId);
  const latestStepId = useSessionStore((s) => s.latestStepId);
  const steps = useSessionStore((s) => s.steps);
  const historyQuery = useTokenHistory(sessionId, token);
  const history = historyQuery.data ?? null;
  const stepId = selectedStepId ?? latestStepId;
  const fallbackRequestId = stepId === null ? lastTurnRequestId(history) : null;
  const requestId = selectedRequestId ?? fallbackRequestId;
  if (requestId !== null) {
    return {
      shown: { kind: "request", requestId },
      ask: { request: requestId },
      loading: false,
    };
  }
  const step = stepId === null ? undefined : steps.get(stepId);
  if (step === undefined) {
    return {
      shown: null,
      ask: null,
      loading: stepId === null && historyQuery.isPending,
    };
  }
  return {
    shown: { kind: "step", step, isLatest: latestStepId === step.id },
    ask: { step: step.id },
    loading: false,
  };
}

export function SnapshotLens() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useSessionStore((s) => s.token);
  const load = useSessionStore((s) => s.load);
  const { shown, ask, loading } = usePickerShown();
  const query = useContextAt(sessionId, token, ask);

  // While the session itself is still arriving — or didn't
  // — the lens has nothing of its own to show: one line for
  // the state, in the screen's own words for it.
  const loadLine = sessionLoadLine(load);
  if (loadLine !== null) {
    return <p className="empty">{loadLine}</p>;
  }
  if (shown === null) {
    return (
      <p className="empty">
        {loading
          ? "Loading the snapshot…"
          : "No steps recorded for this session yet."}
      </p>
    );
  }
  return (
    <div className="snapshot-lens">
      <StepPicker shown={shown} />
      {query.isPending && <p className="empty">Loading the snapshot…</p>}
      {query.isError && (
        <p className="empty">
          The snapshot couldn&rsquo;t be loaded — the recorder may be
          restarting.
        </p>
      )}
      {query.data === null && (
        <p className="empty">
          This {shown.kind} isn&rsquo;t in the recordings.
        </p>
      )}
      {query.data !== undefined && query.data !== null && (
        <>
          <SessionStatements states={query.data.states} />
          <SizeCard context={query.data} />
          <FixedLoadPanel fixedLoad={query.data.fixedLoad} />
          <ItemsCard context={query.data} />
          {query.data.compaction !== null && (
            <CompactionPanel compaction={query.data.compaction} />
          )}
        </>
      )}
    </div>
  );
}
