import { beforeEach, describe, expect, it } from "vitest";

import { anchorFindings } from "../src/session/findings.js";
import { useSessionStore } from "../src/session/store.js";
import { finding, snapshotWithRequests } from "./support/findings.js";

// Request 1 was carried by step 101 (turn 11). Request 2 was
// carried by steps 103 and 104 on the main thread (turn 12) and
// by 105 in the subagent.

function anchors(...found: ReturnType<typeof finding>[]) {
  const { turns, stepsByTurn } = useSessionStore.getState();
  return anchorFindings(found, { turns, stepsByTurn });
}

beforeEach(() => {
  useSessionStore.getState().begin("s1", "tok");
  useSessionStore.getState().snapshot(snapshotWithRequests());
});

describe("anchoring a finding to a row", () => {
  it("pins a rebuild to the step whose result its request carried", () => {
    const found = finding({ requestId: 1, turnId: 12 });
    expect(anchors(found).get(found.id)).toEqual({ step: 101 });
  });

  it("falls back to the first main-thread step of the finding's turn", () => {
    const found = finding({ requestId: 99, turnId: 12 });
    expect(anchors(found).get(found.id)).toEqual({ step: 103 });
  });

  it("pins to the turn when the turn ran no main-thread step", () => {
    const { stepsByTurn } = useSessionStore.getState();
    stepsByTurn.set(
      12,
      (stepsByTurn.get(12) ?? []).filter((s) => s.branchId !== null),
    );
    const found = finding({ requestId: 99, turnId: 12 });
    expect(anchors(found).get(found.id)).toEqual({ turn: 12 });
  });

  it("never pins to a subagent's step", () => {
    const { stepsByTurn } = useSessionStore.getState();
    stepsByTurn.set(
      12,
      (stepsByTurn.get(12) ?? []).filter((s) => s.id === 105),
    );
    const found = finding({ requestId: 2, turnId: 12 });
    expect(anchors(found).get(found.id)).toEqual({ turn: 12 });
  });

  it("takes the first of two steps one request carried, in recorded order", () => {
    const found = finding({ requestId: 2, turnId: 12 });
    expect(anchors(found).get(found.id)).toEqual({ step: 103 });
  });

  it("pins a session-level finding to the session's first main-thread step", () => {
    const found = finding({ requestId: null, turnId: null });
    expect(anchors(found).get(found.id)).toEqual({ step: 101 });
  });

  it("pins a session-level finding to the first turn when no turn has a main-thread step", () => {
    const { stepsByTurn } = useSessionStore.getState();
    stepsByTurn.set(11, []);
    stepsByTurn.set(12, []);
    const found = finding({ requestId: null, turnId: null });
    expect(anchors(found).get(found.id)).toEqual({ turn: 11 });
  });

  it("pins a stale finding to nothing", () => {
    const found = finding({ requestId: 99, turnId: 777 });
    expect(anchors(found).get(found.id)).toBeNull();
  });

  it("anchors every finding in one call", () => {
    const first = finding({ id: "a", requestId: 1 });
    const second = finding({ id: "b", requestId: 2 });
    expect([...anchors(first, second)]).toEqual([
      ["a", { step: 101 }],
      ["b", { step: 103 }],
    ]);
  });
});
