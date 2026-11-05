// The session screen's store (ADR-0027): the snapshot's rows
// and the stream's changes, held by id so a row subscribes to
// its own data and re-renders only when that row changes. The
// screen's place and choices live here too — selection,
// collapsed turns, filters, follow-live — so a stream reset
// that reloads the snapshot never loses them.
//
// The store is also the stream's sink: the shell's one stream
// hands it the session's changes, summaries, snapshots and
// end through the sink's own calls, and asks it how many
// steps it holds. Health and the connection's state are the
// shell's business, not the lens's — the sink takes those
// calls and sets them aside.

import { create } from "zustand";

import type {
  ContextPoint,
  HumanMoment,
  SessionSnapshot,
  SnapshotSummary,
  StepDetail,
  StepSummary,
  TurnSummary as WireTurnSummary,
} from "@flightpath/flightpath/api/payloads";
import type {
  StreamHealth,
  StreamMessage,
} from "@flightpath/flightpath/daemon/stream-messages";

import type { StreamStatus } from "../stream.js";
import type { SessionViewState } from "../view-state.js";
import { loadStepDetail } from "./api.js";
import { eventKey } from "./rows.js";
import type { HumanRow, SessionData, StepRow, TurnShell } from "./types.js";

/** The detail panel's tabs: the step's facts, or its suggestions. */
export type DetailTab = "details" | "suggestions";

export type DetailState =
  | { stepId: number; status: "loading" }
  | { stepId: number; status: "ready"; data: StepDetail }
  | { stepId: number; status: "error" };

export interface SessionStore extends SessionData {
  sessionId: string | null;
  token: string | null;
  load: "idle" | "loading" | "ready" | "missing" | "failed";
  sessionSummary: SnapshotSummary | null;
  selectedStepId: number | null;
  /** A request the snapshot lens shows in place of a step: a
   * turn that ran no step has none to select. */
  selectedRequestId: number | null;
  /** The session's latest step: the one answer the lenses
   * and the stream read, kept current as steps land and
   * when a snapshot lands. */
  latestStepId: number | null;
  detail: DetailState | null;
  detailTab: DetailTab;
  collapsedTurns: ReadonlySet<number>;
  collapsedBranches: ReadonlySet<number>;
  followLive: boolean;
  /** The user turned follow-live off at its control: that
   * off holds against position until they turn it back on. */
  followHeldOff: boolean;
  failuresOnly: boolean;
  steppedInOnly: boolean;
  search: string;
  announcement: string;
  /** Counts every announcement, so the live region's text is
   * replaced even when a later one repeats the words. */
  announcementCount: number;
  pendingSteps: number;
  freshStepIds: ReadonlySet<number>;
  /** Steps the stream has brought since the snapshot: the
   * count follow-live keys on, not a row's key. */
  arrivedSteps: number;
  sessionDeleted: boolean;

  begin: (sessionId: string, token: string) => void;
  snapshotMissing: () => void;
  snapshotFailed: () => void;
  restorePlace: (place: SessionViewState | null) => void;
  selectStep: (stepId: number | null) => void;
  selectRequest: (requestId: number) => void;
  openStep: (stepId: number, tab?: DetailTab) => void;
  setDetailTab: (tab: DetailTab) => void;
  closeDetail: () => void;
  toggleTurn: (turnId: number) => void;
  toggleBranch: (branchId: number) => void;
  expandTurn: (turnId: number) => void;
  setFollowLive: (follow: boolean) => void;
  followScrolled: (atBottom: boolean) => void;
  setFailuresOnly: (on: boolean) => void;
  setSteppedInOnly: (on: boolean) => void;
  setSearch: (text: string) => void;
  flushAnnouncement: () => void;
  announce: (text: string) => void;
  consumeFresh: (stepId: number) => void;

  // The sink's calls (stream.ts): the shell's stream writes
  // through these, and only these.
  change: (message: StreamMessage) => void;
  summary: (summary: SnapshotSummary) => void;
  health: (health: StreamHealth) => void;
  snapshot: (snapshot: SessionSnapshot) => void;
  deleted: () => void;
  status: (status: StreamStatus) => void;
  stepCount: () => number;
}

/** Past this many turns, a session opens with its turns shut. */
const COLLAPSE_ALL_OVER = 50;

/** Whether one step started after another: the later
 * start wins, and a tie goes to the step recorded later. */
function isLaterStep(candidate: StepSummary, current: StepSummary): boolean {
  const candidateStart = candidate.startedAt ?? 0;
  const currentStart = current.startedAt ?? 0;
  return (
    candidateStart > currentStart ||
    (candidateStart === currentStart && candidate.id > current.id)
  );
}

/** Steps in the order they started: the earlier start
 * first, and a tie goes to the step recorded first. The
 * order a branch's steps are kept and shown in. */
function byStartedAt(a: StepRow, b: StepRow): number {
  return (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id;
}

/** The latest step in a set of steps: the one that started
 * last. The store keeps its answer current as steps land
 * and seeds it from this scan when a snapshot lands. */
export function latestStepId(steps: Map<number, StepRow>): number | null {
  let latest: StepRow | null = null;
  for (const step of steps.values()) {
    if (latest === null || isLaterStep(step, latest)) latest = step;
  }
  return latest?.id ?? null;
}

function promptOf(turn: WireTurnSummary): string | null {
  const prompt = turn.humanMoments.find((moment) => moment.kind === "prompt");
  return prompt === undefined ? null : prompt.sentence;
}

function mapsFromSnapshot(snapshot: SessionSnapshot): SessionData {
  const turns = new Map<number, TurnShell>();
  const steps = new Map<number, StepRow>();
  const humans = new Map<number, HumanRow>();
  const stepsByTurn = new Map<number, StepRow[]>();
  const humansByTurn = new Map<number, HumanRow[]>();
  const stepsByBranch = new Map<number, StepRow[]>();
  const openStepIds = new Set<number>();
  for (const turn of snapshot.turns) {
    turns.set(turn.id, {
      id: turn.id,
      sequence: turn.sequence,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      failures: turn.failures,
      steppedIn: turn.steppedIn,
      images: turn.images,
      files: turn.files,
      promptSentence: promptOf(turn),
    });
    const turnSteps: StepRow[] = [];
    for (const step of turn.steps) {
      const row: StepRow = { ...step, turnId: turn.id };
      steps.set(step.id, row);
      turnSteps.push(row);
      if (step.branchId !== null) {
        const branchSteps = stepsByBranch.get(step.branchId) ?? [];
        branchSteps.push(row);
        stepsByBranch.set(step.branchId, branchSteps);
      }
      if (step.outcome === "open") openStepIds.add(step.id);
    }
    stepsByTurn.set(turn.id, turnSteps);
    const turnHumans: HumanRow[] = [];
    for (const moment of turn.humanMoments) {
      const row: HumanRow = { ...moment, turnId: turn.id };
      humans.set(moment.id, row);
      turnHumans.push(row);
    }
    humansByTurn.set(turn.id, turnHumans);
  }
  for (const branchSteps of stepsByBranch.values()) {
    branchSteps.sort(byStartedAt);
  }
  const branches = new Map(snapshot.branches.map((b) => [b.id, b]));
  const events = new Map(snapshot.sessionEvents.map((e) => [eventKey(e), e]));
  const samples = [...snapshot.contextSamples].sort((a, b) => a.at - b.at);
  return {
    turns,
    steps,
    humans,
    branches,
    events,
    samples,
    stepsByTurn,
    humansByTurn,
    stepsByBranch,
    openStepIds,
  };
}

function defaultCollapsed(snapshot: SessionSnapshot): ReadonlySet<number> {
  if (snapshot.turns.length <= COLLAPSE_ALL_OVER) {
    return new Set();
  }
  const last = snapshot.turns[snapshot.turns.length - 1];
  const shut = new Set(snapshot.turns.map((turn) => turn.id));
  if (last !== undefined) {
    shut.delete(last.id);
  }
  return shut;
}

type SetState = (partial: Partial<SessionStore>) => void;
type GetState = () => SessionStore;

type DataCollections = Pick<
  SessionStore,
  | "turns"
  | "steps"
  | "humans"
  | "branches"
  | "events"
  | "samples"
  | "stepsByTurn"
  | "humansByTurn"
  | "stepsByBranch"
  | "openStepIds"
  | "freshStepIds"
>;

// One session's data, empty: a session that just opened
// shares nothing with the one before it.
function emptyCollections(): DataCollections {
  return {
    turns: new Map(),
    steps: new Map(),
    humans: new Map(),
    branches: new Map(),
    events: new Map(),
    samples: [],
    stepsByTurn: new Map(),
    humansByTurn: new Map(),
    stepsByBranch: new Map(),
    openStepIds: new Set(),
    freshStepIds: new Set(),
  };
}

const initialState = {
  sessionId: null,
  token: null,
  load: "idle",
  sessionSummary: null,
  ...emptyCollections(),
  selectedStepId: null,
  selectedRequestId: null,
  latestStepId: null,
  detail: null,
  detailTab: "details",
  collapsedTurns: new Set(),
  collapsedBranches: new Set(),
  followLive: true,
  followHeldOff: false,
  failuresOnly: false,
  steppedInOnly: false,
  search: "",
  announcement: "",
  announcementCount: 0,
  pendingSteps: 0,
  arrivedSteps: 0,
  sessionDeleted: false,
} satisfies Partial<SessionStore>;

function loadActions(set: SetState, get: GetState) {
  return {
    begin: (sessionId: string, token: string) => {
      // A new session starts empty: the last one's rows stay
      // out while this one's snapshot loads, and no change
      // lands in its maps before it.
      set({
        sessionId,
        token,
        load: "loading",
        sessionSummary: null,
        ...emptyCollections(),
        selectedStepId: null,
        selectedRequestId: null,
        latestStepId: null,
        detail: null,
        sessionDeleted: false,
        arrivedSteps: 0,
        pendingSteps: 0,
      });
    },

    snapshot: (snapshot: SessionSnapshot) => {
      const state = get();
      const maps = mapsFromSnapshot(snapshot);
      const firstLoad = state.load !== "ready";
      const selected =
        state.selectedStepId !== null && maps.steps.has(state.selectedStepId)
          ? state.selectedStepId
          : null;
      set({
        load: "ready",
        sessionSummary: snapshot.summary,
        ...maps,
        selectedStepId: selected,
        latestStepId: latestStepId(maps.steps),
        detail:
          state.detail !== null && maps.steps.has(state.detail.stepId)
            ? state.detail
            : null,
        collapsedTurns: firstLoad
          ? defaultCollapsed(snapshot)
          : state.collapsedTurns,
        freshStepIds: new Set(),
        arrivedSteps: 0,
      });
    },

    snapshotMissing: () => set({ load: "missing" }),
    snapshotFailed: () => set({ load: "failed" }),
  };
}

function changeActions(set: SetState, get: GetState) {
  return {
    change: (message: StreamMessage) => {
      const state = get();
      switch (message.event) {
        case "step":
          applyStepChange(state, set, message.data);
          break;
        case "turn": {
          const head = message.data.turn;
          const turns = new Map(state.turns);
          turns.set(head.id, {
            ...head,
            promptSentence: turns.get(head.id)?.promptSentence ?? null,
          });
          set({ turns });
          break;
        }
        case "human":
          applyHumanChange(state, set, message.data);
          break;
        case "branch": {
          const branches = new Map(state.branches);
          branches.set(message.data.branch.id, message.data.branch);
          set({ branches });
          break;
        }
        case "segment": {
          const events = new Map(state.events);
          events.set(eventKey(message.data.event), message.data.event);
          set({ events });
          break;
        }
        case "context":
          applyContextChange(state, set, message.data.point);
          break;
        default:
          // A session list row is the picker's news, and the
          // client sends this session's summary, health and end
          // to their own sink calls: nothing here to apply.
          break;
      }
    },

    summary: (summary: SnapshotSummary) => set({ sessionSummary: summary }),

    // Health is the shell's banner's business, and the
    // connection's state is its indicator's: the lens takes
    // the sink's calls for them and sets them aside.
    health: () => undefined,
    status: () => undefined,

    deleted: () => set({ sessionDeleted: true }),

    stepCount: () => get().steps.size,
  };
}

function selectionActions(set: SetState, get: GetState) {
  return {
    selectStep: (stepId: number | null) =>
      set({ selectedStepId: stepId, selectedRequestId: null }),

    selectRequest: (requestId: number) =>
      set({ selectedRequestId: requestId, selectedStepId: null }),

    openStep: (stepId: number, tab: DetailTab = "details") => {
      const { token } = get();
      set({
        selectedStepId: stepId,
        selectedRequestId: null,
        detail: { stepId, status: "loading" },
        detailTab: tab,
      });
      if (token === null) return;
      void loadStepDetail(token, stepId).then(
        (data) => {
          if (get().detail?.stepId !== stepId) return;
          set({
            detail:
              data === null
                ? { stepId, status: "error" }
                : { stepId, status: "ready", data },
          });
        },
        () => {
          if (get().detail?.stepId === stepId) {
            set({ detail: { stepId, status: "error" } });
          }
        },
      );
    },

    setDetailTab: (tab: DetailTab) => set({ detailTab: tab }),

    closeDetail: () => set({ detail: null }),

    restorePlace: (place: SessionViewState | null) => {
      const state = get();
      if (state.load !== "ready" || place === null) return;
      set({
        selectedStepId:
          place.selectedStepId !== null && state.steps.has(place.selectedStepId)
            ? place.selectedStepId
            : state.selectedStepId,
        selectedRequestId: null,
        // Whatever was saved is the place — an empty list
        // means every turn stood open. The default belongs
        // to the snapshot, and stands only when nothing was
        // saved at all.
        collapsedTurns: new Set(place.collapsedTurnIds),
      });
    },
  };
}

function announceText(set: SetState, get: GetState, text: string): void {
  set({ announcement: text, announcementCount: get().announcementCount + 1 });
}

function collapseActions(set: SetState, get: GetState) {
  return {
    toggleTurn: (turnId: number) => {
      const next = new Set(get().collapsedTurns);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      set({ collapsedTurns: next });
    },

    toggleBranch: (branchId: number) => {
      const next = new Set(get().collapsedBranches);
      if (next.has(branchId)) {
        next.delete(branchId);
      } else {
        next.add(branchId);
      }
      set({ collapsedBranches: next });
    },

    expandTurn: (turnId: number) => {
      if (!get().collapsedTurns.has(turnId)) return;
      const next = new Set(get().collapsedTurns);
      next.delete(turnId);
      set({ collapsedTurns: next });
    },
  };
}

function screenActions(set: SetState, get: GetState) {
  return {
    // The control's word is final: an explicit off is held,
    // and only the control lifts it.
    setFollowLive: (follow: boolean) =>
      set({ followLive: follow, followHeldOff: !follow }),

    // Position's say: scrolling up stops following and the
    // bottom resumes it, unless the control's off is held.
    followScrolled: (atBottom: boolean) => {
      const state = get();
      if (atBottom) {
        if (!state.followLive && !state.followHeldOff) {
          set({ followLive: true });
        }
      } else if (state.followLive) {
        set({ followLive: false });
      }
    },
    setFailuresOnly: (on: boolean) => set({ failuresOnly: on }),
    setSteppedInOnly: (on: boolean) => set({ steppedInOnly: on }),
    setSearch: (text: string) => set({ search: text }),

    flushAnnouncement: () => {
      const { pendingSteps } = get();
      if (pendingSteps === 0) return;
      announceText(
        set,
        get,
        pendingSteps === 1 ? "1 new step" : `${pendingSteps} new steps`,
      );
      set({ pendingSteps: 0 });
    },

    announce: (text: string) => announceText(set, get, text),

    consumeFresh: (stepId: number) => {
      if (!get().freshStepIds.has(stepId)) return;
      const next = new Set(get().freshStepIds);
      next.delete(stepId);
      set({ freshStepIds: next });
    },
  };
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  ...initialState,
  ...loadActions(set, get),
  ...changeActions(set, get),
  ...selectionActions(set, get),
  ...collapseActions(set, get),
  ...screenActions(set, get),
}));

function upsertStepIndex(
  index: Map<number, StepRow[]>,
  key: number,
  step: StepRow,
  sorted: boolean,
): Map<number, StepRow[]> {
  const list = index.get(key) ?? [];
  const at = list.findIndex((row) => row.id === step.id);
  const next =
    at === -1
      ? [...list, step]
      : list.map((row) => (row.id === step.id ? step : row));
  if (sorted) next.sort(byStartedAt);
  const copy = new Map(index);
  copy.set(key, next);
  return copy;
}

function removeStepIndex(
  index: Map<number, StepRow[]>,
  key: number,
  stepId: number,
): Map<number, StepRow[]> {
  const list = index.get(key);
  if (list === undefined || !list.some((row) => row.id === stepId)) {
    return index;
  }
  const copy = new Map(index);
  copy.set(
    key,
    list.filter((row) => row.id !== stepId),
  );
  return copy;
}

// A step whose turn changes leaves its old turn's list,
// not only joins the new one's: the index is keyed by a
// field that can change, so the entry moves with it.
function reindexByTurn(
  index: Map<number, StepRow[]>,
  held: StepRow | undefined,
  step: StepRow,
): Map<number, StepRow[]> {
  let next = index;
  if (
    held !== undefined &&
    held.turnId !== null &&
    held.turnId !== step.turnId
  ) {
    next = removeStepIndex(next, held.turnId, step.id);
  }
  if (step.turnId !== null) {
    next = upsertStepIndex(next, step.turnId, step, false);
  }
  return next;
}

function applyStepChange(
  state: SessionStore,
  set: (partial: Partial<SessionStore>) => void,
  data: { turnId: number | null; step: StepSummary },
): void {
  const step: StepRow = { ...data.step, turnId: data.turnId };
  const isNew = !state.steps.has(step.id);
  const steps = new Map(state.steps);
  steps.set(step.id, step);
  const partial: Partial<SessionStore> = { steps };
  const currentLatest =
    state.latestStepId === null
      ? null
      : (state.steps.get(state.latestStepId) ?? null);
  if (currentLatest === null || isLaterStep(step, currentLatest)) {
    partial.latestStepId = step.id;
  }
  const held = state.steps.get(step.id);
  const stepsByTurn = reindexByTurn(state.stepsByTurn, held, step);
  if (stepsByTurn !== state.stepsByTurn) {
    partial.stepsByTurn = stepsByTurn;
  }
  if (step.branchId !== null) {
    partial.stepsByBranch = upsertStepIndex(
      state.stepsByBranch,
      step.branchId,
      step,
      true,
    );
  }
  const wasOpen = state.openStepIds.has(step.id);
  const isOpen = step.outcome === "open";
  if (wasOpen !== isOpen) {
    const openStepIds = new Set(state.openStepIds);
    if (isOpen) {
      openStepIds.add(step.id);
    } else {
      openStepIds.delete(step.id);
    }
    partial.openStepIds = openStepIds;
  }
  if (isNew) {
    partial.arrivedSteps = state.arrivedSteps + 1;
    if (state.load === "ready") {
      partial.pendingSteps = state.pendingSteps + 1;
      const fresh = new Set(state.freshStepIds);
      fresh.add(step.id);
      partial.freshStepIds = fresh;
    }
  }
  set(partial);
}

function applyHumanChange(
  state: SessionStore,
  set: (partial: Partial<SessionStore>) => void,
  data: { turnId: number; human: HumanMoment },
): void {
  const row: HumanRow = { ...data.human, turnId: data.turnId };
  const humans = new Map(state.humans);
  humans.set(data.human.id, row);
  const list = state.humansByTurn.get(data.turnId) ?? [];
  const at = list.findIndex((moment) => moment.id === data.human.id);
  const humansByTurn = new Map(state.humansByTurn);
  humansByTurn.set(
    data.turnId,
    at === -1
      ? [...list, row]
      : list.map((moment) => (moment.id === data.human.id ? row : moment)),
  );
  const partial: Partial<SessionStore> = { humans, humansByTurn };
  if (data.human.kind === "prompt") {
    const turn = state.turns.get(data.turnId);
    if (turn !== undefined && turn.promptSentence === null) {
      const turns = new Map(state.turns);
      turns.set(turn.id, { ...turn, promptSentence: data.human.sentence });
      partial.turns = turns;
    }
  }
  set(partial);
}

function applyContextChange(
  state: SessionStore,
  set: (partial: Partial<SessionStore>) => void,
  point: ContextPoint,
): void {
  // Points arrive in time order: the new one goes on the end,
  // replacing the last when it restates the same moment. Only
  // a point that arrives out of order pays for a sort.
  const samples = state.samples;
  const last = samples[samples.length - 1];
  if (last !== undefined && point.at < last.at) {
    const next = samples.filter((sample) => sample.at !== point.at);
    next.push({ at: point.at, contextTokens: point.contextTokens });
    next.sort((a, b) => a.at - b.at);
    set({ samples: next });
    return;
  }
  if (last !== undefined && point.at === last.at) {
    set({
      samples: [
        ...samples.slice(0, -1),
        { at: point.at, contextTokens: point.contextTokens },
      ],
    });
    return;
  }
  set({
    samples: [...samples, { at: point.at, contextTokens: point.contextTokens }],
  });
}
