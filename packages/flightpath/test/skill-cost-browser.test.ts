import { join } from "node:path";

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { expectAxeCleanOnPage } from "./support/axe.js";
import { useSeededBrowser } from "./support/browser-boot.js";
import { makeTempRoot } from "./support/cleanup.js";
import {
  SKILL_COST_SESSION,
  seedSkillCostSession,
} from "./support/skill-cost-session.js";
import { newThemedPage } from "./support/theme-page.js";

// A skill and the files it attached, in the rises and in the
// snapshot, and a saved tool output read back, in a real browser:
// the lines sit inside their cards, a file's size clear of its detail, at phone and desktop widths in
// both themes, and the page never scrolls sideways. Captures go
// to the suite's temporary folder.
const START = Date.now() - 900_000;

const suite = useSeededBrowser("flightpath-skill-cost-", (db) =>
  seedSkillCostSession(db, START),
);

const VIEWS = [
  { theme: "light", width: 1440 },
  { theme: "light", width: 390 },
  { theme: "dark", width: 1440 },
  { theme: "dark", width: 390 },
] as const;

async function openSession(page: Page, path = ""): Promise<void> {
  const started = suite();
  await page.goto(
    `${started.base}/#session/${SKILL_COST_SESSION}${path}?token=${started.token}`,
  );
}

/** The skill's files line opened, and every part of it measured
 * against the box that holds it. */
async function openFilesInside(page: Page, card: string): Promise<void> {
  await page.locator(".skill-files-head").click();
  await expect
    .poll(() => page.locator(".skill-files-list").isVisible())
    .toBe(true);
  const measured = await page.evaluate((cardSelector) => {
    const box = document.querySelector(cardSelector)?.getBoundingClientRect();
    const parts = [
      ...document.querySelectorAll(
        ".skill-files-head, .skill-files-file, .skill-files-path, .skill-files-size",
      ),
    ].map((part) => part.getBoundingClientRect());
    // The text's own box: a nowrap line can run past its element's.
    const textBox = (element: Element): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const root = document.scrollingElement;
    const overlapping = [...document.querySelectorAll(".skill-files-file")]
      .map((row) => [
        textBox(row.querySelector(".skill-files-detail")!),
        row.querySelector(".skill-files-size")!.getBoundingClientRect(),
      ])
      .filter(
        ([a, b]) =>
          a!.left < b!.right &&
          b!.left < a!.right &&
          a!.top < b!.bottom &&
          b!.top < a!.bottom,
      ).length;
    const title = document.querySelector(".skill-files-title")!;
    const chevron = document.querySelector(".skill-files-head svg")!;
    const firstLine = textBox(title);
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    const titleBox = title.getBoundingClientRect();
    const chevronBox = chevron.getBoundingClientRect();
    const head = {
      chevronMiddle: chevronBox.top + chevronBox.height / 2,
      titleTop: titleBox.top,
      lineHeight: Number.isNaN(lineHeight) ? firstLine.height : lineHeight,
      titleHeight: titleBox.height,
    };
    return {
      head,
      overlapping,
      card: box === undefined ? null : { left: box.left, right: box.right },
      parts: parts.map(({ left, right }) => ({ left, right })),
      pageScrolls: root !== null && root.scrollWidth > root.clientWidth,
    };
  }, card);
  expect(measured.card).not.toBeNull();
  // The head and its size, then each of the three files' row,
  // path and size.
  expect(measured.parts).toHaveLength(2 + 3 * 3);
  for (const part of measured.parts) {
    expect(part.left).toBeGreaterThanOrEqual(measured.card!.left);
    expect(part.right).toBeLessThanOrEqual(measured.card!.right);
  }
  // The title keeps to one line, and the chevron sits beside it.
  const { head } = measured;
  expect(head.titleHeight).toBeLessThan(head.lineHeight * 1.5);
  expect(head.chevronMiddle).toBeGreaterThan(head.titleTop);
  expect(head.chevronMiddle).toBeLessThan(head.titleTop + head.lineHeight);
  expect(measured.overlapping).toBe(0);
  expect(measured.pageScrolls).toBe(false);
}

describe.each(VIEWS)("a skill's files in $theme at $width px", (view) => {
  async function themedPage(): Promise<Page> {
    return newThemedPage(suite().browser, view.theme, {
      viewport: { width: view.width, height: 900 },
    });
  }

  it("sit under the skill in the rises, inside the card", async () => {
    const page = await themedPage();
    await openSession(page, "/tokens");
    await page.locator(".tokens-rise-head").first().click();
    await expect
      .poll(() => page.locator(".skill-files-head").textContent())
      .toBe("+ 3 files it attachedabout 18.0K tokensest.");
    await openFilesInside(page, ".tokens-rise-items");
    await expectAxeCleanOnPage(page);
    await page
      .locator(".tokens-rise")
      .first()
      .screenshot({
        path: join(shotsDir, `rise-${view.theme}-${view.width}.png`),
      });
    await page.close();
  }, 120_000);

  it("sit under the skill in the snapshot, inside the panel", async () => {
    const page = await themedPage();
    await openSession(page);
    await page.locator('[data-row-key="step-2"]').click();
    await page.locator("#lens-tab-snapshot").click();
    await page.locator(".snapshot-group-head", { hasText: "Skills" }).click();
    await expect
      .poll(() => page.locator(".skill-files-head").textContent())
      .toBe("+ 3 files it attachedabout 18.0K tokensest.");
    await openFilesInside(page, ".snapshot-lens");
    await expectAxeCleanOnPage(page);
    await page.locator(".snapshot-lens").screenshot({
      path: join(shotsDir, `snapshot-${view.theme}-${view.width}.png`),
    });
    await page.close();
  }, 120_000);
});

// Set to keep the screenshots; otherwise they go to a temporary folder.
const shotsDir =
  process.env["FLIGHTPATH_CAPTURES"] ?? makeTempRoot("flightpath-skill-cost-");

describe("a saved tool output read back", () => {
  it("reads as the output of its step, which the panel opens", async () => {
    const page = await suite().browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page);
    await page.locator('[data-row-key="step-2"]').click();
    await expect
      .poll(() => page.locator(".detail-title").textContent())
      .toBe("Read the saved output of Ran `npm test`");
    await page.locator(".detail-link").click();
    await expect
      .poll(() => page.locator(".detail-title").textContent())
      .toBe("Ran `npm test`");
    await expect
      .poll(() => page.locator(".detail").textContent())
      .toContain("Output saved to a file (31.0 KB)");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 120_000);
});
