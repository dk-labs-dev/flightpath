import { mkdirSync } from "node:fs";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  makeRoot,
  startTestDaemon,
  stopDaemon,
  type StartedDaemon,
} from "./support/daemon.js";
import { requiredValue } from "./support/rows.js";
import {
  seedConditions,
  seedSample,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// The session picker in a real browser, on a database seeded
// row by row: what is recording now, the day folders, the
// filters, and the list's timing at a thousand sessions.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfToday(): number {
  const date = new Date();
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** The full-date folder heading, as the picker writes it. */
function dateHeading(ms: number): string {
  const date = new Date(ms);
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const rest = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${weekday} ${rest}`;
}

const today = startOfToday();
const now = Date.now();

function seedPickerFixture(dataDir: string): void {
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    seedSession(db, {
      id: "sess-live",
      projectPath: "/home/self/tip-calc",
      status: "live",
      firstSeenAt: now - 42 * MINUTE,
      lastSeenAt: now,
    });
    seedConditions(db, "sess-live", { updatedAt: now });
    const liveTurn = seedTurn(db, {
      sessionId: "sess-live",
      startedAt: now - 42 * MINUTE,
      promptText: "Build the tip calculator screen",
    });
    seedStep(db, { sessionId: "sess-live", turnId: liveTurn });
    seedStep(db, { sessionId: "sess-live", turnId: liveTurn });
    seedStep(db, { sessionId: "sess-live", turnId: liveTurn });
    seedSample(db, {
      sessionId: "sess-live",
      sampledAt: now - 5 * MINUTE,
      contextTokens: 100_000,
    });
    seedSample(db, {
      sessionId: "sess-live",
      sampledAt: now - MINUTE,
      contextTokens: 152_300,
    });

    seedSession(db, {
      id: "sess-today",
      projectPath: "/home/self/tip-calc",
      firstSeenAt: today + 2 * MINUTE,
      lastSeenAt: today + 32 * MINUTE,
    });
    seedConditions(db, "sess-today", { updatedAt: today });
    seedTurn(db, {
      sessionId: "sess-today",
      startedAt: today + 2 * MINUTE,
      promptText: "Fix the split rounding bug",
    });

    // Started before midnight, ended after: it belongs to the
    // day it started.
    seedSession(db, {
      id: "sess-past-midnight",
      projectPath: "/work/notes-app",
      firstSeenAt: today - 10 * MINUTE,
      lastSeenAt: today + 20 * MINUTE,
    });
    seedConditions(db, "sess-past-midnight", { updatedAt: today });
    seedTurn(db, {
      sessionId: "sess-past-midnight",
      startedAt: today - 10 * MINUTE,
      promptText: "Refactor the parser loop",
    });

    seedSession(db, {
      id: "sess-older",
      projectPath: "/work/notes-app",
      firstSeenAt: today - 3 * DAY + 2 * MINUTE,
      lastSeenAt: today - 3 * DAY + 47 * MINUTE,
    });
    seedConditions(db, "sess-older", { updatedAt: today });
    seedTurn(db, {
      sessionId: "sess-older",
      startedAt: today - 3 * DAY + 2 * MINUTE,
      promptText: "Plan the import wizard",
    });
  } finally {
    db.close();
    storage.close();
  }
}

async function bootPickerDaemon(): Promise<StartedDaemon> {
  const { root, dataDir } = makeRoot("flightpath-picker-test-");
  mkdirSync(dataDir, { recursive: true });
  seedPickerFixture(dataDir);
  return startTestDaemon(root, { startOptions: { idleMs: "600000" } });
}

/** The picker's folders as heading → session titles, from the live DOM. */
async function folderMap(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const map: Record<string, string[]> = {};
    let heading = "";
    for (const row of document.querySelectorAll(".picker-table tbody tr")) {
      const toggle = row.querySelector(".day-toggle");
      if (toggle !== null) {
        // The button reads "Today · 1 session": key the map by
        // the day heading alone, without the count after it.
        const text = toggle.textContent ?? "";
        const cut = text.indexOf(" · ");
        heading = cut === -1 ? text : text.slice(0, cut);
        map[heading] = [];
        continue;
      }
      const title = row.querySelector(".cell-title a")?.textContent;
      if (title !== undefined && title !== null) {
        map[heading]?.push(title);
      }
    }
    return map;
  });
}

describe("the session picker", () => {
  let daemon: StartedDaemon;
  let browser: Browser;
  let base: string;
  let token: string;

  beforeAll(async () => {
    daemon = await bootPickerDaemon();
    token = daemon.token;
    base = `http://127.0.0.1:${daemon.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await stopDaemon(daemon.child);
    await runCleanups();
  });

  async function openPicker(hash = "#sessions"): Promise<Page> {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(`${base}/${hash}&token=${token}`);
    await page.waitForSelector(".picker");
    return page;
  }

  it("lists the live session's latest context size", async () => {
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions",
      token,
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      sessions: { id: string; contextNow: number | null }[];
    };
    const live = requiredValue(
      body.sessions.find((session) => session.id === "sess-live"),
      "the live session in the list",
    );
    expect(live.contextNow).toBe(152_300);
    const todayRow = requiredValue(
      body.sessions.find((session) => session.id === "sess-today"),
      "today's session in the list",
    );
    expect(todayRow.contextNow).toBeNull();
  });

  it("shows the recording-now card and the day folders", async () => {
    const page = await openPicker();
    const card = page.locator(".live-card");
    await expect(await card.getAttribute("href")).toBe("#session/sess-live");
    const cardText = await card.innerText();
    expect(cardText).toContain("Build the tip calculator screen");
    expect(cardText).toContain("/home/self/tip-calc");
    expect(cardText).toContain("turn 1 running");
    expect(cardText).toContain("3");
    expect(cardText).toContain("152.3K");
    // The nav's Now entry names the live session's folder.
    expect(await page.locator(".nav-now").innerText()).toContain(
      "tip-calc · recording",
    );
    const folders = await folderMap(page);
    expect(Object.keys(folders)).toEqual([
      "Today",
      "Yesterday",
      dateHeading(today - 3 * DAY),
    ]);
    const toggles = page.locator(".day-toggle");
    expect(await toggles.nth(0).textContent()).toBe("Today · 1 session");
    expect(await toggles.nth(1).textContent()).toBe("Yesterday · 1 session");
    expect(folders["Today"]).toEqual(["Fix the split rounding bug"]);
    // Yesterday starts closed; opening it shows its session,
    // filed under the day it started though it ended today.
    expect(folders["Yesterday"]).toEqual([]);
    await page.locator(".day-toggle", { hasText: "Yesterday" }).click();
    const opened = await folderMap(page);
    expect(opened["Yesterday"]).toEqual(["Refactor the parser loop"]);
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 60_000);

  it("narrows by search text and project together, within the page", async () => {
    const page = await openPicker();
    await page.fill("#picker-search", "parser");
    // A folder with a match opens on its own; a day with no
    // match is not shown at all.
    const folders = await folderMap(page);
    expect(folders["Yesterday"]).toEqual(["Refactor the parser loop"]);
    expect(folders["Today"]).toBeUndefined();
    await page.selectOption("#picker-project", "tip-calc");
    expect(await page.locator(".picker-none").innerText()).toContain(
      "No sessions match",
    );
    await page.selectOption("#picker-project", "");
    await page.fill("#picker-search", "");
    const restored = await folderMap(page);
    expect(restored["Today"]).toEqual(["Fix the split rounding bug"]);
    await page.close();
  }, 60_000);

  it("keeps the filter across a session visit and the back button", async () => {
    const page = await openPicker();
    await page.fill("#picker-search", "parser");
    await page
      .locator(".cell-title a", { hasText: "Refactor the parser loop" })
      .click();
    await page.waitForFunction(() =>
      window.location.hash.startsWith("#session/"),
    );
    await page.goBack();
    await page.waitForSelector(".picker");
    expect(await page.inputValue("#picker-search")).toBe("parser");
    const folders = await folderMap(page);
    expect(folders["Yesterday"]).toEqual(["Refactor the parser loop"]);
    await page.close();
  }, 60_000);

  it("says the load failed once, then recovers when the retry lands", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    // The first list answer is a 500; every later one passes
    // through to the daemon.
    let failedOnce = false;
    await page.route("**/api/sessions", async (route) => {
      if (!failedOnce && route.request().method() === "GET") {
        failedOnce = true;
        await route.fulfill({ status: 500, body: "" });
        return;
      }
      await route.continue();
    });
    await page.goto(`${base}/#sessions&token=${token}`);
    await page.waitForSelector(".load-failed", { timeout: 10_000 });
    expect(await page.locator(".load-failed").innerText()).toContain(
      "Couldn't load sessions. Retrying…",
    );
    // The retry lands on its own: the list renders, the line goes.
    await page.waitForSelector(".picker");
    await page.waitForFunction(
      () => document.querySelector(".load-failed") === null,
    );
    await page.close();
  }, 60_000);

  it("moves a session from recording now to earlier when it ends", async () => {
    const page = await openPicker();
    const storage = openStorage({ dataDir: daemon.dataDir });
    const db = new DatabaseSync(storage.dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      seedSession(db, {
        id: "sess-late",
        projectPath: "/work/notes-app",
        status: "live",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      seedConditions(db, "sess-late", { updatedAt: Date.now() });
      seedTurn(db, {
        sessionId: "sess-late",
        startedAt: Date.now(),
        promptText: "Triage the overnight failures",
      });
    } finally {
      db.close();
      storage.close();
    }
    await page.waitForSelector(".live-card[href='#session/sess-late']", {
      timeout: 5_000,
    });
    const writer = openStorage({ dataDir: daemon.dataDir });
    const writeDb = new DatabaseSync(writer.dbPath);
    try {
      writeDb.exec("PRAGMA busy_timeout = 5000");
      writeDb
        .prepare("UPDATE sessions SET status = 'ended' WHERE id = ?")
        .run("sess-late");
    } finally {
      writeDb.close();
      writer.close();
    }
    await page.waitForFunction(
      () =>
        document.querySelector(".live-card[href='#session/sess-late']") ===
        null,
    );
    const folders = await folderMap(page);
    expect(folders["Today"]).toContain("Triage the overnight failures");
    await page.close();
  }, 60_000);
});

describe("the picker at a thousand sessions", () => {
  let daemon: StartedDaemon;
  let browser: Browser;

  beforeAll(async () => {
    const { root, dataDir } = makeRoot("flightpath-picker-1000-");
    mkdirSync(dataDir, { recursive: true });
    const storage = openStorage({ dataDir });
    const db = new DatabaseSync(storage.dbPath);
    try {
      db.exec("BEGIN");
      for (let index = 0; index < 1000; index += 1) {
        // A quarter-hour apart: a thousand sessions inside the
        // fifteen days retention keeps, so the daemon's start-up
        // purge has nothing to delete mid-test.
        const startedAt = now - index * 15 * MINUTE;
        seedSession(db, {
          id: `bulk-${index}`,
          projectPath: "/work/bulk",
          firstSeenAt: startedAt,
          lastSeenAt: startedAt + 30 * MINUTE,
        });
        seedTurn(db, {
          sessionId: `bulk-${index}`,
          startedAt,
          promptText: `Bulk session ${index}`,
        });
      }
      db.exec("COMMIT");
    } finally {
      db.close();
      storage.close();
    }
    daemon = await startTestDaemon(root, {
      startOptions: { idleMs: "600000" },
    });
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await stopDaemon(daemon.child);
    await runCleanups();
  });

  it("lists a thousand sessions in under 500 ms, paging past 200", async () => {
    const startedAt = performance.now();
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/sessions",
      token: daemon.token,
    });
    const elapsed = performance.now() - startedAt;
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1000);
    expect(elapsed).toBeLessThan(500);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(
      `http://127.0.0.1:${daemon.port}/#sessions&token=${daemon.token}`,
    );
    await page.waitForSelector(".picker-table");
    // Only today's folder starts open, and the first page holds
    // 200 sessions: today's sessions are the ones on screen.
    const startedToday = Math.floor((now - today) / (15 * MINUTE)) + 1;
    const rows = await page
      .locator(".picker-table tbody tr:not(.day-row)")
      .count();
    expect(rows).toBe(startedToday);
    expect(await page.locator(".picker-more").innerText()).toContain(
      "Show more sessions",
    );
    await page.locator(".picker-more").click();
    // The next page reaches yesterday's folder: opening it shows
    // a full day of sessions that were not in the first page.
    await page.locator(".day-toggle", { hasText: "Yesterday" }).click();
    const folders = await folderMap(page);
    expect(folders["Yesterday"]).toHaveLength(96);
    await page.close();
  }, 120_000);
});
