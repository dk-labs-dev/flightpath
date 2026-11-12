import { describe, expect, it } from "vitest";

import type {
  ContextAtStep,
  ContextItem,
  Rise,
  SnapshotSummary,
  StepSummary,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";

import {
  shareCardNumbers,
  type CardNumbers,
} from "../src/session/share-card-numbers.js";
import { cardTextLines } from "../src/session/share-card-render.js";

// The card's text: the render module's own list of the
// strings it draws, checked line by line, and held against
// a poisoned fixture for privacy — every marker the record
// holds must stay off the card.

const FULL: CardNumbers = {
  promptsTokens: 41,
  contextTokens: 59_375,
  biggestRise: { tokens: 20_573, kind: "one file read" },
  durationMs: 438_000,
  steps: 23,
  overheadTokens: 0,
};

const EMPTY: CardNumbers = {
  promptsTokens: null,
  contextTokens: null,
  biggestRise: null,
  durationMs: null,
  steps: null,
  overheadTokens: null,
};

describe("cardTextLines", () => {
  it("words a full card exactly as it is drawn", () => {
    expect(cardTextLines(FULL)).toEqual([
      "My Claude Code session, in numbers",
      "My prompts",
      "about 41 tokens",
      "What Claude Code was carrying",
      "59,375 tokens",
      "Biggest jump",
      "+20,573 tokens · one file read",
      "7 min · 23 steps · Flightpath added 0 tokens",
      "flightpath",
      "github.com/dk-labs-dev/flightpath",
    ]);
  });

  it("says about only on the estimate", () => {
    const lines = cardTextLines(FULL);
    expect(lines.filter((line) => line.includes("about"))).toEqual([
      "about 41 tokens",
    ]);
  });

  it("shows the duration and steps alone when both big numbers are missing", () => {
    expect(cardTextLines({ ...EMPTY, durationMs: 438_000, steps: 23 })).toEqual(
      [
        "My Claude Code session, in numbers",
        "7 min · 23 steps",
        "flightpath",
        "github.com/dk-labs-dev/flightpath",
      ],
    );
  });

  it("shows the overhead alone when it is all the summary gives", () => {
    expect(cardTextLines({ ...EMPTY, overheadTokens: 0 })).toEqual([
      "My Claude Code session, in numbers",
      "Flightpath added 0 tokens",
      "flightpath",
      "github.com/dk-labs-dev/flightpath",
    ]);
  });

  it("drops the kind phrase when the rise links no step", () => {
    const lines = cardTextLines({
      ...EMPTY,
      biggestRise: { tokens: 4_000, kind: null },
    });
    expect(lines).toContain("+4,000 tokens");
  });

  it("counts one step as one step", () => {
    const lines = cardTextLines({ ...EMPTY, durationMs: 60_000, steps: 1 });
    expect(lines).toContain("1 min · 1 step");
  });

  it("keeps the view's own words for a session under a minute", () => {
    const lines = cardTextLines({ ...EMPTY, durationMs: 42_000, steps: 3 });
    expect(lines).toContain("42s · 3 steps");
  });
});

// Markers planted in every private-shaped field the record
// holds: the session's title, its project path, its model,
// a prompt's text is never in a payload — but a file's
// path, a result's label and a rise item's label are, and
// a careless card could carry any of them.
const MARKERS = {
  title: "ZZTITLEZZ",
  path: "ZZFILEZZ.ts",
  label: "ZZLABELZZ",
  model: "ZZMODELZZ",
  project: "/ZZPROJECTZZ",
};

function poisonedSummary(): SnapshotSummary {
  return {
    id: "sess-1",
    title: `Fix ${MARKERS.title} at home`,
    project: MARKERS.project,
    status: "ended",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_438_000,
    lastActivityAt: 1_700_000_438_000,
    model: MARKERS.model,
    permissionModes: [],
    sources: [],
    endSeen: true,
    note: "",
    counts: { turns: 3, steps: 23, requests: 9, branches: 0, humanMoments: 3 },
    failures: 0,
    steppedIn: 0,
    tokensProcessed: 0,
    contextNow: 59_375,
    window: { tokens: 200_000, source: "model-list", reportedAt: null },
    overheadTokens: 0,
    waitingSince: null,
    lastStepAt: 1_700_000_438_000,
    cache: null,
  };
}

function poisonedContext(): ContextAtStep {
  const items: ContextItem[] = [
    { kind: "prompt", turnId: 1, sequence: 1, chars: 100, tokens: 41 },
    {
      kind: "file-read",
      stepId: 5,
      path: `/home/user/project/${MARKERS.path}`,
      chars: 60_000,
      tokens: 20_573,
      measured: true,
    },
    {
      kind: "tool-result",
      stepId: 6,
      label: MARKERS.label,
      chars: 10,
      tokens: 4,
      measured: false,
    },
  ];
  return {
    stepId: 7,
    scope: { kind: "main" },
    measured: null,
    epoch: { startedAt: 1_700_000_000_000, afterCompactionSegmentId: null },
    items,
    fixedLoad: null,
    compaction: null,
    totals: { measured: null, items: 0, named: 0, other: null },
    states: { telemetry: true, tokensPartial: false, joinedPartway: false },
  };
}

function poisonedHistory(): TokenHistory {
  const rise: Rise = {
    id: "rise-1",
    fromRequestId: 1,
    toRequestId: 2,
    at: 1_700_000_060_000,
    delta: 20_573,
    link: "exact",
    items: [
      {
        kind: "step",
        stepId: 5,
        label: `Read ${MARKERS.path}`,
        chars: 1,
        rawChars: 1,
        tokens: 20_573,
        estimated: false,
      },
      {
        kind: "attachment",
        turnId: 1,
        attachmentKind: "file",
        name: MARKERS.path,
        bytes: 10,
        tokens: 4,
        estimated: true,
      },
    ],
  };
  return {
    sessionId: "sess-1",
    states: { telemetry: true, tokensPartial: false, joinedPartway: false },
    base: null,
    main: [],
    branches: [],
    background: [],
    turns: [],
    room: {
      model: null,
      window: { tokens: null, source: "model-list", reportedAt: null },
      autoCompact: null,
      toLimit: null,
      toAutoCompact: null,
      turnsLeft: null,
    },
    rises: [rise],
    drops: [],
    rebuilds: [],
  };
}

function poisonedSteps(): Map<number, StepSummary> {
  return new Map([
    [
      5,
      {
        id: 5,
        toolName: "Read",
        outcome: "succeeded",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_000,
        durationMs: 1,
        branchId: null,
        resultRequestId: null,
        sentence: `Read the file ${MARKERS.path} in ${MARKERS.project}`,
      },
    ],
  ]);
}

describe("the card's privacy", () => {
  it("carries no marker from the record into any drawn string", () => {
    const numbers = shareCardNumbers({
      summary: poisonedSummary(),
      context: poisonedContext(),
      history: poisonedHistory(),
      steps: poisonedSteps(),
      nowMs: 1_700_000_500_000,
    });
    const drawn = cardTextLines(numbers).join("\n");
    for (const marker of Object.values(MARKERS)) {
      expect(drawn).not.toContain(marker);
    }
    // The card still says what it honestly can: the rise's
    // kind is the step's tool, never the step's label.
    expect(drawn).toContain("+20,573 tokens · one file read");
  });
});
