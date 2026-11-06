import { describe, expect, it } from "vitest";

import type { StreamHealth } from "../src/daemon/stream-messages.js";
import { formatClock } from "../src/format.js";
import {
  cantStartCause,
  droppedLine,
  healthAction,
  healthProblem,
  navStatus,
  waitingLine,
} from "../../view/src/health-state.js";

// The health banner's state and words, from the readings the
// stream carries: which problem shows, what it says, and the
// nav line that agrees with it.

const AT = 1_760_000_000_000;

const bindError = {
  at: AT,
  message: "listen EADDRINUSE: address already in use 127.0.0.1:4747",
  code: "EADDRINUSE",
};

function health(partial: Partial<StreamHealth>): StreamHealth {
  return {
    buffered: 0,
    oldestAt: null,
    dropped: 0,
    lastError: null,
    problem: null,
    autostart: true,
    ...partial,
  };
}

describe("health state", () => {
  it("shows nothing without a reading or with a clean one", () => {
    expect(healthProblem(null)).toBeNull();
    expect(healthProblem(health({}))).toBeNull();
  });

  it("shows can't start over dropped events when both are wrong", () => {
    const problem = healthProblem(
      health({
        dropped: 9,
        lastError: bindError,
        problem: { kind: "port", port: 4747, reason: "in-use" },
      }),
    );
    expect(problem?.kind).toBe("cant-start");
  });

  it("shows dropped events when nothing failed to start", () => {
    expect(healthProblem(health({ dropped: 3 }))).toEqual({
      kind: "dropped",
      dropped: 3,
    });
  });

  it("turns the port class into the port action", () => {
    const problem = healthProblem(
      health({
        lastError: bindError,
        problem: { kind: "port", port: 4747, reason: "in-use" },
      }),
    );
    if (problem === null) throw new Error("expected a problem");
    expect(healthAction(problem)).toEqual({ kind: "port" });
  });

  it("turns the database class into the path action", () => {
    const problem = healthProblem(
      health({
        lastError: { at: AT, message: "database disk image is malformed" },
        problem: { kind: "database", path: "/data/flightpath.db" },
      }),
    );
    if (problem === null) throw new Error("expected a problem");
    expect(healthAction(problem)).toEqual({
      kind: "database",
      path: "/data/flightpath.db",
    });
  });

  it("has no action when the failure has no known class", () => {
    const problem = healthProblem(
      health({
        lastError: { at: AT, message: "unexpected error" },
        problem: { kind: "other" },
      }),
    );
    if (problem === null) throw new Error("expected a problem");
    expect(healthAction(problem)).toBeNull();
  });

  it("says the bind cause with the port and the time", () => {
    expect(
      cantStartCause(bindError, {
        kind: "port",
        port: 4747,
        reason: "in-use",
      }),
    ).toBe(
      `Port 4747 is in use by another program, and the recorder couldn't bind it at ${formatClock(AT)}.`,
    );
  });

  it("says a port that isn't allowed isn't allowed, not in use", () => {
    const deniedError = {
      at: AT,
      message: "listen EACCES: permission denied 127.0.0.1:80",
      code: "EACCES",
    };
    expect(
      cantStartCause(deniedError, {
        kind: "port",
        port: 80,
        reason: "not-allowed",
      }),
    ).toBe(
      `The recorder isn't allowed to use port 80, so it couldn't start at ${formatClock(AT)}.`,
    );
  });

  it("says the database cause without the raw error", () => {
    expect(
      cantStartCause(
        { at: AT, message: "database disk image is malformed" },
        { kind: "database", path: "/data/flightpath.db" },
      ),
    ).toBe(`The recorder couldn't open its database at ${formatClock(AT)}.`);
  });

  it("keeps an unknown cause's own words", () => {
    expect(
      cantStartCause(
        { at: AT, message: "unexpected error" },
        { kind: "other" },
      ),
    ).toBe("unexpected error");
  });

  it("words the wait with the oldest event's age", () => {
    const now = AT + 9 * 60_000;
    expect(waitingLine(health({ buffered: 214, oldestAt: AT }), now)).toBe(
      "214 events are waiting on this machine, the oldest from 9 minutes ago. Nothing is lost yet: they're stored the moment the recorder starts.",
    );
    expect(waitingLine(health({ buffered: 1, oldestAt: AT }), now)).toContain(
      "1 event is waiting",
    );
    expect(waitingLine(health({}), now)).toBeNull();
  });

  it("words the drop with the count agreeing with its noun", () => {
    expect(droppedLine(1)).toBe(
      "About 1 event dropped: the buffer was full; transcripts still cover these sessions.",
    );
    expect(droppedLine(2)).toBe(
      "About 2 events dropped: the buffer was full; transcripts still cover these sessions.",
    );
    expect(droppedLine(120)).toBe(
      "About 120 events dropped: the buffer was full; transcripts still cover these sessions.",
    );
  });

  it("keeps the nav line in agreement", () => {
    const clean = health({});
    expect(navStatus(clean, { kind: "live" }, "4747")).toEqual({
      text: "Recorder running · 4747",
      tone: "ok",
    });
    const failed = health({ lastError: bindError });
    expect(navStatus(failed, { kind: "live" }, "4747")).toEqual({
      text: "Recorder can't start",
      tone: "failure",
    });
    expect(navStatus(health({ dropped: 5 }), { kind: "live" }, "4747")).toEqual(
      { text: "Recorder running · 5 dropped", tone: "warning" },
    );
    expect(navStatus(failed, { kind: "down" }, "4747")).toEqual({
      text: "Recorder unreachable",
      tone: "warning",
    });
    // A stopped recorder outranks even a can't-start reading:
    // the stop is the newest word, and it is final.
    expect(
      navStatus(failed, { kind: "stopped", reason: "off" }, "4747"),
    ).toEqual({ text: "Recorder stopped", tone: "failure" });
  });
});
