// The session screen: the summary and curve, the step tree
// and the detail panel, live. It loads one snapshot; from
// there the shell's stream — the page's one stream — hands
// the store every change, and a reset reloads the snapshot
// into the same store. The place — selection, collapsed
// turns, scroll — survives both because it lives in the
// store and in the saved view state, not in the data.

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useQueryClient } from "@tanstack/react-query";

import { sessionHref, type Lens, type RouteFocus } from "../route.js";
import { backoffMs } from "../stream.js";
import { loadViewState, saveViewState } from "../view-state.js";
import { loadSnapshot, tokenHistoryOptions } from "./api.js";
import { useClockTick } from "./clock.js";
import { StepDetailPanel } from "./detail.js";
import { FindingsList } from "./FindingsList.js";
import { FindingsProvider } from "./findings-context.js";
import { sessionLoadLine } from "./load-line.js";
import { useSessionStore, type SessionStore } from "./store.js";
import { SessionSummary } from "./summary.js";
import { StepTree, type ScrollRequest } from "./tree.js";

function useSessionData(sessionId: string, token: string): void {
  const store = useSessionStore;
  useEffect(() => {
    store.getState().begin(sessionId, token);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const attempt = (): void => {
      void loadSnapshot(token, sessionId).then(
        (snapshot) => {
          if (!live) return;
          if (snapshot === null) {
            store.getState().snapshotMissing();
            return;
          }
          store.getState().snapshot(snapshot);
          store.getState().restorePlace(loadViewState(sessionId));
        },
        () => {
          if (!live) return;
          // A failed load is retried with a growing delay,
          // and the screen says so: the recorder may be
          // restarting, and the load lands when it is back.
          store.getState().snapshotFailed();
          attempts += 1;
          timer = setTimeout(attempt, backoffMs(attempts - 1));
        },
      );
    };
    attempt();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [sessionId, token, store]);
}

/** The tokens lens's history is a second read beside the
 * snapshot. When the address names that lens, its read
 * starts with the snapshot's rather than when the lens
 * mounts, so a long session's curve is already arriving
 * while the screen settles — the lens's own query then
 * reads the warmed cache. */
function useTokenHistoryPrefetch(
  sessionId: string,
  token: string,
  lens: Lens,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (lens !== "tokens") return;
    void queryClient.prefetchQuery(tokenHistoryOptions(sessionId, token));
  }, [sessionId, token, lens, queryClient]);
}

function useSessionClock(): void {
  useClockTick();
  useEffect(() => {
    // New steps announce themselves in batches, not one by
    // one: the flush runs on its own slow interval and writes
    // only when steps are waiting.
    const announce = setInterval(() => {
      useSessionStore.getState().flushAnnouncement();
    }, 10_000);
    return () => clearInterval(announce);
  }, []);
}

function usePlaceSaving(
  sessionId: string,
  scrollTopRef: RefObject<number>,
  anchorRef: RefObject<{ key: string | null; offset: number }>,
  restoreSettledRef: RefObject<boolean>,
  scheduleRef: RefObject<() => void>,
): void {
  const store = useSessionStore;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = (): void => {
      // Nothing is saved while a restore is still settling:
      // the position it reads mid-restore is clamped against
      // unmeasured rows, and saving it would overwrite the
      // very place being restored.
      if (!restoreSettledRef.current) return;
      const state = store.getState();
      saveViewState(sessionId, {
        selectedStepId: state.selectedStepId,
        collapsedTurnIds: [...state.collapsedTurns],
        scrollTop: scrollTopRef.current,
        anchorKey: anchorRef.current.key,
        anchorOffset: anchorRef.current.offset,
      });
    };
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(save, 300);
    };
    scheduleRef.current = schedule;
    // The place is saved when the place changes — the
    // selection, the collapsed turns, the scroll — not on
    // every store change the stream brings.
    const unsubscribe = store.subscribe((state, prev) => {
      if (
        state.selectedStepId !== prev.selectedStepId ||
        state.collapsedTurns !== prev.collapsedTurns
      ) {
        schedule();
      }
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      save();
    };
  }, [
    sessionId,
    store,
    scrollTopRef,
    anchorRef,
    restoreSettledRef,
    scheduleRef,
  ]);
}

function useSearchShortcut(): void {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      event.preventDefault();
      document.getElementById("step-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

function Toolbar() {
  const search = useSessionStore((s) => s.search);
  const failuresOnly = useSessionStore((s) => s.failuresOnly);
  const steppedInOnly = useSessionStore((s) => s.steppedInOnly);
  const followLive = useSessionStore((s) => s.followLive);
  const failures = useSessionStore((s) => s.sessionSummary?.failures ?? 0);
  const steppedIn = useSessionStore((s) => s.sessionSummary?.steppedIn ?? 0);
  const live = useSessionStore((s) => s.sessionSummary?.status === "live");
  const store = useSessionStore;
  return (
    <div className="steps-toolbar">
      <label className="search-box">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7"></circle>
          <path d="M20 20l-3.5-3.5"></path>
        </svg>
        <input
          id="step-search"
          type="search"
          placeholder="Search steps"
          value={search}
          onChange={(event) => store.getState().setSearch(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="filter-button"
        aria-pressed={steppedInOnly}
        onClick={() => store.getState().setSteppedInOnly(!steppedInOnly)}
      >
        You stepped in · {steppedIn}
      </button>
      <button
        type="button"
        className="filter-button"
        aria-pressed={failuresOnly}
        onClick={() => store.getState().setFailuresOnly(!failuresOnly)}
      >
        Failures · {failures}
      </button>
      <button
        type="button"
        className="filter-button"
        aria-pressed={followLive}
        disabled={!live}
        onClick={() => store.getState().setFollowLive(!followLive)}
      >
        Follow live
      </button>
    </div>
  );
}

const LENS_TABS: { lens: Lens; label: string }[] = [
  { lens: "steps", label: "Steps" },
  { lens: "tokens", label: "Tokens" },
  { lens: "snapshot", label: "Snapshot" },
];

const ARROW_OFFSETS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

/** What an address carries for the selection: the request when
 * one is shown in place of a step, else the step. */
function selectionFocus(selection: {
  selectedStepId: number | null;
  selectedRequestId: number | null;
}): RouteFocus {
  if (selection.selectedRequestId !== null) {
    return { request: selection.selectedRequestId };
  }
  if (selection.selectedStepId !== null) {
    return { step: selection.selectedStepId };
  }
  return {};
}

/** The lens tabs: a tablist with manual activation — the
 * arrow keys move between tabs, and Enter or Space chooses
 * the tab with focus, so travelling the tabs never changes
 * the lens by accident. Choosing one is a navigation: it
 * pushes an address naming the lens and the current step,
 * and the back button walks the lenses in reverse. */
function LensTabs({ sessionId, lens }: { sessionId: string; lens: Lens }) {
  const selectedStepId = useSessionStore((s) => s.selectedStepId);
  const selectedRequestId = useSessionStore((s) => s.selectedRequestId);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (next: Lens): void => {
    if (next === lens) return;
    window.location.hash = sessionHref(
      sessionId,
      next,
      selectionFocus({ selectedStepId, selectedRequestId }),
    );
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const offset = ARROW_OFFSETS[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next = (index + offset + LENS_TABS.length) % LENS_TABS.length;
    tabRefs.current[next]?.focus();
  };
  return (
    <div className="lens-group" role="tablist" aria-label="Lens">
      {LENS_TABS.map((tab, index) => (
        <button
          key={tab.lens}
          ref={(button) => {
            tabRefs.current[index] = button;
          }}
          type="button"
          role="tab"
          id={`lens-tab-${tab.lens}`}
          aria-selected={tab.lens === lens}
          aria-controls="lens-panel"
          tabIndex={tab.lens === lens ? 0 : -1}
          className={tab.lens === lens ? "lens-active" : undefined}
          onClick={() => choose(tab.lens)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// The lenses load on demand: each sits behind its own chunk,
// so opening a session pays for the steps lens and the rest
// arrive only when their tab is chosen.
const TokensLens = lazy(() =>
  import("./tokens-lens.js").then((module) => ({
    default: module.TokensLens,
  })),
);
const SnapshotLens = lazy(() =>
  import("./snapshot-lens.js").then((module) => ({
    default: module.SnapshotLens,
  })),
);

/** The steps body's props, grouped so the lens switch
 * hands them on as one. */
interface StepsBodyProps {
  sessionId: string;
  load: SessionStore["load"];
  scrollRequest: ScrollRequest | null;
  onPlace: (
    scrollTop: number,
    anchorKey: string | null,
    anchorOffset: number,
  ) => void;
  onRestoreBegin: () => void;
  onRestoreSettled: () => void;
  onCurveSelect: (stepId: number) => void;
}

const LAZY_LENSES: Record<Exclude<Lens, "steps">, typeof TokensLens> = {
  tokens: TokensLens,
  snapshot: SnapshotLens,
};

/** The open lens's panel. Switching lenses unmounts the one
 * left: its place is the store's and the saved view state's,
 * not the components', so the steps lens comes back to the
 * place it left, as it does after a reload. */
function LensBody({
  lens,
  ...body
}: { lens: Lens } & StepsBodyProps): ReactNode {
  if (lens === "steps") {
    return <ScreenBody {...body} />;
  }
  const LazyLens = LAZY_LENSES[lens];
  return (
    <Suspense fallback={<p className="empty">Loading the lens…</p>}>
      <LazyLens />
    </Suspense>
  );
}

/** The step or request the address names, applied once the
 * snapshot is in. The address wins over the saved place: a
 * deep link is a deliberate address, and the saved place is
 * only where the last visit left off. A step the session
 * doesn't hold selects nothing — the address was written
 * against another session, or the step has gone — and
 * nothing says so; a request the session doesn't hold is
 * answered by the snapshot lens itself. */
function useFocusFromAddress(sessionId: string, focus: RouteFocus): void {
  const load = useSessionStore((s) => s.load);
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (load !== "ready") return;
    if (focus.step === undefined && focus.request === undefined) return;
    const key = `${sessionId}:${focus.step ?? ""}:${focus.request ?? ""}`;
    if (appliedFor.current === key) return;
    appliedFor.current = key;
    const store = useSessionStore.getState();
    if (focus.step !== undefined) {
      store.selectStep(store.steps.has(focus.step) ? focus.step : null);
    } else if (focus.request !== undefined) {
      store.selectRequest(focus.request);
    }
  }, [sessionId, focus, load]);
}

/** The selection, kept in the address as it changes: a
 * selection isn't a navigation, so it replaces the current
 * entry rather than pushing one — the back button walks
 * lenses and screens, never steps. */
function useSelectionInAddress(sessionId: string, lens: Lens): void {
  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (
        state.selectedStepId === prev.selectedStepId &&
        state.selectedRequestId === prev.selectedRequestId
      ) {
        return;
      }
      history.replaceState(
        null,
        "",
        window.location.pathname +
          sessionHref(sessionId, lens, selectionFocus(state)),
      );
    });
    return unsubscribe;
  }, [sessionId, lens]);
}

/** The one banner that is the lens's own: word that the
 * session on screen was deleted. The connection's state is
 * the shell indicator's, and the recorder's health is the
 * shell banner's — the lens draws neither. */
function DeletedNotice() {
  const deleted = useSessionStore((s) => s.sessionDeleted);
  if (!deleted) return null;
  return (
    <p className="stream-banner stream-banner-warn" role="alert">
      This session was deleted. What is on screen is its last state.
    </p>
  );
}

/** The place's working state: the refs the tree reports
 * into, the scheduler the place saving fills in, and
 * whether the restore has settled. A place starts
 * unrestored — saving waits for the settle, on a session
 * switch, a reload, and a lens round trip alike. */
function usePlaceState(sessionId: string) {
  const scrollTopRef = useRef(0);
  const anchorRef = useRef<{ key: string | null; offset: number }>({
    key: null,
    offset: 0,
  });
  const restoreSettledRef = useRef(false);
  const scheduleSaveRef = useRef<() => void>(() => {});
  useEffect(() => {
    restoreSettledRef.current = false;
  }, [sessionId]);
  const onPlace = useCallback(
    (scrollTop: number, anchorKey: string | null, anchorOffset: number) => {
      scrollTopRef.current = scrollTop;
      anchorRef.current = { key: anchorKey, offset: anchorOffset };
      scheduleSaveRef.current();
    },
    [],
  );
  const onRestoreBegin = useCallback(() => {
    restoreSettledRef.current = false;
  }, []);
  const onRestoreSettled = useCallback(() => {
    restoreSettledRef.current = true;
    // The settle asks for a save itself, through the same
    // debounced schedule as every other save: a scroll
    // taken while the restore was settling had its save
    // dropped by the wait above, and this is what keeps
    // that scroll from being lost with it.
    scheduleSaveRef.current();
  }, []);
  return {
    scrollTopRef,
    anchorRef,
    restoreSettledRef,
    scheduleSaveRef,
    onPlace,
    onRestoreBegin,
    onRestoreSettled,
  };
}

/** Choosing a point on the context curve selects its step and
 * asks the steps body to scroll it into view; the nonce makes
 * choosing the same step twice a fresh request. */
function useCurveScroll(): {
  scrollRequest: ScrollRequest | null;
  onCurveSelect: (stepId: number) => void;
} {
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(
    null,
  );
  const nonce = useRef(0);
  const onCurveSelect = useCallback((stepId: number) => {
    useSessionStore.getState().selectStep(stepId);
    nonce.current += 1;
    setScrollRequest({ stepId, nonce: nonce.current });
  }, []);
  return { scrollRequest, onCurveSelect };
}

export function SessionScreen({
  sessionId,
  token,
  lens,
  focus,
}: {
  sessionId: string;
  token: string;
  lens: Lens;
  focus: RouteFocus;
}) {
  const load = useSessionStore((s) => s.load);
  const announcement = useSessionStore((s) => s.announcement);
  const announcementCount = useSessionStore((s) => s.announcementCount);
  const { scrollRequest, onCurveSelect } = useCurveScroll();
  const place = usePlaceState(sessionId);

  useSessionData(sessionId, token);
  useTokenHistoryPrefetch(sessionId, token, lens);
  useSessionClock();
  usePlaceSaving(
    sessionId,
    place.scrollTopRef,
    place.anchorRef,
    place.restoreSettledRef,
    place.scheduleSaveRef,
  );
  useSearchShortcut();
  useFocusFromAddress(sessionId, focus);
  useSelectionInAddress(sessionId, lens);

  return (
    <div className="session-screen">
      <div className="session-head">
        <LensTabs sessionId={sessionId} lens={lens} />
      </div>
      <div
        className="lens-panel"
        role="tabpanel"
        id="lens-panel"
        aria-labelledby={`lens-tab-${lens}`}
      >
        <LensBody
          lens={lens}
          sessionId={sessionId}
          load={load}
          scrollRequest={scrollRequest}
          onPlace={place.onPlace}
          onRestoreBegin={place.onRestoreBegin}
          onRestoreSettled={place.onRestoreSettled}
          onCurveSelect={onCurveSelect}
        />
      </div>
      <div className="sr-announcer" aria-live="polite" role="status">
        <span key={announcementCount}>{announcement}</span>
      </div>
    </div>
  );
}

const STEPS_MIN_PX = 320;
const PANEL_MIN_PX = 280;
/** The split's own footprint in the row: the handle and its two gaps. */
const SPLIT_CHROME_PX = 46;
const DEFAULT_STEPS_WIDTH = 560;
const STEPS_WIDTH_KEY = "flightpath-steps-width";

/** The steps width the person last chose, kept per browser. */
function loadStepsWidth(): number | null {
  try {
    const raw = localStorage.getItem(STEPS_WIDTH_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Storage can refuse (private modes): the split then
    // stands at its default for this visit.
    return null;
  }
}

function saveStepsWidth(width: number): void {
  try {
    localStorage.setItem(STEPS_WIDTH_KEY, String(width));
  } catch {
    // A refused write leaves the default split next visit;
    // the chosen width still holds for this one.
  }
}

/** The widest steps width a container of `container` px
 * allows: any wider and the detail panel would fall below
 * its own minimum, beside the split's footprint. */
function maxStepsWidth(container: number): number {
  return Math.max(STEPS_MIN_PX, container - PANEL_MIN_PX - SPLIT_CHROME_PX);
}

/** A steps width inside both minimums for a container of `container` px. */
function clampStepsWidth(width: number, container: number): number {
  return Math.min(Math.max(width, STEPS_MIN_PX), maxStepsWidth(container));
}

/** Both values are measured on the border box, so they
 * describe the same box. */
function useSeparatorMeasure(
  host: RefObject<HTMLDivElement | null>,
): { now: number; max: number } | null {
  const [measured, setMeasured] = useState<{ now: number; max: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const handle = host.current;
    if (handle === null) return;
    const main = handle.parentElement;
    const panel = handle.previousElementSibling;
    if (main === null || !(panel instanceof HTMLElement)) return;
    const measure = (): void => {
      setMeasured({
        now: panel.offsetWidth,
        max: maxStepsWidth(main.clientWidth),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [host]);
  return measured;
}

function nudgeDelta(event: { key: string; shiftKey: boolean }): number | null {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return null;
  return (event.shiftKey ? 48 : 16) * (event.key === "ArrowRight" ? 1 : -1);
}

/** The drag handle between the tree and the detail panel:
 * dragging moves the split, and the arrow keys move it in
 * steps, wider steps with Shift. */
function PanelResizer({
  onDragTo,
  onNudge,
  onCommit,
}: {
  onDragTo: (clientX: number) => void;
  onNudge: (delta: number) => void;
  onCommit: () => void;
}) {
  const drag = useRef<{ pointerId: number } | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const measured = useSeparatorMeasure(host);
  const endDrag = (event: { pointerId: number }): boolean => {
    if (drag.current?.pointerId !== event.pointerId) return false;
    drag.current = null;
    return true;
  };
  return (
    <div
      ref={host}
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the steps and the detail panel"
      aria-valuemin={STEPS_MIN_PX}
      aria-valuemax={measured?.max}
      aria-valuenow={measured === null ? undefined : Math.round(measured.now)}
      tabIndex={0}
      onPointerDown={(event) => {
        drag.current = { pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) {
          onDragTo(event.clientX);
        }
      }}
      onPointerUp={(event) => {
        if (endDrag(event)) onCommit();
      }}
      onPointerCancel={(event) => {
        if (endDrag(event)) onCommit();
      }}
      onLostPointerCapture={(event) => {
        endDrag(event);
      }}
      onKeyDown={(event) => {
        const delta = nudgeDelta(event);
        if (delta === null) return;
        event.preventDefault();
        onNudge(delta);
      }}
      onKeyUp={(event) => {
        if (nudgeDelta(event) !== null) onCommit();
      }}
    >
      <span className="panel-resizer-grip" aria-hidden="true"></span>
    </div>
  );
}

/** The split between the tree and the panel: the width the
 * person chose, applied inside the two minimums and kept
 * per browser. A drag or a nudge moves the split at once
 * but writes the kept width only when the gesture ends, so
 * a drag doesn't write on every pointer move. */
function useStepsWidth() {
  const [stepsWidth, setStepsWidth] = useState<number | null>(loadStepsWidth);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const chosen = useRef<number | null>(null);
  const apply = useCallback((next: number) => {
    const main = mainRef.current;
    if (main === null) return;
    const width = clampStepsWidth(next, main.clientWidth);
    chosen.current = width;
    setStepsWidth(width);
  }, []);
  const onCommit = useCallback(() => {
    if (chosen.current !== null) saveStepsWidth(chosen.current);
  }, []);
  const onDragTo = useCallback(
    (clientX: number) => {
      const main = mainRef.current;
      if (main === null) return;
      apply(clientX - main.getBoundingClientRect().left);
    },
    [apply],
  );
  const onNudge = useCallback(
    (delta: number) => {
      const panel = mainRef.current?.querySelector(".steps-panel");
      if (!(panel instanceof HTMLElement)) return;
      // The nudge starts from the width as drawn, not the
      // width as stored: a stored width wider than the
      // window allows would spend the first press on the
      // clamp and leave the split where it stands.
      apply(panel.offsetWidth + delta);
    },
    [apply],
  );
  return { stepsWidth, mainRef, onDragTo, onNudge, onCommit };
}

function ScreenBody({
  sessionId,
  load,
  scrollRequest,
  onPlace,
  onRestoreBegin,
  onRestoreSettled,
  onCurveSelect,
}: StepsBodyProps): ReactNode {
  const split = useStepsWidth();
  // The saved place, read as the body mounts: a lens round
  // trip remounts the body, and the place it restores is
  // the one saved by then, not the one the session opened
  // with.
  const restoredPlace = useMemo(() => loadViewState(sessionId), [sessionId]);
  // The remount restores the place again, so saving holds
  // until that restore settles, as it does at a first open.
  useLayoutEffect(() => {
    onRestoreBegin();
  }, [onRestoreBegin]);
  const showInSteps = useCallback(
    (stepId: number) => {
      onCurveSelect(stepId);
      useSessionStore.getState().openStep(stepId, "suggestions");
    },
    [onCurveSelect],
  );
  const loadLine = sessionLoadLine(load);
  if (loadLine !== null) {
    return <p className="empty">{loadLine}</p>;
  }
  return (
    <>
      <SessionSummary onCurveSelect={onCurveSelect} />
      <DeletedNotice />
      <FindingsProvider sessionId={sessionId}>
        <SplitLayout split={split}>
          <section className="steps-panel" aria-label="Steps">
            <Toolbar />
            <FindingsList onShowInSteps={showInSteps} />
            <StepTree
              scrollRequest={scrollRequest}
              restoredPlace={restoredPlace}
              onPlace={onPlace}
              onRestoreSettled={onRestoreSettled}
            />
          </section>
        </SplitLayout>
      </FindingsProvider>
    </>
  );
}

/** The loaded screen's lower half: the steps section, the
 * resizer, and the detail panel in the chosen split. */
function SplitLayout({
  split,
  children,
}: {
  split: ReturnType<typeof useStepsWidth>;
  children: ReactNode;
}) {
  const sized = split.stepsWidth !== null;
  return (
    <div
      className={`session-main${sized ? " session-main-sized" : ""}`}
      ref={split.mainRef}
      style={
        {
          "--steps-basis": `${split.stepsWidth ?? DEFAULT_STEPS_WIDTH}px`,
          "--steps-reserve": `${PANEL_MIN_PX + SPLIT_CHROME_PX}px`,
        } as CSSProperties
      }
    >
      {children}
      <PanelResizer
        onDragTo={split.onDragTo}
        onNudge={split.onNudge}
        onCommit={split.onCommit}
      />
      <StepDetailPanel />
    </div>
  );
}
