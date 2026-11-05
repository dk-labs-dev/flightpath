import type { Page } from "playwright";

/** Move the daemon to a new port through the settings
 *  screen: open the screen, expand the Advanced section,
 *  fill the port, save, confirm the move in the dialog, and
 *  wait until the page is served from the new port. Returns
 *  the moment the confirming click lands, so a caller can
 *  time the move from there. */
export async function movePortOnScreen(
  page: Page,
  settingsUrl: string,
  target: number,
): Promise<number> {
  await page.goto(settingsUrl);
  await page.waitForSelector("#f-autostart");
  const advanced = page.locator(".settings-advanced .advanced-toggle");
  if ((await advanced.getAttribute("aria-expanded")) !== "true") {
    await advanced.click();
  }
  await page.waitForSelector("#f-port", { state: "visible" });
  await page.locator("#f-port").fill(String(target));
  await page.getByRole("button", { name: "Save changes" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  const startedAt = Date.now();
  await dialog.getByRole("button", { name: `Move to ${target}` }).click();
  await page.waitForFunction(
    (moved) => location.port === String(moved),
    target,
  );
  await page.waitForSelector("#f-autostart");
  return startedAt;
}
