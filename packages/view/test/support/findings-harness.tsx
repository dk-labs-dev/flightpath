// The findings panel's component-test harness: the findings
// provider over a query client whose reads a fetch stand-in
// answers, and the render-and-settle rhythm the tests share.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { FindingsProvider } from "../../src/session/findings-context.js";
import { useSessionStore } from "../../src/session/store.js";
import { jsonResponse } from "../fixtures.js";
import { snapshotWithRequests } from "./findings.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Served {
  /** What the findings read answers: a list, a status, or nothing yet. */
  read: Finding[] | number | "pending";
  /** What the dismiss route answers. */
  dismiss: number;
}

export interface Harness {
  client: QueryClient;
  served: Served;
  /** Every request the page made, as "METHOD path". */
  requests: string[];
  render: (ui: ReactNode) => Promise<void>;
  settle: () => Promise<void>;
  container: HTMLDivElement;
}

function answer(
  served: Served,
  path: string,
  method: string,
): Promise<Response> {
  if (method === "POST")
    return Promise.resolve(jsonResponse(served.dismiss, null));
  if (path.endsWith("/findings")) {
    if (served.read === "pending") return new Promise(() => undefined);
    if (typeof served.read === "number") {
      return Promise.resolve(jsonResponse(served.read, null));
    }
    return Promise.resolve(jsonResponse(200, served.read));
  }
  return Promise.resolve(jsonResponse(404, null));
}

export const harness = {} as Harness;

let root: Root;

beforeEach(() => {
  harness.container = document.createElement("div");
  document.body.append(harness.container);
  root = createRoot(harness.container);
  harness.client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  harness.served = { read: [], dismiss: 200 };
  harness.requests = [];
  vi.stubGlobal("fetch", (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    harness.requests.push(`${method} ${path}`);
    return answer(harness.served, path, method);
  });
  harness.settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
  };
  harness.render = async (ui) => {
    act(() => {
      root.render(
        <QueryClientProvider client={harness.client}>
          <FindingsProvider sessionId="s1">{ui}</FindingsProvider>
        </QueryClientProvider>,
      );
    });
    await harness.settle();
  };
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  useSessionStore.setState({
    detail: null,
    detailTab: "details",
    announcement: "",
  });
  useSessionStore.getState().begin("s1", "tok");
  useSessionStore.getState().snapshot(snapshotWithRequests());
});

afterEach(() => {
  act(() => root.unmount());
  harness.container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
