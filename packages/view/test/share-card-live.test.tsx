// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ContextAtStep,
  SessionSnapshot,
  SnapshotSummary,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";

import { contextQueryKey, tokensQueryKey } from "../src/session/api.js";
import { useShareCardNumbers } from "../src/session/share-card.js";
import { cardTextLines } from "../src/session/share-card-render.js";
import { useSessionStore } from "../src/session/store.js";

// The card on a live session: the numbers are built from
// the store and the session's reads as they stand, so when
// a step lands — the store's own sink calls, exactly as
// the shell's stream makes them, with the reads the stream
// would mark stale — the rebuilt card carries the new
// context number.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_700_000_000_000;

function summary(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    id: "sess-live",
    title: "A live session",
    project: null,
    status: "live",
    startedAt: T0,
    endedAt: null,
    lastActivityAt: T0 + 60_000,
    model: null,
    permissionModes: [],
    sources: [],
    endSeen: false,
    note: "",
    counts: { turns: 1, steps: 1, requests: 1, branches: 0, humanMoments: 1 },
    failures: 0,
    steppedIn: 0,
    tokensProcessed: 0,
    contextNow: 20_000,
    window: { tokens: 200_000, source: "model-list", reportedAt: null },
    overheadTokens: 0,
    waitingSince: null,
    lastStepAt: T0 + 60_000,
    cache: null,
    ...overrides,
  };
}

function snapshot(): SessionSnapshot {
  return {
    summary: summary(),
    turns: [
      {
        id: 11,
        sequence: 1,
        startedAt: T0,
        endedAt: null,
        failures: 0,
        steppedIn: 0,
        images: 0,
        files: 0,
        steps: [
          {
            id: 101,
            toolName: "Read",
            outcome: "succeeded",
            startedAt: T0 + 1_000,
            endedAt: T0 + 2_000,
            durationMs: 1_000,
            branchId: null,
            resultRequestId: null,
            sentence: "Read a file",
          },
        ],
        humanMoments: [],
      },
    ],
    branches: [],
    sessionEvents: [],
    contextSamples: [{ at: T0 + 2_000, contextTokens: 20_000 }],
  };
}

function contextAt(promptsTokens: number): ContextAtStep {
  return {
    stepId: null,
    scope: { kind: "main" },
    measured: null,
    epoch: { startedAt: T0, afterCompactionSegmentId: null },
    items: [
      {
        kind: "prompt",
        turnId: 11,
        sequence: 1,
        chars: promptsTokens * 3,
        tokens: promptsTokens,
      },
    ],
    fixedLoad: null,
    compaction: null,
    totals: { measured: null, items: 0, named: 0, other: null },
    states: { telemetry: true, tokensPartial: false, joinedPartway: false },
  };
}

const HISTORY: TokenHistory = {
  sessionId: "sess-live",
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
  rises: [],
  drops: [],
  rebuilds: [],
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let contexts: Map<number, ContextAtStep>;

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function Probe() {
  const numbers = useShareCardNumbers();
  return <output>{cardTextLines(numbers).join("\n")}</output>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  contexts = new Map([[101, contextAt(6)]]);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/tokens")) {
        return Promise.resolve(jsonResponse(HISTORY));
      }
      const step = /step=(\d+)/.exec(url)?.[1];
      const payload =
        step === undefined ? null : (contexts.get(Number(step)) ?? null);
      return Promise.resolve(jsonResponse(payload));
    }),
  );
  const state = useSessionStore.getState();
  state.begin("sess-live", "token-1");
  state.snapshot(snapshot());
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the share card on a live session", () => {
  it("rebuilds with the new context number when a step lands", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.textContent).toContain("20,000 tokens");
    expect(container.textContent).toContain("about 6 tokens");

    // A new step lands, with its context point and the
    // session's new summary, through the sink's own calls;
    // the reads the stream marks stale are invalidated as
    // the stream marks them.
    contexts.set(102, contextAt(14));
    const state = useSessionStore.getState();
    await act(async () => {
      state.change({
        event: "step",
        data: {
          sessionId: "sess-live",
          turnId: 11,
          step: {
            id: 102,
            toolName: "Bash",
            outcome: "succeeded",
            startedAt: T0 + 70_000,
            endedAt: T0 + 71_000,
            durationMs: 1_000,
            branchId: null,
            resultRequestId: null,
            sentence: "Ran a command",
          },
        },
      });
      state.change({
        event: "context",
        data: {
          sessionId: "sess-live",
          point: { id: 2, at: T0 + 71_000, contextTokens: 26_500 },
        },
      });
      state.summary(
        summary({
          contextNow: 26_500,
          counts: {
            turns: 1,
            steps: 2,
            requests: 2,
            branches: 0,
            humanMoments: 1,
          },
          lastActivityAt: T0 + 71_000,
          lastStepAt: T0 + 71_000,
        }),
      );
    });
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: contextQueryKey("sess-live", { step: 102 }),
      });
      await queryClient.invalidateQueries({
        queryKey: tokensQueryKey("sess-live"),
      });
    });
    await settle();

    expect(container.textContent).toContain("26,500 tokens");
    expect(container.textContent).toContain("about 14 tokens");
    expect(container.textContent).not.toContain("20,000 tokens");
  });
});
