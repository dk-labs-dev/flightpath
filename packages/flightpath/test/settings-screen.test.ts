import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type Locator, type Page } from "playwright";

import { formatSize } from "../src/format.js";
import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { runCleanups } from "./support/cleanup.js";
import { clickBoxCenter } from "./support/click.js";
import {
  callDaemon,
  callDaemonJson,
  freePort,
  makeRoot,
  startTestDaemon,
  waitFor,
} from "./support/daemon.js";
import { sequencedHookEnvelope, userPromptEvent } from "./support/events.js";
import { movePortOnScreen } from "./support/settings-screen.js";

// The settings screen in a real browser: one draft and one
// save bar for the whole page, the save's two confirmations
// in their order, switches and the idle choice, the port
// warning's wording in both telemetry states, the move
// itself, and the unsaved-changes guard. Each test sets up
// its own starting state through the API, so no test depends
// on another.

const DAY = 24 * 60 * 60 * 1000;

let root: string;
let dataDir: string;
let base: string;
let port: number;
let token: string;
let browser: Browser;

interface SettingsReply {
  settings: {
    port: number;
    autostart: boolean;
    startupNotice: boolean;
    terminalLine: boolean;
    storePromptText: boolean;
    excludedFolders: string[];
    retentionDays: number;
    idleShutdownMinutes: number;
  };
  boundPort: number;
  liveSessions: { id: string; title: string }[];
  retention: { sessionCount: number; databaseBytes: number };
}

async function getSettings(): Promise<SettingsReply> {
  const reply = await callDaemon(port, {
    method: "GET",
    path: "/api/settings",
    token,
  });
  return JSON.parse(reply.body) as SettingsReply;
}

/** Wait until the daemon's telemetry setup reads as the
 *  given state. */
async function waitForTelemetryState(state: string): Promise<void> {
  await waitFor(async () => {
    const { json } = await callDaemonJson(
      port,
      "GET",
      "/api/telemetry-setup",
      token,
    );
    return json["state"] === state;
  });
}

/** The starting state every screen test arranges for itself:
 *  the default settings saved, no sessions stored, telemetry
 *  off. The port is left wherever it is. */
async function resetViaApi(): Promise<void> {
  await callDaemonJson(
    port,
    "PUT",
    "/api/settings",
    token,
    JSON.stringify({
      autostart: true,
      startupNotice: true,
      terminalLine: true,
      storePromptText: true,
      excludedFolders: [],
      retentionDays: 15,
      idleShutdownMinutes: 30,
    }),
  );
  await callDaemon(port, {
    method: "POST",
    path: "/api/delete-all-data",
    token,
  });
  await callDaemonJson(
    port,
    "POST",
    "/api/telemetry-setup",
    token,
    JSON.stringify({ action: "off" }),
  );
}

/** The reset, then retention set to `days`: the starting
 *  state the tests that lower retention arrange. */
async function resetWithRetention(days: number): Promise<void> {
  await resetViaApi();
  await callDaemonJson(
    port,
    "PUT",
    "/api/settings",
    token,
    JSON.stringify({ retentionDays: days }),
  );
}

/** A confirmed move, handed over: wait until the page is
 *  served from the new port, as movePortOnScreen does, and
 *  only then point this file's port and base at it. The next
 *  test's reset calls the port as soon as this returns, so
 *  the daemon must already be listening there. */
async function handOverMovedPort(page: Page, target: number): Promise<void> {
  await page.waitForFunction(
    (moved) => location.port === String(moved),
    target,
  );
  port = target;
  base = `http://127.0.0.1:${target}`;
}

async function seedLiveSession(id: string, title: string): Promise<void> {
  const posted = await callDaemon(port, {
    method: "POST",
    path: "/events/hook",
    token,
    headers: { "content-type": "application/json" },
    body: sequencedHookEnvelope("env-screen", userPromptEvent(id, title)),
  });
  expect(posted.status).toBe(204);
  await waitFor(async () =>
    (await getSettings()).liveSessions.some((session) => session.id === id),
  );
}

/** An ended session last seen `ageDays` ago, written straight
 *  to the store the daemon is serving, as the retention tests
 *  seed theirs. */
function seedEndedSession(id: string, ageDays: number): void {
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  const at = Date.now() - ageDays * DAY;
  db.prepare(
    "INSERT INTO sessions (id, project_path, status, first_seen_at, last_seen_at) VALUES (?, ?, 'ended', ?, ?)",
  ).run(id, "/work/old", at, at);
  db.close();
  storage.close();
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(`${base}/#settings&token=${token}`);
  await page.waitForSelector("#f-autostart");
}

/** The telemetry group, found by its heading. */
function telemetryGroup(page: Page): Locator {
  return page.locator(".settings-group", {
    has: page.locator("#group-telemetry-h"),
  });
}

/** Switch telemetry on through the confirmation dialog. */
async function turnTelemetryOn(page: Page): Promise<void> {
  const telemetry = telemetryGroup(page);
  await telemetry.getByRole("button", { name: "Turn on…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Turn on", exact: true })
    .click();
}

async function openAdvanced(page: Page): Promise<void> {
  const toggle = page.locator(".settings-advanced .advanced-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await page.waitForSelector("#f-port", { state: "visible" });
}

/** A page at the desktop size every screen test uses. */
async function newScreenPage(): Promise<Page> {
  return browser.newPage({ viewport: { width: 1440, height: 900 } });
}

/** Open the screen with Advanced expanded; returns the port
 *  the settings currently name. */
async function openAdvancedSettings(page: Page): Promise<number> {
  await openSettings(page);
  await openAdvanced(page);
  return (await getSettings()).settings.port;
}

function saveBar(page: Page): Locator {
  return page.getByRole("region", { name: "Unsaved changes" });
}

async function saveChanges(page: Page): Promise<void> {
  await saveBar(page).getByRole("button", { name: "Save changes" }).click();
}

/** Save from the bar and return the dialog the save opens,
 *  once it is up. */
async function saveIntoDialog(page: Page): Promise<Locator> {
  await saveChanges(page);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

/** Save from the bar and confirm the retention deletion
 *  the save asks for, in the dialog it opens. */
async function saveAndConfirmDelete(
  page: Page,
  dialog: Locator,
): Promise<void> {
  await saveIntoDialog(page);
  await dialog.getByRole("button", { name: "Delete older and save" }).click();
}

/** Open the screen, lower retention to 30 days, and save
 *  into the confirmation dialog the lowering opens: the
 *  page, the recorded PUTs, the dialog, and its text. */
async function lowerRetentionIntoDialog(): Promise<{
  page: Page;
  puts: { bodies: Record<string, unknown>[] };
  dialog: Locator;
  text: string;
}> {
  const page = await newScreenPage();
  await openSettings(page);
  const puts = recordPuts(page);
  await page.locator("#f-retentionDays").selectOption("30");
  const dialog = await saveIntoDialog(page);
  const text = (await dialog.textContent()) ?? "";
  return { page, puts, dialog, text };
}

/** Follow the Sessions link into the leave dialog, and
 *  return the dialog once it is up. */
async function openLeaveDialog(page: Page): Promise<Locator> {
  await page.locator('a[data-route="sessions"]').click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

/** What a declined confirmation leaves behind: no request
 *  went out, and the daemon still holds 90 days. */
async function expectDeclineSavedNothing(puts: {
  bodies: Record<string, unknown>[];
}): Promise<void> {
  expect(puts.bodies.length).toBe(0);
  expect((await getSettings()).settings.retentionDays).toBe(90);
}

/** Open the screen and switch the startup notice off, so
 *  the save bar is up and the leave guard is armed. */
async function openWithUnsavedNotice(page: Page): Promise<void> {
  await openSettings(page);
  await page.locator("#f-startupNotice").click();
  await saveBar(page).waitFor({ state: "visible" });
}

/** The PUT bodies this page sends to the settings route
 *  from now on, in order. */
function recordPuts(page: Page): { bodies: Record<string, unknown>[] } {
  const recorded: { bodies: Record<string, unknown>[] } = { bodies: [] };
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/settings")) {
      recorded.bodies.push(
        JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
      );
    }
  });
  return recorded;
}

/** True when the browser's own unload prompt is armed. */
async function beforeUnloadPrevented(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/** One field kind's change-and-change-back: change → the bar
 *  counts one change; change back → the bar goes; change
 *  again and save → the one PUT carries exactly the final
 *  value. */
async function proveChangeBack(
  page: Page,
  change: () => Promise<void>,
  back: () => Promise<void>,
  expectedBody: Record<string, unknown>,
  confirm?: () => Promise<void>,
): Promise<void> {
  const bar = saveBar(page);
  const puts = recordPuts(page);
  await change();
  await bar.waitFor({ state: "visible" });
  expect(await bar.textContent()).toContain("1 unsaved change");
  await back();
  await waitFor(async () => (await bar.count()) === 0);
  await change();
  await bar.getByRole("button", { name: "Save changes" }).click();
  if (confirm !== undefined) {
    await confirm();
  }
  await waitFor(async () => puts.bodies.length === 1);
  expect(puts.bodies[0]).toEqual(expectedBody);
  // The save adopts its values as the baseline: with the
  // saved flash over, the bar is gone — a baseline that never
  // adopted would bring it back with the change still counted.
  await waitFor(
    async () =>
      (await bar.count()) === 0 &&
      (await page
        .getByText("Saved. New sessions use these settings.")
        .count()) === 0,
  );
}

beforeAll(async () => {
  const made = makeRoot("flightpath-settings-screen-");
  root = made.root;
  dataDir = made.dataDir;
  mkdirSync(join(root, "claude"), { recursive: true });
  // The daemon under test inherits no telemetry setup from
  // this machine, and its Claude Code folder exists, as a real
  // install's does.
  const extra: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY") {
      extra[key] = undefined;
    }
  }
  // The screen talks to the daemon only through its API, which
  // isn't activity, so the default idle limit would end the
  // daemon partway through this file on a loaded machine.
  const started = await startTestDaemon(root, {
    extra,
    startOptions: { idleMs: "600000" },
  });
  port = started.port;
  token = started.token;
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

describe("the settings screen", () => {
  it("changes and saves every setting from the screen, through the one bar", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const bar = saveBar(page);
    await page.locator("#f-autostart").click();
    await page
      .locator("#f-excludedFolders")
      .fill("  /work/secret  \n/work/plain");
    await bar.waitFor({ state: "visible" });
    expect(await bar.textContent()).toContain("2 unsaved changes");
    await bar.getByRole("button", { name: "Save changes" }).click();
    await waitFor(
      async () => (await getSettings()).settings.autostart === false,
    );
    const saved = await getSettings();
    expect(saved.settings.excludedFolders).toEqual([
      "/work/secret",
      "/work/plain",
    ]);
    await page
      .getByText("Saved. New sessions use these settings.")
      .waitFor({ state: "visible" });
    expect(await page.locator(".settings-screen").textContent()).toContain(
      "The first 2,000 characters of each prompt.",
    );
    await page.locator("#f-storePromptText").click();
    await bar.waitFor({ state: "visible" });
    await bar.getByRole("button", { name: "Save changes" }).click();
    await waitFor(
      async () => (await getSettings()).settings.storePromptText === false,
    );
    await page.locator("#f-retentionDays").selectOption("30");
    await saveChanges(page);
    await waitFor(
      async () => (await getSettings()).settings.retentionDays === 30,
    );
    await openAdvanced(page);
    await page.locator("#f-idleShutdownMinutes").selectOption("60");
    await saveChanges(page);
    await waitFor(
      async () => (await getSettings()).settings.idleShutdownMinutes === 60,
    );
    await page.close();
  }, 120_000);

  it("saves the note after a turn and shows it saved after a reload", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const note = page.locator("#f-terminalLine");
    expect(await note.getAttribute("aria-checked")).toBe("true");
    expect(await page.locator(".settings-screen").textContent()).toContain(
      "One line after Claude's reply when a turn has a suggestion worth a look. Nothing is shown otherwise.",
    );
    expect(await page.getByLabel("Show a note after a turn").count()).toBe(1);
    await note.click();
    await saveChanges(page);
    await waitFor(
      async () => (await getSettings()).settings.terminalLine === false,
    );
    await page.reload();
    await page.waitForSelector("#f-terminalLine");
    expect(
      await page.locator("#f-terminalLine").getAttribute("aria-checked"),
    ).toBe("false");
    await page.close();
  }, 120_000);

  it("announces the saved line from a status region mounted before the save", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    // The region a screen reader watches must already be on
    // the page, empty, before anything is saved into it.
    const status = page.locator(".save-bar").getByRole("status");
    expect(await status.count()).toBe(1);
    expect(((await status.textContent()) ?? "").trim()).toBe("");
    await page.locator("#f-autostart").click();
    await saveBar(page).waitFor({ state: "visible" });
    expect(((await status.textContent()) ?? "").trim()).toBe("");
    await saveChanges(page);
    await waitFor(
      async () =>
        ((await status.textContent()) ?? "") ===
        "Saved. New sessions use these settings.",
    );
    await page.close();
  }, 120_000);

  it("follows the kept count on the retention line, through a delete-all", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const stakes = page.locator(".retention-stakes");
    // The size on the line is whatever the daemon's store
    // measures now — a reset store still has its tables — so
    // the expectation is read from the same reply the view
    // reads, and formatted the way the view formats it.
    await waitFor(async () => {
      const reply = await getSettings();
      return ((await stakes.textContent()) ?? "").includes(
        `Keeping 0 sessions · ${formatSize(reply.retention.databaseBytes)}, in ${dataDir}.`,
      );
    });
    await seedLiveSession("screen-count-1", "Count me");
    await page.reload();
    await page.waitForSelector("#f-autostart");
    expect(await stakes.textContent()).toContain("Keeping 1 session ·");
    await page.getByRole("button", { name: "Delete all data…" }).click();
    const deleteDialog = page.getByRole("dialog");
    await deleteDialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await deleteDialog
      .getByRole("button", { name: "Delete everything" })
      .click();
    await waitFor(async () =>
      ((await stakes.textContent()) ?? "").includes("Keeping 0 sessions"),
    );
    expect((await getSettings()).retention.sessionCount).toBe(0);
    await page.close();
  }, 120_000);

  it("names the recording sessions in the port warning, at 0, 1, 3 and 7, with telemetry off", async () => {
    await resetViaApi();
    const setup = await callDaemonJson(
      port,
      "GET",
      "/api/telemetry-setup",
      token,
    );
    expect(setup.json["state"]).toBe("off");
    const page = await newScreenPage();
    const current = await openAdvancedSettings(page);
    const dialog = page.getByRole("dialog");

    async function warnAndKeep(expected: string): Promise<string> {
      await page.locator("#f-port").fill(String(current + 13));
      await saveIntoDialog(page);
      const text = (await dialog.textContent()) ?? "";
      expect(text).toContain(expected);
      expect(text).not.toContain("Restart the");
      expect(text).not.toContain("lost until they restart");
      await dialog.getByRole("button", { name: `Keep ${current}` }).click();
      await dialog.waitFor({ state: "detached" });
      expect((await getSettings()).settings.port).toBe(current);
      await page.locator("#f-port").fill(String(current));
      return text;
    }

    function expectOffWording(text: string): void {
      expect(text).toContain("on recording at the new port");
      expect(text).toContain("nothing needs a restart");
    }

    await warnAndKeep("No Claude Code sessions are recording now.");
    await seedLiveSession("warn-1", "Alpha task");
    const one = await warnAndKeep("The 1 Claude Code session recording now");
    expect(one).toContain("Alpha task");
    expectOffWording(one);
    await seedLiveSession("warn-2", "Beta task");
    await seedLiveSession("warn-3", "Gamma task");
    const three = await warnAndKeep("The 3 Claude Code sessions recording now");
    expect(three).toContain("Gamma task");
    expectOffWording(three);
    for (const [id, title] of [
      ["warn-4", "Delta task"],
      ["warn-5", "Epsilon task"],
      ["warn-6", "Zeta task"],
      ["warn-7", "Eta task"],
    ] as const) {
      await seedLiveSession(id, title);
    }
    const seven = await warnAndKeep("The 7 Claude Code sessions recording now");
    expect(seven).toContain("Epsilon task");
    expect(seven).toContain("and 2 more");
    expect(seven).not.toContain("Zeta task");
    expectOffWording(seven);
    expect((await getSettings()).settings.port).toBe(current);
    await page.close();
  }, 180_000);

  it("turns telemetry on and off through the screen, and warns about lost telemetry while it is on", async () => {
    await resetViaApi();
    await seedLiveSession("warn-on-1", "Telemetry task");
    const page = await newScreenPage();
    await openSettings(page);

    const telemetry = telemetryGroup(page);
    await turnTelemetryOn(page);
    await waitForTelemetryState("on");
    expect(await telemetry.locator(".pill-on").textContent()).toBe("On");
    expect(await telemetry.textContent()).toContain(
      "Telemetry is on for Flightpath",
    );

    await openAdvanced(page);
    const current = (await getSettings()).settings.port;
    await page.locator("#f-port").fill(String(current + 13));
    const dialog = await saveIntoDialog(page);
    const text = (await dialog.textContent()) ?? "";
    expect(text).toContain("Restart the 1 Claude Code session");
    expect(text).toContain("Telemetry task");
    expect(text).toContain(
      "Their telemetry keeps going to the old port and is lost until they restart.",
    );
    await dialog.getByRole("button", { name: `Keep ${current}` }).click();
    await dialog.waitFor({ state: "detached" });
    await page.locator("#f-port").fill(String(current));

    await telemetry.getByRole("button", { name: "Turn off…" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Turn off", exact: true })
      .click();
    await waitForTelemetryState("off");
    expect(await telemetry.locator(".pill-off").textContent()).toBe("Off");
    await page.close();
  }, 180_000);

  it("reports a telemetry change the daemon fails as not saved, apart from an unreachable daemon", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    // The router's guard answers a thrown handler with a 500
    // and an empty body; the screen must say the change was
    // not saved, not that the daemon could not be reached.
    await page.route("**/api/telemetry-setup", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, body: "" });
        return;
      }
      await route.continue();
    });
    const telemetry = telemetryGroup(page);
    await turnTelemetryOn(page);
    await waitFor(async () =>
      ((await telemetry.locator(".group-status").textContent()) ?? "").includes(
        "Telemetry could not be changed; nothing was saved.",
      ),
    );
    await page.close();
  }, 120_000);

  it("lowering retention names what goes, and a decline saves nothing", async () => {
    await resetWithRetention(90);
    seedEndedSession("screen-old-1", 40);
    seedEndedSession("screen-old-2", 40);
    const { page, puts, dialog, text } = await lowerRetentionIntoDialog();
    expect(text).toContain("Keep recordings for 30 days?");
    expect(text).toContain("about 2 sessions");
    expect(text).toContain("This can't be undone.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await expectDeclineSavedNothing(puts);
    await saveAndConfirmDelete(page, dialog);
    await waitFor(
      async () => (await getSettings()).settings.retentionDays === 30,
    );
    expect(puts.bodies.length).toBe(1);
    expect(puts.bodies[0]).toEqual({ retentionDays: 30 });
    await page.close();
  }, 120_000);

  it("lowering retention with nothing old enough saves without asking", async () => {
    await resetWithRetention(90);
    seedEndedSession("screen-young-1", 10);
    const page = await newScreenPage();
    await openSettings(page);
    const puts = recordPuts(page);
    await page.locator("#f-retentionDays").selectOption("30");
    await saveChanges(page);
    await waitFor(async () => puts.bodies.length === 1);
    expect(puts.bodies[0]).toEqual({ retentionDays: 30 });
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.close();
  }, 120_000);

  it("lowering retention names one session in the singular", async () => {
    await resetWithRetention(90);
    seedEndedSession("screen-single-1", 40);
    const { page, puts, dialog, text } = await lowerRetentionIntoDialog();
    expect(text).toContain("about 1 session.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await expectDeclineSavedNothing(puts);
    await page.close();
  }, 120_000);

  it("runs the save confirmations in order, and a decline at either saves nothing", async () => {
    await resetWithRetention(90);
    seedEndedSession("order-old-1", 40);
    seedEndedSession("order-old-2", 40);
    const page = await newScreenPage();
    const current = await openAdvancedSettings(page);
    const target = current + 7;
    const puts = recordPuts(page);
    const dialog = page.getByRole("dialog");
    const portAsked = async (): Promise<boolean> =>
      ((await dialog.textContent()) ?? "").includes(
        `Move Flightpath to port ${target}?`,
      );
    await page.locator("#f-retentionDays").selectOption("30");
    await page.locator("#f-port").fill(String(target));
    await saveIntoDialog(page);
    expect(await dialog.textContent()).toContain(
      "Keep recordings for 30 days?",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(puts.bodies.length).toBe(0);
    await saveAndConfirmDelete(page, dialog);
    await waitFor(portAsked);
    await dialog.getByRole("button", { name: `Keep ${current}` }).click();
    await dialog.waitFor({ state: "detached" });
    await expectDeclineSavedNothing(puts);
    await saveAndConfirmDelete(page, dialog);
    await waitFor(portAsked);
    await dialog.getByRole("button", { name: `Move to ${target}` }).click();
    await waitFor(async () => puts.bodies.length === 1);
    expect(puts.bodies[0]).toEqual({ retentionDays: 30, port: target });
    await handOverMovedPort(page, target);
    await page.close();
  }, 180_000);

  it("saves three fields from three groups in one request", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const puts = recordPuts(page);
    await page.locator("#f-autostart").click();
    await page.locator("#f-retentionDays").selectOption("30");
    await openAdvanced(page);
    const current = (await getSettings()).settings.port;
    const target = current + 7;
    await page.locator("#f-port").fill(String(target));
    const bar = saveBar(page);
    await waitFor(async () =>
      ((await bar.textContent()) ?? "").includes("3 unsaved changes"),
    );
    await bar.getByRole("button", { name: "Save changes" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: `Move to ${target}` }).click();
    await waitFor(async () => puts.bodies.length === 1);
    expect(puts.bodies[0]).toEqual({
      autostart: false,
      retentionDays: 30,
      port: target,
    });
    await handOverMovedPort(page, target);
    await page.close();
  }, 120_000);

  it("clears the bar on change back: a switch", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    await proveChangeBack(
      page,
      async () => page.locator("#f-autostart").click(),
      async () => page.locator("#f-autostart").click(),
      { autostart: false },
    );
    await page.close();
  }, 120_000);

  it("clears the bar on change back: the folders list", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    await proveChangeBack(
      page,
      async () => page.locator("#f-excludedFolders").fill("/work/one"),
      async () => page.locator("#f-excludedFolders").fill(""),
      { excludedFolders: ["/work/one"] },
    );
    await page.close();
  }, 120_000);

  it("clears the bar on change back: the days choice", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    await proveChangeBack(
      page,
      async () => {
        await page.locator("#f-retentionDays").selectOption("30");
      },
      async () => {
        await page.locator("#f-retentionDays").selectOption("15");
      },
      { retentionDays: 30 },
    );
    await page.close();
  }, 120_000);

  it("clears the bar on change back: the idle choice", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    await openAdvanced(page);
    await proveChangeBack(
      page,
      async () => {
        await page.locator("#f-idleShutdownMinutes").selectOption("60");
      },
      async () => {
        await page.locator("#f-idleShutdownMinutes").selectOption("30");
      },
      { idleShutdownMinutes: 60 },
    );
    await page.close();
  }, 120_000);

  it("clears the bar on change back: the port", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    const current = await openAdvancedSettings(page);
    const target = current + 7;
    await proveChangeBack(
      page,
      async () => page.locator("#f-port").fill(String(target)),
      async () => page.locator("#f-port").fill(String(current)),
      { port: target },
      async () => {
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        await dialog.getByRole("button", { name: `Move to ${target}` }).click();
        await handOverMovedPort(page, target);
      },
    );
    await page.close();
  }, 120_000);

  it("shows a field error under its field, says so in the bar, and focuses the field", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    const current = await openAdvancedSettings(page);
    await page.locator("#f-port").fill("70000");
    const dialog = await saveIntoDialog(page);
    await dialog.getByRole("button", { name: "Move to 70000" }).click();
    const error = page.locator("#e-port");
    await waitFor(async () =>
      ((await error.textContent()) ?? "").includes("between 1 and 65535"),
    );
    expect(await saveBar(page).textContent()).toContain("1 field needs fixing");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      "f-port",
    );
    expect((await getSettings()).settings.port).toBe(current);
    await page.close();
  }, 120_000);

  it("asks before leaving: Keep editing and Esc both keep editing", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openWithUnsavedNotice(page);
    await waitFor(async () => beforeUnloadPrevented(page));
    const dialog = await openLeaveDialog(page);
    expect(await dialog.textContent()).toContain("You have unsaved changes");
    // A second ask while it waits opens no second dialog: the
    // page behind the modal is inert, so the click lands
    // nowhere.
    await clickBoxCenter(page, page.locator('a[data-route="sessions"]'));
    expect(await page.getByRole("dialog").count()).toBe(1);
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => location.hash === "#settings");
    expect(
      await page.locator("#f-startupNotice").getAttribute("aria-checked"),
    ).toBe("false");
    await page.locator('a[data-route="sessions"]').click();
    await dialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => location.hash === "#settings");
    await page.close();
  }, 120_000);

  it("asks before leaving: Discard goes without saving, and the bar's Cancel disarms the guard", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openWithUnsavedNotice(page);
    const dialog = await openLeaveDialog(page);
    await dialog.getByRole("button", { name: "Discard and continue" }).click();
    await page.waitForSelector("#screen .empty");
    expect((await getSettings()).settings.startupNotice).toBe(true);
    await page.locator('a[data-route="settings"]').click();
    await page.waitForSelector("#f-autostart");
    await page.locator("#f-startupNotice").click();
    const bar = saveBar(page);
    await bar.waitFor({ state: "visible" });
    await bar.getByRole("button", { name: "Cancel" }).click();
    await waitFor(
      async () =>
        (await page
          .locator("#f-startupNotice")
          .getAttribute("aria-checked")) === "true",
    );
    await waitFor(async () => !(await beforeUnloadPrevented(page)));
    await page.locator('a[data-route="sessions"]').click();
    await page.waitForSelector("#screen .empty");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.close();
  }, 120_000);

  it("leaving with Save and continue saves first; a declined confirmation stays", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const puts = recordPuts(page);
    await openAdvanced(page);
    const current = (await getSettings()).settings.port;
    const target = current + 7;
    await page.locator("#f-port").fill(String(target));
    const dialog = await openLeaveDialog(page);
    await dialog.getByRole("button", { name: "Save and continue" }).click();
    await waitFor(async () =>
      ((await dialog.textContent()) ?? "").includes(
        `Move Flightpath to port ${target}?`,
      ),
    );
    await dialog.getByRole("button", { name: `Keep ${current}` }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => location.hash === "#settings");
    expect(puts.bodies.length).toBe(0);
    await page.locator("#f-port").fill(String(current));
    await page.locator("#f-startupNotice").click();
    await openLeaveDialog(page);
    await dialog.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForSelector("#screen .empty");
    expect(puts.bodies.length).toBe(1);
    expect(puts.bodies[0]).toEqual({ startupNotice: false });
    expect((await getSettings()).settings.startupNotice).toBe(false);
    await page.close();
  }, 120_000);

  it("toggles each switch from the keyboard, and the bar counts them", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    for (const id of [
      "f-autostart",
      "f-startupNotice",
      "f-terminalLine",
      "f-storePromptText",
    ]) {
      await waitFor(async () => {
        await page.keyboard.press("Tab");
        return page.evaluate(
          (target) => document.activeElement?.id === target,
          id,
        );
      });
      await page.keyboard.press("Space");
      await waitFor(
        async () =>
          (await page.locator(`#${id}`).getAttribute("aria-checked")) ===
          "false",
      );
    }
    const bar = saveBar(page);
    await bar.waitFor({ state: "visible" });
    expect(await bar.textContent()).toContain("4 unsaved changes");
    await page.close();
  }, 120_000);

  it("keeps an idle value outside the four as the current option", async () => {
    await resetViaApi();
    await callDaemonJson(
      port,
      "PUT",
      "/api/settings",
      token,
      JSON.stringify({ idleShutdownMinutes: 20 }),
    );
    const page = await newScreenPage();
    await openSettings(page);
    await openAdvanced(page);
    const select = page.locator("#f-idleShutdownMinutes");
    expect(await select.inputValue()).toBe("20");
    expect(await select.locator("option:checked").textContent()).toBe(
      "20 minutes (current)",
    );
    expect(await saveBar(page).count()).toBe(0);
    await page.close();
  }, 120_000);

  it("says the recorder also waits for a running session's cache to go cold", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    await openAdvanced(page);
    const help = page.locator("#f-idleShutdownMinutes ~ .field-help");
    expect((await help.textContent())?.replace(/\s+/g, " ")).toBe(
      "with no activity, or once a running session's cache has gone cold if that's later (at most about an hour). The next session starts it again.",
    );
    await page.close();
  }, 120_000);

  it("keeps the idle field's sentence inside the screen on a phone", async () => {
    await resetViaApi();
    const page = await browser.newPage({
      viewport: { width: 390, height: 664 },
    });
    await openSettings(page);
    await openAdvanced(page);
    const box = await page
      .locator("#f-idleShutdownMinutes ~ .field-help")
      .boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.close();
  }, 120_000);

  it("keeps the save bar in view on a phone while a field has focus", async () => {
    await resetViaApi();
    const page = await browser.newPage({
      viewport: { width: 390, height: 664 },
    });
    await openSettings(page);
    await page.locator("#f-autostart").click();
    const bar = saveBar(page);
    await bar.waitFor({ state: "visible" });
    await page.locator("#f-autostart").focus();
    const box = await bar
      .getByRole("button", { name: "Save changes" })
      .boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(664);
    }
    await page.close();
  }, 120_000);

  it("is axe-clean with the bar shown and with each dialog open", async () => {
    await resetWithRetention(90);
    seedEndedSession("axe-old-1", 40);
    const page = await newScreenPage();
    await openSettings(page);
    await page.locator("#f-autostart").click();
    await saveBar(page).waitFor({ state: "visible" });
    await expectAxeCleanOnPage(page);
    await page.locator("#f-retentionDays").selectOption("30");
    const dialog = await saveIntoDialog(page);
    await expectAxeCleanOnPage(page);
    await dialog.getByRole("button", { name: "Delete older and save" }).click();
    await openAdvanced(page);
    const current = (await getSettings()).settings.port;
    await page.locator("#f-port").fill(String(current + 7));
    await saveIntoDialog(page);
    await waitFor(async () =>
      ((await dialog.textContent()) ?? "").includes(
        `Move Flightpath to port ${current + 7}?`,
      ),
    );
    await expectAxeCleanOnPage(page);
    await dialog.getByRole("button", { name: `Keep ${current}` }).click();
    await dialog.waitFor({ state: "detached" });
    await openLeaveDialog(page);
    await expectAxeCleanOnPage(page);
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await page.close();
  }, 120_000);

  it("labels every control on the screen", async () => {
    const page = await newScreenPage();
    await openSettings(page);
    await openAdvanced(page);
    const unlabelled = await page.evaluate(() => {
      const controls = document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(
        ".settings-screen input, .settings-screen select, .settings-screen textarea",
      );
      return [...controls]
        .filter(
          (control) =>
            (control.labels?.length ?? 0) === 0 &&
            !control.getAttribute("aria-label"),
        )
        .map((control) => control.id);
    });
    expect(unlabelled).toEqual([]);
    await page.close();
  }, 60_000);

  it("reaches the settings screen from the old address, token intact", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await page.goto(`${base}/settings#token=${token}`);
    await page.waitForSelector("#f-autostart");
    // The screen loaded, which the shell only shows with a
    // valid token — and the token it stored is the daemon's.
    const stored = await page.evaluate(() =>
      sessionStorage.getItem("flightpath-token"),
    );
    expect(stored).toBe(token);
    await page.close();
  }, 60_000);

  it("moves to the new port and reloads there with the token still valid", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    const newPort = await freePort();
    await movePortOnScreen(page, `${base}/#settings&token=${token}`, newPort);
    const reachable = await page.evaluate(async () => {
      const response = await fetch("/api/settings", {
        headers: {
          "x-flightpath-token":
            sessionStorage.getItem("flightpath-token") ?? "",
        },
      });
      return response.status;
    });
    expect(reachable).toBe(200);
    port = newPort;
    base = `http://127.0.0.1:${newPort}`;
    await waitFor(async () => (await getSettings()).settings.port === newPort);
    await page.close();
  }, 120_000);

  it("shows the six cards in order, with their titles, descriptions and no band icons", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const headings = await page
      .locator(".settings-screen")
      .getByRole("heading", { level: 2 })
      .all();
    expect(headings.length).toBe(6);
    const headingTexts = await Promise.all(
      headings.map(async (heading) => (await heading.textContent()) ?? ""),
    );
    expect(headingTexts.slice(0, 4)).toEqual([
      "Recording",
      "Appearance",
      "Your data",
      "Claude Code telemetry",
    ]);
    // Advanced's heading wraps its toggle, so the heading's
    // text runs on into the summary the toggle shows.
    expect(headingTexts[4]).toContain("Advanced settings");
    expect(headingTexts[5]).toBe("Danger zone");
    const cards = await page.evaluate(() => {
      const sections = [
        ...document.querySelectorAll(".settings-screen > section"),
      ];
      return sections.map((section) => {
        return {
          text: section.textContent ?? "",
          bandIcons:
            section.firstElementChild?.querySelectorAll("svg").length ?? 0,
        };
      });
    });
    const descriptions = [
      "What Flightpath records, and when.",
      "How this page looks, in this browser.",
      "Where recordings live, and how long they're kept.",
      "Extra detail from Claude Code itself, with your consent.",
      "Stops after 30 min with no activity",
      "This can't be undone.",
    ];
    descriptions.forEach((description, index) => {
      expect(cards[index]?.text).toContain(description);
    });
    expect(cards.map((card) => card.bandIcons)).toEqual([0, 0, 0, 0, 1, 0]);
    // The screen's one spacing rule puts 20 px between its
    // children: the first card sits that far below the intro
    // line, and each card that far below the one above it. A
    // card rule cancelling that margin leaves the cards
    // flush, and this fails.
    const gaps = await page.evaluate(() => {
      const intro = document.querySelector(".screen-sub");
      const sections = [
        ...document.querySelectorAll(".settings-screen > section"),
      ];
      const rects = sections.map((section) => section.getBoundingClientRect());
      const measured: number[] = [];
      if (intro && rects[0]) {
        measured.push(rects[0].top - intro.getBoundingClientRect().bottom);
      }
      for (let index = 1; index < rects.length; index++) {
        const above = rects[index - 1];
        const below = rects[index];
        if (above && below) measured.push(below.top - above.bottom);
      }
      return measured;
    });
    expect(gaps.length).toBe(6);
    for (const gap of gaps) {
      expect(Math.abs(gap - 20)).toBeLessThanOrEqual(1);
    }
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 120_000);

  it("opens and closes advanced from its row, and the summary follows the saved values", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await openSettings(page);
    const toggle = page.locator(".settings-advanced .advanced-toggle");
    const saved = (await getSettings()).settings;
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    // The panel stays mounted while closed, hidden: the
    // toggle's aria-controls names an element in the page.
    expect(await page.locator("#advanced-panel").count()).toBe(1);
    await page.waitForSelector("#f-port", { state: "hidden" });
    expect(await toggle.textContent()).toContain(
      `Port ${saved.port} · Stops after 30 min with no activity`,
    );
    await toggle.click();
    await waitFor(
      async () => (await toggle.getAttribute("aria-expanded")) === "true",
    );
    await page.waitForSelector("#f-port", { state: "visible" });
    await expectAxeCleanOnPage(page);
    await page.locator("#f-idleShutdownMinutes").selectOption("60");
    // The bar counting the change proves the draft rendered;
    // only then does the summary still reading the saved
    // value prove it follows the saved values, not the draft.
    await waitFor(async () =>
      ((await saveBar(page).textContent()) ?? "").includes("1 unsaved change"),
    );
    expect(await toggle.textContent()).toContain("Stops after 30 min");
    await saveChanges(page);
    await waitFor(async () =>
      ((await toggle.textContent()) ?? "").includes(
        "Stops after 60 min with no activity",
      ),
    );
    await toggle.click();
    await waitFor(
      async () => (await toggle.getAttribute("aria-expanded")) === "false",
    );
    await page.close();
  }, 120_000);

  it("opens advanced and focuses the port when the address asks for the port", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await page.goto(`${base}/#settings?focus=port&token=${token}`);
    await page.waitForSelector("#f-autostart");
    await waitFor(async () =>
      page.evaluate(() => document.activeElement?.id === "f-port"),
    );
    expect(
      await page
        .locator(".settings-advanced .advanced-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await page.close();
  }, 60_000);

  it("opens advanced when a save answers an error on the port", async () => {
    await resetViaApi();
    const page = await newScreenPage();
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            errors: { port: "must be a whole number between 1 and 65535" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await openSettings(page);
    await page.locator("#f-autostart").click();
    await saveChanges(page);
    const toggle = page.locator(".settings-advanced .advanced-toggle");
    await waitFor(
      async () => (await toggle.getAttribute("aria-expanded")) === "true",
    );
    await waitFor(async () =>
      page.evaluate(() => document.activeElement?.id === "f-port"),
    );
    expect(await page.locator("#e-port").textContent()).toContain(
      "between 1 and 65535",
    );
    expect(await saveBar(page).textContent()).toContain("1 field needs fixing");
    await page.close();
  }, 120_000);
});
