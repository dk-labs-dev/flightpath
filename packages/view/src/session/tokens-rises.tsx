// The tokens lens's rises: under the curve, why the context
// grew — the biggest rises first, each opening to the items
// that entered between its two requests. The sizes are the
// daemon's own: the reply, and a result that is alone in its
// rise, are measured; everything else is an estimate at 2.9
// characters to a token, and an unknown size says so, never
// zero. Selecting a rise — here, or by its point on the
// curve — marks its two points on the curve, so the list and
// the drawing stay one answer.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  RISE_FLOOR,
  type Rise,
  type RiseItem,
  type TokenHistory,
} from "@flightpath/flightpath/api/payloads";
import {
  formatClock,
  formatCount,
  formatSize,
  formatTokens,
} from "@flightpath/flightpath/format";

import { EstimateTag } from "../components/EstimateTag.js";
import { MeasuredTag } from "../components/MeasuredTag.js";
import { SkillFilesList } from "../components/SkillFilesList.js";
import { Explain, LINK_EXPLANATION, RISES_EXPLANATION } from "./explain.js";
import { commandOutputName } from "./words.js";

/** How many rises show before the rest are asked for. */
const SHOWN_FIRST = 10;

const LINK_WORDS: Record<Rise["link"], string> = {
  exact: "steps linked",
  by_time: "steps found by time",
  none: "no step linked",
};

function turnSequences(history: TokenHistory): Map<number, number> {
  return new Map(history.turns.map((turn) => [turn.turnId, turn.sequence]));
}

function turnWords(
  sequences: Map<number, number>,
  turnId: number | null,
): string | null {
  if (turnId === null) return null;
  const sequence = sequences.get(turnId);
  return sequence === undefined ? null : `turn ${formatCount(sequence)}`;
}

function loadLabel(item: Extract<RiseItem, { kind: "load" }>): string {
  switch (item.loadKind) {
    case "skill":
      return `Loaded the ${item.name} skill`;
    case "command-output":
      return commandOutputName(item.name);
    case "instructions":
      return item.name;
  }
}

/** One item's name, as its row reads it — and as its rise's
 * header reads it when the item is the rise's largest named one. */
function riseItemLabel(item: RiseItem, sequences: Map<number, number>): string {
  switch (item.kind) {
    case "step":
    case "branch-return":
      return item.label;
    case "prompt": {
      const words = turnWords(sequences, item.turnId);
      return words === null ? "Your prompt" : `Your prompt, ${words}`;
    }
    case "attachment":
      if (item.name !== null) return item.name;
      return item.attachmentKind === "image" ? "An image" : "A file";
    case "load":
      return loadLabel(item);
    case "reply":
      return "Claude's reply to the request before";
    case "other":
      return "other (system, tools, history)";
  }
}

/** What a collapsed rise says it was: its largest item that
 * has a name, and how many others came with it. The unnamed
 * remainder never leads, however large it is; it is still
 * counted among the others and still listed when the rise
 * opens. */
function riseHeadline(rise: Rise, sequences: Map<number, number>): string {
  const named = rise.items.find((item) => item.kind !== "other");
  if (named === undefined) return "not named";
  const label = riseItemLabel(named, sequences);
  const others = rise.items.length - 1;
  return others === 0 ? label : `${label}, and ${formatCount(others)} more`;
}

/** An item's size, in the screen's voices: a reply's measured
 * figure plain, a step's measured figure plain and tagged, an
 * estimate tagged, an unknown said so. */
function ItemValue({ item }: { item: RiseItem }) {
  if (item.tokens === null) {
    const image = item.kind === "attachment" && item.attachmentKind === "image";
    return (
      <span className="tokens-rise-unknown">
        {image ? "tokens not measured" : "size not known"}
      </span>
    );
  }
  if (!item.estimated) {
    return (
      <span>
        {formatTokens(item.tokens, { exact: true })}
        {item.kind === "step" && <MeasuredTag className="tokens-measured" />}
      </span>
    );
  }
  return (
    <span>
      <span className="tokens-rise-est">about {formatTokens(item.tokens)}</span>{" "}
      <EstimateTag className="tokens-est" />
    </span>
  );
}

/** What a step's result left outside, when less entered
 * than was made: both sizes through the formatter. */
function ItemNote({ item }: { item: RiseItem }) {
  if (item.kind !== "step" || item.rawChars === null || item.chars === null) {
    return null;
  }
  return (
    <small>
      only {formatSize(item.chars)} of the output&rsquo;s{" "}
      {formatSize(item.rawChars)} entered context
    </small>
  );
}

interface RiseRowProps {
  rise: Rise;
  sequences: Map<number, number>;
  turn: string | null;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
}

function RiseChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
      className={
        open
          ? "tokens-rise-chevron tokens-rise-chevron-open"
          : "tokens-rise-chevron"
      }
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function RiseRow({
  rise,
  sequences,
  turn,
  open,
  selected,
  onToggle,
}: RiseRowProps) {
  return (
    <div
      className={selected ? "tokens-rise tokens-rise-selected" : "tokens-rise"}
      data-rise-id={rise.id}
    >
      <div className="tokens-rise-top">
        <button
          type="button"
          className="tokens-rise-head"
          aria-expanded={open}
          onClick={onToggle}
        >
          <RiseChevron open={open} />
          <span className="tokens-rise-delta">
            +{formatTokens(rise.delta, { axis: true })}
          </span>
          <span className="tokens-rise-main">
            <span>{riseHeadline(rise, sequences)}</span>
            <span className="tokens-rise-meta">
              {formatClock(rise.at)}
              {turn !== null && <> · {turn}</>}
            </span>
          </span>
        </button>
        <span className="tokens-rise-side">
          <span className={`tokens-rise-link tokens-rise-link-${rise.link}`}>
            {LINK_WORDS[rise.link]}
          </span>
          <Explain align="right" term="a rise's link" text={LINK_EXPLANATION} />
        </span>
      </div>
      {open && <RiseItems rise={rise} sequences={sequences} />}
    </div>
  );
}

function RiseItemRow({
  item,
  sequences,
}: {
  item: RiseItem;
  sequences: Map<number, number>;
}) {
  return (
    <div className="tokens-rise-item">
      <span>
        <span className="tokens-rise-item-name">
          {riseItemLabel(item, sequences)}
        </span>
        <ItemNote item={item} />
      </span>
      <ItemValue item={item} />
    </div>
  );
}

/** An open rise's items: what entered, each with its size
 * in its own voice. A skill that attached files keeps them
 * under its own row. */
function RiseItems({
  rise,
  sequences,
}: {
  rise: Rise;
  sequences: Map<number, number>;
}) {
  return (
    <div className="tokens-rise-items">
      {rise.items.map((item, index) =>
        item.kind === "load" && item.files !== null ? (
          <div className="tokens-rise-skill" key={index}>
            <RiseItemRow item={item} sequences={sequences} />
            <SkillFilesList
              files={item.files}
              valueClass="tokens-rise-est"
              tagClass="tokens-est"
            />
          </div>
        ) : (
          <RiseItemRow item={item} sequences={sequences} key={index} />
        ),
      )}
    </div>
  );
}

/** The turn a rise landed in, from its end point. */
function turnOfRise(
  history: TokenHistory,
  sequences: Map<number, number>,
  rise: Rise,
): string | null {
  const point = history.main.find(
    (candidate) => candidate.requestId === rise.toRequestId,
  );
  return turnWords(sequences, point?.turnId ?? null);
}

interface RisesFoldProps {
  visible: Rise[];
  history: TokenHistory;
  sequences: Map<number, number>;
  openIds: ReadonlySet<string>;
  selectedRiseId: string | null;
  onToggle: (rise: Rise) => void;
  showAll: boolean;
  total: number;
  onShowAll: () => void;
}

function RisesFold({
  visible,
  history,
  sequences,
  openIds,
  selectedRiseId,
  onToggle,
  showAll,
  total,
  onShowAll,
}: RisesFoldProps) {
  return (
    <>
      <div>
        {visible.map((rise) => (
          <RiseRow
            key={rise.id}
            rise={rise}
            sequences={sequences}
            turn={turnOfRise(history, sequences, rise)}
            open={openIds.has(rise.id)}
            selected={rise.id === selectedRiseId}
            onToggle={() => onToggle(rise)}
          />
        ))}
      </div>
      {!showAll && total > SHOWN_FIRST && (
        <div className="tokens-rises-more">
          <button type="button" className="tokens-show-all" onClick={onShowAll}>
            Show all {formatCount(total)} rises
          </button>
        </div>
      )}
    </>
  );
}

export interface RisesListProps {
  history: TokenHistory;
  selectedRiseId: string | null;
  onSelectRise: (riseId: string) => void;
  /** Bumped when a curve point chooses a rise: the list
   * brings that rise into view. */
  scrollTick: number;
}

/** Bringing a curve-chosen rise into view: past the fold
 * it opens the fold first, and scrolls once the row
 * exists. */
function useRiseScroll(
  rootRef: RefObject<HTMLElement | null>,
  rises: Rise[],
  selectedRiseId: string | null,
  scrollTick: number,
  showAll: boolean,
  setShowAll: (show: boolean) => void,
): void {
  // The tick the scroll last answered. A live refresh
  // brings a new rises array under the same tick, and the
  // scroll belongs to the click, not to the data.
  const answeredTick = useRef(0);
  useEffect(() => {
    if (selectedRiseId === null) return;
    if (answeredTick.current === scrollTick) return;
    const index = rises.findIndex((rise) => rise.id === selectedRiseId);
    if (index === -1) return;
    if (index >= SHOWN_FIRST && !showAll) {
      setShowAll(true);
      return;
    }
    const row = rootRef.current?.querySelector(
      `[data-rise-id="${selectedRiseId}"]`,
    );
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: "nearest" });
    answeredTick.current = scrollTick;
  }, [scrollTick, selectedRiseId, rises, showAll, setShowAll, rootRef]);
}

/** Opening the fold on the reader's ask moves focus to
 * the first newly shown rise's head: the button that was
 * pressed unmounts, and focus must not fall to the page.
 * The curve click opens the same fold without arming
 * this — its focus stays on the curve. */
function useShowAllFocus(
  rootRef: RefObject<HTMLElement | null>,
  rises: Rise[],
  showAll: boolean,
  setShowAll: (show: boolean) => void,
): () => void {
  const armed = useRef(false);
  useEffect(() => {
    if (!showAll || !armed.current) return;
    armed.current = false;
    const firstNew = rises[SHOWN_FIRST];
    if (firstNew === undefined) return;
    const head = rootRef.current?.querySelector<HTMLElement>(
      `[data-rise-id="${firstNew.id}"] .tokens-rise-head`,
    );
    head?.focus();
  }, [showAll, rises, rootRef]);
  return () => {
    armed.current = true;
    setShowAll(true);
  };
}

function RisesHead({ total }: { total: number }) {
  const count = total === 1 ? "1 rise" : `${formatCount(total)} rises`;
  return (
    <div className="tokens-card-head">
      <h2 id="tokens-rises-h">Biggest rises</h2>
      <Explain term="a rise" text={RISES_EXPLANATION} />
      <span className="tokens-card-sub tokens-rises-count">
        {count} over {formatTokens(RISE_FLOOR, { axis: true })} tokens
      </span>
    </div>
  );
}

export function RisesList({
  history,
  selectedRiseId,
  onSelectRise,
  scrollTick,
}: RisesListProps) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const sequences = useMemo(() => turnSequences(history), [history]);
  const rises = history.rises;
  const visible = showAll ? rises : rises.slice(0, SHOWN_FIRST);
  useRiseScroll(
    rootRef,
    rises,
    selectedRiseId,
    scrollTick,
    showAll,
    setShowAll,
  );

  const showAllAndFocus = useShowAllFocus(rootRef, rises, showAll, setShowAll);

  const toggle = (rise: Rise): void => {
    onSelectRise(rise.id);
    setOpenIds((was) => {
      const next = new Set(was);
      if (next.has(rise.id)) next.delete(rise.id);
      else next.add(rise.id);
      return next;
    });
  };

  return (
    <section
      className="tokens-card"
      aria-labelledby="tokens-rises-h"
      ref={rootRef}
    >
      <RisesHead total={rises.length} />
      <RisesFold
        visible={visible}
        history={history}
        sequences={sequences}
        openIds={openIds}
        selectedRiseId={selectedRiseId}
        onToggle={toggle}
        showAll={showAll}
        total={rises.length}
        onShowAll={showAllAndFocus}
      />
    </section>
  );
}
