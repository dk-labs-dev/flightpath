import type { Locator } from "playwright";
import { expect } from "vitest";

// Opening and closing one of the view's "?" explanations
// in a browser test: the note a button opens is the element
// its aria-controls names, and it is in the page only while
// the note is open. A note must also lie inside the box
// that clips it — the nearest ancestor that scrolls, whose
// edge can start well inside the window — wherever its
// word wraps.

export async function openExplainNote(button: Locator): Promise<Locator> {
  const page = button.page();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const noteId = await button.getAttribute("aria-controls");
  const note = page.locator(`[id="${noteId}"]`);
  await expect.poll(() => note.count()).toBe(1);
  const clip = await note.evaluate((el) => {
    let node = el.parentElement;
    while (node !== null) {
      const style = getComputedStyle(node);
      if (
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll"
      ) {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }
      node = node.parentElement;
    }
    return { left: 0, right: window.innerWidth };
  });
  const noteBox = await note.boundingBox();
  expect(noteBox).not.toBeNull();
  expect(noteBox!.x).toBeGreaterThanOrEqual(clip.left);
  expect(noteBox!.x + noteBox!.width).toBeLessThanOrEqual(clip.right);
  return note;
}

export async function closeExplainNote(button: Locator): Promise<void> {
  const page = button.page();
  const noteId = await button.getAttribute("aria-controls");
  await button.click();
  await expect.poll(() => page.locator(`[id="${noteId}"]`).count()).toBe(0);
}
