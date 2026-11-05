import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectAxeCleanOnPage } from "./support/axe.js";
import { startScreenBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import { clickBoxCenter } from "./support/click.js";
import { callDaemon, callDaemonJson, waitFor } from "./support/daemon.js";
import { dataTheme, newThemedPage } from "./support/theme-page.js";

declare global {
  interface Window {
    closeEvents: number;
    sessionsClicks: number;
  }
}

// The one confirmation dialog in a real browser: it closes
// only when a person closes it, Esc never confirms, focus
// moves in and comes back, the page behind it is inert, and
// Delete all data needs DELETE typed exactly. Each test sets
// its starting state through the API, so no test depends on
// another.

let base: string;
let port: number;
let token: string;
let browser: Browser;

async function resetViaApi(): Promise<void> {
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

async function newPage(): Promise<Page> {
  return browser.newPage({ viewport: { width: 1440, height: 900 } });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(`${base}/#settings&token=${token}`);
  await page.waitForSelector("#f-autostart");
}

/** Reset through the API and land on a fresh settings page:
 *  the starting point nearly every test here shares. */
async function openFreshSettings(): Promise<Page> {
  await resetViaApi();
  const page = await newPage();
  await openSettings(page);
  return page;
}

function telemetryGroup(page: Page): Locator {
  return page.locator(".settings-group", {
    has: page.locator("#group-telemetry-h"),
  });
}

/** Count the POSTs to a path this page makes from now on. */
function countPosts(page: Page, path: string): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(path)) {
      count += 1;
    }
  });
  return () => count;
}

async function openDialogFrom(page: Page, opener: Locator): Promise<Locator> {
  await opener.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function openTurnOnDialog(page: Page): Promise<Locator> {
  return openDialogFrom(
    page,
    telemetryGroup(page).getByRole("button", { name: "Turn on…" }),
  );
}

async function openTurnOffDialog(page: Page): Promise<Locator> {
  return openDialogFrom(
    page,
    telemetryGroup(page).getByRole("button", { name: "Turn off…" }),
  );
}

async function openDeleteDialog(page: Page): Promise<Locator> {
  return openDialogFrom(
    page,
    page.getByRole("button", { name: "Delete all data…" }),
  );
}

async function dialogGone(page: Page): Promise<boolean> {
  return (await page.locator(".confirm-dialog").count()) === 0;
}

async function dismissWithEscape(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await waitFor(() => dialogGone(page));
}

/** Confirm the turn-on dialog and wait for it to close. */
async function confirmTurnOn(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Turn on", exact: true }).click();
  await waitFor(() => dialogGone(page));
}

/** Open the turn-on dialog, dismiss it the given way, and
 *  check the dismissal posted nothing and changed nothing. */
async function dismissalPostsNothing(
  dismiss: (dialog: Locator) => Promise<void>,
): Promise<void> {
  const page = await openFreshSettings();
  const posts = countPosts(page, "/api/telemetry-setup");
  const dialog = await openTurnOnDialog(page);
  await dismiss(dialog);
  await waitFor(() => dialogGone(page));
  expect(posts()).toBe(0);
  expect(await telemetryGroup(page).locator(".pill-off").textContent()).toBe(
    "Off",
  );
  await page.close();
}

async function activeElementText(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
}

function squashed(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

beforeAll(async () => {
  const started = await startScreenBrowser("flightpath-confirm-dialog-");
  base = started.base;
  port = started.port;
  token = started.token;
  browser = started.browser;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

describe("the confirmation dialog", () => {
  it("stays open when the backdrop is clicked, and posts nothing", async () => {
    const page = await openFreshSettings();
    const posts = countPosts(page, "/api/telemetry-setup");
    await openTurnOnDialog(page);
    const start = Date.now();
    await page.mouse.click(8, 8);
    // The criterion's own measure: still open one second
    // after the click, so nothing closed it on a timer.
    await page.waitForFunction((t) => Date.now() - t >= 1_000, start);
    expect(await page.locator("dialog[open]").count()).toBe(1);
    expect(posts()).toBe(0);
    await page.close();
  }, 120_000);

  it("Esc dismisses it through the parent, and posts nothing", async () => {
    const page = await openFreshSettings();
    const posts = countPosts(page, "/api/telemetry-setup");
    await openTurnOnDialog(page);
    // Esc must route through the parent, not close the dialog
    // itself: count the dialog's own close events.
    await page.evaluate(() => {
      window.closeEvents = 0;
      document.querySelector("dialog")?.addEventListener("close", () => {
        window.closeEvents += 1;
      });
    });
    await page.keyboard.press("Escape");
    await waitFor(() => dialogGone(page));
    expect(posts()).toBe(0);
    const closeEvents = await page.evaluate(() => window.closeEvents);
    expect(closeEvents).toBe(0);
    await page.close();
  }, 120_000);

  it("the close button dismisses it, and posts nothing", async () => {
    await dismissalPostsNothing(async (dialog) => {
      await dialog.getByRole("button", { name: "Close" }).click();
    });
  }, 120_000);

  it("Cancel dismisses it, and posts nothing", async () => {
    await dismissalPostsNothing(async (dialog) => {
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  }, 120_000);

  it("moves focus to the first action, keeps Tab inside, and returns focus on close", async () => {
    const page = await openFreshSettings();
    await openTurnOnDialog(page);
    await waitFor(async () => (await activeElementText(page)) === "Turn on");
    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        document
          .querySelector("dialog")
          ?.contains(document.activeElement ?? null),
      );
      expect(inside).toBe(true);
    }
    await dismissWithEscape(page);
    await waitFor(async () => (await activeElementText(page)) === "Turn on…");
    await page.close();
  }, 120_000);

  it("leaves the page behind it unusable while it is open", async () => {
    const page = await openFreshSettings();
    await openTurnOnDialog(page);
    const link = page.getByRole("link", { name: "Sessions" });
    // Count activations of the link itself: a click that
    // reaches it fires the listener, so a count of zero after
    // a real click at its centre is what proves the page
    // behind the modal cannot be used.
    await page.evaluate(() => {
      window.sessionsClicks = 0;
      const sessions = Array.from(document.querySelectorAll("a")).find(
        (anchor) => anchor.textContent?.trim() === "Sessions",
      );
      sessions?.addEventListener("click", () => {
        window.sessionsClicks += 1;
      });
    });
    await clickBoxCenter(page, link);
    expect(await page.evaluate(() => window.sessionsClicks)).toBe(0);
    expect(await page.locator("dialog[open]").count()).toBe(1);
    await page.close();
  }, 120_000);

  it("reuses the open dialog when its opener is triggered twice", async () => {
    const page = await openFreshSettings();
    await telemetryGroup(page)
      .getByRole("button", { name: "Turn on…" })
      .dblclick();
    await waitFor(
      async () => (await page.locator("dialog[open]").count()) === 1,
    );
    expect(await page.locator("dialog").count()).toBe(1);
    await page.close();
  }, 120_000);

  it("ends closed when the browser closes the dialog itself", async () => {
    const page = await openFreshSettings();
    await openTurnOnDialog(page);
    await page.evaluate(() => {
      document.querySelector("dialog")?.close();
    });
    await waitFor(() => dialogGone(page));
    expect(await telemetryGroup(page).locator(".pill-off").textContent()).toBe(
      "Off",
    );
    await page.close();
  }, 120_000);

  it("enables Delete everything only for exactly DELETE, and deletes once", async () => {
    const page = await openFreshSettings();
    const deletes = countPosts(page, "/api/delete-all-data");
    const dialog = await openDeleteDialog(page);
    const confirm = dialog.getByRole("button", { name: "Delete everything" });
    const field = dialog.getByLabel("Type DELETE to confirm");
    // With a confirmation to type, focus lands in the field
    // on open, not on the first action.
    await waitFor(
      async () =>
        await page.evaluate(
          () =>
            document.activeElement ===
            document.querySelector(".confirm-dialog-field input"),
        ),
    );
    expect(await confirm.isDisabled()).toBe(true);
    await field.fill("delete");
    expect(await confirm.isDisabled()).toBe(true);
    await field.fill("DELET");
    expect(await confirm.isDisabled()).toBe(true);
    await field.fill("DELETE");
    await waitFor(async () => !(await confirm.isDisabled()));
    await confirm.click();
    await waitFor(() => dialogGone(page));
    expect(deletes()).toBe(1);
    await page.close();
  }, 120_000);

  it("shows the wording each confirmation was given", async () => {
    const page = await openFreshSettings();
    const turnOn = await openTurnOnDialog(page);
    expect(squashed(await turnOn.locator("h2").textContent())).toBe(
      "Turn on Claude Code telemetry?",
    );
    expect(
      squashed(await turnOn.locator(".confirm-dialog-body").textContent()),
    ).toBe(
      "Flightpath adds its telemetry settings to your Claude Code settings file (~/.claude/settings.json) so Claude Code sends its telemetry to this computer. It never leaves this machine. It applies from your next session, and turning it off removes exactly what was added.",
    );
    await confirmTurnOn(page, turnOn);

    const turnOff = await openTurnOffDialog(page);
    expect(squashed(await turnOff.locator("h2").textContent())).toBe(
      "Turn off Claude Code telemetry?",
    );
    expect(
      squashed(await turnOff.locator(".confirm-dialog-body").textContent()),
    ).toBe(
      "Flightpath removes the settings it added to your Claude Code settings file. Recording carries on from hooks and transcripts, without background requests or exact timings.",
    );
    await turnOff.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() => dialogGone(page));

    const wipe = await openDeleteDialog(page);
    expect(squashed(await wipe.locator("h2").textContent())).toBe(
      "Delete every recording?",
    );
    const body = squashed(
      await wipe.locator(".confirm-dialog-body").textContent(),
    );
    expect(body).toBe(
      "Every session Flightpath has recorded on this computer is deleted, and the space is given back. Your settings stay. This can't be undone.",
    );
    expect(body.replace("Your settings stay.", "")).not.toContain("setting");
    await page.close();
  }, 120_000);

  it("is axe-clean with each of the three dialogs open", async () => {
    const page = await openFreshSettings();
    const turnOn = await openTurnOnDialog(page);
    await expectAxeCleanOnPage(page);
    await confirmTurnOn(page, turnOn);

    await openTurnOffDialog(page);
    await expectAxeCleanOnPage(page);
    await dismissWithEscape(page);

    await openDeleteDialog(page);
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 120_000);

  it("is axe-clean in dark with a dialog open", async () => {
    await resetViaApi();
    const page = await newThemedPage(browser, "dark");
    await openSettings(page);
    await openTurnOnDialog(page);
    expect(await dataTheme(page)).toBe("dark");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 120_000);
});
