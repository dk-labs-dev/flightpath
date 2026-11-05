import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectAxeCleanOnPage } from "./support/axe.js";
import { runCleanups } from "./support/cleanup.js";
import { bootBrowser } from "./support/browser.js";
import {
  dataTheme,
  newThemedPage,
  resolvedTokens,
} from "./support/theme-page.js";

let base: string;
let token: string;
let browser: Browser;

beforeAll(async () => {
  ({ base, token, browser } = await bootBrowser("flightpath-theme-browser-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

type SystemScheme = "light" | "dark";

async function openPage(
  hash: string,
  storedTheme?: "light" | "dark",
  colorScheme: SystemScheme = "light",
): Promise<Page> {
  const page =
    storedTheme === undefined
      ? await browser.newPage({
          viewport: { width: 1440, height: 900 },
          colorScheme,
        })
      : await newThemedPage(browser, storedTheme, { colorScheme });
  await page.goto(`${base}/${hash}&token=${encodeURIComponent(token)}`);
  return page;
}

async function openSettings(storedTheme?: "light" | "dark"): Promise<Page> {
  const page = await openPage("#settings", storedTheme);
  await page.waitForSelector("#group-appearance-h");
  return page;
}

async function openSessions(
  storedTheme?: "light" | "dark",
  colorScheme: SystemScheme = "light",
): Promise<Page> {
  const page = await openPage("#sessions", storedTheme, colorScheme);
  await page.waitForSelector("#screen .empty");
  return page;
}

async function tokenValue(page: Page, name: string): Promise<string> {
  const value = (await resolvedTokens(page))[name];
  if (value === undefined) throw new Error(`no token named ${name}`);
  return value;
}

function channelsOf(value: string): [number, number, number] {
  const parts =
    /rgba?\(([^)]+)\)/
      .exec(value)?.[1]
      ?.split(",")
      .map((part) => Number(part.trim())) ?? [];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function luminance(value: string): number {
  const [r, g, b] = channelsOf(value).map((part) => {
    const channel = part / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

describe("the dark theme in a browser", () => {
  it("passes axe on the sessions and settings screens in light", async () => {
    const sessions = await openSessions("light");
    await expectAxeCleanOnPage(sessions);
    await sessions.close();
    const settings = await openSettings("light");
    await expectAxeCleanOnPage(settings);
    await settings.close();
  }, 60_000);

  it("passes axe on the sessions and settings screens in dark", async () => {
    const sessions = await openSessions("dark");
    expect(await dataTheme(sessions)).toBe("dark");
    expect(channelsOf(await tokenValue(sessions, "--paper"))).toEqual([
      10, 10, 10,
    ]);
    await expectAxeCleanOnPage(sessions);
    await sessions.close();
    const settings = await openSettings("dark");
    await expectAxeCleanOnPage(settings);
    await settings.close();
  }, 60_000);

  it("holds the switch's on track at 3:1 against dark paper", async () => {
    const page = await openSettings("dark");
    const track = await page
      .locator('.switch[aria-checked="true"]')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const paper = await tokenValue(page, "--paper");
    const ratio =
      (Math.max(luminance(track), luminance(paper)) + 0.05) /
      (Math.min(luminance(track), luminance(paper)) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(3);
    await page.close();
  }, 60_000);

  it("keeps the choice across a reload, and System clears it", async () => {
    const page = await openSettings();
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect.poll(() => dataTheme(page)).toBe("dark");
    await page.reload();
    await page.waitForSelector("#group-appearance-h");
    expect(await dataTheme(page)).toBe("dark");
    expect(
      await page
        .getByRole("radio", { name: "Dark" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await page.getByRole("radio", { name: "System" }).click();
    await expect.poll(() => dataTheme(page)).toBeNull();
    await page.close();
  }, 60_000);

  it("never counts a theme pick as an unsaved change", async () => {
    const page = await openSettings();
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect
      .poll(() =>
        page.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
      )
      .toBe("true");
    await expect.poll(() => dataTheme(page)).toBe("dark");
    expect(await page.locator(".save-bar.save-bar-idle").count()).toBe(1);
    expect(await page.getByLabel("Unsaved changes").count()).toBe(0);
    await page.close();
  }, 60_000);

  it("follows the OS under System, without a reload", async () => {
    const page = await openSessions();
    expect(await dataTheme(page)).toBeNull();
    await page.emulateMedia({ colorScheme: "dark" });
    expect(channelsOf(await tokenValue(page, "--paper"))).toEqual([10, 10, 10]);
    await page.emulateMedia({ colorScheme: "light" });
    expect(channelsOf(await tokenValue(page, "--paper"))).toEqual([
      255, 255, 255,
    ]);
    await page.close();
  }, 60_000);

  it("declares the colour scheme the theme choice names", async () => {
    const schemeOf = (page: Page): Promise<string> =>
      page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      );
    const light = await openSessions("light", "dark");
    expect(await schemeOf(light)).toBe("light");
    await light.close();
    const dark = await openSessions("dark", "light");
    expect(await schemeOf(dark)).toBe("dark");
    await dark.close();
    const system = await openSessions();
    expect(await schemeOf(system)).toBe("light dark");
    await system.close();
  }, 60_000);

  it("draws Dark on a light computer as System draws on a dark one", async () => {
    const chosen = await openSessions("dark", "light");
    const followed = await openSessions(undefined, "dark");
    const tokens = await resolvedTokens(chosen);
    expect(Object.keys(tokens).length).toBeGreaterThan(60);
    expect(await resolvedTokens(followed)).toEqual(tokens);
    await chosen.close();
    await followed.close();
  }, 60_000);

  it("draws Light on a dark computer as System draws on a light one", async () => {
    const chosen = await openSessions("light", "dark");
    const followed = await openSessions(undefined, "light");
    expect(await resolvedTokens(followed)).toEqual(
      await resolvedTokens(chosen),
    );
    await chosen.close();
    await followed.close();
  }, 60_000);

  it("applies a pick in one tab to the other tab", async () => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto(`${base}/#settings&token=${encodeURIComponent(token)}`);
    await first.waitForSelector("#group-appearance-h");
    const second = await context.newPage();
    await second.goto(`${base}/#sessions&token=${encodeURIComponent(token)}`);
    await second.waitForSelector("#screen .empty");
    await first.getByRole("radio", { name: "Dark" }).click();
    await second.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "dark",
    );
    await context.close();
  }, 60_000);

  // Only the theme's own key is blocked: blocking the
  // shell's own keys would test a different behaviour.
  it("still applies a pick for the tab when storage is blocked", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.addInitScript(() => {
      const real = window.localStorage;
      const blocked = {
        getItem(key: string): string | null {
          if (key === "flightpath-theme") throw new Error("storage blocked");
          return real.getItem(key);
        },
        setItem(key: string, value: string): void {
          if (key === "flightpath-theme") throw new Error("storage blocked");
          real.setItem(key, value);
        },
        removeItem(key: string): void {
          real.removeItem(key);
        },
      };
      Object.defineProperty(window, "localStorage", { value: blocked });
    });
    await page.goto(`${base}/#settings&token=${encodeURIComponent(token)}`);
    await page.waitForSelector("#group-appearance-h");
    expect(await dataTheme(page)).toBeNull();
    expect(
      await page
        .getByRole("radio", { name: "System" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect.poll(() => dataTheme(page)).toBe("dark");
    await page.close();
  }, 60_000);
});
