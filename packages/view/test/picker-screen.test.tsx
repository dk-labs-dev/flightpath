// @vitest-environment jsdom
import { readFileSync } from "node:fs";

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { SessionsScreen } from "../src/components/SessionsScreen.js";
import { useClockStore } from "../src/session/clock.js";
import { QUIET_AFTER_MS } from "../src/sessions/model.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function liveItem(lastActivityAt: number): SessionListItem {
  return {
    id: "sess-live",
    title: "A session",
    project: "/work/app",
    status: "live",
    startedAt: lastActivityAt - 60_000,
    endedAt: null,
    lastActivityAt,
    endSeen: true,
    hasOpenStep: false,
    turns: 1,
    steps: 3,
    tokensProcessed: 0,
    contextNow: null,
    sources: [],
    note: "",
  };
}

describe("the picker's live card", () => {
  it("turns quiet when the clock passes, and stops calling its turn running", () => {
    // Heard from just inside the quiet limit: still active.
    const lastActivityAt = Date.now() - QUIET_AFTER_MS + 30_000;
    act(() => {
      root.render(
        <SessionsScreen
          sessions={[liveItem(lastActivityAt)]}
          failed={false}
          emptyHidden={0}
          retentionDays={null}
        />,
      );
    });
    const card = container.querySelector(".live-card");
    expect(card?.textContent).toContain("turn 1 running");
    expect(card?.textContent).not.toContain("quiet since");
    // No new data lands; the clock alone passes the limit.
    act(() => {
      useClockStore.getState().setNow(lastActivityAt + QUIET_AFTER_MS);
    });
    expect(card?.textContent).toContain(
      `Live · quiet since ${formatClock(lastActivityAt)}`,
    );
    expect(card?.textContent).toContain("turn 1");
    expect(card?.textContent).not.toContain("turn 1 running");
  });

  it("calls a session with a step running active however long the clock runs", () => {
    const lastActivityAt = Date.now() - QUIET_AFTER_MS - 60_000;
    const busy = { ...liveItem(lastActivityAt), hasOpenStep: true };
    act(() => {
      root.render(
        <SessionsScreen
          sessions={[busy]}
          failed={false}
          emptyHidden={0}
          retentionDays={null}
        />,
      );
    });
    const card = container.querySelector(".live-card");
    expect(card?.textContent).toContain("turn 1 running");
    expect(card?.textContent).not.toContain("quiet since");
  });
});

describe("the first-open line", () => {
  const LINE =
    "Start Claude Code in any project and your session appears here, live.";

  function renderSessions(sessions: SessionListItem[]): void {
    act(() => {
      root.render(
        <SessionsScreen
          sessions={sessions}
          failed={false}
          emptyHidden={0}
          retentionDays={null}
        />,
      );
    });
  }

  it("is one plain line with a link to the guide when there is no session", () => {
    renderSessions([]);
    const line = container.querySelector(".empty");
    expect(line?.textContent).toBe(`${LINE} Read the guide`);
    expect(line?.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/dk-labs-dev/flightpath/blob/main/docs/guide.md",
    );
    expect(container.querySelector(".picker")).toBeNull();
  });

  it("goes away once a session exists", () => {
    renderSessions([]);
    renderSessions([earlierItem("sess-a", dayAt(0, 9))]);
    expect(container.textContent).not.toContain(LINE);
    expect(container.querySelector(".empty")).toBeNull();
  });
});

describe("the empty-sessions line", () => {
  function renderWithHidden(emptyHidden: number): void {
    act(() => {
      root.render(
        <SessionsScreen
          sessions={[earlierItem("sess-a", dayAt(0, 9))]}
          failed={false}
          emptyHidden={emptyHidden}
          retentionDays={null}
        />,
      );
    });
  }

  it("names the hidden empty sessions, agreeing with the count", () => {
    renderWithHidden(1);
    expect(container.textContent).toContain("1 empty session not shown.");
    renderWithHidden(3);
    expect(container.textContent).toContain("3 empty sessions not shown.");
  });

  it("says nothing when none are hidden", () => {
    renderWithHidden(0);
    expect(container.textContent).not.toContain("not shown.");
  });
});

function earlierItem(id: string, startedAt: number): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    project: "/work/app",
    status: "ended",
    startedAt,
    endedAt: startedAt + 60_000,
    lastActivityAt: startedAt + 60_000,
    endSeen: true,
    hasOpenStep: false,
    turns: 2,
    steps: 5,
    tokensProcessed: 1_000,
    contextNow: null,
    sources: [],
    note: "",
  };
}

/** A day in the past at a given hour, stepped by calendar
 * date so a daylight-saving change can't move it. */
function dayAt(daysAgo: number, hour: number): number {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    hour,
  ).getTime();
}

function renderEarlier(sessions: SessionListItem[]): void {
  act(() => {
    root.render(
      <SessionsScreen
        sessions={sessions}
        failed={false}
        emptyHidden={0}
        retentionDays={null}
      />,
    );
  });
}

describe("the picker's day folders", () => {
  it("counts each folder's sessions, one as one and three as three", () => {
    renderEarlier([
      earlierItem("today-1", dayAt(0, 9)),
      earlierItem("yday-1", dayAt(1, 9)),
      earlierItem("yday-2", dayAt(1, 10)),
      earlierItem("yday-3", dayAt(1, 11)),
    ]);
    const toggles = [...container.querySelectorAll(".day-toggle")].map(
      (button) => button.textContent,
    );
    expect(toggles).toContain("Today · 1 session");
    expect(toggles).toContain("Yesterday · 3 sessions");
  });

  it("turns a shut folder's chevron as it opens, and shows its rows", () => {
    renderEarlier([earlierItem("yday-1", dayAt(1, 9))]);
    const button = container.querySelector(".day-toggle");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(
      button?.querySelector("svg")?.getAttribute("style") ?? "",
    ).not.toContain("rotate(90deg)");
    expect(container.querySelector(".picker-table .cell-title")).toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.querySelector("svg")?.getAttribute("style")).toContain(
      "rotate(90deg)",
    );
    expect(container.querySelector(".picker-table .cell-title")).not.toBeNull();
  });

  it("heads every column in one face, and keeps the numbers monospace", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/view.css", "utf8");
    document.head.append(style);
    renderEarlier([earlierItem("today-1", dayAt(0, 9))]);
    const heads = [...container.querySelectorAll(".picker-table thead th")];
    expect(heads.length).toBeGreaterThan(0);
    const families = new Set(
      heads.map((th) => getComputedStyle(th).fontFamily),
    );
    expect(families.size).toBe(1);
    const numberCell = container.querySelector(".picker-table td.cell-num");
    expect(numberCell).not.toBeNull();
    expect(getComputedStyle(numberCell as Element).fontFamily).not.toBe(
      [...families][0],
    );
    style.remove();
  });

  it("has no serious or critical axe violations", async () => {
    renderEarlier([
      earlierItem("today-1", dayAt(0, 9)),
      earlierItem("yday-1", dayAt(1, 9)),
    ]);
    const results = await axe.run(container);
    const blocking = results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking).toEqual([]);
  });
});
