// The tokens lens's component-test harness, shared by the
// lens's test files: one hand-built history, one fetch
// stand-in answering the one read the lens makes, and the
// render-and-settle rhythm every test plays. Each file
// sets up with its own default answer; a test overrides
// the answer with setResponder.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import type { TokenHistory } from "@flightpath/flightpath/api/payloads";

import { useSessionStore } from "../../src/session/store.js";
import { TokensLens } from "../../src/session/tokens-lens.js";
import type { StepRow } from "../../src/session/types.js";
import { tokenPoint } from "../fixtures.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export const T0 = 1_700_000_000_000;

const MAIN = [
  tokenPoint(1, T0, 20_000, null),
  tokenPoint(2, T0 + 60_000, 60_000),
  tokenPoint(3, T0 + 120_000, 90_000),
  tokenPoint(4, T0 + 180_000, 95_000),
  tokenPoint(5, T0 + 720_000, 30_000),
  tokenPoint(6, T0 + 780_000, 40_000),
];

/** The hand-built history most lens tests play on: six
 * points, a compaction drop, three rebuilds. */
export function history(overrides: Partial<TokenHistory> = {}): TokenHistory {
  return {
    sessionId: "sess-tokens",
    states: { telemetry: true, tokensPartial: false, joinedPartway: false },
    base: MAIN[0] ?? null,
    main: MAIN,
    branches: [],
    background: [],
    turns: [],
    room: {
      window: { tokens: 200_000, source: "model-list", reportedAt: null },
      autoCompact: { tokens: 193_000, source: "model-default" },
      toLimit: 160_000,
      toAutoCompact: 153_000,
      turnsLeft: { value: 7, estimated: true },
    },
    rises: [],
    drops: [
      {
        id: "drop-5",
        fromRequestId: 4,
        toRequestId: 5,
        at: T0 + 720_000,
        before: 95_000,
        after: 30_000,
        cause: "compaction",
        segmentId: 2,
      },
    ],
    rebuilds: [
      {
        id: "rb-3",
        requestId: 3,
        at: T0 + 120_000,
        written: 90_000,
        context: 90_000,
        cause: {
          kind: "expired",
          expected: false,
          gapMinutes: 10,
          lifetime: "5m",
        },
      },
      {
        id: "rb-5",
        requestId: 5,
        at: T0 + 720_000,
        written: 28_000,
        context: 30_000,
        cause: { kind: "compaction", expected: true, segmentId: 2 },
      },
      {
        id: "rb-6",
        requestId: 6,
        at: T0 + 780_000,
        written: 40_000,
        context: 40_000,
        cause: null,
      },
    ],
    ...overrides,
  };
}

export let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let responder: () => Promise<Response>;

/** jsdom has no scrollIntoView: the harness stands it in
 * on every element, and a test counts its calls here. */
export const scrollIntoView = vi.fn();

/** The answer the fetch stand-in gives until a test says
 * otherwise: each file's setup installs its default. */
export function setResponder(next: () => Promise<Response>): void {
  responder = next;
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => responder()),
  );
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function renderLens(steps: StepRow[] = []): Promise<void> {
  const state = useSessionStore.getState();
  state.begin("sess-tokens", "token-1");
  useSessionStore.setState({
    steps: new Map(steps.map((s) => [s.id, s])),
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TokensLens />
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Fetch the history again on the same client, the way
 * the shell's stream news does in the app: the lens stays
 * mounted and the new payload lands on it. */
export async function refetchLens(): Promise<void> {
  await act(async () => {
    await client.invalidateQueries();
  });
  await settle();
}

export function texts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map(
    (el) => el.textContent ?? "",
  );
}

/** The per-file wiring: a fresh container and root per
 * test, the file's default answer in place, and the fetch
 * stand-in installed. */
export function setupTokensLensTests(
  defaultResponder: () => Promise<Response>,
): void {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    responder = defaultResponder;
    stubFetch();
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as Element["scrollIntoView"];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
}
