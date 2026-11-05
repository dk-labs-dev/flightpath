import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { useSeededBrowser } from "./support/browser-boot.js";
import {
  seedConditions,
  seedRequestExact,
  seedSession,
  seedTurn,
} from "./support/seed.js";
import { newThemedPage } from "./support/theme-page.js";

// The cold-cache clock in the summary header, over two live
// sessions whose last request wrote an hour's cache: one with
// eight minutes of it left, one past its end.

const NEAR = "sess-cache-near";
const PAST = "sess-cache-past";
const MINUTE = 60_000;

function seedIdleSession(
  db: DatabaseSync,
  id: string,
  endedMinutesAgo: number,
): void {
  const ended = Date.now() - endedMinutesAgo * MINUTE;
  seedSession(db, {
    id,
    status: "live",
    firstSeenAt: ended - 5 * MINUTE,
    lastSeenAt: ended,
    // This process stands for the session's Claude Code, so the
    // daemon's session-end watch leaves the session live.
    hostPid: process.pid,
  });
  seedConditions(db, id, { updatedAt: ended });
  seedTurn(db, {
    id: id === NEAR ? 1 : 2,
    sessionId: id,
    sequence: 1,
    startedAt: ended - 4 * MINUTE,
    endedAt: ended,
    promptText: "Build a tip calculator",
  });
  seedRequestExact(db, {
    id: id === NEAR ? 1 : 2,
    sessionId: id,
    turnId: id === NEAR ? 1 : 2,
    startedAt: ended - 3_000,
    durationMs: 3_000,
    input: 130,
    cacheRead: 83_000,
    cacheWrite1h: 8_000,
  });
}

const suite = useSeededBrowser("flightpath-cache-clock-", (db) => {
  seedIdleSession(db, NEAR, 52);
  seedIdleSession(db, PAST, 72);
});

async function openSession(page: Page, id: string): Promise<void> {
  const started = suite();
  await page.goto(started.base + "/#session/" + id + "?token=" + started.token);
  await page.locator(".summary-title").waitFor();
}

async function measureSummary(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`${selector} is missing`);
      const { top, bottom, left, right } = el.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const root = document.scrollingElement;
    return {
      card: box(".summary"),
      title: box(".summary-title"),
      badge: box(".session-badge"),
      meta: box(".summary-meta"),
      clock: box(".cache-clock"),
      headline: box(".cache-clock-headline"),
      detail: box(".cache-clock-detail"),
      link: box(".cache-clock-body a"),
      pageScrolls: root !== null && root.scrollWidth > root.clientWidth,
    };
  });
}

describe.each([
  ["a phone", 390],
  ["a desktop", 1440],
])("the cache clock on %s", (_name, width) => {
  it("sits under the title row inside the summary, with nothing cut off", async () => {
    const page = await suite().browser.newPage({
      viewport: { width, height: 900 },
    });
    await openSession(page, NEAR);
    await page.locator(".cache-clock").waitFor();
    const m = await measureSummary(page);
    expect(m.pageScrolls).toBe(false);
    for (const part of [m.clock, m.headline, m.detail, m.link]) {
      expect(part.left).toBeGreaterThanOrEqual(m.card.left);
      expect(part.right).toBeLessThanOrEqual(m.card.right);
    }
    // The clock takes the row below the title, the badge and the
    // meta line, and its own lines do not overlap.
    for (const above of [m.title, m.badge, m.meta]) {
      expect(m.clock.top).toBeGreaterThanOrEqual(above.bottom);
    }
    expect(m.detail.top).toBeGreaterThanOrEqual(m.headline.bottom - 1);
    expect(m.link.top).toBeGreaterThanOrEqual(m.detail.bottom - 1);
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 90_000);

  it("reads the expired words for a session past its cache's end", async () => {
    const page = await newThemedPage(suite().browser, "dark", {
      viewport: { width, height: 900 },
    });
    await openSession(page, PAST);
    await page.locator(".cache-clock").waitFor();
    expect(
      await page.locator('[role="status"].cache-clock-lines').textContent(),
    ).toBe("Cache expiredYour next message could write about 91.1K tokens.");
    expect((await measureSummary(page)).pageScrolls).toBe(false);
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 90_000);
});

describe("the cache clock's words in the browser", () => {
  it("counts the minutes left from the last request's end", async () => {
    const page = await suite().browser.newPage();
    await openSession(page, NEAR);
    await page.locator(".cache-clock").waitFor();
    expect(await page.locator(".cache-clock-headline").textContent()).toMatch(
      /^Cache warm for about [78] more minutes$/,
    );
    await page.close();
  }, 90_000);
});
