// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TokenHistory } from "@flightpath/flightpath/api/payloads";

import {
  openSnapshotAfterCompaction,
  openSnapshotAtTurn,
} from "../src/session/compaction-request.js";
import { useSessionStore } from "../src/session/store.js";
import { fixtureSnapshot, jsonResponse, tokenPoint } from "./fixtures.js";
import { history } from "./support/tokens-lens-harness.js";

const EVENT_AT = 85_000;
const EVENT_KEY = "segment:41";

let client: QueryClient;

function stubHistory(answer: TokenHistory | "unreadable"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        answer === "unreadable"
          ? jsonResponse(500, {})
          : jsonResponse(200, answer),
      ),
    ),
  );
}

function withRequestsAround(): TokenHistory {
  return history({
    main: [
      tokenPoint(50, EVENT_AT - 5_000, 60_000),
      tokenPoint(51, EVENT_AT + 5_000, 20_000),
      tokenPoint(52, EVENT_AT + 9_000, 22_000),
    ],
  });
}

async function afterTheFetch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = useSessionStore.getState();
  state.begin("s1", "token");
  state.snapshot(fixtureSnapshot());
  const events = new Map(useSessionStore.getState().events);
  events.set(EVENT_KEY, {
    kind: "segment",
    id: 41,
    at: EVENT_AT,
    sentence: "Compacted the conversation",
    segmentKind: "compact",
  });
  useSessionStore.setState({ events });
  window.location.hash = "#session/s1";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a compaction row in the steps lens", () => {
  it("opens the snapshot at the first request after the compaction", async () => {
    stubHistory(withRequestsAround());
    openSnapshotAfterCompaction(client, EVENT_KEY);
    await vi.waitFor(() =>
      expect(window.location.hash).toBe("#session/s1/snapshot?request=51"),
    );
  });

  it("opens the snapshot where it already stands when no request followed", async () => {
    stubHistory(history({ main: [tokenPoint(50, EVENT_AT - 5_000, 60_000)] }));
    openSnapshotAfterCompaction(client, EVENT_KEY);
    await vi.waitFor(() =>
      expect(window.location.hash).toBe("#session/s1/snapshot"),
    );
  });

  it("does the same when the history can't be read", async () => {
    stubHistory("unreadable");
    openSnapshotAfterCompaction(client, EVENT_KEY);
    await vi.waitFor(() =>
      expect(window.location.hash).toBe("#session/s1/snapshot"),
    );
  });

  it("leaves the address alone when the person has moved on while it waited", async () => {
    stubHistory(withRequestsAround());
    openSnapshotAfterCompaction(client, EVENT_KEY);
    window.location.hash = "#session/s1/tokens";
    await afterTheFetch();
    expect(window.location.hash).toBe("#session/s1/tokens");
  });
});

describe("a turn row without steps in the steps lens", () => {
  const turnPoint = (requestId: number, turnId: number | null) => ({
    ...tokenPoint(requestId, requestId * 1_000, 20_000),
    turnId,
  });

  it("opens the snapshot at the turn's last request", async () => {
    stubHistory(
      history({
        main: [turnPoint(50, 11), turnPoint(51, 12), turnPoint(52, 12)],
      }),
    );
    openSnapshotAtTurn(client, 12);
    await vi.waitFor(() =>
      expect(window.location.hash).toBe("#session/s1/snapshot?request=52"),
    );
  });

  it("opens the snapshot where it already stands when the turn sent no request", async () => {
    stubHistory(history({ main: [turnPoint(50, 11)] }));
    openSnapshotAtTurn(client, 12);
    await vi.waitFor(() =>
      expect(window.location.hash).toBe("#session/s1/snapshot"),
    );
  });
});
