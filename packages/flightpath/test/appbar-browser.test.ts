import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { useSeededBrowser } from "./support/browser-boot.js";
import { waitForConnection } from "./support/connection.js";
import { seedConditions, seedSession, seedTurn } from "./support/seed.js";

// The app bar, and the first-run hint on an ended
// session's screen. The session's title is its first
// prompt's text, so a 60-character prompt makes the title
// the breadcrumb has to fit beside the connection pill.

const LONG = "sess-long-title";
const SHORT = "sess-short-title";
const LONG_TITLE =
  "A session title long enough to crowd the phone app bar today";
const AT = Date.now() - 3_600_000;

function seedTitle(db: DatabaseSync, id: string, promptText: string): void {
  seedSession(db, {
    id,
    status: "ended",
    firstSeenAt: AT,
    lastSeenAt: AT + 60_000,
  });
  seedConditions(db, id, { updatedAt: AT });
  seedTurn(db, {
    sessionId: id,
    sequence: 1,
    startedAt: AT,
    endedAt: AT + 50_000,
    promptText,
  });
}

const suite = useSeededBrowser("flightpath-appbar-", (db) => {
  seedTitle(db, LONG, LONG_TITLE);
  seedTitle(db, SHORT, "Short");
});

async function openSession(
  page: Page,
  id: string,
  title: string,
): Promise<void> {
  const started = suite();
  const url = started.base + "/#session/" + id + "?token=" + started.token;
  await page.goto(url);
  await page.locator(".crumb-current", { hasText: title }).waitFor();
  await waitForConnection(page, "Live");
}

// Reads the app bar's pieces in one pass: every check
// below measures the same boxes.
async function measureBar(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".appbar");
    const pill = document.querySelector(".connection-pill");
    const crumb = document.querySelector(".crumb");
    const spacer = document.querySelector(".appbar-spacer");
    const current = document.querySelector(".crumb-current");
    if (
      bar === null ||
      pill === null ||
      crumb === null ||
      spacer === null ||
      current === null
    ) {
      throw new Error("app bar pieces missing");
    }
    const piece = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      bar: piece(bar),
      pill: piece(pill),
      crumb: piece(crumb),
      spacer: piece(spacer),
      title: piece(current),
      titleTruncated: current.scrollWidth > current.clientWidth,
    };
  });
}

describe("the app bar", () => {
  it("keeps the pill on the breadcrumb's line under a 60-character title", async () => {
    expect(LONG_TITLE.length).toBe(60);
    const page = await suite().browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page, LONG, LONG_TITLE);
    const boxes = await measureBar(page);
    // Sharing the line means their vertical centres meet:
    // the bar centres both pieces, and the pill is taller
    // than the crumb, so their tops differ on one line.
    const pillCentre = boxes.pill.top + boxes.pill.height / 2;
    const crumbCentre = boxes.crumb.top + boxes.crumb.height / 2;
    expect(Math.abs(pillCentre - crumbCentre)).toBeLessThanOrEqual(2);
    expect(boxes.crumb.right).toBeLessThanOrEqual(boxes.pill.left + 2);
    expect(boxes.titleTruncated).toBe(true);
    // At phone width the breadcrumb shows the title only:
    // its "Sessions" link is hidden, and that hiding is
    // what leaves the title its room — with the link back
    // the title would get about 60 px instead of about 140.
    expect(await page.locator(".crumb a").isVisible()).toBe(false);
    expect(boxes.title.width).toBeGreaterThanOrEqual(120);
    await page.close();
  }, 90_000);

  it("keeps the pill at the bar's right edge under a short title", async () => {
    const browser = suite().browser;
    const shortPage = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(shortPage, SHORT, "Short");
    const shortBoxes = await measureBar(shortPage);
    const longPage = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(longPage, LONG, LONG_TITLE);
    const longBoxes = await measureBar(longPage);
    expect(
      Math.abs(longBoxes.bar.height - shortBoxes.bar.height),
    ).toBeLessThanOrEqual(2);
    // The gap between the pill's right edge and the bar's
    // right edge: the bar's own right padding, 20 px, when
    // the pill sits at the right edge of a one-line bar.
    const pillRightGap = shortBoxes.bar.right - shortBoxes.pill.right;
    expect(pillRightGap).toBeGreaterThanOrEqual(18);
    expect(pillRightGap).toBeLessThanOrEqual(22);
    await longPage.close();
    await shortPage.close();
  }, 90_000);

  it("leaves the long title uncut on a wide bar, the spacer taking no room", async () => {
    const page = await suite().browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, LONG, LONG_TITLE);
    const boxes = await measureBar(page);
    // The spacer beside a crumb does not grow, so the crumb
    // takes the bar's free room instead of splitting it with
    // the spacer; without that rule the spacer would be as
    // wide as the crumb and this width would not be 0.
    expect(boxes.spacer.width).toBe(0);
    expect(boxes.titleTruncated).toBe(false);
    await page.close();
  }, 90_000);

  it("passes axe on the session page at phone and wide widths", async () => {
    const browser = suite().browser;
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page, LONG, LONG_TITLE);
    await expectAxeCleanOnPage(page);
    const widePage = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(widePage, LONG, LONG_TITLE);
    await expectAxeCleanOnPage(widePage);
    await widePage.close();
    await page.close();
  }, 90_000);

  it("words the first-run hint without calling an ended session live", async () => {
    const page = await suite().browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page, LONG, LONG_TITLE);
    const hint = page.locator("#hint p");
    await hint.waitFor();
    expect(await hint.innerText()).toBe(
      "Each row is one thing Claude did. Click a row for its details.",
    );
    await page.close();
  }, 90_000);
});
