import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { startSeededBrowser, type SeededBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import {
  seedConditions,
  seedRequestExact,
  seedSegment,
  seedSession,
  seedTurn,
} from "./support/seed.js";
import { frameBudgetHolds, medianOf, percentileOf } from "./support/time.js";

// The tokens lens's budget, on the steps lens's pattern: a
// 5,000-request session opens inside the same envelope the
// steps lens holds (under 1.5 s to the drawn curve), and
// scrolling it keeps every frame inside 50 ms at the 95th
// percentile, taken as the median of several scrolls because one
// scroll is 23 frames and a single stalled frame decides its 95th.
// The curve draws a reduced set — the reading
// still walks all 5,000 points — so the cost a long session
// adds is the payload and the reduction, both small.

const SESSION = "sess-tokens-budget";
const REQUESTS = 5_000;
const OPEN_BUDGET_MS = 1_500;
const FRAME_P95_BUDGET_MS = 50;
const SCROLL_PASSES = 5;

function seedLongSession(db: DatabaseSync): void {
  const start = Date.now() - 3_600_000;
  seedSession(db, {
    id: SESSION,
    model: "claude-sonnet",
    firstSeenAt: start,
    lastSeenAt: start + REQUESTS * 1_000,
  });
  seedConditions(db, SESSION, { sources: ["hook", "telemetry"] });
  seedSegment(db, {
    sessionId: SESSION,
    kind: "startup",
    startedAt: start,
    contextTokens: 20_000,
  });
  seedTurn(db, {
    id: 1,
    sessionId: SESSION,
    sequence: 1,
    startedAt: start,
    endedAt: start + REQUESTS * 1_000,
    promptChars: 21,
  });
  for (let i = 0; i < REQUESTS; i += 1) {
    seedRequestExact(db, {
      id: i + 1,
      sessionId: SESSION,
      turnId: 1,
      startedAt: start + i * 1_000,
      input: 200,
      cacheRead: 20_000 + i * 10,
      output: 100,
    });
  }
}

let started: SeededBrowser;
let browser: Browser;
let page: Page;

async function frameDeltasWhileScrolling(): Promise<number[]> {
  return page.evaluate(async () => {
    const scroller = document.querySelector(".screen");
    if (scroller === null) throw new Error("no .screen to scroll");
    const deltas: number[] = [];
    let last = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        deltas.push(now - last);
        last = now;
        frames += 1;
        scroller.scrollTop = frames * 30;
        if (frames < 24) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return deltas.slice(1);
  });
}

beforeAll(async () => {
  started = await startSeededBrowser(
    "flightpath-tokens-budget-",
    seedLongSession,
  );
  browser = started.browser;
  page = await browser.newPage({ viewport: { width: 1440, height: 480 } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

describe("the tokens lens's budget", () => {
  it("opens a 5,000-request session inside the steps lens's envelope", async () => {
    await page.goto(
      `${started.base}/#session/${SESSION}/tokens?token=${started.token}`,
    );
    await page.waitForSelector("polyline.tokens-curve-line");
    const openedMs = await page.evaluate(() => performance.now());
    expect(openedMs).toBeLessThan(OPEN_BUDGET_MS);
    const passP95s: number[] = [];
    for (let pass = 0; pass < SCROLL_PASSES; pass += 1) {
      passP95s.push(percentileOf(await frameDeltasWhileScrolling(), 0.95));
    }
    const p95 = medianOf(passP95s);
    console.log(
      `tokens lens: scroll frames p95 ${p95.toFixed(1)} ms, median of ${SCROLL_PASSES} passes`,
    );
    if (frameBudgetHolds) expect(p95).toBeLessThan(FRAME_P95_BUDGET_MS);
  });
});
