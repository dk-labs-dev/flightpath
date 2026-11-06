// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailTabs } from "../src/session/DetailTabs.js";
import { FindingCard } from "../src/session/FindingCard.js";
import { useSessionStore } from "../src/session/store.js";
import { finding } from "./support/findings.js";
import { harness } from "./support/findings-harness.js";

const noop = () => undefined;
const CODE = '"permissions": {\n  "deny": ["Read(./dist/**)"]\n}';

async function renderCard(
  overrides: Parameters<typeof finding>[0] = {},
  failed = false,
) {
  await harness.render(
    <FindingCard
      finding={finding(overrides)}
      place="panel"
      dismissFailed={failed}
      onDismiss={noop}
    />,
  );
}
const q = <T extends Element>(selector: string) =>
  harness.container.querySelector<T>(selector);

function stubClipboard(write: () => Promise<void>) {
  const writeText = vi.fn(write);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

afterEach(() => vi.useRealTimers());

describe("a finding's card", () => {
  it.each(["Worth fixing", "Worth a look", "Did you know"] as const)(
    "shows a %s card with the finding's words as sent",
    async (grade) => {
      await renderCard({ grade });
      const card = q("article");
      const heading = q("h4");
      expect(card?.getAttribute("aria-labelledby")).toBe(heading?.id);
      expect(heading?.textContent).toBe(grade);
      expect(q(".finding-headline")?.textContent).toBe(finding().headline);
      expect(q(".finding-body")?.textContent).toBe(finding().body);
    },
  );

  it("opens its doc link in a new tab, in the link style, with the label as sent", async () => {
    await renderCard();
    const link = q<HTMLAnchorElement>(".finding-doc");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.getAttribute("href")).toBe(finding().doc.url);
    expect(link?.textContent).toBe(
      `${finding().doc.label} (opens in a new tab)`,
    );
  });

  it("has no Copy and no code block when there is no text to copy", async () => {
    await renderCard({ copy: null });
    expect(q(".finding-copy")).toBeNull();
    expect(q("pre")).toBeNull();
    expect(q(".finding-dismiss")?.getAttribute("aria-label")).toBe(
      "Dismiss this suggestion",
    );
  });

  it("shows the suggested text in a code block with a named Copy button", async () => {
    await renderCard({ copy: CODE });
    expect(q("pre code")?.textContent).toBe(CODE);
    expect(q(".finding-copy")?.getAttribute("aria-label")).toBe(
      "Copy the suggested text",
    );
  });

  it("lists a finding's items under the body, verbatim, and nothing when empty", async () => {
    await renderCard({ list: ["CLAUDE.md", ".claude/rules/testing.md"] });
    const items = [...harness.container.querySelectorAll(".finding-items li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "CLAUDE.md",
      ".claude/rules/testing.md",
    ]);
    await renderCard({ list: [] });
    expect(q("ul")).toBeNull();
  });

  it("says plainly when a dismissal did not go through", async () => {
    await renderCard({}, true);
    expect(q(".finding-card > .finding-status")?.textContent).toBe(
      "Couldn't dismiss this suggestion. Try again.",
    );
  });
});

describe("a list cut short", () => {
  const cut = { list: ["a.md", "b.md"], more: ["c.md", "d.md", "e.md"] };
  const more = () => q<HTMLButtonElement>(".finding-more");
  const rest = () =>
    document.getElementById(more()?.getAttribute("aria-controls") ?? "");

  it("offers the rest behind a button that says how many, shut at first", async () => {
    await renderCard(cut);
    expect(more()?.textContent).toBe("and 3 more");
    expect(more()?.getAttribute("aria-expanded")).toBe("false");
    expect(rest()?.hasAttribute("hidden")).toBe(true);
    expect(
      [...(rest()?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual(["c.md", "d.md", "e.md"]);
  });

  it("shows the rest in place and reads Show fewer, then folds them again", async () => {
    await renderCard(cut);
    act(() => more()?.click());
    expect(more()?.textContent).toBe("Show fewer");
    expect(more()?.getAttribute("aria-expanded")).toBe("true");
    expect(rest()?.hasAttribute("hidden")).toBe(false);
    act(() => more()?.click());
    expect(more()?.textContent).toBe("and 3 more");
    expect(rest()?.hasAttribute("hidden")).toBe(true);
  });

  it("has no button when the list was not cut", async () => {
    await renderCard({ list: ["a.md"], more: [] });
    expect(more()).toBeNull();
  });
});

describe("Copy", () => {
  const press = async () => {
    await act(async () => q<HTMLButtonElement>(".finding-copy")?.click());
  };

  it("writes the suggested text, not the body, then reads Copied for two seconds", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    await renderCard({ copy: CODE });
    vi.useFakeTimers();
    await press();
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(q(".finding-copy")?.textContent).toBe("Copied");
    expect(q(".finding-copy")?.getAttribute("aria-label")).toBe(
      "Copied the suggested text",
    );
    expect(useSessionStore.getState().announcement).toBe(
      "Copied the suggested text.",
    );
    act(() => vi.advanceTimersByTime(1_999));
    expect(q(".finding-copy")?.textContent).toBe("Copied");
    act(() => vi.advanceTimersByTime(1));
    expect(q(".finding-copy")?.textContent).toBe("Copy");
  });

  it("restarts the two seconds when pressed again", async () => {
    stubClipboard(() => Promise.resolve());
    await renderCard({ copy: CODE });
    vi.useFakeTimers();
    await press();
    act(() => vi.advanceTimersByTime(1_500));
    await press();
    act(() => vi.advanceTimersByTime(1_500));
    expect(q(".finding-copy")?.textContent).toBe("Copied");
    act(() => vi.advanceTimersByTime(500));
    expect(q(".finding-copy")?.textContent).toBe("Copy");
  });

  it("says so and keeps the text selectable when the write is refused", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    await renderCard({ copy: CODE });
    await press();
    expect(
      q("pre .finding-status, .finding-card > .finding-status"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain(
      "Couldn't copy. Select the text above and copy it yourself.",
    );
    expect(q(".finding-copy")?.textContent).toBe("Copy");
    expect(q("pre code")?.textContent).toBe(CODE);
  });

  it("says so when the browser has no clipboard", async () => {
    vi.stubGlobal("navigator", {});
    await renderCard({ copy: CODE });
    await press();
    expect(harness.container.textContent).toContain("Couldn't copy.");
  });
});

describe("the detail panel's tabs", () => {
  const two = [
    finding({ id: "a", grade: "Worth a look" }),
    finding({ id: "b", grade: "Worth fixing" }),
  ];
  async function renderTabs(tab: "details" | "suggestions") {
    await harness.render(
      <DetailTabs suggestions={two} tab={tab} onTab={noop} onDismissed={noop}>
        <p>the facts</p>
      </DetailTabs>,
    );
  }

  it("names the tab by its count and marks it with the worst grade", async () => {
    await renderTabs("details");
    const tabs = [...harness.container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Details",
      "Suggestions · 2",
    ]);
    expect(tabs[1]?.querySelector(".grade-fix")).not.toBeNull();
  });

  it("keeps the tab bar's roving tab stop on the chosen tab", async () => {
    await renderTabs("suggestions");
    const tabs = [...harness.container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("hides the panel that is not chosen but keeps it in the page", async () => {
    await renderTabs("details");
    const panels = [...harness.container.querySelectorAll('[role="tabpanel"]')];
    expect(panels.map((p) => p.hasAttribute("hidden"))).toEqual([false, true]);
    expect(panels[1]?.getAttribute("aria-label")).toBe("Suggestions");
  });

  it.each([
    ["ArrowRight", 0, "suggestions"],
    ["ArrowLeft", 1, "details"],
    ["Home", 1, "details"],
    ["End", 0, "suggestions"],
  ])("%s on tab %i chooses %s", async (key, from, chosen) => {
    const onTab = vi.fn();
    await harness.render(
      <DetailTabs
        suggestions={two}
        tab="details"
        onTab={onTab}
        onDismissed={noop}
      >
        <p>the facts</p>
      </DetailTabs>,
    );
    const tab = harness.container.querySelectorAll('[role="tab"]')[from];
    act(() => {
      tab?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect(onTab).toHaveBeenCalledWith(chosen);
  });
});
