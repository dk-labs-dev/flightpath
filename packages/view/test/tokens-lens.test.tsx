// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { Rise } from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { useSessionStore } from "../src/session/store.js";
import type { StepRow } from "../src/session/types.js";
import { jsonResponse, tokenPoint } from "./fixtures.js";
import {
  container,
  history,
  refetchLens,
  renderLens,
  scrollIntoView,
  setResponder,
  settle,
  setupTokensLensTests,
  T0,
  texts,
} from "./support/tokens-lens-harness.js";

// The tokens lens against a hand-built history: the curve's
// lines and marks, the room's wording case by case, the
// plain statements flag by flag, and the load states. The
// harness is shared with the other lens test files.

setupTokensLensTests(() => Promise.resolve(jsonResponse(200, history())));

/** Press a key on the curve, the way the keyboard
 * tests drive it. */
function pressKey(svg: Element | null, key: string): void {
  act(() => {
    svg?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function stepRow(overrides: Partial<StepRow>): StepRow {
  return {
    id: 5,
    toolName: "Read",
    outcome: "succeeded",
    startedAt: T0 + 5_000,
    endedAt: T0 + 55_000,
    durationMs: null,
    branchId: null,
    resultRequestId: 2,
    sentence: "",
    turnId: null,
    ...overrides,
  };
}

describe("the curve", () => {
  it("draws the lines, band, tick, markers and gap from the payload", async () => {
    await renderLens();
    const labelTexts = texts(".tokens-curve-labels span");
    expect(labelTexts).toContain("base · 20.0K tokens");
    // The peak is 95K and both marks stand beyond its reach:
    // they are named in the note's strip above the chart,
    // not drawn, and not among the curve's labels.
    expect(texts(".tokens-above-note")).toEqual([
      "Above the chart: auto-compact at 193K, the limit at 200K",
    ]);
    expect(labelTexts.some((text) => text.startsWith("Above the chart"))).toBe(
      false,
    );
    expect(container.querySelector(".tokens-limit-line")).toBeNull();
    expect(container.querySelector(".tokens-autocompact-line")).toBeNull();
    expect(labelTexts).toContain("compacted");
    expect(
      container.querySelectorAll("polyline.tokens-curve-line"),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll("polygon.tokens-curve-area"),
    ).toHaveLength(1);
    expect(texts("svg title")).toContain("Compacted the conversation");
    expect(texts("svg title")).toContain("idle 9 min");
    const labels = [...container.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Cache rebuilt"));
    expect(labels.sort()).toEqual([
      "Cache rebuilt after compaction (expected)",
      "Cache rebuilt: cause unknown",
      "Cache rebuilt: the cache expired after 10 minutes",
    ]);
    expect(container.textContent).toContain("idle longer than the cache lasts");
    const legend = texts(".tokens-legend span").map((text) => text.trim());
    expect(legend.some((text) => text === "cache rebuilt")).toBe(true);
  });

  it("draws both marks when they stand within reach of the peak", async () => {
    const main = [
      tokenPoint(1, T0, 20_000, null),
      tokenPoint(2, T0 + 60_000, 150_000),
    ];
    const room = {
      window: {
        tokens: 200_000,
        source: "model-list" as const,
        reportedAt: null,
      },
      autoCompact: { tokens: 193_000, source: "model-default" as const },
      toLimit: 50_000,
      toAutoCompact: 43_000,
      turnsLeft: null,
    };
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            main,
            base: main[0] ?? null,
            drops: [],
            rebuilds: [],
            room,
          }),
        ),
      ),
    );
    await renderLens();
    expect(container.querySelectorAll("line.tokens-limit-line")).toHaveLength(
      1,
    );
    expect(
      container.querySelectorAll("line.tokens-autocompact-line"),
    ).toHaveLength(1);
    const labelTexts = texts(".tokens-curve-labels span");
    expect(labelTexts).toContain("limit · 200K");
    expect(labelTexts).toContain("auto-compact · 193K");
    expect(labelTexts.some((text) => text.startsWith("Above the chart"))).toBe(
      false,
    );
    expect(container.querySelector(".tokens-above-note")).toBeNull();
  });

  it("names both marks above the chart when they stand beyond the peak", async () => {
    const main = [
      tokenPoint(1, T0, 20_000, null),
      tokenPoint(2, T0 + 60_000, 202_000),
    ];
    const room = {
      window: {
        tokens: 1_000_000,
        source: "model-list" as const,
        reportedAt: null,
      },
      autoCompact: { tokens: 967_000, source: "model-default" as const },
      toLimit: 798_000,
      toAutoCompact: 765_000,
      turnsLeft: null,
    };
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            main,
            base: main[0] ?? null,
            drops: [],
            rebuilds: [],
            room,
          }),
        ),
      ),
    );
    await renderLens();
    expect(container.querySelector(".tokens-limit-line")).toBeNull();
    expect(container.querySelector(".tokens-autocompact-line")).toBeNull();
    expect(texts(".tokens-above-note")).toEqual([
      "Above the chart: auto-compact at 967K, the limit at 1M",
    ]);
  });

  it("keys the legend's warning diamond only to an unexpected rebuild", async () => {
    const expectedOnly = (history().rebuilds ?? []).filter(
      (rebuild) => rebuild.cause?.kind === "compaction",
    );
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rebuilds: expectedOnly }))),
    );
    await renderLens();
    const legend = texts(".tokens-legend span").map((text) => text.trim());
    expect(legend.some((text) => text === "cache rebuilt")).toBe(false);
    expect(
      legend.some((text) => text.startsWith("rebuilt after compaction")),
    ).toBe(true);
  });

  it("never prints one time twice on the time strip", async () => {
    const main = [
      tokenPoint(1, T0, 20_000, null),
      tokenPoint(2, T0 + 20_000, 30_000),
      tokenPoint(3, T0 + 40_000, 40_000),
    ];
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({ main, base: main[0] ?? null, drops: [], rebuilds: [] }),
        ),
      ),
    );
    await renderLens();
    const times = texts(".tokens-curve-labels span").filter((text) =>
      /^\d{1,2}:\d{2} [AP]M$/.test(text),
    );
    expect(times).toEqual([formatClock(T0), formatClock(T0 + 40_000)]);
    expect(new Set(times).size).toBe(times.length);
  });

  it("answers the arrow keys with the step the point stands for", async () => {
    await renderLens([stepRow({})]);
    const svg = container.querySelector("svg.tokens-curve-svg");
    expect(svg).not.toBeNull();
    // No point chosen yet: the slider reports no value.
    expect(svg?.getAttribute("aria-valuenow")).toBeNull();
    const press = (key: string): void => pressKey(svg, key);
    press("ArrowRight");
    press("ArrowRight");
    expect(useSessionStore.getState().selectedStepId).toBe(5);
    expect(svg?.getAttribute("aria-valuenow")).toBe("2");
    expect(svg?.getAttribute("aria-valuetext")).toContain("60.0K tokens");
    press("ArrowRight");
    expect(svg?.getAttribute("aria-valuetext")).toContain(
      "Cache rebuilt: the cache expired after 10 minutes",
    );
    expect(container.querySelector(".tokens-tooltip")?.textContent).toContain(
      "Cache rebuilt: the cache expired after 10 minutes",
    );
    press("ArrowRight");
    press("ArrowRight");
    expect(svg?.getAttribute("aria-valuetext")).toContain(
      "Cache rebuilt after compaction (expected)",
    );
    expect(svg?.getAttribute("aria-valuetext")).toContain("idle 9 min");
  });

  it("chooses the rise when the arrows land on its end point", async () => {
    const rise: Rise = {
      id: "rise-k",
      fromRequestId: 2,
      toRequestId: 3,
      at: T0 + 120_000,
      delta: 30_000,
      link: "exact",
      items: [{ kind: "other", tokens: 30_000, estimated: true }],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    const svg = container.querySelector("svg.tokens-curve-svg");
    pressKey(svg, "ArrowRight");
    pressKey(svg, "ArrowRight");
    pressKey(svg, "ArrowRight");
    const row = container.querySelector(".tokens-rise");
    expect(row?.classList.contains("tokens-rise-selected")).toBe(true);
    expect(container.querySelectorAll(".tokens-rise-point")).toHaveLength(2);
  });

  it("scrolls to a curve-chosen rise once, not again on a refresh", async () => {
    const chosen: Rise = {
      id: "rise-chosen",
      fromRequestId: 99,
      toRequestId: 3,
      at: T0 + 120_000,
      delta: 30_000,
      link: "exact",
      items: [{ kind: "other", tokens: 30_000, estimated: true }],
    };
    const filler = (index: number): Rise => ({
      id: `rise-f${index}`,
      fromRequestId: 99,
      toRequestId: 98,
      at: T0,
      delta: 12_000 - index * 1_000,
      link: "none",
      items: [{ kind: "other", tokens: 1_000, estimated: true }],
    });
    const rises = [
      chosen,
      ...Array.from({ length: 11 }, (_, index) => filler(index)),
    ];
    setResponder(() => Promise.resolve(jsonResponse(200, history({ rises }))));
    await renderLens();
    const svg = container.querySelector("svg.tokens-curve-svg");
    pressKey(svg, "ArrowRight");
    pressKey(svg, "ArrowRight");
    pressKey(svg, "ArrowRight");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // The session grows: a new history lands under the
    // same click and the same selection.
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ rises: [...rises, filler(11)] })),
      ),
    );
    await refetchLens();
    expect(texts(".tokens-rises-count")).toEqual(["13 rises over 2K tokens"]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("the room", () => {
  it("reads the measured room and tags its one estimate", async () => {
    await renderLens();
    expect(texts(".tokens-room-big")).toEqual(["153K"]);
    expect(texts(".tokens-room-label")).toEqual([
      "tokens to auto-compact (193K, model default)",
      "tokens to the limit (200K)",
    ]);
    expect(texts(".tokens-room-mid")).toEqual(["160K"]);
    expect(texts(".tokens-room-caption")).toEqual([
      "base 20K · since then 20K · to auto-compact 153K",
    ]);
    expect(container.textContent).toContain("about 7 turns at this pace");
    expect(texts(".tokens-est")).toEqual(["estimate"]);
  });

  it("says one turn in the singular", async () => {
    const room = {
      ...history().room,
      turnsLeft: { value: 1, estimated: true as const },
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(container.textContent).toContain("about 1 turn at this pace");
    expect(container.textContent).not.toContain("1 turns");
  });

  it("hides the estimate when no turns are left", async () => {
    const room = {
      ...history().room,
      turnsLeft: { value: 0, estimated: true as const },
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(container.textContent).not.toContain("at this pace");
    expect(container.querySelector(".tokens-est")).toBeNull();
  });

  it("says past the point when the session is past it", async () => {
    const room = { ...history().room, toAutoCompact: -7_000 };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(texts(".tokens-room-big")).toEqual(["7K"]);
    expect(texts(".tokens-room-label")).toEqual([
      "tokens past auto-compact (193K, model default)",
      "tokens to the limit (200K)",
    ]);
    expect(texts(".tokens-room-caption")).toEqual([
      "base 20K · since then 20K · past auto-compact by 7K",
    ]);
  });

  it("hides the estimate when the pace is unknown", async () => {
    const room = { ...history().room, turnsLeft: null };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(container.textContent).not.toContain("turns at this pace");
    expect(container.querySelector(".tokens-est")).toBeNull();
  });

  it("says the auto-compact point isn't known when it isn't", async () => {
    const room = {
      ...history().room,
      autoCompact: null,
      toAutoCompact: null,
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(container.textContent).toContain(
      "auto-compact point for this model isn",
    );
    expect(container.textContent).toContain("/context");
    expect(container.querySelector(".tokens-bar")).toBeNull();
    expect(texts(".tokens-room-mid")).toEqual(["160K"]);
  });

  it("names a setting as the reader's own", async () => {
    const room = {
      ...history().room,
      autoCompact: { tokens: 193_000, source: "setting" as const },
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ room }))));
    await renderLens();
    expect(texts(".tokens-room-label")).toEqual([
      "tokens to auto-compact (193K, your setting)",
      "tokens to the limit (200K)",
    ]);
  });
});

describe("the plain statements", () => {
  it("speaks of missing telemetry only without it", async () => {
    const states = {
      telemetry: false,
      tokensPartial: false,
      joinedPartway: false,
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ states }))));
    await renderLens();
    expect(container.textContent).toContain("Recorded without telemetry");
    expect(container.textContent).toContain(
      "totals cover your own requests only",
    );
  });

  it("keeps the telemetry statement back when telemetry is on", async () => {
    await renderLens();
    expect(container.textContent).not.toContain("Recorded without telemetry");
  });

  it("speaks of an unread transcript only when part is missing", async () => {
    const states = {
      telemetry: true,
      tokensPartial: true,
      joinedPartway: false,
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ states }))));
    await renderLens();
    expect(container.textContent).toContain(
      "some requests are missing from these figures",
    );
  });

  it("speaks of joining partway only when recording did", async () => {
    const states = {
      telemetry: true,
      tokensPartial: false,
      joinedPartway: true,
    };
    setResponder(() => Promise.resolve(jsonResponse(200, history({ states }))));
    await renderLens();
    expect(container.textContent).toContain(
      "started recording partway through this session",
    );
  });

  it("says nothing extra when no flag holds", async () => {
    await renderLens();
    expect(container.querySelectorAll(".tokens-note")).toHaveLength(0);
  });
});

describe("the load states", () => {
  it("shows the loading words while the history is on its way", async () => {
    setResponder(() => new Promise<Response>(() => undefined));
    await renderLens();
    expect(container.textContent).toContain("Loading token history…");
  });

  it("offers a retry when the history can't be loaded, and it works", async () => {
    setResponder(() => Promise.resolve(jsonResponse(500, {})));
    await renderLens();
    expect(container.textContent).toContain("Token history couldn");
    const button = [...container.querySelectorAll("button")].find(
      (el) => el.textContent === "Retry",
    );
    expect(button).toBeDefined();
    setResponder(() => Promise.resolve(jsonResponse(200, history())));
    act(() => button?.click());
    await settle();
    expect(container.textContent).toContain("Context over time");
  });

  it("treats a session the daemon doesn't know as a failed load", async () => {
    setResponder(() => Promise.resolve(jsonResponse(404, {})));
    await renderLens();
    expect(container.textContent).toContain("Token history couldn");
  });

  it("says no requests yet when the session has none", async () => {
    const empty = history({ main: [], base: null, drops: [], rebuilds: [] });
    setResponder(() => Promise.resolve(jsonResponse(200, empty)));
    await renderLens();
    expect(container.textContent).toContain(
      "No requests recorded yet for this session.",
    );
  });
});
