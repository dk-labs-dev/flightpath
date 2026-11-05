// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppearanceGroup } from "../src/components/AppearanceGroup.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("data-theme");
});

function render(): void {
  act(() => root.render(<AppearanceGroup />));
}

function radios(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  );
}

function pressKey(element: Element, key: string): void {
  act(() => {
    element.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

describe("AppearanceGroup", () => {
  it("shows the card with System, Light and Dark, System checked", () => {
    render();
    expect(container.querySelector("h2")?.textContent).toBe("Appearance");
    expect(container.textContent).toContain(
      "How this page looks, in this browser.",
    );
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Theme");
    expect(radios().map((radio) => radio.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(
      ["true", "false", "false"],
    );
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it("checks the stored choice on open", () => {
    window.localStorage.setItem("flightpath-theme", "dark");
    render();
    expect(radios()[2]?.getAttribute("aria-checked")).toBe("true");
    expect(radios()[2]?.tabIndex).toBe(0);
  });

  it("applies and stores a click at once", () => {
    render();
    act(() => radios()[2]?.click());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("flightpath-theme")).toBe("dark");
    expect(radios()[2]?.getAttribute("aria-checked")).toBe("true");
  });

  it("moves and selects with the arrow keys", () => {
    render();
    const system = radios()[0] as HTMLButtonElement;
    system.focus();
    pressKey(system, "ArrowRight");
    expect(document.activeElement?.textContent).toBe("Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    pressKey(document.activeElement as Element, "ArrowRight");
    expect(document.activeElement?.textContent).toBe("Dark");
    pressKey(document.activeElement as Element, "ArrowRight");
    expect(document.activeElement?.textContent).toBe("System");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    pressKey(document.activeElement as Element, "ArrowLeft");
    expect(document.activeElement?.textContent).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("jumps to the ends with Home and End", () => {
    render();
    const system = radios()[0] as HTMLButtonElement;
    system.focus();
    pressKey(system, "End");
    expect(document.activeElement?.textContent).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(radios()[2]?.getAttribute("aria-checked")).toBe("true");
    pressKey(document.activeElement as Element, "Home");
    expect(document.activeElement?.textContent).toBe("System");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(radios()[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("follows a pick made in another tab", () => {
    render();
    act(() => {
      window.localStorage.setItem("flightpath-theme", "light");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "flightpath-theme" }),
      );
    });
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
  });
});
