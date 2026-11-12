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
  RISE_KIND_BY_TOOL,
  riseKindPhrase,
  shareCardNumbers,
  type ShareCardInput,
} from "../src/session/share-card-numbers.js";

// The share card's numbers, from hand-built reads in the
// shapes the daemon sends: a full fixture first, then each
// field missing in turn.

const T0 = 1_700_000_000_000;

function summary(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    id: "sess-1",
    title: "A session",
    project: null,
    status: "ended",
    startedAt: T0,
    endedAt: T0 + 438_000,
    lastActivityAt: T0 + 438_000,
    model: null,
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
    lastStepAt: T0 + 438_000,
    cache: null,
    ...overrides,
  };
}

function contextWith(items: ContextItem[]): ContextAtStep {
  return {
    stepId: 7,
    scope: { kind: "main" },
    measured: null,
    epoch: { startedAt: T0, afterCompactionSegmentId: null },
    items,
    fixedLoad: null,
    compaction: null,
    totals: { measured: null, items: 0, named: 0, other: null },
    states: { telemetry: true, tokensPartial: false, joinedPartway: false },
  };
}

function promptItem(tokens: number | null, turnId = 1): ContextItem {
  return { kind: "prompt", turnId, sequence: turnId, chars: null, tokens };
}

function historyWith(rises: Rise[]): TokenHistory {
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
    rises,
    drops: [],
    rebuilds: [],
  };
}

function step(id: number, toolName: string): StepSummary {
  return {
    id,
    toolName,
    outcome: "succeeded",
    startedAt: T0,
    endedAt: T0,
    durationMs: 1,
    branchId: null,
    resultRequestId: null,
    sentence: "A step",
  };
}

function input(overrides: Partial<ShareCardInput> = {}): ShareCardInput {
  return {
    summary: summary(),
    context: contextWith([promptItem(20), promptItem(21, 2)]),
    history: historyWith([
      {
        id: "rise-1",
        fromRequestId: 1,
        toRequestId: 2,
        at: T0 + 60_000,
        delta: 20_573,
        link: "exact",
        items: [
          {
            kind: "step",
            stepId: 5,
            label: "A step's label",
            chars: 1,
            rawChars: 1,
            tokens: 20_573,
            estimated: false,
          },
        ],
      },
    ]),
    steps: new Map([[5, step(5, "Read")]]),
    nowMs: T0 + 500_000,
    ...overrides,
  };
}

describe("shareCardNumbers", () => {
  it("reads every field from a full fixture", () => {
    expect(shareCardNumbers(input())).toEqual({
      promptsTokens: 41,
      contextTokens: 59_375,
      biggestRise: { tokens: 20_573, kind: "one file read" },
      durationMs: 438_000,
      steps: 23,
      overheadTokens: 0,
    });
  });

  it("sums only the prompt items, leaving out the rest", () => {
    const context = contextWith([
      promptItem(10),
      { kind: "reply", requestId: 1, tokens: 700 },
      promptItem(5, 2),
    ]);
    expect(shareCardNumbers(input({ context })).promptsTokens).toBe(15);
  });

  it("counts a prompt with a known size beside one without", () => {
    const context = contextWith([promptItem(null), promptItem(9, 2)]);
    expect(shareCardNumbers(input({ context })).promptsTokens).toBe(9);
  });

  it("leaves the prompts out when no prompt size is known", () => {
    const context = contextWith([promptItem(null)]);
    expect(shareCardNumbers(input({ context })).promptsTokens).toBeNull();
  });

  it("leaves the prompts out when the context read is missing", () => {
    expect(shareCardNumbers(input({ context: null })).promptsTokens).toBeNull();
  });

  it("leaves the context out when the summary never recorded it", () => {
    const numbers = shareCardNumbers(
      input({ summary: summary({ contextNow: null }) }),
    );
    expect(numbers.contextTokens).toBeNull();
  });

  it("keeps the overhead at a real 0", () => {
    const numbers = shareCardNumbers(
      input({ summary: summary({ overheadTokens: 0 }) }),
    );
    expect(numbers.overheadTokens).toBe(0);
  });

  it("reads the summary's fields as absent together when there is no summary", () => {
    const numbers = shareCardNumbers(input({ summary: null }));
    expect(numbers.contextTokens).toBeNull();
    expect(numbers.durationMs).toBeNull();
    expect(numbers.steps).toBeNull();
    expect(numbers.overheadTokens).toBeNull();
  });

  it("leaves the rise out when the history is missing or names none", () => {
    expect(shareCardNumbers(input({ history: null })).biggestRise).toBeNull();
    expect(
      shareCardNumbers(input({ history: historyWith([]) })).biggestRise,
    ).toBeNull();
  });

  it("takes the largest rise, the first the history names", () => {
    const smaller: Rise = {
      id: "rise-2",
      fromRequestId: 3,
      toRequestId: 4,
      at: T0 + 120_000,
      delta: 3_000,
      link: "exact",
      items: [],
    };
    const numbers = shareCardNumbers(
      input({
        history: historyWith([
          { ...(input().history?.rises[0] as Rise), delta: 20_573 },
          smaller,
        ]),
      }),
    );
    expect(numbers.biggestRise?.tokens).toBe(20_573);
  });

  it("names a branch return as a subagent's result", () => {
    const rise: Rise = {
      id: "rise-1",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 4_000,
      link: "exact",
      items: [
        {
          kind: "branch-return",
          stepId: 9,
          branchId: 2,
          label: "A branch's label",
          chars: 1,
          tokens: 4_000,
          estimated: true,
        },
      ],
    };
    expect(
      shareCardNumbers(input({ history: historyWith([rise]) })).biggestRise,
    ).toEqual({
      tokens: 4_000,
      kind: "a subagent's result",
    });
  });

  it("passes a step the store doesn't hold and takes the next linked step", () => {
    const rise: Rise = {
      id: "rise-1",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 4_000,
      link: "by_time",
      items: [
        {
          kind: "step",
          stepId: 99,
          label: "A step's label",
          chars: 1,
          rawChars: 1,
          tokens: 3_000,
          estimated: true,
        },
        {
          kind: "step",
          stepId: 5,
          label: "A step's label",
          chars: 1,
          rawChars: 1,
          tokens: 1_000,
          estimated: true,
        },
      ],
    };
    const numbers = shareCardNumbers(input({ history: historyWith([rise]) }));
    expect(numbers.biggestRise).toEqual({
      tokens: 4_000,
      kind: "one file read",
    });
  });

  it("keeps a rise that links no step, with no kind", () => {
    const rise: Rise = {
      id: "rise-1",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 4_000,
      link: "none",
      items: [{ kind: "other", tokens: 4_000, estimated: true }],
    };
    expect(
      shareCardNumbers(input({ history: historyWith([rise]) })).biggestRise,
    ).toEqual({
      tokens: 4_000,
      kind: null,
    });
  });

  it("runs a live session's duration to now", () => {
    const numbers = shareCardNumbers(
      input({
        summary: summary({ status: "live", endedAt: null }),
        nowMs: T0 + 60_000,
      }),
    );
    expect(numbers.durationMs).toBe(60_000);
  });

  it("runs an ended session's duration to its last activity when no end was seen", () => {
    const numbers = shareCardNumbers(
      input({
        summary: summary({ endedAt: null, lastActivityAt: T0 + 5_000 }),
      }),
    );
    expect(numbers.durationMs).toBe(5_000);
  });
});

describe("riseKindPhrase", () => {
  it("gives every row of the kind table", () => {
    for (const [tool, phrase] of Object.entries(RISE_KIND_BY_TOOL)) {
      expect(riseKindPhrase(tool)).toBe(phrase);
    }
    expect(Object.keys(RISE_KIND_BY_TOOL).sort()).toEqual([
      "Agent",
      "Bash",
      "Read",
      "Task",
      "WebFetch",
      "WebSearch",
    ]);
  });

  it("gives one phrase for every MCP tool, naming no server", () => {
    expect(riseKindPhrase("mcp__notes__search")).toBe("an MCP tool's output");
  });

  it("calls any other tool a tool's output", () => {
    expect(riseKindPhrase("Grep")).toBe("a tool's output");
  });
});
