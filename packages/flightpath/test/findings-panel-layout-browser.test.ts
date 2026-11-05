import { type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import {
  focused,
  openWorstCard,
  openFindingsList,
  openFindingsSession,
} from "./support/findings-page.js";
import { pinned, seedFindingsSession } from "./support/findings-session.js";
import { newThemedPage } from "./support/theme-page.js";

// The panel's keyboard, phone layout and accessibility against the real daemon.
let address: { base: string; token: string };
let browser: Browser;

beforeAll(async () => {
  const start = Date.now() - 7 * 60 * 60_000;
  const started = await startSeededBrowser(
    "flightpath-findings-layout-",
    (db) => seedFindingsSession(db, start),
  );
  address = { base: started.base, token: started.token };
  browser = started.browser;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

const PHONE = { width: 390, height: 844 };
const SIZES = [{ width: 1440, height: 900 }, PHONE];

describe("the keyboard", () => {
  it.each(SIZES)(
    "toggles the list with Enter and Space at $width px",
    async (viewport) => {
      const page = await newThemedPage(browser, "light", { viewport });
      await openFindingsSession(page, address);
      await page.locator(".findings-toggle").focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.locator(".findings-region").isVisible())
        .toBe(true);
      await page.keyboard.press("Space");
      await expect
        .poll(() => page.locator(".findings-region").isVisible())
        .toBe(false);
      await page.close();
    },
    60_000,
  );

  it.each(SIZES)(
    "moves through a card's controls in order at $width px",
    async (viewport) => {
      const page = await newThemedPage(browser, "light", { viewport });
      await openFindingsSession(page, address);
      await openFindingsList(page);
      await page.locator(".findings-region .finding-doc").first().focus();
      await page.keyboard.press("Tab");
      expect(await focused(page)).toBe("button.finding-show");
      await page.keyboard.press("Tab");
      expect(await focused(page)).toBe("button.finding-dismiss");
      await page.close();
    },
    60_000,
  );

  it.each(SIZES)(
    "moves focus to the next card when a list card is dismissed at $width px",
    async (viewport) => {
      const page = await newThemedPage(browser, "light", { viewport });
      await openFindingsSession(page, address);
      await openFindingsList(page);
      await page.locator(".findings-region .finding-dismiss").first().focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.locator(".findings-region article").count())
        .toBe(2);
      await expect.poll(() => focused(page)).toContain("finding-grade");
      await page.close();
    },
    60_000,
  );

  it("returns focus to the row when the phone sheet closes with Escape", async () => {
    const page = await newThemedPage(browser, "light", { viewport: PHONE });
    await openFindingsSession(page, address);
    await page.locator(`[data-row-key="step-${pinned.model}"]`).click();
    await page.waitForSelector(".detail .detail-title");
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.getAttribute("data-row-key"),
        ),
      )
      .toBe(`step-${pinned.model}`);
    await page.close();
  }, 60_000);
});

describe("the phone layout", () => {
  it("has no sideways scroll and big enough targets with the list and the sheet open", async () => {
    const page = await newThemedPage(browser, "light", { viewport: PHONE });
    await openWorstCard(page, address);
    const measured = await page.evaluate(() => {
      const small = [
        ...document.querySelectorAll(
          ".finding-dismiss, .finding-copy, .finding-show",
        ),
      ].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.width < 24 || box.height < 24);
      });
      const names = [
        ...document.querySelectorAll(".finding-dismiss, .finding-show"),
      ].filter((el) => el.getBoundingClientRect().width > 0).length;
      return {
        small: small.length,
        checked: names,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(measured.checked).toBeGreaterThanOrEqual(2);
    expect(measured.small).toBe(0);
    expect(measured.overflow).toBeLessThanOrEqual(0);
    await page.close();
  }, 60_000);

  it("keeps the marker on the row's line beside a long name", async () => {
    const page = await newThemedPage(browser, "light", { viewport: PHONE });
    await openFindingsSession(page, address);
    await expect
      .poll(() => page.locator(".trow .grade-marker").count())
      .toBeGreaterThan(0);
    const fit = await page.evaluate(() => {
      const clip = document
        .querySelector(".tree-scroll")
        ?.getBoundingClientRect();
      return [...document.querySelectorAll(".trow .grade-marker")].map(
        (mark) => {
          const box = mark.getBoundingClientRect();
          const line = mark.closest(".trow-line")?.getBoundingClientRect();
          return {
            inClip:
              clip !== undefined &&
              box.left >= clip.left &&
              box.right <= clip.right,
            inLine:
              line !== undefined &&
              box.left >= line.left &&
              box.right <= line.right,
          };
        },
      );
    });
    expect(fit.length).toBeGreaterThan(0);
    expect(fit.every((m) => m.inClip && m.inLine)).toBe(true);
    await page.close();
  }, 60_000);
});

describe("accessibility", () => {
  it.each(
    SIZES.flatMap((viewport) =>
      (["light", "dark"] as const).map((theme) => ({ viewport, theme })),
    ),
  )(
    "is clean with the list open and a card showing, $viewport.width px $theme",
    async ({ viewport, theme }) => {
      const page = await newThemedPage(browser, theme, { viewport });
      await openWorstCard(page, address);
      await expectAxeCleanOnPage(page);
      await page.close();
    },
    60_000,
  );
});
