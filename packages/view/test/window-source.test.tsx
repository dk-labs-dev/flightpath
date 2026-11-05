// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ContextWindow,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { ContextCurve } from "../src/session/curve.js";
import { useSessionStore } from "../src/session/store.js";
import { SessionSummary } from "../src/session/summary.js";
import { fixtureSnapshot, jsonResponse } from "./fixtures.js";
import {
  container,
  history,
  renderLens,
  setResponder,
  setupTokensLensTests,
  settle,
  T0,
} from "./support/tokens-lens-harness.js";

// The window's source on screen: the room panel's line and
// the summary's segment, source by source; the hint beside
// every window but a report's; and the Steps strip scaling
// to the session, its limit named when it stands above.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

setupTokensLensTests(() => Promise.resolve(jsonResponse(200, history())));

type Room = TokenHistory["room"];

/** A room whose window is the one under test: the auto-compact
 * point stands as the harness's does, and the room to the
 * limit is measured from the harness's 95K peak. */
function roomWith(window: ContextWindow): Room {
  return {
    window,
    autoCompact:
      window.tokens === null
        ? null
        : { tokens: 193_000, source: "model-default" },
    toLimit: window.tokens === null ? null : window.tokens - 95_000,
    toAutoCompact: window.tokens === null ? null : 153_000,
    turnsLeft: { value: 7, estimated: true },
  };
}

async function renderRoom(window: ContextWindow): Promise<void> {
  setResponder(() =>
    Promise.resolve(jsonResponse(200, history({ room: roomWith(window) }))),
  );
  await renderLens();
}

function sourceLine(): string {
  return container.querySelector(".tokens-room-source")?.textContent ?? "";
}

function windowHint(): HTMLButtonElement | null {
  return container.querySelector(
    'button[aria-label="What is the window size?"]',
  );
}

describe("the room panel's source line", () => {
  it("names the model list, with the hint", async () => {
    await renderRoom({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(sourceLine()).toContain("200K window · from Claude’s model list");
    expect(windowHint()).not.toBeNull();
  });

  it("names the report and its time, with no hint", async () => {
    const at = T0 + 13 * 60_000;
    await renderRoom({
      tokens: 1_000_000,
      source: "context-command",
      reportedAt: at,
    });
    expect(sourceLine()).toContain(
      `1M window · from your /context at ${formatClock(at)}`,
    );
    expect(windowHint()).toBeNull();
  });

  it("names a measured window as a floor, with the hint", async () => {
    await renderRoom({
      tokens: 1_000_000,
      source: "inferred",
      reportedAt: null,
    });
    expect(sourceLine()).toContain(
      "At least 1M window · this session went past 200K",
    );
    expect(windowHint()).not.toBeNull();
  });

  it("names the model an unknown window isn't known for, and hides the room bar and the limit", async () => {
    await renderRoom({ tokens: null, source: "unknown", reportedAt: null });
    const summary = fixtureSnapshot().summary;
    summary.model = "claude-new-model";
    act(() => {
      useSessionStore.setState({ sessionSummary: summary });
    });
    await settle();
    expect(sourceLine()).toContain("Window not known for claude-new-model");
    expect(container.querySelector(".tokens-bar")).toBeNull();
    expect(container.textContent).not.toContain("tokens to the limit");
    expect(windowHint()).not.toBeNull();
  });

  it("gives the hint's text word for word", async () => {
    await renderRoom({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(windowHint()?.getAttribute("aria-label")).toBe(
      "What is the window size?",
    );
    act(() => {
      windowHint()?.click();
    });
    const note = container.querySelector(".tokens-room-source .explain-note");
    expect(note?.textContent).toBe(
      "If this looks wrong, run /context once in Claude Code, and Flightpath reads the exact size from it. Its report goes into the conversation (about 9K tokens), so once is enough.",
    );
  });
});

describe("the tokens curve with an unknown window", () => {
  it("draws no limit line and names no limit", async () => {
    await renderRoom({ tokens: null, source: "unknown", reportedAt: null });
    expect(container.querySelector(".tokens-limit-line")).toBeNull();
    expect(container.textContent).not.toContain("limit ·");
    expect(container.textContent).not.toContain("the limit at");
  });
});

let box: HTMLDivElement;
let boxRoot: Root;

beforeEach(() => {
  box = document.createElement("div");
  document.body.append(box);
  boxRoot = createRoot(box);
});

afterEach(() => {
  act(() => boxRoot.unmount());
  box.remove();
});

/** The store as a session screen holds it, with the
 * snapshot's window and model the ones under test. */
function seedSummary(window: ContextWindow): void {
  const snapshot = fixtureSnapshot();
  snapshot.summary.window = window;
  const state = useSessionStore.getState();
  state.begin("s1", "token");
  state.snapshot(snapshot);
}

function summaryContext(): string {
  return box.querySelector(".summary-context")?.textContent ?? "";
}

describe("the summary line's window source", () => {
  it("ends with the model list and the hint", () => {
    seedSummary({ tokens: 200_000, source: "model-list", reportedAt: null });
    act(() => {
      boxRoot.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    expect(summaryContext()).toContain("context 20K of 200K tokens");
    expect(summaryContext()).toContain("· from Claude’s model list");
    expect(
      box.querySelector('button[aria-label="What is the window size?"]'),
    ).not.toBeNull();
  });

  it("ends with the report and its time, with no hint", () => {
    const at = T0 + 13 * 60_000;
    seedSummary({
      tokens: 200_000,
      source: "context-command",
      reportedAt: at,
    });
    act(() => {
      boxRoot.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    expect(summaryContext()).toContain(
      `· from your /context at ${formatClock(at)}`,
    );
    expect(
      box.querySelector('button[aria-label="What is the window size?"]'),
    ).toBeNull();
  });

  it("ends with a measured window as at least its size, with the hint", () => {
    seedSummary({ tokens: 1_000_000, source: "inferred", reportedAt: null });
    act(() => {
      boxRoot.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    expect(summaryContext()).toContain("of 1M tokens");
    expect(summaryContext()).toContain("· at least 1M, inferred");
    expect(
      box.querySelector('button[aria-label="What is the window size?"]'),
    ).not.toBeNull();
  });

  it("drops the of … and says the window isn't known", () => {
    seedSummary({ tokens: null, source: "unknown", reportedAt: null });
    act(() => {
      boxRoot.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    expect(summaryContext()).not.toContain(" of ");
    expect(summaryContext()).toContain("· window not known");
    expect(
      box.querySelector('button[aria-label="What is the window size?"]'),
    ).not.toBeNull();
  });
});

describe("the Steps strip", () => {
  function renderStrip(limit: number | null, peak: number): void {
    act(() => {
      boxRoot.render(
        <ContextCurve
          limit={limit}
          samples={[
            { at: 1000, contextTokens: 20_000 },
            { at: 2000, contextTokens: peak },
          ]}
          steps={new Map()}
          humans={new Map()}
          events={[]}
          live={false}
          selectedStep={null}
          onSelectStep={() => undefined}
        />,
      );
    });
  }

  it("fills the strip with an 82K session on a 1M window, and names the limit above it", () => {
    renderStrip(1_000_000, 82_000);
    expect(box.querySelector(".curve-limit")).toBeNull();
    expect(box.querySelector(".curve-caption")?.textContent).toContain(
      "the limit, 1M, is above the strip",
    );
    const points = box
      .querySelector("polyline.curve-line")
      ?.getAttribute("points");
    const heights = (points ?? "")
      .split(" ")
      .map((point) => Number(point.split(",")[1]));
    // The peak stands near the top of the 60-unit strip,
    // not along its bottom at 8% of a 1M scale.
    expect(Math.min(...heights)).toBeLessThan(15);
  });

  it("draws the dashed limit line when the limit fits the scale", () => {
    renderStrip(200_000, 150_000);
    expect(box.querySelector(".curve-limit")).not.toBeNull();
    expect(box.querySelector(".curve-caption")?.textContent).toContain(
      "dashed line: the context limit",
    );
  });

  it("names no limit when the window isn't known", () => {
    renderStrip(null, 82_000);
    expect(box.querySelector(".curve-limit")).toBeNull();
    const caption = box.querySelector(".curve-caption")?.textContent ?? "";
    expect(caption).not.toContain("dashed line");
    expect(caption).not.toContain("above the strip");
  });
});
