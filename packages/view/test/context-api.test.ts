// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  type UseQueryResult,
} from "@tanstack/react-query";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContextAsk,
  ContextAtStep,
} from "@flightpath/flightpath/api/payloads";

import {
  contextQueryKey,
  loadContextAt,
  noteContextNews,
  useContextAt,
  type ShownContextStep,
} from "../src/session/api.js";
import { latestStepId } from "../src/session/store.js";
import type { StepRow } from "../src/session/types.js";

// The snapshot lens's live rule, at the seam the stream
// writes to: the context of the session's latest step is
// refreshed on the stream's news, at most once a second,
// and a step that isn't the latest is never refreshed —
// its context is fixed.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function stepRow(id: number, startedAt: number): StepRow {
  return {
    id,
    toolName: "Read",
    outcome: "succeeded",
    startedAt,
    endedAt: startedAt + 100,
    durationMs: null,
    branchId: null,
    resultRequestId: null,
    sentence: "",
    turnId: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function Probe({
  sessionId,
  token,
  ask,
  onQuery,
}: {
  sessionId: string | null;
  token: string | null;
  ask: ContextAsk | null;
  onQuery: (query: UseQueryResult<ContextAtStep | null>) => void;
}) {
  const query = useContextAt(sessionId, token, ask);
  useEffect(() => {
    onQuery(query);
  });
  return null;
}

async function renderProbe(props: {
  sessionId: string | null;
  token: string | null;
  ask: ContextAsk | null;
}): Promise<UseQueryResult<ContextAtStep | null> | undefined> {
  let seen: UseQueryResult<ContextAtStep | null> | undefined;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, {
          ...props,
          onQuery: (query) => {
            seen = query;
          },
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root.unmount());
  container.remove();
  return seen;
}

describe("the context read", () => {
  it("asks for the step's context with the token in a header", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { stepId: 5 })),
    );
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      loadContextAt("token-1", "sess-1", { step: 5 }),
    ).resolves.toEqual({
      stepId: 5,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("/api/sessions/sess-1/context?step=5");
    expect(init.headers).toEqual({ "x-flightpath-token": "token-1" });
  });

  it("asks for a request's context by its id", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { stepId: null })),
    );
    vi.stubGlobal("fetch", fetchFn);
    await loadContextAt("token-1", "sess-1", { request: 41 });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/sessions/sess-1/context?request=41");
  });

  it("reads a missing step as null and a failure as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(404, {}))),
    );
    await expect(
      loadContextAt("token-1", "sess-1", { step: 5 }),
    ).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(500, {}))),
    );
    await expect(
      loadContextAt("token-1", "sess-1", { step: 5 }),
    ).rejects.toThrow("context answered 500");
  });

  it("stands the query down until session, token and step are known", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { stepId: 5 })),
    );
    vi.stubGlobal("fetch", fetchFn);
    const down = await renderProbe({
      sessionId: null,
      token: null,
      ask: null,
    });
    expect(down?.fetchStatus).toBe("idle");
    const halfDown = await renderProbe({
      sessionId: "sess-1",
      token: "token-1",
      ask: null,
    });
    expect(halfDown?.fetchStatus).toBe("idle");
    expect(fetchFn).not.toHaveBeenCalled();
    const ready = await renderProbe({
      sessionId: "sess-1",
      token: "token-1",
      ask: { step: 5 },
    });
    expect(ready?.data).toEqual({ stepId: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("the context query's live rule", () => {
  it("names the query by session and by step or request", () => {
    expect(contextQueryKey("sess-1", { step: 5 })).toEqual([
      "context",
      "sess-1",
      "step",
      5,
    ]);
    expect(contextQueryKey("sess-1", { request: 5 })).toEqual([
      "context",
      "sess-1",
      "request",
      5,
    ]);
  });

  it("finds the latest step: the one that started last", () => {
    const steps = new Map([
      [1, stepRow(1, 5_000)],
      [2, stepRow(2, 9_000)],
      [3, stepRow(3, 7_000)],
    ]);
    expect(latestStepId(steps)).toBe(2);
    expect(latestStepId(new Map())).toBeNull();
  });

  it("takes no note for a step that isn't the latest", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const fixed: ShownContextStep = { stepId: 5, isLatest: false };
    noteContextNews(client, "sess-fixed", () => fixed);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates at once, then at most once a second", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const shown: ShownContextStep = { stepId: 5, isLatest: true };
    noteContextNews(client, "sess-live", () => shown);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["context", "sess-live", "step", 5],
    });
    // A burst inside the second earns one more at its end,
    // not one per note.
    noteContextNews(client, "sess-live", () => shown);
    noteContextNews(client, "sess-live", () => shown);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({
      queryKey: ["context", "sess-live", "step", 5],
    });
  });

  it("notes the shown step when it is the latest, and only then", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const steps = new Map([
      [1, stepRow(1, 5_000)],
      [2, stepRow(2, 9_000)],
    ]);
    let selected: number | null = 1;
    const resolve = (): ShownContextStep | null => {
      const latest = latestStepId(steps);
      const shownId = selected ?? latest;
      return shownId === null
        ? null
        : { stepId: shownId, isLatest: shownId === latest };
    };
    noteContextNews(client, "sess-news", resolve);
    expect(spy).not.toHaveBeenCalled();
    selected = null;
    noteContextNews(client, "sess-news", resolve);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["context", "sess-news", "step", 2],
    });
  });

  it("sends the trailing refresh to the step that is latest when it fires", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    // The sequence, on the throttle's own clock: a context
    // point for step 5; another 200 ms later, with the
    // timer armed for step 5; step 6 lands at 500 ms; step
    // 6's own context point at 700 ms finds the timer set
    // and returns. The refresh at the second's end goes to
    // step 6 — the step the news has moved to.
    let latest = 5;
    const resolve = (): ShownContextStep => ({
      stepId: latest,
      isLatest: true,
    });
    noteContextNews(client, "sess-probe", resolve);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({
      queryKey: ["context", "sess-probe", "step", 5],
    });
    vi.advanceTimersByTime(200);
    noteContextNews(client, "sess-probe", resolve);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    latest = 6;
    noteContextNews(client, "sess-probe", resolve);
    vi.advanceTimersByTime(200);
    noteContextNews(client, "sess-probe", resolve);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({
      queryKey: ["context", "sess-probe", "step", 6],
    });
  });

  it("drops the trailing refresh when the shown step is fixed by then", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    let shown: ShownContextStep = { stepId: 5, isLatest: true };
    noteContextNews(client, "sess-moved", () => shown);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    noteContextNews(client, "sess-moved", () => shown);
    // The person picks step 5 to read: a step lands after
    // it, so the shown step is fixed and its context can't
    // change — the armed refresh has nowhere to go.
    shown = { stepId: 5, isLatest: false };
    vi.advanceTimersByTime(800);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
