// The step tree: a virtualized list (TanStack Virtual) over
// the flat rows, so a 5,000-step session renders only the
// rows in view. Keyboard follows the tree pattern — up and
// down move, left collapses or goes to the parent, right
// expands, Enter opens a step's details. "Follow live" keeps
// the newest row in view until the user scrolls up.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import type { SnapshotSummary } from "@flightpath/flightpath/api/payloads";

import type { SessionViewState } from "../view-state.js";
import { useClockStore } from "./clock.js";
import {
  openSnapshotAfterCompaction,
  openSnapshotAtTurn,
} from "./compaction-request.js";
import { useSessionDataSlice } from "./data-slice.js";
import { isPhoneWidth } from "./detail.js";
import { rowMarkers, type RowMarker } from "./findings.js";
import { useFindingsState } from "./findings-context.js";
import { buildRows, rowAction, type Row, type RowChoices } from "./rows.js";
import { RowView } from "./rows-view.js";
import { useSessionStore } from "./store.js";

export interface ScrollRequest {
  stepId: number;
  nonce: number;
}

export interface StepTreeProps {
  scrollRequest: ScrollRequest | null;
  restoredPlace: SessionViewState | null;
  onPlace: (
    scrollTop: number,
    anchorKey: string | null,
    anchorOffset: number,
  ) => void;
  onRestoreSettled: () => void;
}

type TreeVirtualizer = Virtualizer<HTMLDivElement, Element>;

/** The waiting line, as a pure function of the state it is
 * handed: whether a step is running is read from the set the
 * store keeps current, never from a scan of every step. */
export function waitingText(
  summary: SnapshotSummary | null,
  openStepIds: ReadonlySet<number>,
  nowMs: number,
): string | null {
  if (summary === null || summary.status !== "live") return null;
  if (openStepIds.size > 0) return null;
  if (summary.waitingSince !== null) return "Waiting for you";
  if (summary.lastStepAt !== null && nowMs - summary.lastStepAt >= 120_000) {
    const minutes = Math.floor((nowMs - summary.lastStepAt) / 60_000);
    return `No new steps for ${minutes} minutes`;
  }
  return null;
}

/** The waiting line's words, from the summary, the steps
 * still running, and the clock. */
function useWaiting(): string | null {
  const summary = useSessionStore((s) => s.sessionSummary);
  const openStepIds = useSessionStore((s) => s.openStepIds);
  const nowMs = useClockStore((s) => s.nowMs);
  return useMemo(
    () => waitingText(summary, openStepIds, nowMs),
    [summary, openStepIds, nowMs],
  );
}

/** The steps tree's choices as the store holds them, bar
 * the waiting line, which the tree reads separately. */
function useRowChoices(): Omit<RowChoices, "waiting"> {
  const collapsedTurns = useSessionStore((s) => s.collapsedTurns);
  const collapsedBranches = useSessionStore((s) => s.collapsedBranches);
  const failuresOnly = useSessionStore((s) => s.failuresOnly);
  const steppedInOnly = useSessionStore((s) => s.steppedInOnly);
  const search = useSessionStore((s) => s.search);
  return useMemo(
    () => ({
      collapsedTurns,
      collapsedBranches,
      failuresOnly,
      steppedInOnly,
      search,
    }),
    [collapsedTurns, collapsedBranches, failuresOnly, steppedInOnly, search],
  );
}

function useRows(): Row[] {
  const data = useSessionDataSlice();
  const choices = useRowChoices();
  const waiting = useWaiting();
  return useMemo(
    () => buildRows(data, { ...choices, waiting }),
    [data, choices, waiting],
  );
}

const NO_TURNS: ReadonlySet<number> = new Set();

/** The markers the tree draws. A turn that stands shut carries
 * the markers of the steps inside it; a filter opens every turn,
 * so it never moves a marker off its step. */
function useRowMarkers(): ReadonlyMap<string, RowMarker> {
  const { findings, anchors } = useFindingsState();
  const steps = useSessionStore((s) => s.steps);
  const collapsedTurns = useSessionStore((s) => s.collapsedTurns);
  const filtering = useSessionStore(
    (s) => s.failuresOnly || s.steppedInOnly || s.search !== "",
  );
  return useMemo(
    () =>
      rowMarkers(
        findings,
        anchors,
        steps,
        filtering ? NO_TURNS : collapsedTurns,
      ),
    [findings, anchors, steps, collapsedTurns, filtering],
  );
}

function parentKey(rows: Row[], index: number): string | null {
  const row = rows[index];
  if (row === undefined || row.depth === 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate !== undefined && candidate.depth < row.depth) {
      return candidate.key;
    }
  }
  return null;
}

interface KeyActions {
  moveActive: (key: string) => void;
  activate: (row: Row) => void;
  /** Whether a turn or branch row stands open, in the
   * folds the reader keeps — the store's for the steps
   * tree, its own for a reader with separate folds. */
  isOpen: (row: Row) => boolean;
  /** Fold or unfold a turn or branch row. */
  toggle: (row: Row) => void;
}

function arrowRight(
  rows: Row[],
  row: Row,
  index: number,
  actions: KeyActions,
): void {
  if ((row.kind === "turn" || row.kind === "branch") && !actions.isOpen(row)) {
    actions.toggle(row);
    return;
  }
  const next = rows[index + 1];
  if (next !== undefined && next.depth > row.depth) {
    actions.moveActive(next.key);
  }
}

function arrowLeft(
  rows: Row[],
  row: Row,
  index: number,
  actions: KeyActions,
): void {
  if ((row.kind === "turn" || row.kind === "branch") && actions.isOpen(row)) {
    actions.toggle(row);
    return;
  }
  const parent = parentKey(rows, index);
  if (parent !== null) actions.moveActive(parent);
}

/** A row the keyboard can land on: one that opens or toggles. */
function focusable(row: Row): boolean {
  return rowAction(row) !== null;
}

function steppedRow(
  rows: Row[],
  from: number,
  direction: 1 | -1,
): Row | undefined {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    const row = rows[i];
    if (row !== undefined && focusable(row)) return row;
  }
  return undefined;
}

/** The tree pattern's keys, worked on the row under the active key. */
export function handleTreeKey(
  event: KeyboardEvent,
  rows: Row[],
  activeKey: string | null,
  actions: KeyActions,
): void {
  const found = rows.findIndex((row) => row.key === activeKey);
  const current = found === -1 ? 0 : found;
  const row = rows[current];
  if (row === undefined) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = steppedRow(rows, current, event.key === "ArrowDown" ? 1 : -1);
    if (next !== undefined) actions.moveActive(next.key);
  } else if (event.key === "Home") {
    event.preventDefault();
    const first = rows.find((candidate) => focusable(candidate));
    if (first !== undefined) actions.moveActive(first.key);
  } else if (event.key === "End") {
    event.preventDefault();
    const last = steppedRow(rows, rows.length, -1);
    if (last !== undefined) actions.moveActive(last.key);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    arrowRight(rows, row, current, actions);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    arrowLeft(rows, row, current, actions);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    actions.activate(row);
  }
}

/** Follow live: while following, steps arriving scroll the
 * newest row into view. The trigger is the store's count of
 * arrived steps — a filter change, a collapse or the waiting
 * row coming and going also changes the last row, and none
 * of those is a step arriving. Turning follow on goes to the
 * newest row too. */
function useFollowLive(rows: Row[], virtualizer: TreeVirtualizer): void {
  const arrivedSteps = useSessionStore((s) => s.arrivedSteps);
  const followLive = useSessionStore((s) => s.followLive);
  const seen = useRef({ arrived: 0, follow: false });
  useEffect(() => {
    const grew = arrivedSteps > seen.current.arrived;
    const turnedOn = followLive && !seen.current.follow;
    seen.current = { arrived: arrivedSteps, follow: followLive };
    if (!followLive || (!grew && !turnedOn)) return;
    if (rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows' length is the scroll target; the triggers are the count and the toggle
  }, [arrivedSteps, followLive]);
}

/** A scroll request: open the step's turn and branch, then show its row. */
function useScrollRequest(
  request: ScrollRequest | null,
  focusRow: (key: string) => void,
  setActiveKey: (key: string) => void,
): void {
  useEffect(() => {
    if (request === null) return;
    const state = useSessionStore.getState();
    const step = state.steps.get(request.stepId);
    if (step === undefined) return;
    if (step.turnId !== null) state.expandTurn(step.turnId);
    if (step.branchId !== null && state.collapsedBranches.has(step.branchId)) {
      state.toggleBranch(step.branchId);
    }
    const key = `step-${request.stepId}`;
    setActiveKey(key);
    // A request that also opened the phone sheet leaves focus
    // to the sheet, which traps it.
    if (state.detail === null || !isPhoneWidth()) focusRow(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a new request arrives, not on row changes
  }, [request]);
}

/** The row a saved place hangs from: the anchor it saved,
 * or — for a place saved with no anchor — the selected
 * step's row. */
function anchorKeyOf(place: SessionViewState): string | null {
  if (place.anchorKey !== null) return place.anchorKey;
  return place.selectedStepId !== null ? `step-${place.selectedStepId}` : null;
}

interface RestoreProgress {
  started: boolean;
  settled: boolean;
  stable: number;
  raf: number;
  startedAt: number;
  stopListening: (() => void) | null;
}

interface RestoreInputs {
  rows: Row[];
  place: SessionViewState | null;
  scrollEl: HTMLDivElement | null;
  virtualizer: TreeVirtualizer;
}

const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function stopRestoreListening(progress: RestoreProgress): void {
  progress.stopListening?.();
  progress.stopListening = null;
}

function finishRestore(progress: RestoreProgress): void {
  progress.settled = true;
  cancelAnimationFrame(progress.raf);
  stopRestoreListening(progress);
}

/** Listen, for the life of the restore, for input that
 * means scrolling. The restore holds its aim against
 * every scroll, the user's included, for as long as it
 * runs — so that input settles it on the spot and the
 * user's scroll stands. Judged by the input, never by
 * the position: the virtualizer's own re-measures move
 * the position too. */
function yieldToUserScroll(
  progress: RestoreProgress,
  el: HTMLDivElement,
  onSettled: () => void,
): void {
  const settle = (): void => {
    finishRestore(progress);
    onSettled();
  };
  // A wheel or a touch drag means scrolling whatever
  // they land on; the other two are judged by what
  // they carry.
  const onScrollInput = (): void => {
    settle();
  };
  const onKeyDown = (event: globalThis.KeyboardEvent): void => {
    if (SCROLL_KEYS.has(event.key)) settle();
  };
  // A press on a row is a selection, not a scroll;
  // only a press on the scrollbar itself — the press
  // whose target is the scroll element — is.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target === el) settle();
  };
  el.addEventListener("wheel", onScrollInput, { passive: true });
  el.addEventListener("touchmove", onScrollInput, { passive: true });
  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  el.addEventListener("keydown", onKeyDown, { passive: true });
  progress.stopListening = () => {
    el.removeEventListener("wheel", onScrollInput);
    el.removeEventListener("touchmove", onScrollInput);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
  };
}

/** One frame of the restore: hold the position at the
 * anchor row's start plus the saved offset within it,
 * re-aiming as rows measure, until the position holds
 * still — or give up after five seconds, so saving is
 * never blocked for good. */
function restoreFrame(
  progress: RestoreProgress,
  latest: RefObject<RestoreInputs>,
  onSettled: () => void,
): void {
  if (progress.settled) return;
  const { rows, place, scrollEl, virtualizer } = latest.current;
  if (place !== null && scrollEl !== null) {
    const key = anchorKeyOf(place);
    const index = key === null ? -1 : rows.findIndex((row) => row.key === key);
    let want: number | null = null;
    if (index >= 0) {
      const item = virtualizer
        .getVirtualItems()
        .find((entry) => entry.index === index);
      if (item === undefined) {
        virtualizer.scrollToIndex(index, { align: "start" });
        progress.stable = 0;
      } else {
        want = item.start + place.anchorOffset;
      }
    } else if (key === null) {
      // No anchor and no selection: the saved offset
      // itself, clamped to the list as it now measures.
      const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      want = Math.min(place.scrollTop, max);
    }
    if (want !== null) {
      if (Math.abs(scrollEl.scrollTop - want) > 1) {
        virtualizer.scrollToOffset(want);
        progress.stable = 0;
      } else {
        progress.stable += 1;
      }
    }
  }
  if (progress.stable >= 2 || performance.now() - progress.startedAt > 5_000) {
    finishRestore(progress);
    onSettled();
    return;
  }
  progress.raf = requestAnimationFrame(() =>
    restoreFrame(progress, latest, onSettled),
  );
}

/** The place a reload saved, restored onto the rows. The
 * anchor is the saved row, not the saved pixel offset:
 * rows are sized by the 56 px estimate until they are
 * measured, so an offset restored before measurement
 * clamps against a shorter list and lands where the
 * selected row is not rendered — and saving that clamped
 * value then overwrote the place itself. The restore
 * scrolls to the anchor row, which the virtualizer
 * re-applies as rows measure, then settles the saved
 * offset within the row — or settles where it stands
 * the moment the user scrolls, whichever comes first.
 * Settling is what the screen waits for before it saves
 * anything, and the settle asks for a save itself, so a
 * scroll taken during the restore is the place that
 * gets kept. The restore waits
 * for the scroll element as well as the rows: the element
 * arrives a render after the tree mounts, and a restore
 * attempted without it is silently dropped. */
function useRestoredScroll(
  rows: Row[],
  place: SessionViewState | null,
  virtualizer: TreeVirtualizer,
  scrollEl: HTMLDivElement | null,
  onSettled: () => void,
): void {
  const progress = useRef<RestoreProgress>({
    started: false,
    settled: false,
    stable: 0,
    raf: 0,
    startedAt: 0,
    stopListening: null,
  });
  const latest = useRef<RestoreInputs>({ rows, place, scrollEl, virtualizer });

  useEffect(() => {
    latest.current = { rows, place, scrollEl, virtualizer };
    const state = progress.current;
    if (state.settled) return;
    const anchorKey = place === null ? null : anchorKeyOf(place);
    if (place === null || (anchorKey === null && place.scrollTop <= 0)) {
      // Nothing saved, or a saved place at the top with
      // no row to hang it from: the tree stands there.
      finishRestore(state);
      onSettled();
      return;
    }
    if (scrollEl === null || rows.length === 0) return;
    const index =
      anchorKey === null ? -1 : rows.findIndex((row) => row.key === anchorKey);
    if (anchorKey !== null && index === -1) {
      // The anchored row is not in this data — folded or
      // filtered away since the save.
      finishRestore(state);
      onSettled();
      return;
    }
    if (state.started) return;
    state.started = true;
    state.startedAt = performance.now();
    yieldToUserScroll(state, scrollEl, onSettled);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
    state.raf = requestAnimationFrame(() =>
      restoreFrame(state, latest, onSettled),
    );
  }, [rows, place, scrollEl, virtualizer, onSettled]);

  useEffect(() => {
    const state = progress.current;
    return () => {
      cancelAnimationFrame(state.raf);
      stopRestoreListening(state);
    };
  }, []);
}

function TreeRows({
  virtualizer,
  rows,
  markers,
  activeKey,
  onActivate,
}: {
  virtualizer: TreeVirtualizer;
  rows: Row[];
  markers: ReadonlyMap<string, RowMarker>;
  activeKey: string | null;
  onActivate: (row: Row) => void;
}) {
  // The roving tab stop rests on the active row, or — before
  // anything is active — on the first row the keyboard can
  // use, never on a row that opens nothing.
  const tabStopKey =
    activeKey ?? rows.find((row) => focusable(row))?.key ?? null;
  return (
    <div
      className="tree-inner"
      role="presentation"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (row === undefined) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            role="presentation"
            className="tree-slot"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <RowView
              row={row}
              tabIndex={row.key === tabStopKey ? 0 : -1}
              marker={markers.get(row.key)}
              onActivate={onActivate}
              onToggle={toggleFold}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Row focus and activation: the roving row, opening and toggling. */
function useRowFocus(
  rows: Row[],
  virtualizer: TreeVirtualizer,
  scrollEl: HTMLDivElement | null,
) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const focusRow = (key: string): void => {
    const index = rows.findIndex((row) => row.key === key);
    if (index === -1) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() => {
      const el = scrollEl?.querySelector<HTMLElement>(
        `[data-row-key="${key}"]`,
      );
      el?.focus({ preventScroll: true });
    });
  };

  const activate = (row: Row): void => {
    // A row that opens nothing takes neither the panel nor
    // the tab stop: clicking it leaves both where they were.
    if (rowAction(row) === null) return;
    setActiveKey(row.key);
    if (row.kind === "step") {
      useSessionStore.getState().openStep(row.stepId);
    } else if (row.kind === "branch" && row.spawningStepId !== null) {
      useSessionStore.getState().openStep(row.spawningStepId);
    } else if (row.kind === "event") {
      openSnapshotAfterCompaction(queryClient, row.eventKey);
    } else if (row.kind === "turn" && row.stepless) {
      openSnapshotAtTurn(queryClient, row.turnId);
    } else {
      toggleFold(row);
    }
  };

  const moveActive = (key: string): void => {
    setActiveKey(key);
    focusRow(key);
  };

  return { activeKey, setActiveKey, focusRow, activate, moveActive };
}

/** The place as it stands, reported to the screen for
 * saving whenever it changes: the scroll position hangs
 * from the selected step's row when that row is on
 * screen, else from the first visible row, with the
 * offset into the row — a bare offset cannot be restored
 * before rows are measured, a row can. */
function usePlaceReporter(
  rows: Row[],
  virtualizer: TreeVirtualizer,
  scrollEl: HTMLDivElement | null,
  onPlace: StepTreeProps["onPlace"],
): () => void {
  const selectedStepId = useSessionStore((s) => s.selectedStepId);
  const lastPlace = useRef<{
    top: number;
    key: string | null;
    offset: number;
  } | null>(null);
  const reportPlace = (): void => {
    if (scrollEl === null) return;
    const top = scrollEl.scrollTop;
    const items = virtualizer.getVirtualItems();
    let key: string | null = null;
    let start: number | null = null;
    if (selectedStepId !== null) {
      const index = rows.findIndex(
        (row) => row.key === `step-${selectedStepId}`,
      );
      const item =
        index === -1 ? undefined : items.find((entry) => entry.index === index);
      if (item !== undefined) {
        key = `step-${selectedStepId}`;
        start = item.start;
      }
    }
    if (key === null) {
      const first = items[0];
      const row = first === undefined ? undefined : rows[first.index];
      if (first !== undefined && row !== undefined) {
        key = row.key;
        start = first.start;
      }
    }
    const offset = start === null ? 0 : top - start;
    const last = lastPlace.current;
    if (
      last !== null &&
      last.top === top &&
      last.key === key &&
      last.offset === offset
    ) {
      return;
    }
    lastPlace.current = { top, key, offset };
    onPlace(top, key, offset);
  };
  useEffect(() => {
    reportPlace();
  });
  return reportPlace;
}

/** Fold or unfold a turn or branch row in the store's folds. */
function toggleFold(row: Row): void {
  const state = useSessionStore.getState();
  if (row.kind === "turn") state.toggleTurn(row.turnId);
  else if (row.kind === "branch") state.toggleBranch(row.branchId);
}

/** The steps tree's folds are the store's: whether a turn
 * or branch row stands open there, and its toggle. */
function storeFolds(): Pick<KeyActions, "isOpen" | "toggle"> {
  return {
    isOpen: (row) => {
      const state = useSessionStore.getState();
      if (row.kind === "turn") return !state.collapsedTurns.has(row.turnId);
      if (row.kind === "branch") {
        return !state.collapsedBranches.has(row.branchId);
      }
      return false;
    },
    toggle: toggleFold,
  };
}

export function StepTree(props: StepTreeProps) {
  const rows = useRows();
  const markers = useRowMarkers();
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 56,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const { activeKey, setActiveKey, focusRow, activate, moveActive } =
    useRowFocus(rows, virtualizer, scrollEl);
  const keyActions = { moveActive, activate, ...storeFolds() };

  useFollowLive(rows, virtualizer);
  useScrollRequest(props.scrollRequest, focusRow, setActiveKey);
  useRestoredScroll(
    rows,
    props.restoredPlace,
    virtualizer,
    scrollEl,
    props.onRestoreSettled,
  );

  const reportPlace = usePlaceReporter(
    rows,
    virtualizer,
    scrollEl,
    props.onPlace,
  );

  const onScroll = (): void => {
    if (scrollEl === null) return;
    reportPlace();
    // Position has its say on follow-live — at the bottom
    // it follows, scrolled up it stops — but the control's
    // explicit off holds against it, and the store keeps
    // that distinction. A follow scroll lands at the
    // bottom, which is where following is decided anyway.
    const atBottom =
      scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 48;
    useSessionStore.getState().followScrolled(atBottom);
  };

  return (
    <>
      <div
        className="tree-scroll"
        role="tree"
        aria-label="Session steps"
        ref={setScrollEl}
        onScroll={onScroll}
        onKeyDown={(event) => handleTreeKey(event, rows, activeKey, keyActions)}
      >
        <TreeRows
          virtualizer={virtualizer}
          rows={rows}
          markers={markers}
          activeKey={activeKey}
          onActivate={activate}
        />
      </div>
      {rows.length === 0 && (
        <p className="empty">No steps match. Clear the search or filters.</p>
      )}
    </>
  );
}
