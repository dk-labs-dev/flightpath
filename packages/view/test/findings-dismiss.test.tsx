// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { StepDetailPanel } from "../src/session/detail.js";
import { FindingsList } from "../src/session/FindingsList.js";
import { findingsQueryKey } from "../src/session/api.js";
import { useSessionStore } from "../src/session/store.js";
import { finding } from "./support/findings.js";
import { harness } from "./support/findings-harness.js";

const trio = [
  finding({ id: "a", grade: "Worth fixing", requestId: 1 }),
  finding({ id: "b", grade: "Worth a look", requestId: 2 }),
  finding({ id: "c", grade: "Did you know", requestId: 99, turnId: 12 }),
];
const list = () =>
  harness.container.querySelector<HTMLElement>(".findings-list");
const cards = () => [...harness.container.querySelectorAll("article")];
const dismissButtons = () => [
  ...harness.container.querySelectorAll<HTMLButtonElement>(".finding-dismiss"),
];

async function renderOpenList(found = trio) {
  harness.served.read = found;
  await harness.render(
    <>
      <input id="step-search" />
      <div className="tree-scroll">
        <div role="treeitem" tabIndex={0} id="row" />
      </div>
      <FindingsList onShowInSteps={() => undefined} />
    </>,
  );
  await eventually(() => expect(list()).not.toBeNull());
  const toggle = list()?.querySelector<HTMLButtonElement>(".findings-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") {
    act(() => toggle.click());
  }
}

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3_000 });

async function press(button: HTMLButtonElement | undefined) {
  await act(async () => button?.click());
  await harness.settle();
  await harness.settle();
}

describe("dismissing in the list", () => {
  it("posts once, drops the card and updates the line at once", async () => {
    await renderOpenList();
    await press(dismissButtons()[0]);
    expect(harness.requests.filter((r) => r.startsWith("POST"))).toEqual([
      "POST /api/sessions/s1/findings/a/dismiss",
    ]);
    await eventually(() => expect(cards()).toHaveLength(2));
    expect(list()?.querySelector(".findings-line")?.textContent).toBe(
      "2 suggestions · Worth a look",
    );
    expect(
      harness.requests.filter((r) => r === "GET /api/sessions/s1/findings"),
    ).toHaveLength(1);
  });

  it("keeps the list open when the last finding worth fixing goes", async () => {
    await renderOpenList();
    await press(dismissButtons()[0]);
    await eventually(() => expect(cards()).toHaveLength(2));
    expect(
      list()?.querySelector(".findings-toggle")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("sends nothing more for a second press while the first is pending", async () => {
    await renderOpenList();
    const first = dismissButtons()[0];
    await act(async () => {
      first?.click();
      first?.click();
    });
    await harness.settle();
    expect(harness.requests.filter((r) => r.startsWith("POST"))).toHaveLength(
      1,
    );
  });

  it("announces the dismissal in the screen's own live region text", async () => {
    await renderOpenList();
    await press(dismissButtons()[0]);
    expect(useSessionStore.getState().announcement).toBe(
      "Suggestion dismissed.",
    );
  });

  it("keeps the card and says so when the daemon refuses", async () => {
    await renderOpenList();
    harness.served.dismiss = 500;
    await press(dismissButtons()[0]);
    expect(cards()).toHaveLength(3);
    expect(harness.container.textContent).toContain(
      "Couldn't dismiss this suggestion. Try again.",
    );
    expect(dismissButtons()[0]?.disabled).toBe(false);
  });

  it("moves focus to the next card's heading", async () => {
    await renderOpenList();
    await press(dismissButtons()[0]);
    await eventually(() =>
      expect(document.activeElement?.id).toBe("finding-list-b"),
    );
  });

  it("moves focus to the previous card's heading when the last card goes", async () => {
    await renderOpenList();
    await press(dismissButtons()[2]);
    await eventually(() =>
      expect(document.activeElement?.id).toBe("finding-list-b"),
    );
  });

  it("moves focus to the tree's tab stop when the whole list goes", async () => {
    await renderOpenList([trio[0]!]);
    await press(dismissButtons()[0]);
    await eventually(() => expect(list()).toBeNull());
    expect(document.activeElement?.id).toBe("row");
  });

  it("falls back to the search box when the tree has no tab stop", async () => {
    await renderOpenList([trio[0]!]);
    document.getElementById("row")?.setAttribute("tabindex", "-1");
    await press(dismissButtons()[0]);
    await eventually(() =>
      expect(document.activeElement?.id).toBe("step-search"),
    );
  });
});

describe("dismissing in the detail panel", () => {
  async function renderPanel() {
    harness.served.read = [trio[0]!];
    useSessionStore.setState({
      detail: { stepId: 101, status: "loading" },
      detailTab: "suggestions",
      selectedStepId: 101,
    });
    await harness.render(<StepDetailPanel />);
  }

  it("shows the tab bar for a step with a suggestion and none for a step without", async () => {
    await renderPanel();
    await eventually(() =>
      expect(
        harness.container.querySelector('[role="tablist"]'),
      ).not.toBeNull(),
    );
    act(() =>
      useSessionStore.setState({ detail: { stepId: 102, status: "loading" } }),
    );
    expect(harness.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("moves focus to the panel title and leaves the step open on Details", async () => {
    await renderPanel();
    await press(
      harness.container.querySelector<HTMLButtonElement>(".finding-dismiss") ??
        undefined,
    );
    await eventually(() =>
      expect(document.activeElement?.className).toBe("detail-title"),
    );
    expect(harness.container.querySelector('[role="tablist"]')).toBeNull();
    expect(useSessionStore.getState().detail?.stepId).toBe(101);
  });
});

describe("a finding that arrives while the person is working", () => {
  it("moves no focus, adds no dialog or alert and announces nothing", async () => {
    harness.served.read = [];
    await harness.render(
      <>
        <div role="treeitem" tabIndex={0} id="row" />
        <FindingsList onShowInSteps={() => undefined} />
      </>,
    );
    document.getElementById("row")?.focus();
    await act(async () => {
      harness.client.setQueryData(findingsQueryKey("s1"), [trio[0]]);
    });
    await harness.settle();
    expect(list()).not.toBeNull();
    expect(document.activeElement?.id).toBe("row");
    expect(
      document.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="alert"], audio',
      ),
    ).toBeNull();
    expect(useSessionStore.getState().announcement).toBe("");
  });
});
