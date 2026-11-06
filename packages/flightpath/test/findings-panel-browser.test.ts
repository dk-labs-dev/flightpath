import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startSeededBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import { openFindingsList } from "./support/findings-page.js";
import {
  FINDINGS_SESSION,
  pinned,
  QUIET_SESSION,
  seedFindingsSession,
  seedQuietSession,
} from "./support/findings-session.js";
import { newThemedPage, resolvedTokens } from "./support/theme-page.js";

// The findings panel against the real daemon: three findings the
// rebuild detector reports over seeded requests, read through the
// real routes and dismissed through the real route.
let base: string;
let token: string;
let browser: Browser;

beforeAll(async () => {
  const start = Date.now() - 7 * 60 * 60_000;
  const started = await startSeededBrowser(
    "flightpath-findings-panel-",
    (db) => {
      seedFindingsSession(db, start);
      seedQuietSession(db, start);
    },
  );
  ({ base, token, browser } = started);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function open(page: Page, session = FINDINGS_SESSION): Promise<void> {
  await page.goto(`${base}/#session/${session}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".trow");
}

const marker = (page: Page, stepId: number) =>
  page.locator(`[data-row-key="step-${stepId}"] .grade-marker`);

describe("the markers", () => {
  it("name each step's grade, differ in shape and draw in the grade's token", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    await expect
      .poll(() => page.locator(".grade-marker[role=img]").count())
      .toBe(3);
    const drawn = await page.evaluate(() =>
      [...document.querySelectorAll(".trow .grade-marker")].map((el) => ({
        name: el.getAttribute("aria-label"),
        shape: el.firstElementChild?.tagName,
        fill: el.firstElementChild?.getAttribute("fill"),
        colour: getComputedStyle(el).color,
      })),
    );
    expect(drawn).toHaveLength(3);
    const tokens = await resolvedTokens(page);
    const byName = new Map(drawn.map((d) => [d.name, d]));
    expect(byName.get("Worth fixing")).toMatchObject({
      shape: "circle",
      fill: "currentColor",
      colour: tokens["--grade-fix"],
    });
    expect(byName.get("Worth a look")).toMatchObject({
      shape: "circle",
      fill: "none",
      colour: tokens["--grade-look"],
    });
    expect(byName.has("Did you know")).toBe(false);
    await page.close();
  }, 60_000);

  it("sit on the step each rebuild's request was carried by", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    await expect
      .poll(() => marker(page, pinned.habit).getAttribute("aria-label"))
      .toBe("Worth fixing");
    expect(await marker(page, pinned.expired).getAttribute("aria-label")).toBe(
      "Worth a look",
    );
    expect(await marker(page, pinned.model).getAttribute("aria-label")).toBe(
      "Worth a look",
    );
    await page.close();
  }, 60_000);

  it("move onto a shut turn's row and back onto the step when it opens", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    const turn = page.locator('[data-row-key^="turn-"]').last();
    await turn.locator(".trow-toggle").click();
    await expect.poll(() => marker(page, pinned.habit).count()).toBe(0);
    expect(await turn.locator(".grade-marker").getAttribute("aria-label")).toBe(
      "Worth fixing",
    );
    await turn.locator(".trow-toggle").click();
    await expect.poll(() => marker(page, pinned.habit).count()).toBe(1);
    await page.close();
  }, 60_000);
});

describe("the list and the card", () => {
  it("starts open with the cards in view when a suggestion is worth fixing", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    const toggle = page.locator(".findings-toggle");
    await expect
      .poll(() => toggle.textContent())
      .toBe("3 suggestions · 1 worth fixing");
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    const controls = await toggle.getAttribute("aria-controls");
    expect(await page.locator(`#${controls}`).isVisible()).toBe(true);
    expect(
      await page.locator(".findings-region .finding-grade").allTextContents(),
    ).toEqual(["Worth fixing", "Worth a look", "Worth a look"]);
    await page.close();
  }, 60_000);

  it("opens the step on its Suggestions tab from Show in steps", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    await openFindingsList(page);
    await page.locator(".findings-region .finding-show").first().click();
    await expect
      .poll(() =>
        page.locator("#detail-tab-suggestions").getAttribute("aria-selected"),
      )
      .toBe("true");
    expect(
      await page
        .locator(`[data-row-key="step-${pinned.habit}"]`)
        .getAttribute("aria-selected"),
    ).toBe("true");
    await page.close();
  }, 60_000);

  it("opens a marked row on Details and keeps its card on the second tab", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    await page.locator(`[data-row-key="step-${pinned.model}"]`).click();
    await expect
      .poll(() =>
        page.locator("#detail-tab-details").getAttribute("aria-selected"),
      )
      .toBe("true");
    expect(await page.locator("#detail-tab-suggestions").textContent()).toBe(
      "Suggestions · 1",
    );
    await page.locator("#detail-tab-suggestions").click();
    expect(
      await page
        .locator("#detail-panel-suggestions .finding-headline")
        .textContent(),
    ).toContain("Pick your model at the start of a session");
    await page.close();
  }, 60_000);
});

describe("dismissing", () => {
  it("stays gone after the page is reloaded", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page);
    await page.locator(`[data-row-key="step-${pinned.model}"]`).click();
    await page.locator("#detail-tab-suggestions").click();
    await page.locator("#detail-panel-suggestions .finding-dismiss").click();
    await expect.poll(() => marker(page, pinned.model).count()).toBe(0);
    expect(await page.locator("#detail-tab-suggestions").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.className)).toBe(
      "detail-title",
    );
    await page.reload();
    await page.waitForSelector(".trow");
    await expect
      .poll(() => page.locator(".findings-toggle").textContent())
      .toBe("2 suggestions · 1 worth fixing");
    expect(await marker(page, pinned.model).count()).toBe(0);
    await page.close();
  }, 60_000);
});

describe("a session with nothing to say", () => {
  it("shows no list or marker and starts the tree under the toolbar", async () => {
    const page = await newThemedPage(browser, "light");
    await open(page, QUIET_SESSION);
    expect(await page.locator(".findings-list, .grade-marker").count()).toBe(0);
    const gap = await page.evaluate(() => {
      const bar = document
        .querySelector(".steps-toolbar")
        ?.getBoundingClientRect();
      const tree = document
        .querySelector(".tree-scroll")
        ?.getBoundingClientRect();
      return bar === undefined || tree === undefined
        ? null
        : tree.top - bar.bottom;
    });
    expect(gap).toBeLessThan(2);
    await page.close();
  }, 60_000);
});
