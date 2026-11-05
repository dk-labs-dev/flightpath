import { QueryClient, skipToken } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findingsQueryKey,
  loadTokenHistory,
  noteSessionReadsStale,
  tokenHistoryOptions,
  tokensQueryKey,
} from "../src/session/api.js";
import { jsonResponse } from "./fixtures.js";

// The history read and its stream throttle: a 404 is a
// session the daemon doesn't know, anything else failing is
// an error the lens can retry, and a burst of stream news
// earns at most one invalidation a second.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("loadTokenHistory", () => {
  it("reads the history from the session's address", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { sessionId: "sess" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const history = await loadTokenHistory("token-1", "sess");
    expect(history).toEqual({ sessionId: "sess" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/sess/tokens",
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it("answers null for a session the daemon doesn't know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(404, {}))),
    );
    expect(await loadTokenHistory("token-1", "gone")).toBeNull();
  });

  it("throws on a failure the lens can retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(500, {}))),
    );
    await expect(loadTokenHistory("token-1", "sess")).rejects.toThrow(
      "token history answered 500",
    );
  });
});

describe("tokenHistoryOptions", () => {
  it("stands down while the session or its token is unknown", () => {
    expect(tokenHistoryOptions(null, null).queryFn).toBe(skipToken);
    expect(tokenHistoryOptions("sess", null).queryFn).toBe(skipToken);
    expect(tokenHistoryOptions(null, "token-1").queryFn).toBe(skipToken);
    expect(tokenHistoryOptions(null, null).queryKey).toEqual(
      tokensQueryKey(""),
    );
  });

  it("reads the history once both are known", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { sessionId: "sess" }))),
    );
    const client = new QueryClient();
    const options = tokenHistoryOptions("sess", "token-1");
    expect(options.queryKey).toEqual(tokensQueryKey("sess"));
    await expect(client.fetchQuery(options)).resolves.toEqual({
      sessionId: "sess",
    });
  });
});

describe("noteSessionReadsStale", () => {
  function invalidatedKeys(client: QueryClient) {
    const spy = vi.spyOn(client, "invalidateQueries");
    return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
  }

  it("invalidates the token history and the findings together", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const keys = invalidatedKeys(client);
    noteSessionReadsStale(client, "sess-a");
    expect(keys()).toEqual([
      tokensQueryKey("sess-a"),
      findingsQueryKey("sess-a"),
    ]);
  });

  it("invalidates at once, then at most once a second", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const keys = invalidatedKeys(client);
    noteSessionReadsStale(client, "sess-d");
    expect(keys()).toHaveLength(2);
    // A burst inside the second earns one trailing note.
    noteSessionReadsStale(client, "sess-d");
    noteSessionReadsStale(client, "sess-d");
    noteSessionReadsStale(client, "sess-d");
    expect(keys()).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(keys()).toHaveLength(4);
    // After the second passes, the next note lands at once.
    vi.advanceTimersByTime(1_100);
    noteSessionReadsStale(client, "sess-d");
    expect(keys()).toHaveLength(6);
  });

  it("throttles each session on its own clock", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const keys = invalidatedKeys(client);
    noteSessionReadsStale(client, "sess-b");
    noteSessionReadsStale(client, "sess-c");
    expect(keys()).toHaveLength(4);
  });
});
