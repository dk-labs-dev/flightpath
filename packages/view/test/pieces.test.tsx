// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { FirstRunHint } from "../src/components/FirstRunHint.js";
import { SessionsScreen } from "../src/components/SessionsScreen.js";
import { useClockStore } from "../src/session/clock.js";
import { StepDetailPanel } from "../src/session/detail.js";
import { CONTEXT_EXPLANATION, Explain } from "../src/session/explain.js";
import { useSessionStore } from "../src/session/store.js";
import { SessionSummary } from "../src/session/summary.js";
import {
  QUIET_AFTER_MS,
  sessionStateLabel,
  type SessionStateSource,
} from "../src/sessions/model.js";
import { fixtureSnapshot } from "./fixtures.js";

// jsdom has no matchMedia; the detail panel asks it which
// layout the stylesheet would pick. A desktop answer.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useSessionStore.getState().begin("s1", "token");
  useSessionStore.getState().snapshot(fixtureSnapshot());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the summary", () => {
  it("shows the session's title, counts and curve", () => {
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    expect(container.querySelector("h1")?.textContent).toBe("tip-calc at proj");
    expect(container.textContent).toContain("6 steps");
    expect(container.textContent).toContain("2 turns");
    expect(container.textContent).toContain("1 subagent");
    expect(container.textContent).toContain("2 times you stepped in");
    const curve = container.querySelector('[role="slider"]');
    expect(curve?.getAttribute("aria-label")).toContain(
      "Context size per request",
    );
    expect(curve?.getAttribute("aria-valuemax")).toBe("6");
    expect(curve?.getAttribute("aria-valuetext")).toBe("No step selected");
  });

  it("reads one turn and one step in the singular", () => {
    const fixture = fixtureSnapshot();
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: {
          ...fixture.summary,
          counts: { ...fixture.summary.counts, turns: 1, steps: 1 },
        },
      });
    });
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const counts = [
      ...container.querySelectorAll(".summary-counts > span"),
    ].map((count) => count.textContent);
    expect(counts).toContain("1 turn");
    expect(counts).toContain("1 step");
  });

  it("reads none in the plural, and one time you stepped in in the singular", () => {
    const fixture = fixtureSnapshot();
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: {
          ...fixture.summary,
          counts: { ...fixture.summary.counts, turns: 0, steps: 0 },
          steppedIn: 1,
        },
      });
    });
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const counts = [
      ...container.querySelectorAll(".summary-counts > span"),
    ].map((count) => count.textContent);
    expect(counts).toContain("0 turns");
    expect(counts).toContain("0 steps");
    expect(counts).toContain("1 time you stepped in");
  });

  it("says the session ended and its exit was seen", () => {
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const status = container.querySelector(".session-badge")?.textContent;
    expect(status).toContain("Ended");
    expect(status).not.toContain("no exit seen");
  });

  it("says Live while the session is still being heard from", () => {
    const fixture = fixtureSnapshot();
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: { ...fixture.summary, status: "live", endedAt: null },
      });
      useClockStore.getState().setNow(9000 + 60_000);
    });
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const status = container.querySelector(".session-badge")?.textContent;
    expect(status).toBe("Live");
  });

  it("says when a live session went quiet, from the clock", () => {
    const fixture = fixtureSnapshot();
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: { ...fixture.summary, status: "live", endedAt: null },
      });
      useClockStore.getState().setNow(9000 + QUIET_AFTER_MS);
    });
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const status = container.querySelector(".session-badge")?.textContent;
    expect(status).toBe(`Live · quiet since ${formatClock(9000)}`);
  });

  it("says plainly when the end was concluded, not seen", () => {
    const fixture = fixtureSnapshot();
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: { ...fixture.summary, endSeen: false },
      });
    });
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    const status = container.querySelector(".session-badge")?.textContent;
    expect(status).toContain("· no exit seen");
    expect(status).not.toContain("(no exit seen)");
  });

  it("names the selected step's context under the curve", () => {
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    act(() => {
      useSessionStore.getState().selectStep(104);
    });
    expect(container.textContent).toContain("selected step:");
    expect(container.textContent).toContain("in context");
  });
});

describe("the badge and the picker card", () => {
  interface StateFacts {
    status: string;
    lastActivityAt: number;
    endedAt: number | null;
    endSeen: boolean;
    nowMs: number;
  }

  // One fixture per state, shaped for both readers: the
  // summary reads its snapshot, the card reads a list item.
  // The snapshot's steps are all ended, so neither reader
  // sees a step running.
  function renderBoth(facts: StateFacts): {
    badge: Element | null;
    cardState: string | null;
    source: SessionStateSource;
  } {
    const fixture = fixtureSnapshot();
    const source: SessionStateSource = {
      status: facts.status,
      hasOpenStep: false,
      lastActivityAt: facts.lastActivityAt,
      endedAt: facts.endedAt,
      endSeen: facts.endSeen,
    };
    const item: SessionListItem = {
      id: "s1",
      title: fixture.summary.title,
      project: null,
      startedAt: fixture.summary.startedAt,
      turns: 0,
      steps: 0,
      tokensProcessed: 0,
      contextNow: null,
      sources: [],
      note: "",
      ...source,
    };
    act(() => {
      useSessionStore.getState().snapshot({
        ...fixture,
        summary: {
          ...fixture.summary,
          status: facts.status,
          lastActivityAt: facts.lastActivityAt,
          endedAt: facts.endedAt,
          endSeen: facts.endSeen,
        },
      });
      useClockStore.getState().setNow(facts.nowMs);
    });
    act(() => {
      root.render(
        <>
          <SessionSummary onCurveSelect={() => undefined} />
          <SessionsScreen
            sessions={[item]}
            failed={false}
            emptyHidden={0}
            retentionDays={null}
          />
        </>,
      );
    });
    const meta = container.querySelector(".live-meta")?.textContent ?? null;
    return {
      badge: container.querySelector(".session-badge"),
      cardState: meta === null ? null : meta.replace(/ · no turns yet$/, ""),
      source,
    };
  }

  // Times ride on the real clock: mounting the picker starts
  // its tick, which sets the shared clock to now.
  it("words a live session the same on the badge and the card", () => {
    const at = Date.now();
    const { badge, cardState } = renderBoth({
      status: "live",
      lastActivityAt: at,
      endedAt: null,
      endSeen: true,
      nowMs: at,
    });
    expect(badge?.textContent).toBe("Live");
    expect(badge?.className).toContain("session-badge-live");
    expect(badge?.querySelector(".session-badge-dot")).not.toBeNull();
    expect(cardState).toBe(badge?.textContent);
  });

  it("words a quiet session the same on the badge and the card", () => {
    const at = Date.now();
    const quietAt = at - QUIET_AFTER_MS - 60_000;
    const { badge, cardState } = renderBoth({
      status: "live",
      lastActivityAt: quietAt,
      endedAt: null,
      endSeen: true,
      nowMs: at,
    });
    expect(badge?.textContent).toBe(
      `Live · quiet since ${formatClock(quietAt)}`,
    );
    expect(badge?.className).toContain("session-badge-quiet");
    expect(cardState).toBe(badge?.textContent);
  });

  // The card renders live sessions only, so the remaining
  // states are pinned badge against the one label function.
  it("words the ended and paused states from the one function", () => {
    const at = Date.now();
    const ended = renderBoth({
      status: "ended",
      lastActivityAt: at - 60_000,
      endedAt: at - 60_000,
      endSeen: true,
      nowMs: at,
    });
    expect(ended.badge?.textContent).toBe(
      sessionStateLabel(ended.source, at).text,
    );
    expect(ended.badge?.className).toContain("session-badge-ended");
    expect(ended.badge?.querySelector(".session-badge-dot")).toBeNull();
    const unseen = renderBoth({
      status: "ended",
      lastActivityAt: at - 60_000,
      endedAt: at - 60_000,
      endSeen: false,
      nowMs: at,
    });
    expect(unseen.badge?.textContent).toBe(
      `Ended ${formatClock(at - 60_000)} · no exit seen`,
    );
    const paused = renderBoth({
      status: "paused",
      lastActivityAt: at,
      endedAt: null,
      endSeen: true,
      nowMs: at,
    });
    expect(paused.badge?.textContent).toBe("Paused");
    expect(paused.badge?.className).toContain("session-badge-ended");
  });
});

describe("the explanations", () => {
  it("opens on request and says what context means", () => {
    act(() => {
      root.render(<Explain term="context" text={CONTEXT_EXPLANATION} />);
    });
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(
      "Everything Claude is holding in mind for the next request",
    );
  });
});

describe("the first-run hint", () => {
  it("says what a row is and how to read it, true live or ended", () => {
    act(() => {
      root.render(<FirstRunHint visible={true} onDismiss={() => undefined} />);
    });
    expect(container.querySelector(".hint p")?.textContent).toBe(
      "Each row is one thing Claude did. Click a row for its details.",
    );
  });
});

describe("the detail panel", () => {
  it("shows the step's facts and its request's table", () => {
    act(() => {
      useSessionStore.setState({
        detail: {
          stepId: 101,
          status: "ready",
          data: {
            id: 101,
            sessionId: "s1",
            toolName: "Bash",
            outcome: "succeeded",
            sentence: "Ran npm test",
            savedOutputStepId: null,
            facts: [
              { label: "Command", value: "npm test" },
              { label: "Outcome", value: "Succeeded" },
            ],
            requests: [
              {
                id: 7,
                model: "claude-sonnet-4-5",
                startedAt: 1050,
                durationMs: 900,
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                facts: [{ label: "Source", value: "hook" }],
              },
            ],
          },
        },
      });
    });
    act(() => {
      root.render(<StepDetailPanel />);
    });
    expect(container.textContent).toContain("Ran npm test");
    expect(container.textContent).toContain("npm test");
    expect(container.textContent).toContain("Request");
    expect(container.textContent).toContain("claude-sonnet-4-5");
    expect(container.textContent).toContain(
      "File contents and tool output stay in Claude Code",
    );
  });

  it("shows a request once: its table, and no fact the table already gives", () => {
    act(() => {
      useSessionStore.setState({
        detail: {
          stepId: 102,
          status: "ready",
          data: {
            id: 102,
            sessionId: "s1",
            toolName: "Bash",
            outcome: "succeeded",
            sentence: "Ran npm test",
            savedOutputStepId: null,
            facts: [{ label: "Command", value: "npm test" }],
            requests: [
              {
                id: 8,
                model: "claude-sonnet-4-5",
                startedAt: 1050,
                durationMs: 900,
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                facts: [{ label: "Part of", value: "the main conversation" }],
              },
            ],
          },
        },
      });
    });
    act(() => {
      root.render(<StepDetailPanel />);
    });
    const requestGroup = [...container.querySelectorAll(".detail-group")].find(
      (group) => group.querySelector("h3")?.textContent === "Request",
    );
    const terms = [
      ...(requestGroup?.querySelectorAll(".fact-list dt") ?? []),
    ].map((term) => term.textContent);
    expect(terms).toEqual(["Part of"]);
    expect(container.textContent).not.toContain("Tokens in");
    const heads = [
      ...(requestGroup?.querySelectorAll(".request-table th") ?? []),
    ].map((head) => head.textContent);
    expect(heads).toContain("In");
  });

  describe("a Read of a saved tool output", () => {
    function showStep(savedOutputStepId: number | null): void {
      act(() => {
        useSessionStore.setState({
          detail: {
            stepId: 103,
            status: "ready",
            data: {
              id: 103,
              sessionId: "s1",
              toolName: "Read",
              outcome: "succeeded",
              sentence: 'Read the saved output of the step "Ran `npm test`"',
              savedOutputStepId,
              facts: [],
              requests: [],
            },
          },
        });
      });
      act(() => {
        root.render(<StepDetailPanel />);
      });
    }

    it("links to the step that printed it", () => {
      showStep(101);
      const link = container.querySelector<HTMLButtonElement>(".detail-link");
      expect(link?.textContent).toBe("Open the step that printed it");
      vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
      try {
        act(() => link?.click());
        expect(useSessionStore.getState().detail?.stepId).toBe(101);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("offers no link when that step is not recorded", () => {
      showStep(null);
      expect(container.querySelector(".detail-link")).toBeNull();
    });
  });

  it("says plainly when nothing is selected", () => {
    act(() => {
      root.render(<StepDetailPanel />);
    });
    expect(container.textContent).toContain("Pick a step to read what it did.");
  });
});

describe("accessibility of the populated pieces", () => {
  it("has no serious or critical axe violations", async () => {
    act(() => {
      root.render(
        <>
          <SessionSummary onCurveSelect={() => undefined} />
          <StepDetailPanel />
        </>,
      );
    });
    const results = await axe.run(container);
    const blocking = results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking).toEqual([]);
  });
});

describe("the header's branch counts", () => {
  function headerText(kinds: (string | null)[]): string {
    const snapshot = fixtureSnapshot();
    snapshot.branches = kinds.map((kind, index) => ({
      id: 100 + index,
      agentId: null,
      agentType: null,
      kind,
      spawningStepId: null,
      startedAt: 5200,
      endedAt: 6900,
      totalTokens: 900,
      steps: 1,
      requests: 1,
      sentence: "A branch",
    }));
    useSessionStore.getState().snapshot(snapshot);
    act(() => {
      root.render(<SessionSummary onCurveSelect={() => undefined} />);
    });
    return container.textContent ?? "";
  }

  it("counts no subagents and names no Claude Code helpers at zero", () => {
    const text = headerText([]);
    expect(text).toContain("0 subagents");
    expect(text).not.toContain("Claude Code helper");
  });

  it("uses the singular for one of each", () => {
    const text = headerText(["user", "internal"]);
    expect(text).toContain("1 subagent");
    expect(text).not.toContain("1 subagents");
    expect(text).toContain("1 Claude Code helper");
    expect(text).not.toContain("1 Claude Code helpers");
  });

  it("uses the plural for two of each, and counts a kindless branch as a helper", () => {
    const text = headerText(["user", "user", "internal", null]);
    expect(text).toContain("2 subagents");
    expect(text).toContain("2 Claude Code helpers");
  });
});
