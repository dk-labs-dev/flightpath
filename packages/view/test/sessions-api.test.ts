import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  SessionListItem,
  SessionsPayload,
} from "@flightpath/flightpath/api/payloads";
import type { StreamMessage } from "@flightpath/flightpath/daemon/stream-messages";

import {
  applySessionMessage,
  SESSIONS_QUERY_KEY,
} from "../src/sessions/api.js";

// The stream's list news, applied to the query's cache the
// picker reads: rows arrive, change and go away without a
// reload or a poll.

const HOUR = 3_600_000;

function item(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    id: "sess",
    title: "A session",
    project: "/work/app",
    status: "ended",
    startedAt: 0,
    endedAt: null,
    lastActivityAt: 0,
    endSeen: true,
    hasOpenStep: false,
    turns: 1,
    steps: 1,
    tokensProcessed: 0,
    contextNow: null,
    sources: [],
    note: "",
    ...overrides,
  };
}

function clientWith(sessions: SessionListItem[], emptyHidden = 0): QueryClient {
  const client = new QueryClient();
  client.setQueryData<SessionsPayload>(SESSIONS_QUERY_KEY, {
    sessions,
    emptyHidden,
  });
  return client;
}

function cached(client: QueryClient): SessionListItem[] | undefined {
  return client.getQueryData<SessionsPayload>(SESSIONS_QUERY_KEY)?.sessions;
}

function cachedHidden(client: QueryClient): number | undefined {
  return client.getQueryData<SessionsPayload>(SESSIONS_QUERY_KEY)?.emptyHidden;
}

function rowMessage(row: SessionListItem): StreamMessage {
  return { event: "session", data: { sessionId: row.id, session: row } };
}

function rowMessageWithCount(
  row: SessionListItem,
  emptyHidden: number,
): StreamMessage {
  return {
    event: "session",
    data: { sessionId: row.id, session: row, emptyHidden },
  };
}

describe("applySessionMessage", () => {
  it("places a new live session at the front", () => {
    const client = clientWith([item({ id: "old", startedAt: 1 * HOUR })]);
    applySessionMessage(
      client,
      rowMessage(item({ id: "new", status: "live", startedAt: 2 * HOUR })),
    );
    expect(cached(client)?.map((session) => session.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("orders two live sessions by latest activity, as the server does", () => {
    // Started second but quiet since; the session that started
    // first and is still active leads the server's list, so it
    // leads the cache too — by activity, not by start.
    const client = clientWith([
      item({
        id: "started-later",
        status: "live",
        startedAt: 2 * HOUR,
        lastActivityAt: 2 * HOUR,
      }),
      item({
        id: "started-first",
        status: "live",
        startedAt: 1 * HOUR,
        lastActivityAt: 3 * HOUR,
      }),
    ]);
    applySessionMessage(
      client,
      rowMessage(
        item({
          id: "started-later",
          status: "live",
          startedAt: 2 * HOUR,
          lastActivityAt: 2 * HOUR,
        }),
      ),
    );
    expect(cached(client)?.map((session) => session.id)).toEqual([
      "started-first",
      "started-later",
    ]);
  });

  it("replaces a row in place when its session changes", () => {
    const client = clientWith([
      item({ id: "a", startedAt: 2 * HOUR }),
      item({ id: "b", startedAt: 1 * HOUR }),
    ]);
    applySessionMessage(
      client,
      rowMessage(item({ id: "b", title: "Renamed", startedAt: 1 * HOUR })),
    );
    expect(cached(client)?.map((session) => session.title)).toEqual([
      "A session",
      "Renamed",
    ]);
  });

  it("moves a session that ends below the ones still live", () => {
    const client = clientWith([
      item({ id: "ending", status: "live", startedAt: 2 * HOUR }),
      item({ id: "live", status: "live", startedAt: 1 * HOUR }),
    ]);
    applySessionMessage(
      client,
      rowMessage(item({ id: "ending", status: "ended", startedAt: 2 * HOUR })),
    );
    expect(cached(client)?.map((session) => session.id)).toEqual([
      "live",
      "ending",
    ]);
  });

  it("removes the row a tombstone names", () => {
    const client = clientWith([
      item({ id: "gone", startedAt: 2 * HOUR }),
      item({ id: "kept", startedAt: 1 * HOUR }),
    ]);
    applySessionMessage(client, {
      event: "session",
      data: { sessionId: "gone", deleted: true },
    });
    expect(cached(client)?.map((session) => session.id)).toEqual(["kept"]);
  });

  it("takes out a session that ends empty, and counts it, with no reload", () => {
    // The list is open on a live session with nothing in it
    // yet; it ends with no prompt typed, so the stream's
    // hidden note takes its row out and the count the line
    // reads rises to one — no reload involved.
    const client = clientWith([
      item({ id: "emptying", status: "live", turns: 0, startedAt: 2 * HOUR }),
      item({ id: "kept", startedAt: 1 * HOUR }),
    ]);
    applySessionMessage(client, {
      event: "session",
      data: { sessionId: "emptying", hidden: true, emptyHidden: 1 },
    });
    expect(cached(client)?.map((session) => session.id)).toEqual(["kept"]);
    expect(cachedHidden(client)).toBe(1);
  });

  it("lowers the count a returning row carries with it", () => {
    const client = clientWith(
      [item({ id: "kept", startedAt: 1 * HOUR, lastActivityAt: 1 * HOUR })],
      1,
    );
    applySessionMessage(
      client,
      rowMessageWithCount(
        item({ id: "back", startedAt: 2 * HOUR, lastActivityAt: 2 * HOUR }),
        0,
      ),
    );
    expect(cached(client)?.map((session) => session.id)).toEqual([
      "back",
      "kept",
    ]);
    expect(cachedHidden(client)).toBe(0);
  });

  it("lowers the count a tombstone carries with it", () => {
    const client = clientWith([item({ id: "kept", startedAt: 1 * HOUR })], 1);
    applySessionMessage(client, {
      event: "session",
      data: { sessionId: "purged", deleted: true, emptyHidden: 0 },
    });
    expect(cached(client)?.map((session) => session.id)).toEqual(["kept"]);
    expect(cachedHidden(client)).toBe(0);
  });

  it("leaves the list alone for other messages", () => {
    const before = [item({ id: "a" })];
    const client = clientWith(before);
    applySessionMessage(client, {
      event: "health",
      data: {
        buffered: 0,
        oldestAt: null,
        dropped: 0,
        lastError: null,
        problem: null,
        autostart: true,
      },
    });
    expect(cached(client)).toEqual(before);
  });

  it("does nothing before the first load lands", () => {
    const client = new QueryClient();
    applySessionMessage(client, rowMessage(item({ id: "a" })));
    expect(cached(client)).toBeUndefined();
  });
});
