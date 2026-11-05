// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SummaryCache } from "@flightpath/flightpath/api/payloads";

import { CacheClockLine } from "../src/session/cache-clock-line.js";
import { useClockTick } from "../src/session/clock.js";
import { useSessionStore } from "../src/session/store.js";
import { SessionSummary } from "../src/session/summary.js";
import { fixtureSnapshot } from "./fixtures.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;
const START = Date.parse("2026-11-02T10:00:00Z");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** An hour's cache that ended `agoMs` before the test began. */
function hourCache(agoMs: number): SummaryCache {
  return { lifetime: "1h", endedAt: START - agoMs, contextTokens: 91_130 };
}

function Ticking(props: {
  cache: SummaryCache | null;
  live: boolean;
  stepRunning: boolean;
}) {
  useClockTick();
  return <CacheClockLine {...props} />;
}

function render(props: Parameters<typeof Ticking>[0]): void {
  act(() => root.render(<Ticking {...props} />));
}

function region(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="status"]');
  if (found === null) throw new Error("the status region is missing");
  return found;
}

describe("the cache clock line", () => {
  it("keeps an empty status region in the page while it is silent", () => {
    render({ cache: hourCache(10 * MINUTE), live: true, stepRunning: false });
    expect(region().textContent).toBe("");
    expect(container.querySelector("a")).toBeNull();
  });

  it("puts the headline and the second line in separate elements", () => {
    render({ cache: hourCache(52 * MINUTE), live: true, stepRunning: false });
    expect(container.querySelector(".cache-clock-headline")?.textContent).toBe(
      "Cache warm for about 8 more minutes",
    );
    expect(container.querySelector(".cache-clock-detail")?.textContent).toBe(
      "After that, your next message could write about 91.1K tokens again.",
    );
  });

  it("keeps the same status region when it starts to speak", () => {
    render({ cache: hourCache(10 * MINUTE), live: true, stepRunning: false });
    const before = region();
    act(() => vi.advanceTimersByTime(45 * MINUTE));
    expect(region()).toBe(before);
    expect(before.textContent).toContain("Cache warm");
  });

  it("goes quiet while a step runs and returns when it ends", () => {
    const cache = hourCache(52 * MINUTE);
    render({ cache, live: true, stepRunning: true });
    expect(region().textContent).toBe("");
    render({ cache, live: true, stepRunning: false });
    expect(region().textContent).toContain("Cache warm");
    render({ cache, live: true, stepRunning: true });
    expect(region().textContent).toBe("");
  });

  it("says expired for a session whose last request was long ago", () => {
    render({
      cache: hourCache(3 * 60 * MINUTE),
      live: true,
      stepRunning: false,
    });
    expect(region().textContent).toBe(
      "Cache expiredYour next message could write about 91.1K tokens.",
    );
  });

  it("links to the documentation from outside the status region", () => {
    render({ cache: hourCache(52 * MINUTE), live: true, stepRunning: false });
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://code.claude.com/docs/en/prompt-caching#cache-lifetime",
    );
    expect(link?.textContent).toBe("Prompt caching: how long the cache lasts");
    expect(region().contains(link)).toBe(false);
  });

  it("rewrites its words once a minute at most", () => {
    render({
      cache: hourCache(54 * MINUTE + 30_000),
      live: true,
      stepRunning: false,
    });
    const target = region();
    const seen = new MutationObserver(() => undefined);
    seen.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    let rewrites = 0;
    for (let second = 0; second < 300; second += 1) {
      act(() => vi.advanceTimersByTime(1_000));
      rewrites += seen.takeRecords().length;
    }
    seen.disconnect();
    // 5:30 left at the start: the minute turns at 5:00, 4:00,
    // 3:00, 2:00 and 1:00, and the 300 seconds end at 0:30.
    expect(rewrites).toBe(5);
    expect(target.textContent).toContain("less than a minute");
  });
});

describe("the cache clock in the summary", () => {
  it("sits in the summary header of a live, idle session", () => {
    const snapshot = fixtureSnapshot();
    snapshot.summary.status = "live";
    snapshot.summary.endedAt = null;
    snapshot.summary.cache = hourCache(60 * MINUTE + MINUTE);
    useSessionStore.getState().begin("s1", "token");
    useSessionStore.getState().snapshot(snapshot);
    act(() => {
      root.render(<SummaryWithTick />);
    });
    const head = container.querySelector(".summary-head");
    expect(head?.querySelector(".cache-clock")?.textContent).toContain(
      "Cache expired",
    );
  });
});

function SummaryWithTick() {
  useClockTick();
  return <SessionSummary onCurveSelect={() => undefined} />;
}
