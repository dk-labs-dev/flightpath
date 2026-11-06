import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

import { chromium, type Browser } from "playwright";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeLastError } from "../src/daemon/last-error.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { runCleanups } from "./support/cleanup.js";
import { connectionWords, waitForConnection } from "./support/connection.js";
import {
  freePort,
  makeRoot,
  readPort,
  readToken,
  startDaemon,
  stopCleanly,
  stopDaemon,
  waitFor,
  waitForDaemonReady,
} from "./support/daemon.js";
import { writeSettings } from "./support/settings.js";

// The connection status in a real browser: the pill in
// the app bar and the banner under it, driven by a real
// daemon's lifecycle — live, dropped, stopped by the off
// switch, stopped by the idle timer — against the design's
// sizes, colours and words.

interface World {
  root: string;
  dataDir: string;
  child: ChildProcess;
  base: string;
  token: string;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function startWorld(
  idleMs = "3600000",
  autostart = true,
): Promise<World> {
  const port = await freePort();
  const made = makeRoot("flightpath-connection-status-");
  writeSettings(made.dataDir, { port, autostart });
  const child = startDaemon(made.root, {}, { idleMs });
  await waitForDaemonReady(child, made.dataDir);
  const bound = readPort(made.dataDir);
  expect(bound).toBe(port);
  return {
    root: made.root,
    dataDir: made.dataDir,
    child,
    base: `http://127.0.0.1:${bound}`,
    token: readToken(made.dataDir),
  };
}

async function openShell(page: Page, world: World): Promise<void> {
  await page.goto(`${world.base}/#sessions&token=${world.token}`);
  await page.waitForSelector("#screen .empty");
  await waitForConnection(page, "Live");
}

async function openPhonePage(world: World): Promise<Page> {
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await openShell(phone, world);
  return phone;
}

describe("the connection status in a browser", () => {
  it("shows Live in the app bar in the artboard's pill, and no strip under it", async () => {
    const world = await startWorld();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page, world);
    expect(await connectionWords(page)).toContain("Live");
    // The old strip is gone from the page entirely.
    expect(await page.locator(".live-slot").count()).toBe(0);
    const pill = await page.evaluate(() => {
      const el = document.querySelector(".connection-pill");
      const dot = document.querySelector(".connection-dot");
      if (el === null || dot === null) throw new Error("pill missing");
      const style = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        background: style.backgroundColor,
        dot: getComputedStyle(dot).backgroundColor,
      };
    });
    expect(pill.height).toBe(30);
    // White at 0.08 clears axe's contrast floor for the
    // pill's white text (4.81:1).
    expect(pill.background).toBe("rgba(255, 255, 255, 0.08)");
    expect(pill.dot).toBe("rgb(163, 230, 53)");
    await expectAxeCleanOnPage(page);
    const phone = await openPhonePage(world);
    await phone.close();
    await page.close();
    await stopDaemon(world.child);
  }, 90_000);

  it("shows Reconnecting… in the amber pill when the daemon drops", async () => {
    const world = await startWorld();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page, world);
    // The phone page opens while the daemon is up — the
    // daemon serves the page, so a page opened after the
    // drop could never load at all.
    const phone = await openPhonePage(world);
    await stopDaemon(world.child);
    await waitForConnection(page, "Reconnecting…", 20_000);
    await waitForConnection(phone, "Reconnecting…", 20_000);
    const pill = await page.evaluate(() => {
      const el = document.querySelector(".connection-pill");
      const arc = document.querySelector(".connection-arc");
      if (el === null || arc === null) throw new Error("pill missing");
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        color: style.color,
        arcAnimation: getComputedStyle(arc).animationName,
      };
    });
    expect(pill.background).toBe("rgb(253, 231, 184)");
    expect(pill.color).toBe("rgb(92, 58, 0)");
    expect(pill.arcAnimation).not.toBe("none");
    await expectAxeCleanOnPage(page);
    await phone.close();
    await page.close();
  }, 90_000);

  it("shows the off banner once, and only it, when the recorder is switched off", async () => {
    const world = await startWorld();
    // A recorded start failure stands in the health reading:
    // while the recorder is stopped its banner must be the
    // only one, so the health banner stays hidden.
    writeLastError(
      world.dataDir,
      Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
    );
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openShell(page, world);
    const phone = await openPhonePage(world);
    writeFileSync(`${world.dataDir}/off`, "");
    await stopCleanly(world.child, world.dataDir);
    await waitForConnection(page, "Recorder stopped", 20_000);
    await waitForConnection(phone, "Recorder stopped", 20_000);
    const banner = page.locator(".connection-stopped-banner");
    await banner.waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator(".health-banner").count()).toBe(0);
    expect(await page.locator('[role="alert"]').count()).toBe(1);
    const words = await banner.innerText();
    expect(words).toContain("Recording is off in all sessions.");
    expect(words).toContain(
      "Run /flightpath:start in a Claude Code session to turn it back on.",
    );
    const pill = await page.evaluate(() => {
      const el = document.querySelector(".connection-pill");
      const dot = document.querySelector(".connection-stop-dot");
      if (el === null || dot === null) throw new Error("pill missing");
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        color: style.color,
        dot: getComputedStyle(dot).backgroundColor,
      };
    });
    expect(pill.background).toBe("rgb(255, 255, 255)");
    expect(pill.color).toBe("rgb(143, 35, 29)");
    expect(pill.dot).toBe("rgb(180, 45, 38)");
    // The alert is announced once: the retries ticking behind
    // it do not re-mount its node. Count the page's stream
    // requests and wait for two retries after the stop, then
    // check the marked node is still the one on the page.
    let streamRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/stream")) streamRequests += 1;
    });
    await page.evaluate(() => {
      document
        .querySelector('[role="alert"]')
        ?.setAttribute("data-marked", "1");
    });
    await waitFor(() => streamRequests >= 2, 30_000);
    const stillMarked = await page.evaluate(
      () =>
        document
          .querySelector('[role="alert"]')
          ?.getAttribute("data-marked") === "1",
    );
    expect(stillMarked).toBe(true);
    await expectAxeCleanOnPage(page);
    await phone.close();
    await page.close();
  }, 90_000);

  describe("after the daemon idles out", () => {
    // Both daemons idle out side by side, so the file waits
    // out the real 61 s once instead of once per test.
    const idled: { world: World; page: Page }[] = [];

    async function openIdling(autostart: boolean): Promise<Page> {
      const world = await startWorld("61000", autostart);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      idled.push({ world, page });
      await openShell(page, world);
      // The daemon idles out on its own at 61 s and says so.
      await waitForConnection(page, "Recorder stopped", 120_000);
      await page
        .locator(".connection-stopped-banner")
        .waitFor({ state: "visible", timeout: 20_000 });
      return page;
    }

    let autostartOn: Page;
    let autostartOff: Page;

    beforeAll(async () => {
      [autostartOn, autostartOff] = await Promise.all([
        openIdling(true),
        openIdling(false),
      ]);
    }, 180_000);

    afterAll(async () => {
      for (const { world, page } of idled) {
        await page.close();
        await stopDaemon(world.child);
      }
    });

    it("words the idle stop with its minutes", async () => {
      const words = await autostartOn
        .locator(".connection-stopped-banner")
        .innerText();
      expect(words).toContain(
        "The recorder isn't running, so nothing new is being recorded. It stopped after 1 minute with no activity.",
      );
      expect(words).toContain("Start a Claude Code session to restart it.");
    });

    it("words the idle stop's next step with the start command when autostart is off", async () => {
      const words = await autostartOff
        .locator(".connection-stopped-banner")
        .innerText();
      // With autostart off a new session starts paused, so a
      // session alone never restarts the recorder: the next
      // step names the command that does.
      expect(words).toContain(
        "Start a Claude Code session and run /flightpath:start in it to restart recording.",
      );
    });
  });

  it("stills the dot and the arc under reduced motion", async () => {
    const world = await startWorld();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openShell(page, world);
    const dotAnimation = await page.evaluate(() => {
      const dot = document.querySelector(".connection-dot");
      if (dot === null) throw new Error("dot missing");
      return getComputedStyle(dot).animationName;
    });
    expect(dotAnimation).toBe("none");
    await stopDaemon(world.child);
    await waitForConnection(page, "Reconnecting…", 20_000);
    const arcAnimation = await page.evaluate(() => {
      const arc = document.querySelector(".connection-arc");
      if (arc === null) throw new Error("arc missing");
      return getComputedStyle(arc).animationName;
    });
    expect(arcAnimation).toBe("none");
    await page.close();
  }, 90_000);
});
