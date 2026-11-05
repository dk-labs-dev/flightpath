import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseSync } from "../src/storage/sqlite.js";
import { runCleanups } from "./support/cleanup.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser } from "./support/browser.js";
import { requiredValue } from "./support/rows.js";
import {
  seedConditions,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// The session badge and the collapsed rail's tooltips in a
// real browser: the badge needs layout and computed styles
// to compare against the design, and the tooltips need real
// hover, focus and geometry — jsdom has none of those. Three
// sessions are seeded in the states the badge words: live,
// live but quiet, and ended with no exit seen. Both live
// sessions name this test process as their host, so the
// daemon's end watch leaves them live for the whole run.

const LIVE = "badge-live";
const QUIET = "badge-quiet";
const ENDED = "badge-ended";

let base: string;
let token: string;
let browser: Browser;

function seedBadgeSessions(db: DatabaseSync, now: number): void {
  const host = { hostPid: process.pid };
  seedSession(db, {
    id: LIVE,
    projectPath: "/home/user/garden",
    status: "live",
    firstSeenAt: now - 120_000,
    lastSeenAt: now,
    ...host,
  });
  seedConditions(db, LIVE, {});
  const liveTurn = seedTurn(db, {
    sessionId: LIVE,
    startedAt: now - 120_000,
    endedAt: now - 60_000,
    promptText: "List the checks that fail",
  });
  seedStep(db, {
    sessionId: LIVE,
    turnId: liveTurn,
    toolName: "Bash",
    input: { command: "npm test" },
    outcome: "succeeded",
    startedAt: now - 110_000,
    durationMs: 400,
  });
  seedSession(db, {
    id: QUIET,
    projectPath: "/home/user/harbor",
    status: "live",
    firstSeenAt: now - 900_000,
    lastSeenAt: now - 420_000,
    ...host,
  });
  seedConditions(db, QUIET, {});
  seedTurn(db, {
    sessionId: QUIET,
    startedAt: now - 900_000,
    endedAt: now - 420_000,
    promptText: "Fix the slug bug",
  });
  seedSession(db, {
    id: ENDED,
    projectPath: "/home/user/harbor",
    status: "ended",
    firstSeenAt: now - 3_600_000,
    lastSeenAt: now - 1_800_000,
  });
  seedConditions(db, ENDED, {});
  seedTurn(db, {
    sessionId: ENDED,
    startedAt: now - 3_600_000,
    endedAt: now - 1_800_000,
    promptText: "say hi",
  });
  // The end was concluded by the daemon, not seen: no exit
  // arrived for this session.
  db.prepare("UPDATE sessions SET end_seen = ? WHERE id = ?").run(0, ENDED);
}

beforeAll(async () => {
  const started = await startSeededBrowser("flightpath-nav-tooltips-", (db) =>
    seedBadgeSessions(db, Date.now()),
  );
  token = started.token;
  base = started.base;
  browser = started.browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openShell(page: Page): Promise<void> {
  await page.goto(`${base}/#sessions&token=${token}`);
  await page.waitForSelector(".live-card");
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${base}/#session/${id}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".session-badge");
}

interface BadgeLook {
  text: string;
  color: string;
  background: string;
  borderColor: string;
  dot: string | null;
}

async function badgeLook(page: Page): Promise<BadgeLook> {
  return page.evaluate(() => {
    const badge = document.querySelector(".session-badge");
    if (badge === null) throw new Error("badge missing");
    const style = getComputedStyle(badge);
    const dotEl = badge.querySelector(".session-badge-dot");
    return {
      text: badge.textContent ?? "",
      color: style.color,
      background: style.backgroundColor,
      borderColor: style.borderColor,
      dot: dotEl === null ? null : getComputedStyle(dotEl).backgroundColor,
    };
  });
}

describe("the session badge in a browser", () => {
  it("draws a live session's badge in the design's green wash", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, LIVE);
    const look = await badgeLook(page);
    expect(look.text).toBe("Live");
    expect(look.color).toBe("rgb(63, 98, 18)");
    expect(look.background).toBe("rgb(240, 249, 224)");
    expect(look.dot).toBe("rgb(77, 124, 15)");
    await page.close();
  }, 90_000);

  it("draws a quiet session's badge in grey, with its quiet time", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, QUIET);
    const look = await badgeLook(page);
    expect(look.text).toMatch(/^Live · quiet since /);
    expect(look.color).toBe("rgb(38, 38, 38)");
    expect(look.background).toBe("rgb(242, 242, 242)");
    expect(look.dot).toBe("rgb(125, 138, 149)");
    await page.close();
  }, 90_000);

  it("draws an unseen end as an outline with no dot", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, ENDED);
    const look = await badgeLook(page);
    expect(look.text).toMatch(/^Ended .* · no exit seen$/);
    expect(look.background).toBe("rgb(255, 255, 255)");
    expect(look.borderColor).toBe("rgb(212, 212, 212)");
    expect(look.dot).toBeNull();
    await page.close();
  }, 90_000);
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function waitForTooltip(page: Page, text: string): Promise<Box> {
  await page.waitForFunction(
    (wanted) => document.querySelector(".nav-tooltip")?.textContent === wanted,
    text,
    { timeout: 10_000 },
  );
  return requiredValue(
    await page.locator(".nav-tooltip").boundingBox(),
    "the tooltip's bounding box",
  );
}

async function waitForNoTooltip(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".nav-tooltip") === null,
    undefined,
    { timeout: 10_000 },
  );
}

/** The tooltip keeps showing its words for a whole window:
 * polled in the page, never a fixed wait. 600 ms is twice
 * the 300 ms hover delay, so a hide set on a timer — or a
 * leave the crossing fires — lands inside the window. With
 * null the same poll asserts the opposite: no tooltip shows
 * at any point in the window. */
async function expectTooltipStays(
  page: Page,
  text: string | null,
): Promise<void> {
  const stayed = await page.evaluate(
    (wanted) =>
      new Promise<boolean>((resolve) => {
        const started = performance.now();
        const check = () => {
          if (
            (document.querySelector(".nav-tooltip")?.textContent ?? null) !==
            wanted
          ) {
            resolve(false);
            return;
          }
          if (performance.now() - started >= 600) {
            resolve(true);
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      }),
    text,
  );
  expect(stayed).toBe(true);
}

async function collapseRail(page: Page): Promise<void> {
  await page.locator("#nav-toggle").click();
  await page.waitForFunction(
    () => document.querySelector("#sidenav")?.className.includes("collapsed"),
    undefined,
    { timeout: 10_000 },
  );
}

interface RailTrigger {
  selector: string;
  text: string;
}

/** The rail's four tooltip triggers and the words each one
 * shows. The recorder status's words are the footer's own,
 * read off the page. */
async function railTriggers(page: Page): Promise<RailTrigger[]> {
  const statusText = await page.evaluate(
    () => document.querySelector(".nav-status .status-text")?.textContent ?? "",
  );
  expect(statusText).not.toBe("");
  return [
    { selector: ".nav-now", text: "garden · recording" },
    { selector: 'a[data-route="sessions"]', text: "Sessions" },
    { selector: 'a[data-route="settings"]', text: "Settings" },
    { selector: ".nav-status", text: statusText },
  ];
}

/** A fresh page on the shell with the rail collapsed and
 * the triggers read: the start every collapsed-rail test
 * shares. */
async function openCollapsedShell(): Promise<{
  page: Page;
  triggers: RailTrigger[];
}> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await openShell(page);
  const triggers = await railTriggers(page);
  await collapseRail(page);
  return { page, triggers };
}

describe("the collapsed rail's tooltips in a browser", () => {
  it("shows no tooltip while the rail is expanded", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    await page.locator('a[data-route="sessions"]').hover();
    await expectTooltipStays(page, null);
    await page.close();
  }, 60_000);

  it("names every icon on hover, clear of the rail and the next icon", async () => {
    const { page, triggers } = await openCollapsedShell();
    // The recorder status is a paragraph, and a paragraph
    // cannot sit inside a span: its tooltip wrapper is a div.
    const statusWrapperTag = await page.evaluate(
      () => document.querySelector(".nav-status")?.parentElement?.tagName,
    );
    expect(statusWrapperTag).toBe("DIV");
    const rail = requiredValue(
      await page.locator("#sidenav").boundingBox(),
      "the rail's bounding box",
    );
    const railRight = rail.x + rail.width;
    for (const [index, trigger] of triggers.entries()) {
      const target = page.locator(trigger.selector).first();
      const tip = await hoverTooltip(page, target, trigger.text);
      // 8 px clear of the rail, and never over the next icon.
      expect(tip.x).toBeGreaterThanOrEqual(railRight + 7);
      const next = triggers[index + 1];
      if (next !== undefined) {
        const nextBox = requiredValue(
          await page.locator(next.selector).first().boundingBox(),
          "the next icon's bounding box",
        );
        expect(overlaps(tip, nextBox)).toBe(false);
      }
      await page.mouse.move(700, 100);
      await waitForNoTooltip(page);
    }
    await page.close();
  }, 90_000);

  it("stays open while the pointer crosses the gap onto it", async () => {
    const { page, triggers } = await openCollapsedShell();
    for (const trigger of triggers) {
      const target = page.locator(trigger.selector).first();
      const tip = await hoverTooltip(page, target, trigger.text);
      // The pointer crosses the gap in steps, as a real one
      // does — a single jump would skip the crossing entirely
      // — and the tooltip is still up after a window longer
      // than the hover delay.
      await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2, {
        steps: 10,
      });
      await expectTooltipStays(page, trigger.text);
      await page.mouse.move(700, 100);
      await waitForNoTooltip(page);
    }
    await page.close();
  }, 90_000);

  it("names every icon on focus, and Escape closes one however it opened", async () => {
    const { page, triggers } = await openCollapsedShell();
    // Focus shows a tooltip at once, and Escape closes it.
    for (const trigger of triggers.slice(0, 3)) {
      await page.locator(trigger.selector).first().focus();
      await waitForTooltip(page, trigger.text);
      await page.keyboard.press("Escape");
      await waitForNoTooltip(page);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }
    // Escape also closes one the pointer opened.
    await page.locator('a[data-route="settings"]').hover();
    await waitForTooltip(page, "Settings");
    await page.keyboard.press("Escape");
    await waitForNoTooltip(page);
    await page.close();
  }, 90_000);

  it("cancels a tooltip still in its hover delay when Escape is pressed", async () => {
    const { page } = await openCollapsedShell();
    await page.locator('a[data-route="sessions"]').hover();
    await page.keyboard.press("Escape");
    await expectTooltipStays(page, null);
    await page.close();
  }, 60_000);

  it("names Now, Sessions and Settings in that order as Tab walks the rail", async () => {
    const { page } = await openCollapsedShell();
    await page.locator("#nav-toggle").focus();
    // The app bar's brand link is the first stop after the
    // toggle; the rail's three names follow it in order.
    await page.keyboard.press("Tab");
    const brandFocused = await page.evaluate(
      () => document.activeElement === document.querySelector(".brand"),
    );
    expect(brandFocused).toBe(true);
    await page.keyboard.press("Tab");
    await waitForTooltip(page, "garden · recording");
    await page.keyboard.press("Tab");
    await waitForTooltip(page, "Sessions");
    await page.keyboard.press("Tab");
    await waitForTooltip(page, "Settings");
    await page.close();
  }, 60_000);

  it("is axe-clean with the rail collapsed and a tooltip open", async () => {
    const { page } = await openCollapsedShell();
    await page.locator('a[data-route="sessions"]').hover();
    await waitForTooltip(page, "Sessions");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 60_000);
});

async function hoverTooltip(
  page: Page,
  target: ReturnType<Page["locator"]>,
  text: string,
): Promise<Box> {
  await target.hover();
  return waitForTooltip(page, text);
}
