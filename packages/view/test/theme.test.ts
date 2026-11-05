// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyThemeChoice,
  chooseTheme,
  followThemeChoices,
  readThemeChoice,
} from "../src/theme.js";

// The theme module: one stored value, applied as the
// document's data-theme, with blocked storage read as System.

const realStorage = window.localStorage;

function stubStorage(storage: Storage): void {
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
}

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new Error("storage blocked");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  stubStorage(realStorage);
  document.documentElement.removeAttribute("data-theme");
});

describe("readThemeChoice", () => {
  it("reads System when nothing is stored", () => {
    expect(readThemeChoice()).toBe("system");
  });

  it("reads a stored explicit choice", () => {
    window.localStorage.setItem("flightpath-theme", "dark");
    expect(readThemeChoice()).toBe("dark");
    window.localStorage.setItem("flightpath-theme", "light");
    expect(readThemeChoice()).toBe("light");
  });

  it("reads System for an unrecognised value", () => {
    window.localStorage.setItem("flightpath-theme", "purple");
    expect(readThemeChoice()).toBe("system");
  });

  it("reads System when storage throws", () => {
    stubStorage(throwingStorage());
    expect(readThemeChoice()).toBe("system");
  });
});

describe("chooseTheme and applyThemeChoice", () => {
  it("sets data-theme for an explicit choice and stores it", () => {
    chooseTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("flightpath-theme")).toBe("dark");
  });

  it("removes data-theme for System, so the OS query decides", () => {
    chooseTheme("dark");
    chooseTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("flightpath-theme")).toBe("system");
  });

  it("still applies the pick to this tab when the write is blocked", () => {
    stubStorage(throwingStorage());
    chooseTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applies without storing", () => {
    applyThemeChoice("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("flightpath-theme")).toBeNull();
  });
});

describe("followThemeChoices", () => {
  it("hands over the choice another tab stored", () => {
    const seen = vi.fn();
    const stop = followThemeChoices(seen);
    window.localStorage.setItem("flightpath-theme", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "flightpath-theme" }),
    );
    expect(seen).toHaveBeenCalledWith("dark");
    stop();
  });

  it("ignores storage events for other keys", () => {
    const seen = vi.fn();
    const stop = followThemeChoices(seen);
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(seen).not.toHaveBeenCalled();
    stop();
  });
});
