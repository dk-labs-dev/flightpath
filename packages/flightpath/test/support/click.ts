import type { Locator, Page } from "playwright";

/** Click the centre of an element's box with the mouse. */
export async function clickBoxCenter(
  page: Page,
  target: Locator,
): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error("the click target has no box");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
