import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { bootBrowser } from "./support/browser.js";
import { distDir } from "./support/daemon.js";
import { requiredValue } from "./support/rows.js";
import { expectAxeCleanOnPage } from "./support/axe.js";

// The view shell in a real browser: the checks jsdom cannot do,
// because they need layout, styles and a real reload.
const distView = join(distDir, "view");

let base: string;
let token: string;
let browser: Browser;

beforeAll(async () => {
  ({ base, token, browser } = await bootBrowser("flightpath-view-browser-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openShell(page: Page, hash = "#sessions"): Promise<void> {
  await page.goto(`${base}/${hash}&token=${token}`);
  await page.waitForSelector("#screen .empty");
}

describe("the view shell in a browser", () => {
  it("collapses and expands by mouse and keyboard, surviving a reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    const toggle = page.locator("#nav-toggle");
    await expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    await toggle.click();
    await expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await expect(
      await page.locator("#sidenav").evaluate((e) => e.className),
    ).toContain("collapsed");
    // The rail keeps the recorder status dot at its foot.
    const dot = requiredValue(
      await page.locator(".status-dot").boundingBox(),
      "the status dot's bounding box",
    );
    expect(dot.width).toBeGreaterThan(0);
    await page.reload();
    await page.waitForSelector("#screen .empty");
    await expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    await page.close();
  }, 60_000);

  it("moves focus to the screen on a route change, and keeps the footer in view", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 700 },
    });
    await openShell(page);
    await page.locator('a[data-route="settings"]').click();
    // The previous screen also has an empty state, so wait for
    // the route change itself: focus lands on the screen.
    await page.waitForFunction(() => document.activeElement?.id === "screen");
    await expect(
      await page
        .locator('a[data-route="settings"]')
        .getAttribute("aria-current"),
    ).toBe("page");
    const footerBox = requiredValue(
      await page.locator(".nav-footer").boundingBox(),
      "the nav footer's bounding box",
    );
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(700);
    await page.close();
  }, 60_000);

  it("has no sideways scroll at 360 px, with the nav stacked above the content", async () => {
    const page = await browser.newPage({
      viewport: { width: 360, height: 800 },
    });
    await openShell(page);
    await expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    // The nav starts collapsed on a narrow screen; opening it
    // stacks it above the content rather than beside it.
    await page.locator("#nav-toggle").click();
    const navBox = requiredValue(
      await page.locator("#sidenav").boundingBox(),
      "the side nav's bounding box",
    );
    const mainBox = requiredValue(
      await page.locator("#screen").boundingBox(),
      "the screen's bounding box",
    );
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(mainBox.y + 1);
    await page.close();
  }, 60_000);

  it("loads nothing from outside 127.0.0.1", async () => {
    const page = await browser.newPage();
    const origins = new Set<string>();
    page.on("request", (request) => {
      origins.add(new URL(request.url()).origin);
    });
    await openShell(page);
    await page.waitForTimeout(300);
    await expect([...origins]).toEqual([base]);
    await page.close();
  }, 60_000);

  it("shows a rebuilt stylesheet on a plain reload", async () => {
    const page = await browser.newPage();
    await openShell(page);
    const href = requiredValue(
      await page.locator('link[rel="stylesheet"]').getAttribute("href"),
      "the stylesheet href",
    );
    const cssName = href.replace("/view/", "");
    const cssPath = join(distView, cssName);
    const indexPath = join(distView, "index.html");
    const originalCss = readFileSync(cssPath, "utf8");
    const originalIndex = readFileSync(indexPath, "utf8");
    const before = await page.evaluate(() => {
      const appbar = document.querySelector(".appbar");
      if (appbar === null) {
        throw new Error("the app bar is missing from the page");
      }
      return getComputedStyle(appbar).backgroundColor;
    });
    try {
      // A rebuild gives the stylesheet a new hashed name and the
      // no-store page points at it; the reload picks it up
      // without a hard refresh.
      const rebuiltName = cssName.replace(/\.css$/, "-rebuilt.css");
      writeFileSync(
        join(distView, rebuiltName),
        `${originalCss}\n.appbar { background: rgb(18, 52, 86); }\n`,
      );
      writeFileSync(indexPath, originalIndex.replace(cssName, rebuiltName));
      await page.reload();
      await page.waitForSelector("#screen .empty");
      const after = await page.evaluate(() => {
        const appbar = document.querySelector(".appbar");
        if (appbar === null) {
          throw new Error("the app bar is missing from the page");
        }
        return getComputedStyle(appbar).backgroundColor;
      });
      await expect(after).toBe("rgb(18, 52, 86)");
      await expect(after).not.toBe(before);
    } finally {
      writeFileSync(indexPath, originalIndex);
    }
    await page.close();
  }, 60_000);
});

describe("axe in a browser", () => {
  it("finds no serious or critical violations on any empty screen", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    await expectAxeCleanOnPage(page);
    await page.locator('a[data-route="settings"]').click();
    await page.waitForSelector("#screen .settings-group");
    await expectAxeCleanOnPage(page);
    await page.goto(`${base}/#session/abc123`);
    await page.waitForSelector("#hint:not([hidden])");
    await expectAxeCleanOnPage(page);
    await page.close();

    const keyless = await browser.newPage();
    await keyless.goto(`${base}/#sessions`);
    await keyless.waitForSelector(".access-key");
    await expectAxeCleanOnPage(keyless);
    await keyless.close();
  }, 120_000);
});
