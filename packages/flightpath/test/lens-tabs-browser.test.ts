import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import { seedStepsSession } from "./support/seed.js";
import { newThemedPage } from "./support/theme-page.js";

// The round-trip test records the place's saves on the page
// itself, in a property of its own it declares here.
declare global {
  interface Window {
    placeWrites: number[];
  }
}

// The session screen's lenses in a real browser: the tabs,
// the lens and the selected step in the address, and the
// history the two together make. Times sit just behind the
// clock, as in the steps lens tests: the daemon's retention
// pass would delete a session whose last activity is older
// than the kept-days setting.
const T0 = Date.now() - 900_000;
const SESSION = "tabs-session";
const SESSION_TITLE = "Build a tip calculator";
const SCROLL_SESSION = "scroll-session";
// The tabs session is seeded first in a fresh database, so
// its three steps hold the ids 1, 2, 3 in seeding order.
const STEPS = [1, 2, 3];

let base: string;
let token: string;
let browser: Browser;

function seedTabsSession(db: DatabaseSync): void {
  seedStepsSession(db, {
    id: SESSION,
    projectPath: "/home/user/tip-calc",
    start: T0,
    prompt: SESSION_TITLE,
    steps: [
      { toolName: "Bash", input: { command: "npm test" } },
      {
        toolName: "Read",
        input: { file_path: "/home/user/tip-calc/src/app.ts" },
      },
      {
        toolName: "Edit",
        input: { file_path: "/home/user/tip-calc/src/app.ts" },
      },
    ],
    samples: [
      { sampledAt: T0 + 20_000, contextTokens: 9000 },
      { sampledAt: T0 + 60_000, contextTokens: 20000 },
    ],
  });
  // A session long enough to scroll: the round-trip test
  // below needs a list well past one viewport.
  seedStepsSession(db, {
    id: SCROLL_SESSION,
    projectPath: "/home/user/tip-calc",
    start: T0,
    prompt: "Build a tip calculator",
    steps: Array.from({ length: 80 }, (_, index) => ({
      toolName: "Read",
      input: { file_path: `/home/user/tip-calc/src/file-${index + 1}.ts` },
    })),
    samples: [{ sampledAt: T0 + 20_000, contextTokens: 9000 }],
  });
}

beforeAll(async () => {
  const started = await startSeededBrowser(
    "flightpath-lens-tabs-",
    seedTabsSession,
  );
  base = started.base;
  token = started.token;
  browser = started.browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openSession(page: Page): Promise<void> {
  await page.goto(`${base}/#session/${SESSION}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".trow");
}

// Searching opens every day's group, so the session is found whatever the hour.
async function openList(page: Page): Promise<void> {
  await page.goto(`${base}/#sessions&token=${token}`);
  await page.locator("#picker-search").fill(SESSION_TITLE);
  await page.waitForSelector(`a[href="#session/${SESSION}"]`);
}

async function tabSelected(page: Page, lens: string): Promise<string | null> {
  return page.locator(`#lens-tab-${lens}`).getAttribute("aria-selected");
}

async function rowSelected(page: Page, stepId: number): Promise<string | null> {
  return page
    .locator(`[data-row-key="step-${stepId}"]`)
    .getAttribute("aria-selected");
}

function hashOf(page: Page): string {
  return new URL(page.url()).hash;
}

async function listScrollTop(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector(".tree-scroll")?.scrollTop ?? -1,
  );
}

/** Open the long session, scroll its list down, and wait
 * for that place to be the saved one. The number returned
 * is the place a return or a reload restores. */
async function scrollToSavedPlace(page: Page): Promise<number> {
  await page.goto(`${base}/#session/${SCROLL_SESSION}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".trow");
  await page.evaluate(() => {
    const scroller = document.querySelector(".tree-scroll");
    if (scroller !== null) scroller.scrollTop = 1473;
  });
  // The saved place is what a return reads: poll for the
  // save itself rather than giving it a fixed amount of time.
  await page.waitForFunction((id) => {
    const raw = sessionStorage.getItem(`flightpath-view:${id}`);
    if (raw === null) return false;
    return (JSON.parse(raw) as { scrollTop: number }).scrollTop > 1200;
  }, SCROLL_SESSION);
  return page.evaluate((id) => {
    const raw = sessionStorage.getItem(`flightpath-view:${id}`);
    return raw === null
      ? 0
      : (JSON.parse(raw) as { scrollTop: number }).scrollTop;
  }, SCROLL_SESSION);
}

/** Open the long session at its saved place and switch
 * to the tokens lens, so the steps lens's return is a
 * remount that restores the place. Returns the place. */
async function openPlaceThenTokens(page: Page): Promise<number> {
  const place = await scrollToSavedPlace(page);
  await page.locator("#lens-tab-tokens").click();
  await expect
    .poll(() => page.locator("#lens-panel").textContent())
    .toContain("Context over time");
  return place;
}

/** Record the place's writes on the page from here on,
 * so every save after the return is seen. */
async function recordPlaceWrites(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const writes: number[] = [];
    window.placeWrites = writes;
    const setItem = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = (key: string, value: string) => {
      if (key === `flightpath-view:${id}`) {
        writes.push((JSON.parse(value) as { scrollTop: number }).scrollTop);
      }
      setItem(key, value);
    };
  }, SCROLL_SESSION);
}

/** The race, made to happen: arm a watcher in the page
 * and click the steps tab in the same task. The watcher
 * follows the list frame by frame as the return's restore
 * runs, and on the first frame the list stands within one
 * row of the place it dispatches a wheel on the list and
 * scrolls it by the further scroll in the same task. The
 * restore needs two still frames to settle, so the wheel
 * always lands while it is still running — never after
 * its window has closed. Resolves once the wheel lands. */
async function wheelInsideRestore(
  page: Page,
  place: number,
  furtherScroll: number,
): Promise<void> {
  await page.evaluate(
    ({ placeAt, further }) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 15_000;
        const watch = (): void => {
          const scroller = document.querySelector(".tree-scroll");
          if (
            scroller !== null &&
            Math.abs(scroller.scrollTop - placeAt) <= 56
          ) {
            scroller.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: further,
                bubbles: true,
                cancelable: true,
              }),
            );
            scroller.scrollTop += further;
            resolve();
            return;
          }
          if (performance.now() > deadline) {
            reject(
              new Error("the restore never came within a row of the place"),
            );
            return;
          }
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
        const tab = document.querySelector("#lens-tab-steps");
        if (tab instanceof HTMLElement) tab.click();
      }),
    { placeAt: place, further: furtherScroll },
  );
}

/** The scroll stands where it was left: no snap back
 * across 500 ms of polling. */
async function expectScrollHolds(page: Page, target: number): Promise<void> {
  const holdUntil = Date.now() + 500;
  while (Date.now() < holdUntil) {
    expect(Math.abs((await listScrollTop(page)) - target)).toBeLessThanOrEqual(
      56,
    );
  }
}

/** Reload the page and check the list comes back
 * standing at the target. */
async function expectReloadRestores(page: Page, target: number): Promise<void> {
  await page.reload();
  await page.waitForSelector(".summary");
  await page.waitForSelector(".tree-scroll");
  await expect
    .poll(async () => Math.abs((await listScrollTop(page)) - target))
    .toBeLessThanOrEqual(56);
}

describe("the lens tabs in a browser", () => {
  it("opens the tokens lens and the named step from a deep link, and again after a reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(`${base}/#session/${SESSION}/tokens?step=2&token=${token}`);
    await page.waitForSelector('[role="tablist"]');
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await expect
      .poll(() => page.locator("#lens-panel").textContent())
      .toContain("Context over time");
    await page.reload();
    await page.waitForSelector('[role="tablist"]');
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await page.locator("#lens-tab-steps").click();
    await expect.poll(() => tabSelected(page, "steps")).toBe("true");
    await expect.poll(() => rowSelected(page, 2)).toBe("true");
    await expect.poll(() => hashOf(page)).toBe(`#session/${SESSION}?step=2`);
    await page.close();
  }, 60_000);

  it("walks the lenses with back and forward", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page);
    await page.locator("#lens-tab-tokens").click();
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await page.locator("#lens-tab-snapshot").click();
    await expect.poll(() => tabSelected(page, "snapshot")).toBe("true");
    await page.goBack();
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await page.goBack();
    await expect.poll(() => tabSelected(page, "steps")).toBe("true");
    await page.goForward();
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await page.close();
  }, 60_000);

  it("selecting steps replaces the address instead of adding history", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openList(page);
    await page.locator(`a[href="#session/${SESSION}"]`).click();
    await page.waitForSelector(".summary");
    for (const stepId of STEPS) {
      await page.locator(`[data-row-key="step-${stepId}"]`).click();
      await expect.poll(() => rowSelected(page, stepId)).toBe("true");
      await expect
        .poll(() => hashOf(page))
        .toBe(`#session/${SESSION}?step=${stepId}`);
    }
    await page.goBack();
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector(".session-screen") === null),
      )
      .toBe(true);
    await expect
      .poll(() => hashOf(page))
      .toBe(`#sessions?q=${SESSION_TITLE.replaceAll(" ", "+")}`);
    await page.close();
  }, 60_000);

  it("moves between tabs with the arrow keys and activates with Enter and Space", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page);
    await page.locator("#lens-tab-steps").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("lens-tab-tokens");
    // Manual activation: the arrow moved focus, not the lens.
    await expect.poll(() => tabSelected(page, "steps")).toBe("true");
    await expect.poll(() => tabSelected(page, "tokens")).toBe("false");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("lens-tab-snapshot");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("lens-tab-tokens");
    await page.keyboard.press("Enter");
    await expect.poll(() => tabSelected(page, "tokens")).toBe("true");
    await page.locator("#lens-tab-steps").focus();
    await page.keyboard.press("Space");
    await expect.poll(() => tabSelected(page, "steps")).toBe("true");
    await page.close();
  }, 60_000);

  it("keeps the steps list's place across a lens round trip and a reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const place = await openPlaceThenTokens(page);
    await page.locator("#lens-tab-steps").click();
    await page.waitForSelector(".tree-scroll");
    // The return restores the place the list was left at.
    await expect
      .poll(async () => Math.abs((await listScrollTop(page)) - place))
      .toBeLessThanOrEqual(56);
    // The reload restores the same place.
    await expectReloadRestores(page, place);
    await page.close();
  }, 60_000);

  it("keeps a scroll made during the place restore, and saves it as the place", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const place = await openPlaceThenTokens(page);
    await recordPlaceWrites(page);
    // The race, driven on purpose: a wheel scroll lands
    // inside the restore the return sets off, by
    // construction — not once the list has reached the
    // place, when the restore's window has closed.
    const furtherScroll = 200;
    await wheelInsideRestore(page, place, furtherScroll);
    // The scroll stands: no snap back to the place.
    await expectScrollHolds(page, place + furtherScroll);
    // Saving has resumed once a write lands furtherScroll px past
    // the place: a save of the place itself is too far to meet it.
    await page.waitForFunction((target) => {
      const writes = window.placeWrites;
      return writes.some((write) => Math.abs(write - target) <= 56);
    }, place + furtherScroll);
    // Every write since the return is the place, or the place
    // plus the further scroll — none is the remount's top, which
    // would overwrite the place.
    const writes = await page.evaluate(() => window.placeWrites);
    for (const write of writes) {
      const atPlace = Math.abs(write - place) <= 56;
      const atScroll = Math.abs(write - (place + furtherScroll)) <= 56;
      expect(atPlace || atScroll).toBe(true);
    }
    // The reload restores the last saved place: the further scroll's.
    await expectReloadRestores(page, place + furtherScroll);
    await page.close();
  }, 60_000);

  it("lets the address win over the saved place, and selects nothing for a step the session doesn't hold", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page);
    await page.locator(`[data-row-key="step-1"]`).click();
    await expect.poll(() => rowSelected(page, 1)).toBe("true");
    // The saved place now names step 1.
    await page.waitForFunction((id) => {
      const raw = sessionStorage.getItem(`flightpath-view:${id}`);
      if (raw === null) return false;
      return (
        (JSON.parse(raw) as { selectedStepId: number | null })
          .selectedStepId === 1
      );
    }, SESSION);
    // The address naming step 2 wins over that saved place:
    // reload with it, so the winner is decided as the saved
    // place lands — the address is applied after it, not
    // before.
    await page.goto(`${base}/#session/${SESSION}?step=2&token=${token}`);
    await page.reload();
    await page.waitForSelector(".summary");
    await expect.poll(() => rowSelected(page, 2)).toBe("true");
    await expect.poll(() => rowSelected(page, 1)).toBe("false");
    // An address naming a step the session doesn't hold
    // selects nothing, and nothing says so.
    await page.goto(`${base}/#session/${SESSION}?step=999&token=${token}`);
    await expect
      .poll(async () =>
        page.locator('[data-row-key][aria-selected="true"]').count(),
      )
      .toBe(0);
    await expect
      .poll(async () => page.locator('[role="alert"]').count())
      .toBe(0);
    await page.close();
  }, 60_000);

  // Each screen is drawn in both themes on both kinds of computer,
  // because the theme choice and the system setting each pick
  // the half of every colour pair.
  const SCHEMES = [
    ["light", "light"],
    ["light", "dark"],
    ["dark", "light"],
    ["dark", "dark"],
  ] as const;

  it.each(SCHEMES)(
    "has no serious or critical axe violations on any screen in %s on a %s computer",
    async (theme, colorScheme) => {
      const page = await newThemedPage(browser, theme, { colorScheme });
      await openSession(page);
      await expectAxeCleanOnPage(page);
      for (const lens of ["tokens", "snapshot"] as const) {
        await page.locator(`#lens-tab-${lens}`).click();
        // Each lens is checked as it stands once loaded, on
        // its own heading: the tokens lens on "Context over
        // time", the snapshot lens on "In context at this step".
        await expect
          .poll(() => page.locator("#lens-panel").textContent())
          .toContain(
            lens === "tokens" ? "Context over time" : "In context at this step",
          );
        await expectAxeCleanOnPage(page);
      }
      await openList(page);
      await expectAxeCleanOnPage(page);
      await page.goto(`${base}/#settings&token=${token}`);
      await page.waitForSelector("#group-appearance-h");
      await expectAxeCleanOnPage(page);
      await page.close();
    },
    120_000,
  );
});
