import type {
  Finding,
  SessionSnapshot,
} from "@flightpath/flightpath/api/payloads";

import { fixtureSnapshot } from "../fixtures.js";

/** A finding in the API's shape; a test overrides what it checks. */
export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "rebuild-1",
    kind: "model",
    grade: "Worth a look",
    at: 5_000,
    requestId: 1,
    turnId: 11,
    headline: "Pick your model at the start of a session · 54.9K tokens",
    body: "Switching models could not reuse the cache.",
    list: [],
    more: [],
    doc: {
      label: "Prompt caching: switching models",
      url: "https://example.test/docs",
    },
    measure: { tokens: 54_900, basis: "measured" },
    copy: null,
    ...overrides,
  };
}

/** The shared fixture with request ids on its main-thread steps:
 * step 101 carried request 1, steps 103 and 104 both carried request 2,
 * and the subagent's step 105 also carried request 2. */
export function snapshotWithRequests(): SessionSnapshot {
  const snapshot = fixtureSnapshot();
  const carried: Record<number, number> = { 101: 1, 103: 2, 105: 2, 104: 2 };
  for (const turn of snapshot.turns) {
    for (const step of turn.steps) {
      step.resultRequestId = carried[step.id] ?? null;
    }
  }
  return snapshot;
}
