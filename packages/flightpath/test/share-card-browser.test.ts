import { readFileSync } from "node:fs";

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { useSeededBrowser } from "./support/browser-boot.js";
import { dataTheme, newThemedPage } from "./support/theme-page.js";
import { waitForConnection } from "./support/connection.js";
import {
  seedConditions,
  seedRequestExact,
  seedSample,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// The Share button and its preview dialog in a real
// browser: the button stands in the app bar on a session
// and nowhere else, at phone width it is the icon alone
// under the same name, and the dialog saves a PNG of the
// card's own size and says so when a copy lands. The
// session is seeded with the README
// sample's shape: prompts of 41 tokens, a context of
// 59,375, and one file read that added 20,573 in a step.

const SESSION = "sess-share";
const BASE = Date.now() - 3_600_000;
const SHARE_NAME = "Share this session's numbers";

function seedShareSession(db: DatabaseSync): void {
  seedSession(db, {
    id: SESSION,
    status: "ended",
    firstSeenAt: BASE,
    lastSeenAt: BASE + 438_000,
  });
  seedConditions(db, SESSION, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 1,
    sessionId: SESSION,
    sequence: 1,
    startedAt: BASE,
    endedAt: BASE + 200_000,
    promptChars: 58,
  });
  seedTurn(db, {
    id: 2,
    sessionId: SESSION,
    sequence: 2,
    startedAt: BASE + 300_000,
    endedAt: BASE + 438_000,
    promptChars: 59,
  });
  const requests = [
    { id: 1, turnId: 1, at: 1_000, input: 20_000, total: 20_000 },
    { id: 2, turnId: 1, at: 120_000, input: 40_573, total: 40_573 },
    { id: 3, turnId: 2, at: 400_000, input: 59_375, total: 59_375 },
  ];
  for (const request of requests) {
    const { total, at, ...rest } = request;
    seedRequestExact(db, {
      sessionId: SESSION,
      ...rest,
      startedAt: BASE + at,
      output: 300,
    });
    seedSample(db, {
      sessionId: SESSION,
      requestId: request.id,
      sampledAt: BASE + at,
      contextTokens: total,
    });
  }
  seedStep(db, {
    id: 1,
    sessionId: SESSION,
    turnId: 1,
    toolName: "Read",
    outcome: "succeeded",
    startedAt: BASE + 10_000,
    endedAt: BASE + 11_000,
    resultSize: 60_000,
    resultRequestId: 2,
  });
  seedStep(db, {
    id: 2,
    sessionId: SESSION,
    turnId: 2,
    toolName: "Bash",
    outcome: "succeeded",
    startedAt: BASE + 310_000,
    endedAt: BASE + 311_000,
    resultSize: 1_000,
    resultRequestId: 3,
  });
}

const suite = useSeededBrowser("flightpath-share-", seedShareSession);

async function openSession(page: Page): Promise<void> {
  const started = suite();
  const url = started.base + "/#session/" + SESSION + "?token=" + started.token;
  await page.goto(url);
  await page.locator(".summary").waitFor();
  await waitForConnection(page, "Live");
}

function closeAction(dialog: ReturnType<Page["getByRole"]>) {
  return dialog
    .locator(".confirm-dialog-actions")
    .getByRole("button", { name: "Close" });
}

function shareButton(page: Page) {
  return page.getByRole("button", { name: SHARE_NAME });
}

/** A desktop page on the seeded session with the preview
 * open: the state every preview test starts from. */
async function openPreview(): Promise<{
  page: Page;
  dialog: ReturnType<Page["getByRole"]>;
}> {
  const page = await suite().browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await openSession(page);
  await shareButton(page).click();
  const dialog = page.getByRole("dialog", { name: SHARE_NAME });
  await dialog.waitFor();
  return { page, dialog };
}

/** The dialog is gone and the Share button holds the
 * focus again: how every way of closing it must end. */
async function expectClosedBackAtButton(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  expect(await focusedLabel(page)).toBe(SHARE_NAME);
}

function focusedLabel(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? null,
  );
}

/** The card canvas's corner and a point in its numbers:
 * the teal the card is drawn in, and white where its
 * heading's words stand. */
async function cardPixels(page: Page): Promise<{
  corner: number[];
  heading: number[];
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".share-preview canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("the share card canvas is missing");
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("the share card canvas has no context");
    }
    const pixel = (x: number, y: number): number[] => [
      ...ctx.getImageData(x, y, 1, 1).data,
    ];
    // Any white pixel in the heading's band proves words
    // were drawn there; the band's own pixels are teal.
    let heading: number[] = [];
    for (let x = 146; x < 700 && heading.length === 0; x += 2) {
      for (let y = 66; y < 100; y += 2) {
        const value = pixel(x, y);
        if (value[0] === 255 && value[1] === 255 && value[2] === 255) {
          heading = value;
          break;
        }
      }
    }
    return { corner: pixel(4, 4), heading };
  });
}

describe("the share button", () => {
  it("stands on a session and is absent on Sessions and Settings", async () => {
    const page = await suite().browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page);
    await expect.poll(() => shareButton(page).count()).toBe(1);
    const world = suite();
    await page.goto(world.base + "/#sessions&token=" + world.token);
    // Leaving the session screen is what the absence is
    // measured against: the summary goes, then the button.
    await expect.poll(() => page.locator(".summary").count()).toBe(0);
    expect(await shareButton(page).count()).toBe(0);
    await page.goto(world.base + "/#settings?token=" + world.token);
    await page.waitForSelector("#f-autostart");
    expect(await shareButton(page).count()).toBe(0);
    await page.close();
  }, 90_000);

  it("is the icon alone at phone width, under the same name", async () => {
    const page = await suite().browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page);
    const button = shareButton(page);
    await button.waitFor();
    const labelVisible = await page.locator(".share-button-label").isVisible();
    expect(labelVisible).toBe(false);
    const boxes = await page.evaluate(() => {
      const el = document.querySelector(".share-button");
      if (el === null) throw new Error("share button missing");
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    // Icon and padding only: the word would take it past 60.
    expect(boxes.width).toBeLessThan(60);
    expect(boxes.height).toBe(30);
    await page.close();
  }, 90_000);
});

describe("the share preview", () => {
  it("opens, saves a PNG of 1200x630, and Close returns focus", async () => {
    const { page, dialog } = await openPreview();
    // The card is drawn: teal at its corner, white in its
    // heading. The token history and the context at the
    // latest step are reads of their own, so the drawing is
    // polled for, not read once.
    await expect
      .poll(async () => (await cardPixels(page)).corner.slice(0, 3), {
        timeout: 15_000,
      })
      .toEqual([31, 111, 139]);
    expect((await cardPixels(page)).heading.slice(0, 3)).toEqual([
      255, 255, 255,
    ]);
    await expectAxeCleanOnPage(page);
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Save image" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("flightpath-session.png");
    const path = await download.path();
    if (path === null) throw new Error("the download has no file");
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    await closeAction(dialog).click();
    await expectClosedBackAtButton(page);
    await page.close();
  }, 90_000);

  it("says Copied. once the copy lands, with clipboard access granted", async () => {
    const started = suite();
    const context = await started.browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(started.base).origin,
    });
    const page = await context.newPage();
    await openSession(page);
    await shareButton(page).click();
    const dialog = page.getByRole("dialog", { name: SHARE_NAME });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Copy" }).click();
    // The note is the only sign the copy happened: it
    // stands in the status line under the card.
    await expect
      .poll(() => dialog.getByRole("status").textContent(), {
        timeout: 15_000,
      })
      .toBe("Copied.");
    await context.close();
  }, 90_000);

  it("closes on Escape and returns focus to the button", async () => {
    const { page } = await openPreview();
    await page.keyboard.press("Escape");
    await expectClosedBackAtButton(page);
    await page.close();
  }, 90_000);

  it("opens in the dark theme as in the light", async () => {
    const browser = suite().browser;
    for (const theme of ["light", "dark"] as const) {
      const page = await newThemedPage(browser, theme, {
        viewport: { width: 1440, height: 900 },
      });
      await openSession(page);
      expect(await dataTheme(page)).toBe(theme);
      await shareButton(page).click();
      const dialog = page.getByRole("dialog", { name: SHARE_NAME });
      await dialog.waitFor();
      await expect
        .poll(async () => (await cardPixels(page)).corner.slice(0, 3), {
          timeout: 15_000,
        })
        .toEqual([31, 111, 139]);
      await closeAction(dialog).click();
      await page.close();
    }
  }, 90_000);
});
