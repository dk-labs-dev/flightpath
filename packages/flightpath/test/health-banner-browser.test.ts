import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeLastError } from "../src/daemon/last-error.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { runCleanups } from "./support/cleanup.js";
import {
  freePort,
  makeRoot,
  readPort,
  readToken,
  startDaemon,
  stopDaemon,
  waitForDaemonReady,
} from "./support/daemon.js";
import { writeBufferEvent } from "./support/buffer.js";
import { requiredValue } from "./support/rows.js";
import { writeSettings } from "./support/settings.js";
import { dataTheme, newThemedPage } from "./support/theme-page.js";

// The health banner in a real browser, fed by the stream: a
// failed start's record and the buffer's files are the
// daemon's own inputs, written the way the daemon's writer
// and the hook write them; the page must show the cause, the
// waiting count and the one action, keep one banner at a
// time, and clear when the record does — the same removal a
// successful start performs.

// Picked by the OS in beforeAll: a fixed port is one a second suite also asks for.
let port = 0;

let browser: Browser;
let child: ChildProcess;
let dataDir: string;
let base: string;
let token: string;

function bindError(): Error {
  return Object.assign(
    new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`),
    { code: "EADDRINUSE" },
  );
}

function clearBuffer(): void {
  rmSync(join(dataDir, "buffer"), { recursive: true, force: true });
}

function clearHealthFiles(): void {
  rmSync(join(dataDir, "last-error"), { force: true });
  rmSync(join(dataDir, "buffer-dropped"), { force: true });
  clearBuffer();
}

/** Seed the trouble until it survives: the daemon's one
 * start-up drain runs after the port file appears, so files
 * written in that window can be drained (and the drop counter
 * reset) before the page ever sees them. The same two files
 * are rewritten each attempt; what persists past a beat is
 * past the drain. */
async function seedTroubleUntilStable(
  olderAt: number,
  newerAt: number,
): Promise<void> {
  const buffer = join(dataDir, "buffer");
  const deadline = Date.now() + 20_000;
  for (;;) {
    writeFileSync(join(dataDir, "buffer-dropped"), "4\n");
    writeBufferEvent(dataDir, olderAt, "older", "s-health-banner");
    writeBufferEvent(dataDir, newerAt, "newer", "s-health-banner");
    writeLastError(dataDir, bindError());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stable =
      existsSync(join(buffer, `${olderAt}-older.json`)) &&
      existsSync(join(buffer, `${newerAt}-newer.json`)) &&
      existsSync(join(dataDir, "buffer-dropped")) &&
      existsSync(join(dataDir, "last-error"));
    if (stable) return;
    if (Date.now() > deadline) {
      throw new Error("the seeded trouble never stabilized");
    }
  }
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${base}/#sessions&token=${token}`);
  await page.waitForSelector("#screen .empty");
}

beforeAll(async () => {
  const made = makeRoot("flightpath-health-banner-");
  dataDir = made.dataDir;
  port = await freePort();
  writeSettings(dataDir, { port });
  child = startDaemon(made.root, {
    FLIGHTPATH_DRAIN_MS: "3600000",
    FLIGHTPATH_IDLE_MS: "3600000",
  });
  await waitForDaemonReady(child, dataDir);
  base = `http://127.0.0.1:${readPort(dataDir)}`;
  token = readToken(dataDir);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopDaemon(child);
  await runCleanups();
});

describe("the health banner in a browser", () => {
  it("shows can't start with the cause and the waiting count, over dropped events", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    await expect(await page.locator(".health-banner").count()).toBe(0);

    await seedTroubleUntilStable(Date.now() - 9 * 60_000, Date.now() - 60_000);

    const banner = page.locator(".health-cant-start");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    await expect(await page.locator(".health-headline").innerText()).toBe(
      "Flightpath can't start its recorder",
    );
    const cause = await page.locator(".health-cause").innerText();
    expect(cause).toContain(
      `Port ${port} is in use by another program, and the recorder couldn't bind it at`,
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector(".health-waiting")
          ?.textContent?.includes("2 events are waiting"),
      undefined,
      { timeout: 20_000 },
    );
    // One banner at a time: the dropped state stays hidden
    // behind the more serious one, and one alert is announced.
    await expect(await page.locator(".health-dropped").count()).toBe(0);
    await expect(await page.locator('[role="alert"]').count()).toBe(1);
    await expect(
      await page.locator(".nav-status .status-text").innerText(),
    ).toBe("Recorder can't start");
    const action = page.locator(".health-actions a.banner-primary");
    await expect(await action.innerText()).toBe("Change the port");
    await expect(await action.getAttribute("href")).toBe(
      "#settings?focus=port",
    );

    // The alert node is the same node when the count moves:
    // announced once, not on every update.
    await page.evaluate(() => {
      document
        .querySelector('[role="alert"]')
        ?.setAttribute("data-marked", "1");
    });
    writeBufferEvent(dataDir, Date.now(), "third", "s-health-banner");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".health-waiting")
          ?.textContent?.includes("3 events are waiting"),
      undefined,
      { timeout: 20_000 },
    );
    const stillMarked = await page.evaluate(
      () =>
        document
          .querySelector('[role="alert"]')
          ?.getAttribute("data-marked") === "1",
    );
    expect(stillMarked).toBe(true);

    clearHealthFiles();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    await page.close();
  }, 90_000);

  it("opens settings at the port field when the banner's action is followed", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    writeLastError(dataDir, bindError());

    const banner = page.locator(".health-cant-start");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".health-actions a.banner-primary").click();

    // Advanced stands open and the port field holds the focus.
    await expect
      .poll(
        async () =>
          page.evaluate(() => ({
            open:
              document
                .querySelector(".settings-advanced .advanced-toggle")
                ?.getAttribute("aria-expanded") === "true",
            focused: document.activeElement?.id ?? "",
          })),
        { timeout: 20_000 },
      )
      .toEqual({ open: true, focused: "f-port" });

    clearHealthFiles();
    await page.close();
  }, 90_000);

  it("shows dropped events on their own, and the nav agrees", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    writeFileSync(join(dataDir, "buffer-dropped"), "120\n");

    const banner = page.locator(".health-dropped");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    await expect(await banner.innerText()).toContain(
      "About 120 events dropped: the buffer was full; transcripts still cover these sessions.",
    );
    await expect(
      await page.locator(".nav-status .status-text").innerText(),
    ).toBe("Recorder running · 120 dropped");

    clearHealthFiles();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    await page.close();
  }, 90_000);

  it("shows the database path with a copy button for a database failure", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    writeLastError(
      dataDir,
      Object.assign(new Error("database disk image is malformed"), {
        code: "ERR_SQLITE_ERROR",
      }),
    );

    const banner = page.locator(".health-cant-start");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    const cause = await page.locator(".health-cause").innerText();
    expect(cause).toContain("The recorder couldn't open its database at");
    await expect(await page.locator(".health-path").innerText()).toContain(
      join(dataDir, "flightpath.db"),
    );
    await expect(
      await page.locator(".health-actions button.banner-primary").innerText(),
    ).toBe("Copy the path");

    clearHealthFiles();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    await page.close();
  }, 90_000);

  it("never covers content on a phone, and stays axe-clean", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openShell(page);
    writeLastError(dataDir, bindError());

    const banner = page.locator(".health-cant-start");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    const bannerBox = requiredValue(
      await banner.boundingBox(),
      "the banner's bounding box",
    );
    const screenBox = requiredValue(
      await page.locator("#screen").boundingBox(),
      "the screen's bounding box",
    );
    expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(screenBox.y + 1);
    await expectAxeCleanOnPage(page);

    clearHealthFiles();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    await page.close();
  }, 90_000);

  it("stays axe-clean in dark", async () => {
    const page = await newThemedPage(browser, "dark");
    await openShell(page);
    writeLastError(dataDir, bindError());

    const banner = page.locator(".health-cant-start");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    expect(await dataTheme(page)).toBe("dark");
    await expectAxeCleanOnPage(page);

    clearHealthFiles();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    await page.close();
  }, 90_000);

  it("says the recorder is unreachable while the stream is down", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page);
    await stopDaemon(child);
    await page.waitForSelector(".connection-down", { timeout: 20_000 });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".nav-status .status-text")
          ?.textContent?.includes("Recorder unreachable"),
      undefined,
      { timeout: 20_000 },
    );
    await page.close();
  }, 90_000);
});
