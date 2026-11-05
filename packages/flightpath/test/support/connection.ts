import type { Page } from "playwright";

/** Wait until the app bar's connection pill says `text`. */
export async function waitForConnection(
  page: Page,
  text: string,
  timeout?: number,
): Promise<void> {
  await page.waitForFunction(
    (wanted) =>
      document
        .querySelector(".connection-status")
        ?.textContent?.includes(wanted) ?? false,
    text,
    timeout === undefined ? {} : { timeout },
  );
}

/** The connection's words on the page: the app bar pill's
 * text and the banner's, together — a catch-up's word moves
 * from the pill to the banner, and the tests read both. */
export function connectionWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pill = document.querySelector(".connection-status")?.textContent;
    const banner = document.querySelector(".connection-banner")?.textContent;
    return [pill, banner].filter(Boolean).join(" ");
  });
}
