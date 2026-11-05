// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type {
  BackgroundWork,
  BranchSeries,
  BranchStart,
} from "@flightpath/flightpath/api/payloads";

import { xFor } from "../src/session/curve-math.js";
import { useSessionStore } from "../src/session/store.js";
import {
  mainScale,
  TOKENS_CURVE_WIDTH,
} from "../src/session/tokens-curve-math.js";
import { jsonResponse, tokenPoint } from "./fixtures.js";
import {
  container,
  history,
  renderLens,
  setResponder,
  settle,
  setupTokensLensTests,
  T0,
} from "./support/tokens-lens-harness.js";

// The tokens lens's subagent lanes against a hand-built
// history: one lane per user subagent in start order, drawn
// on the main curve's own scale, the returned amount as an
// estimate or as not recorded, and the helper
// line counted apart. The lens, its hand-built history and
// the fetch stand-in come from the shared harness; this
// file keeps the branch and background fixtures and the
// lane reads.

function branch(overrides: Partial<BranchSeries> = {}): BranchSeries {
  return {
    branchId: 1,
    agentType: "Explore",
    parentAgentType: null,
    spawningStepId: 41,
    points: [
      tokenPoint(101, T0 + 30_000, 8_000, null),
      tokenPoint(102, T0 + 50_000, 47_000, null),
    ],
    tokensProcessed: 55_000,
    returnedChars: null,
    startedWith: null,
    ...overrides,
  };
}

function background(overrides: Partial<BackgroundWork> = {}): BackgroundWork {
  return {
    branchId: 11,
    agentType: null,
    tokensProcessed: 3_100,
    ...overrides,
  };
}

function lanes(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".tokens-lane")];
}

function firstX(line: Element | undefined): number {
  const pair = (line?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)[0]
    ?.split(",");
  return Number(pair?.[0]);
}

function lineXs(line: Element | null): number[] {
  return (line?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => Number(pair.split(",")[0]));
}

setupTokensLensTests(() => Promise.resolve(jsonResponse(200, history())));

describe("the lanes", () => {
  it("names the subagent a nested subagent was launched from", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            branches: [branch({ parentAgentType: "planner" })],
          }),
        ),
      ),
    );
    await renderLens();
    const drawn = lanes();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.textContent).toContain("Explore (from planner)");
  });

  it("draws one lane per user subagent, in start order, on the main time axis", async () => {
    const later = branch({
      branchId: 2,
      agentType: "general-purpose",
      spawningStepId: 42,
      points: [
        tokenPoint(201, T0 + 90_000, 4_000, null),
        tokenPoint(202, T0 + 110_000, 9_700, null),
      ],
      tokensProcessed: 9_700,
    });
    const earlier = branch();
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ branches: [later, earlier] })),
      ),
    );
    await renderLens();
    const drawn = lanes();
    expect(drawn).toHaveLength(2);
    // The payload lists the later branch first; the lanes
    // stand in the order the subagents started.
    expect(drawn[0]?.textContent).toContain("Explore");
    expect(drawn[1]?.textContent).toContain("general-purpose");
    expect(drawn[0]?.textContent).toContain("used 55K");
    expect(drawn[1]?.textContent).toContain("used 9.7K");
    // Each lane's points spread over the least width,
    // centred on the moment the subagent started: these
    // twenty-second runs span less than that on the axis,
    // so the first point stands half the least width
    // before the start's own place on the main scale.
    const scale = mainScale(
      history().main,
      history().room,
      TOKENS_CURVE_WIDTH,
    ).scale;
    const lines = container.querySelectorAll(".tokens-lane-line");
    expect(firstX(lines[0])).toBeCloseTo(xFor(scale, T0 + 30_000) - 12, 1);
    expect(firstX(lines[1])).toBeCloseTo(xFor(scale, T0 + 90_000) - 12, 1);
  });

  it("draws a thirty-second lane at the least width on an hour-long axis, centred on its start", async () => {
    const hour = history({
      main: [
        tokenPoint(1, T0, 20_000, null),
        tokenPoint(2, T0 + 3_600_000, 60_000, null),
      ],
      branches: [
        branch({
          points: [
            tokenPoint(101, T0 + 600_000, 8_000, null),
            tokenPoint(102, T0 + 630_000, 12_000, null),
          ],
        }),
      ],
      drops: [],
      rebuilds: [],
      rises: [],
    });
    setResponder(() => Promise.resolve(jsonResponse(200, hour)));
    await renderLens();
    const xs = lineXs(container.querySelector(".tokens-lane-line"));
    const first = xs[0] ?? Number.NaN;
    const last = xs[xs.length - 1] ?? Number.NaN;
    expect(last - first).toBeCloseTo(24, 0);
    const scale = mainScale(hour.main, hour.room, TOKENS_CURVE_WIDTH).scale;
    expect((first + last) / 2).toBeCloseTo(xFor(scale, T0 + 600_000), 0);
  });

  it("spreads a lane whose points share one moment over the least width", async () => {
    const hour = history({
      main: [
        tokenPoint(1, T0, 20_000, null),
        tokenPoint(2, T0 + 3_600_000, 60_000, null),
      ],
      branches: [
        branch({
          points: [
            tokenPoint(101, T0 + 600_000, 8_000, null),
            tokenPoint(102, T0 + 600_000, 10_000, null),
            tokenPoint(103, T0 + 600_000, 12_000, null),
          ],
        }),
      ],
      drops: [],
      rebuilds: [],
      rises: [],
    });
    setResponder(() => Promise.resolve(jsonResponse(200, hour)));
    await renderLens();
    const xs = lineXs(container.querySelector(".tokens-lane-line"));
    const scale = mainScale(hour.main, hour.room, TOKENS_CURVE_WIDTH).scale;
    const centre = xFor(scale, T0 + 600_000);
    // Three requests at one moment would all draw at one
    // x; they stand evenly across the least width instead,
    // centred on that moment.
    expect(xs).toHaveLength(3);
    expect(xs[0]).toBeCloseTo(centre - 12, 0);
    expect(xs[1]).toBeCloseTo(centre, 0);
    expect(xs[2]).toBeCloseTo(centre + 12, 0);
  });

  it("stands an empty branch last and breaks start ties by branch id", async () => {
    const moment = T0 + 60_000;
    const empty = branch({
      branchId: 1,
      agentType: "ran-nothing",
      spawningStepId: 51,
      points: [],
      tokensProcessed: 0,
    });
    const higherId = branch({
      branchId: 7,
      agentType: "same-moment-later-id",
      spawningStepId: 52,
      points: [tokenPoint(701, moment, 5_000, null)],
      tokensProcessed: 5_000,
    });
    const lowerId = branch({
      branchId: 3,
      agentType: "same-moment-earlier-id",
      spawningStepId: 53,
      points: [tokenPoint(301, moment, 6_000, null)],
      tokensProcessed: 6_000,
    });
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ branches: [empty, higherId, lowerId] })),
      ),
    );
    await renderLens();
    const drawn = lanes();
    expect(drawn).toHaveLength(3);
    // The two that started at the same moment stand by id;
    // the branch with no points stands last, though its id
    // is the smallest of the three.
    expect(drawn[0]?.textContent).toContain("same-moment-earlier-id");
    expect(drawn[1]?.textContent).toContain("same-moment-later-id");
    expect(drawn[2]?.textContent).toContain("ran-nothing");
  });

  it("falls back to the plain word when a branch names no type", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ branches: [branch({ agentType: null })] })),
      ),
    );
    await renderLens();
    expect(lanes()[0]?.textContent).toContain("subagent");
  });

  it("reads the returned amount as an estimate, tagged as one", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({ branches: [branch({ returnedChars: 73_600 })] }),
        ),
      ),
    );
    await renderLens();
    const lane = lanes()[0];
    expect(lane?.textContent).toContain("returned about 25.4K");
    expect(lane?.querySelector(".tokens-est")?.textContent).toBe("est.");
    expect(lane?.querySelector(".tokens-est")?.getAttribute("title")).toBe(
      "Worked out from the number of characters, at about 2.9 per token. Close, not exact.",
    );
  });

  it("says not recorded when the return wasn't", async () => {
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ branches: [branch()] }))),
    );
    await renderLens();
    const lane = lanes()[0];
    expect(lane?.textContent).toContain("returned: not recorded");
    expect(lane?.querySelector(".tokens-est")).toBeNull();
  });

  it("says on hover what the subagent started with", async () => {
    const startedWith = {
      tokens: 9_600,
      parts: ["task", "skills", "CLAUDE.md", "listings"],
    } satisfies BranchStart;
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ branches: [branch({ startedWith })] })),
      ),
    );
    await renderLens();
    expect(lanes()[0]?.getAttribute("title")).toBe(
      "started with about 9.6K: task, skills, CLAUDE.md, listings",
    );
  });

  it("names only the parts recorded, and nothing when none was", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            branches: [
              branch({ startedWith: { tokens: 650, parts: ["task"] } }),
              branch({ branchId: 2, spawningStepId: 42 }),
            ],
          }),
        ),
      ),
    );
    await renderLens();
    const [recorded, unrecorded] = lanes();
    expect(recorded?.getAttribute("title")).toBe(
      "started with about 650: task",
    );
    expect(unrecorded?.hasAttribute("title")).toBe(false);
  });

  it("selects the spawning step when its lane is clicked", async () => {
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ branches: [branch()] }))),
    );
    await renderLens();
    const lane = lanes()[0];
    expect(lane?.tagName).toBe("BUTTON");
    act(() => (lane as HTMLButtonElement).click());
    expect(useSessionStore.getState().selectedStepId).toBe(41);
  });

  it("leaves a lane without a spawning step unclickable", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({ branches: [branch({ spawningStepId: null })] }),
        ),
      ),
    );
    await renderLens();
    expect(lanes()[0]?.tagName).toBe("DIV");
  });

  it("marks a one-request branch with a dot, not a line", async () => {
    const single = branch({
      points: [tokenPoint(101, T0 + 30_000, 8_000, null)],
    });
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ branches: [single] }))),
    );
    await renderLens();
    expect(container.querySelector(".tokens-lane-dot")).not.toBeNull();
    expect(container.querySelector(".tokens-lane-line")).toBeNull();
  });

  it("shows six lanes, then the rest on request", async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      branch({
        branchId: index + 1,
        spawningStepId: 41 + index,
        points: [
          tokenPoint(100 + index, T0 + (index + 1) * 10_000, 5_000, null),
        ],
      }),
    );
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ branches: many }))),
    );
    await renderLens();
    expect(lanes()).toHaveLength(6);
    const ask = [...container.querySelectorAll("button")].find(
      (el) => el.textContent === "Show all 8",
    );
    expect(ask).toBeDefined();
    expect(ask?.getAttribute("aria-expanded")).toBe("false");
    ask?.focus();
    expect(document.activeElement).toBe(ask);
    act(() => ask?.click());
    await settle();
    expect(lanes()).toHaveLength(8);
    // The toggle stays on the page, so the press leaves the
    // keyboard's place on it, and it now offers the fold.
    expect(document.activeElement).toBe(ask);
    expect(ask?.textContent).toBe("Show the first 6");
    expect(ask?.getAttribute("aria-expanded")).toBe("true");
    act(() => ask?.click());
    await settle();
    expect(lanes()).toHaveLength(6);
    expect(document.activeElement).toBe(ask);
  });
});

describe("the background line", () => {
  it("counts unknown tokens and sums only the known", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            background: [
              background(),
              background({ branchId: 12, tokensProcessed: null }),
            ],
          }),
        ),
      ),
    );
    await renderLens();
    expect(container.querySelector(".tokens-background")?.textContent).toBe(
      "Claude Code helpers: 2 agents, 3.1K tokens (some not recorded)",
    );
  });

  it("never shows the total as zero when none was recorded", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(
          200,
          history({
            background: [
              background({ tokensProcessed: null }),
              background({ branchId: 12, tokensProcessed: null }),
            ],
          }),
        ),
      ),
    );
    await renderLens();
    expect(container.querySelector(".tokens-background")?.textContent).toBe(
      "Claude Code helpers: 2 agents (tokens not recorded)",
    );
  });

  it("speaks of one agent in the singular, without the aside", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ background: [background()] })),
      ),
    );
    await renderLens();
    expect(container.querySelector(".tokens-background")?.textContent).toBe(
      "Claude Code helpers: 1 agent, 3.1K tokens",
    );
  });

  it("stands without the heading when there are no lanes", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ background: [background()] })),
      ),
    );
    await renderLens();
    expect(lanes()).toHaveLength(0);
    expect(container.querySelector(".tokens-lanes-head")).toBeNull();
    expect(container.querySelector(".tokens-background")).not.toBeNull();
  });
});

describe("nothing to draw", () => {
  it("draws nothing when there are no subagents", async () => {
    await renderLens();
    expect(container.querySelector(".tokens-lanes")).toBeNull();
    expect(container.textContent).not.toContain("Subagents");
    expect(container.textContent).not.toContain("Claude Code helpers");
  });
});
