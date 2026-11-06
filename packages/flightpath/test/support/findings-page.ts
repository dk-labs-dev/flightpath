import type { Page } from "playwright";
import { expect } from "vitest";

import { FINDINGS_SESSION } from "./findings-session.js";

export async function openFindingsSession(
  page: Page,
  address: { base: string; token: string },
  session = FINDINGS_SESSION,
): Promise<void> {
  await page.goto(`${address.base}/#session/${session}&token=${address.token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".trow");
}

/** Leaves the list open, whether the session started it open or not. */
export async function openFindingsList(page: Page): Promise<void> {
  const toggle = page.locator(".findings-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
  await expect
    .poll(() => page.locator(".findings-region").isVisible())
    .toBe(true);
}

/** The element focus is on, as its tag and class. */
export function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el === null ? "none" : `${el.tagName.toLowerCase()}.${el.className}`;
  });
}

/** Open the session, its list, and the step of the worst suggestion,
 * on its Suggestions tab. */
export async function openWorstCard(
  page: Page,
  address: { base: string; token: string },
): Promise<void> {
  await openFindingsSession(page, address);
  await openFindingsList(page);
  await page.locator(".findings-region .finding-show").first().click();
  await expect
    .poll(() => page.locator("#detail-panel-suggestions").isVisible())
    .toBe(true);
}
