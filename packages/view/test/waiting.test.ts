import { describe, expect, it } from "vitest";

import type { SnapshotSummary } from "@flightpath/flightpath/api/payloads";

import { waitingText } from "../src/session/tree.js";
import { fixtureSnapshot } from "./fixtures.js";

// The waiting line's words, as a pure function: the browser
// case lives with the lens's browser tests; these pin the
// words themselves — when each line shows, and when neither
// does.

const NOW = 1_000_000;
const NONE_RUNNING: ReadonlySet<number> = new Set();

function summary(overrides: Partial<SnapshotSummary>): SnapshotSummary {
  return { ...fixtureSnapshot().summary, status: "live", ...overrides };
}

describe("waitingText", () => {
  it("says nothing without a live session", () => {
    expect(waitingText(null, NONE_RUNNING, NOW)).toBeNull();
    expect(
      waitingText(
        summary({ status: "ended", waitingSince: NOW - 5_000 }),
        NONE_RUNNING,
        NOW,
      ),
    ).toBeNull();
  });

  it("says 'Waiting for you' while a permission prompt is open", () => {
    expect(
      waitingText(summary({ waitingSince: NOW - 5_000 }), NONE_RUNNING, NOW),
    ).toBe("Waiting for you");
  });

  it("names the quiet minutes once three have passed", () => {
    expect(
      waitingText(
        summary({ waitingSince: null, lastStepAt: NOW - 180_000 }),
        NONE_RUNNING,
        NOW,
      ),
    ).toBe("No new steps for 3 minutes");
    expect(
      waitingText(
        summary({ waitingSince: null, lastStepAt: NOW - 119_000 }),
        NONE_RUNNING,
        NOW,
      ),
    ).toBeNull();
  });

  it("says neither line while a step is running", () => {
    const running: ReadonlySet<number> = new Set([101]);
    expect(
      waitingText(summary({ waitingSince: NOW - 5_000 }), running, NOW),
    ).toBeNull();
    expect(
      waitingText(
        summary({ waitingSince: null, lastStepAt: NOW - 600_000 }),
        running,
        NOW,
      ),
    ).toBeNull();
  });

  it("an open prompt wins over the quiet line", () => {
    expect(
      waitingText(
        summary({ waitingSince: NOW - 5_000, lastStepAt: NOW - 600_000 }),
        NONE_RUNNING,
        NOW,
      ),
    ).toBe("Waiting for you");
  });
});
