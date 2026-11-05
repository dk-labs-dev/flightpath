import { afterEach, describe, expect, it, vi } from "vitest";

import { useSessionStore } from "../src/session/store.js";
import { fixtureSnapshot } from "./fixtures.js";

function loadedStore() {
  useSessionStore.getState().begin("s1", "token");
  useSessionStore.getState().snapshot(fixtureSnapshot());
  return useSessionStore;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loading a snapshot", () => {
  it("normalises turns, steps, moments and branches into the store", () => {
    const state = loadedStore().getState();
    expect(state.turns.get(11)?.promptSentence).toBe("You asked: add tests");
    expect(state.steps.get(105)?.turnId).toBe(12);
    expect(state.branches.get(31)?.steps).toBe(2);
    expect(state.sessionSummary?.counts.steps).toBe(6);
    expect(state.collapsedTurns.size).toBe(0);
    expect(state.stepsByTurn.get(12)?.map((step) => step.id)).toEqual([
      103, 105, 106, 104,
    ]);
    expect(state.humansByTurn.get(11)?.map((moment) => moment.id)).toEqual([
      21, 22,
    ]);
  });

  it("collapses every turn but the last by default past fifty turns", () => {
    const snapshot = fixtureSnapshot();
    snapshot.turns = Array.from({ length: 55 }, (_, index) => ({
      id: 100 + index,
      sequence: index + 1,
      startedAt: 1000 + index,
      endedAt: 1001 + index,
      failures: 0,
      steppedIn: 0,
      images: 0,
      files: 0,
      steps: [],
      humanMoments: [],
    }));
    useSessionStore.getState().begin("s1", "token");
    useSessionStore.getState().snapshot(snapshot);
    const { collapsedTurns } = useSessionStore.getState();
    expect(collapsedTurns.size).toBe(54);
    expect(collapsedTurns.has(154)).toBe(false);
  });

  it("keeps the selection across a reload when the step is still there", () => {
    const store = loadedStore();
    store.getState().selectStep(101);
    store.getState().snapshot(fixtureSnapshot());
    expect(store.getState().selectedStepId).toBe(101);
  });
});

describe("restoring the place", () => {
  it("restores a saved empty collapse list as it stands: every turn open", () => {
    const snapshot = fixtureSnapshot();
    snapshot.turns = Array.from({ length: 55 }, (_, index) => ({
      id: 100 + index,
      sequence: index + 1,
      startedAt: 1000 + index,
      endedAt: 1001 + index,
      failures: 0,
      steppedIn: 0,
      images: 0,
      files: 0,
      steps: [],
      humanMoments: [],
    }));
    const store = useSessionStore;
    store.getState().begin("s1", "token");
    store.getState().snapshot(snapshot);
    expect(store.getState().collapsedTurns.size).toBe(54);
    store.getState().restorePlace({
      selectedStepId: null,
      collapsedTurnIds: [],
      scrollTop: 0,
      anchorKey: null,
      anchorOffset: 0,
    });
    expect(store.getState().collapsedTurns.size).toBe(0);
  });

  it("puts a shown request away when it restores a place", () => {
    const store = loadedStore();
    store.getState().selectRequest(7);
    store.getState().restorePlace({
      selectedStepId: null,
      collapsedTurnIds: [],
      scrollTop: 0,
      anchorKey: null,
      anchorOffset: 0,
    });
    expect(store.getState().selectedRequestId).toBeNull();
  });

  it("keeps the snapshot's default when nothing was saved", () => {
    const snapshot = fixtureSnapshot();
    snapshot.turns = Array.from({ length: 55 }, (_, index) => ({
      id: 100 + index,
      sequence: index + 1,
      startedAt: 1000 + index,
      endedAt: 1001 + index,
      failures: 0,
      steppedIn: 0,
      images: 0,
      files: 0,
      steps: [],
      humanMoments: [],
    }));
    const store = useSessionStore;
    store.getState().begin("s1", "token");
    store.getState().snapshot(snapshot);
    store.getState().restorePlace(null);
    expect(store.getState().collapsedTurns.size).toBe(54);
  });
});

describe("live changes", () => {
  it("adds a step once, counts it for the announcement, marks it fresh", () => {
    const store = loadedStore();
    const step = {
      id: 199,
      toolName: "Bash",
      outcome: "succeeded",
      startedAt: 9100,
      endedAt: 9200,
      durationMs: 100,
      branchId: null,
      resultRequestId: null,
      sentence: "Ran npm run build",
    };
    const message = {
      event: "step",
      data: { sessionId: "s1", turnId: 12, step },
    } as const;
    store.getState().change(message);
    store.getState().change(message);
    const state = store.getState();
    expect(state.steps.get(199)?.turnId).toBe(12);
    expect(state.pendingSteps).toBe(1);
    expect(state.arrivedSteps).toBe(1);
    expect(state.stepsByTurn.get(12)?.some((row) => row.id === 199)).toBe(true);
    expect(state.freshStepIds.has(199)).toBe(true);
    store.getState().flushAnnouncement();
    expect(store.getState().announcement).toBe("1 new step");
    expect(store.getState().pendingSteps).toBe(0);
  });

  it("moves a step out of its old turn's list when its turn changes", () => {
    const store = loadedStore();
    const step = {
      id: 207,
      toolName: "Agent",
      outcome: "succeeded",
      startedAt: 9100,
      endedAt: 9200,
      durationMs: 100,
      branchId: null,
      resultRequestId: null,
      sentence: "Started a subagent",
    };
    store.getState().change({
      event: "step",
      data: { sessionId: "s1", turnId: 11, step },
    });
    expect(
      store
        .getState()
        .stepsByTurn.get(11)
        ?.some((row) => row.id === 207),
    ).toBe(true);
    // The step is re-stamped to the turn that launched its
    // branch: the old turn's list loses it, not only the new
    // turn's list gains it.
    store.getState().change({
      event: "step",
      data: { sessionId: "s1", turnId: 12, step },
    });
    const state = store.getState();
    expect(state.steps.get(207)?.turnId).toBe(12);
    expect(state.stepsByTurn.get(11)?.some((row) => row.id === 207)).toBe(
      false,
    );
    expect(state.stepsByTurn.get(12)?.some((row) => row.id === 207)).toBe(true);
  });

  it("tracks the running steps as they open and close", () => {
    const store = loadedStore();
    const base = {
      toolName: "Bash",
      startedAt: 9100,
      endedAt: null,
      durationMs: null,
      branchId: null,
      resultRequestId: null,
      sentence: "Ran the suite",
    };
    store.getState().change({
      event: "step",
      data: {
        sessionId: "s1",
        turnId: 12,
        step: { ...base, id: 201, outcome: "open" },
      },
    });
    expect(store.getState().openStepIds.has(201)).toBe(true);
    store.getState().change({
      event: "step",
      data: {
        sessionId: "s1",
        turnId: 12,
        step: { ...base, id: 201, outcome: "succeeded", endedAt: 9200 },
      },
    });
    expect(store.getState().openStepIds.has(201)).toBe(false);
  });

  it("names a live turn from its prompt moment", () => {
    const store = loadedStore();
    store.getState().change({
      event: "turn",
      data: {
        sessionId: "s1",
        turn: {
          id: 13,
          sequence: 3,
          startedAt: 9500,
          endedAt: null,
          failures: 0,
          steppedIn: 0,
          images: 0,
          files: 0,
        },
      },
    });
    store.getState().change({
      event: "human",
      data: {
        sessionId: "s1",
        turnId: 13,
        human: {
          id: 30,
          kind: "prompt",
          occurredAt: 9500,
          sentence: "You asked: more",
        },
      },
    });
    expect(store.getState().turns.get(13)?.promptSentence).toBe(
      "You asked: more",
    );
    expect(
      store
        .getState()
        .humansByTurn.get(13)
        ?.map((m) => m.id),
    ).toEqual([30]);
  });

  it("appends context points in order, replaces a restated last point, sorts a stray", () => {
    const store = loadedStore();
    const point = (at: number, contextTokens: number) =>
      ({
        event: "context",
        data: { sessionId: "s1", point: { id: at, at, contextTokens } },
      }) as const;
    store.getState().change(point(9000, 21000));
    let samples = store.getState().samples;
    expect(samples[samples.length - 1]).toMatchObject({
      at: 9000,
      contextTokens: 21000,
    });
    // A restated point at the same moment replaces, not appends.
    store.getState().change(point(9000, 22000));
    samples = store.getState().samples;
    expect(samples.filter((sample) => sample.at === 9000)).toHaveLength(1);
    expect(samples[samples.length - 1]?.contextTokens).toBe(22000);
    // One that arrives out of order still lands in time order.
    store.getState().change(point(6000, 15000));
    const ats = store.getState().samples.map((sample) => sample.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });
});

describe("the latest step", () => {
  const landing = (id: number, startedAt: number) =>
    ({
      event: "step",
      data: {
        sessionId: "s1",
        turnId: 12,
        step: {
          id,
          toolName: "Bash",
          outcome: "succeeded",
          startedAt,
          endedAt: startedAt + 100,
          durationMs: 100,
          branchId: null,
          resultRequestId: null,
          sentence: "Ran a command",
        },
      },
    }) as const;

  it("is the snapshot's latest step when the snapshot lands", () => {
    expect(loadedStore().getState().latestStepId).toBe(104);
  });

  it("follows a landing, and not an older one", () => {
    const store = loadedStore();
    store.getState().change(landing(199, 9100));
    expect(store.getState().latestStepId).toBe(199);
    store.getState().change(landing(198, 8000));
    expect(store.getState().latestStepId).toBe(199);
  });

  it("is reseeded by a snapshot, so a reload can't leave it behind", () => {
    const store = loadedStore();
    store.getState().change(landing(200, 99_000));
    expect(store.getState().latestStepId).toBe(200);
    store.getState().snapshot(fixtureSnapshot());
    expect(store.getState().latestStepId).toBe(104);
  });
});

describe("the sink's calls", () => {
  it("answers the step count it holds, and takes the session's end", () => {
    const store = loadedStore();
    expect(store.getState().stepCount()).toBe(6);
    store.getState().deleted();
    expect(store.getState().sessionDeleted).toBe(true);
  });

  it("sets health and the connection's state aside: neither is the lens's", () => {
    const store = loadedStore();
    const before = store.getState();
    store.getState().health({
      buffered: 12,
      oldestAt: null,
      dropped: 3,
      lastError: null,
      problem: null,
      autostart: true,
    });
    store.getState().status({ kind: "down" });
    expect(store.getState().sessionSummary).toBe(before.sessionSummary);
    expect(store.getState().steps).toBe(before.steps);
  });
});

describe("opening a step", () => {
  it("loads the step's detail from the read API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 101,
          sessionId: "s1",
          toolName: "Bash",
          outcome: "succeeded",
          sentence: "Ran npm test",
          facts: [{ label: "Command", value: "npm test" }],
          requests: [],
        }),
      })),
    );
    const store = loadedStore();
    store.getState().openStep(101);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const detail = store.getState().detail;
    expect(detail?.status).toBe("ready");
    if (detail?.status === "ready") {
      expect(detail.data.facts[0]?.value).toBe("npm test");
    }
  });
});

describe("opening another session", () => {
  it("starts empty: nothing of the last session's rows remains", () => {
    const store = loadedStore();
    expect(store.getState().stepCount()).toBe(6);
    store.getState().begin("s2", "token");
    const empty = store.getState();
    expect(empty.turns.size).toBe(0);
    expect(empty.steps.size).toBe(0);
    expect(empty.humans.size).toBe(0);
    expect(empty.branches.size).toBe(0);
    expect(empty.events.size).toBe(0);
    expect(empty.samples).toEqual([]);
    expect(empty.stepCount()).toBe(0);
    // A change for the new session lands before its snapshot:
    // it is held, and nothing of the first session joins it.
    store.getState().change({
      event: "step",
      data: {
        sessionId: "s2",
        turnId: 77,
        step: {
          id: 901,
          toolName: "Bash",
          outcome: "succeeded",
          startedAt: 100,
          endedAt: 200,
          durationMs: 100,
          branchId: null,
          resultRequestId: null,
          sentence: "Ran the new session's first step",
        },
      },
    });
    const state = store.getState();
    expect(state.stepCount()).toBe(1);
    expect(state.steps.get(901)?.turnId).toBe(77);
    expect(state.steps.has(101)).toBe(false);
  });
});

describe("follow live", () => {
  it("follows position: the bottom resumes it, scrolling up stops it", () => {
    const store = useSessionStore;
    store.getState().setFollowLive(true);
    store.getState().followScrolled(false);
    expect(store.getState().followLive).toBe(false);
    store.getState().followScrolled(true);
    expect(store.getState().followLive).toBe(true);
  });

  it("holds an explicit off against position until turned back on", () => {
    const store = useSessionStore;
    store.getState().setFollowLive(false);
    expect(store.getState().followLive).toBe(false);
    store.getState().followScrolled(true);
    expect(store.getState().followLive).toBe(false);
    store.getState().followScrolled(false);
    store.getState().followScrolled(true);
    expect(store.getState().followLive).toBe(false);
    store.getState().setFollowLive(true);
    expect(store.getState().followLive).toBe(true);
  });
});
