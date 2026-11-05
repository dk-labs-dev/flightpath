import { describe, expect, it } from "vitest";

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import {
  filterSessions,
  groupByDay,
  projectName,
  QUIET_AFTER_MS,
  quietSince,
  sessionStateLabel,
} from "../src/sessions/model.js";

// The picker's shaping, against an injected clock: the day
// folders turn on where midnight falls, not on the test's
// own timing.

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

/** The local midnight that starts the day holding `ms`. */
function dayStart(ms: number): number {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

describe("the picker's day folders", () => {
  it("files a session under the day it started, across midnight", () => {
    const someDay = dayStart(Date.now()) - 2 * 24 * HOUR;
    const nowMs = someDay + 30 * 60_000; // 00:30 on the next day.
    const ranPastMidnight = item({
      id: "late",
      title: "Past midnight",
      startedAt: someDay - 15 * 60_000, // 23:45 the day before.
      endedAt: someDay + 20 * 60_000,
      lastActivityAt: someDay + 20 * 60_000,
    });
    const justStarted = item({
      id: "early",
      title: "Just after midnight",
      startedAt: someDay + 10 * 60_000,
    });
    const folders = groupByDay([ranPastMidnight, justStarted], nowMs);
    expect(folders.map((folder) => folder.heading)).toEqual([
      "Today",
      "Yesterday",
    ]);
    expect(folders[0]?.sessions.map((session) => session.id)).toEqual([
      "early",
    ]);
    expect(folders[1]?.sessions.map((session) => session.id)).toEqual(["late"]);
  });

  it("orders folders and their sessions newest first", () => {
    const todayStart = dayStart(Date.now());
    const a = item({ id: "a", startedAt: todayStart + HOUR });
    const b = item({ id: "b", startedAt: todayStart + 3 * HOUR });
    const c = item({ id: "c", startedAt: todayStart - HOUR });
    const folders = groupByDay([a, b, c], todayStart + 5 * HOUR);
    const shape = folders.map(
      (folder) =>
        `${folder.heading}: ${folder.sessions.map((s) => s.id).join(",")}`,
    );
    expect(shape).toEqual(["Today: b,a", "Yesterday: c"]);
  });
});

describe("the picker's filters", () => {
  const sessions = [
    item({ id: "1", title: "Fix the Parser bug", project: "/work/app" }),
    item({ id: "2", title: "Write docs", project: "/work/app" }),
    item({ id: "3", title: "Parser follow-up", project: "/home/notes" }),
  ];

  it("matches titles and folders as you type, in any case", () => {
    expect(
      filterSessions(sessions, "parser", null).map((session) => session.id),
    ).toEqual(["1", "3"]);
    expect(
      filterSessions(sessions, "NOTES", null).map((session) => session.id),
    ).toEqual(["3"]);
  });

  it("combines the search with the project filter", () => {
    expect(
      filterSessions(sessions, "parser", "app").map((session) => session.id),
    ).toEqual(["1"]);
  });

  it("reads a folder's name off either separator", () => {
    expect(projectName("/work/app")).toBe("app");
    expect(projectName("C:\\work\\app")).toBe("app");
    expect(projectName(null)).toBeNull();
  });
});

describe("the picker's quiet line", () => {
  it("calls a live session quiet only after minutes of silence", () => {
    const live = item({
      status: "live",
      lastActivityAt: 10 * HOUR,
    });
    expect(quietSince(live, 10 * HOUR + QUIET_AFTER_MS - 1)).toBeNull();
    expect(quietSince(live, 10 * HOUR + QUIET_AFTER_MS)).toBe(10 * HOUR);
  });

  it("never calls a session with a step running quiet", () => {
    const busy = item({
      status: "live",
      lastActivityAt: 10 * HOUR,
      hasOpenStep: true,
    });
    expect(quietSince(busy, 20 * HOUR)).toBeNull();
  });

  it("never calls an ended session quiet", () => {
    const ended = item({ status: "ended", lastActivityAt: 10 * HOUR });
    expect(quietSince(ended, 20 * HOUR)).toBeNull();
  });
});

describe("the session state label", () => {
  // A fixed local 10:42, so the words carry a real clock time.
  const at = new Date(2026, 9, 28, 10, 42).getTime();

  it("calls a live session Live, with the live tone", () => {
    const live = item({ status: "live", lastActivityAt: at });
    expect(sessionStateLabel(live, at + 60_000)).toEqual({
      text: "Live",
      tone: "live",
    });
  });

  it("turns quiet at the quiet boundary, not a moment before", () => {
    const live = item({ status: "live", lastActivityAt: at });
    expect(sessionStateLabel(live, at + QUIET_AFTER_MS - 1)).toEqual({
      text: "Live",
      tone: "live",
    });
    expect(sessionStateLabel(live, at + QUIET_AFTER_MS)).toEqual({
      text: `Live · quiet since ${formatClock(at)}`,
      tone: "quiet",
    });
  });

  it("never calls a session with a step running quiet", () => {
    const busy = item({
      status: "live",
      lastActivityAt: at,
      hasOpenStep: true,
    });
    expect(sessionStateLabel(busy, at + 60 * QUIET_AFTER_MS)).toEqual({
      text: "Live",
      tone: "live",
    });
  });

  it("words an ended session by its end, seen or concluded", () => {
    const seen = item({
      status: "ended",
      endedAt: at,
      lastActivityAt: at - 1000,
      endSeen: true,
    });
    expect(sessionStateLabel(seen, at + 1000)).toEqual({
      text: `Ended ${formatClock(at)}`,
      tone: "ended",
    });
    const unseen = item({ status: "ended", endedAt: at, endSeen: false });
    expect(sessionStateLabel(unseen, at + 1000)).toEqual({
      text: `Ended ${formatClock(at)} · no exit seen`,
      tone: "ended",
    });
  });

  it("reads the end off the last activity when no end was recorded", () => {
    const ended = item({
      status: "ended",
      endedAt: null,
      lastActivityAt: at,
      endSeen: true,
    });
    expect(sessionStateLabel(ended, at).text).toBe(`Ended ${formatClock(at)}`);
  });

  it("calls anything else Paused, in the ended tone", () => {
    const paused = item({ status: "paused", lastActivityAt: at });
    expect(sessionStateLabel(paused, at)).toEqual({
      text: "Paused",
      tone: "ended",
    });
  });
});
