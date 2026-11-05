// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { FindingsList } from "../src/session/FindingsList.js";
import { buildRows, type Row } from "../src/session/rows.js";
import { RowView } from "../src/session/rows-view.js";
import {
  markerName,
  rowMarkers,
  type RowMarker,
} from "../src/session/findings.js";
import { useSessionStore } from "../src/session/store.js";
import { finding } from "./support/findings.js";
import { harness } from "./support/findings-harness.js";

const GRADES = ["Worth fixing", "Worth a look", "Did you know"] as const;

function stepRow(stepId: number): Row {
  const row = buildRowsOf().find(
    (candidate) => candidate.kind === "step" && candidate.stepId === stepId,
  );
  if (row === undefined) throw new Error(`no row for step ${stepId}`);
  return row;
}

function buildRowsOf(): Row[] {
  const s = useSessionStore.getState();
  return buildRows(s, {
    collapsedTurns: new Set(),
    collapsedBranches: new Set(),
    failuresOnly: false,
    steppedInOnly: false,
    search: "",
    waiting: null,
  });
}

async function renderRow(marker: RowMarker | undefined, stepId = 101) {
  await harness.render(
    <RowView
      row={stepRow(stepId)}
      marker={marker}
      onActivate={() => undefined}
      onToggle={() => undefined}
    />,
  );
  return harness.container.querySelector<SVGElement>('[role="img"]');
}

describe("a row's marker", () => {
  it.each(GRADES)("is an image named %s", async (grade) => {
    const marker = await renderRow({ grade, more: 0 });
    expect(marker?.getAttribute("aria-label")).toBe(grade);
    expect(marker?.hasAttribute("title")).toBe(false);
    expect(marker?.getAttribute("tabindex")).toBeNull();
  });

  it("draws the three grades in three shapes and three colour classes", async () => {
    const drawn = [];
    for (const grade of GRADES) {
      const marker = await renderRow({ grade, more: 0 });
      drawn.push({
        shape: marker?.firstElementChild?.outerHTML,
        colour: marker?.getAttribute("class"),
      });
    }
    expect(new Set(drawn.map((d) => d.shape)).size).toBe(3);
    expect(new Set(drawn.map((d) => d.colour)).size).toBe(3);
  });

  it("is part of the row's accessible name", async () => {
    await renderRow({ grade: "Worth fixing", more: 0 });
    const row = harness.container.querySelector('[role="treeitem"]');
    expect(row?.querySelector('[aria-label="Worth fixing"]')).not.toBeNull();
  });

  it("is absent when the row has no findings", async () => {
    expect(await renderRow(undefined)).toBeNull();
  });

  it.each([
    [0, "Worth fixing"],
    [1, "Worth fixing, and 1 more suggestion"],
    [2, "Worth fixing, and 2 more suggestions"],
  ])("with %i more is named %s", (more, name) => {
    expect(markerName({ grade: "Worth fixing", more })).toBe(name);
  });
});

describe("markers on shut and open turns", () => {
  const anchors = new Map([
    ["a", { step: 101 }],
    ["b", { step: 103 }],
    ["c", { turn: 12 }],
  ]);
  const all = [
    finding({ id: "a", grade: "Worth a look" }),
    finding({ id: "b", grade: "Worth fixing" }),
    finding({ id: "c", grade: "Did you know" }),
  ];
  const steps = () => useSessionStore.getState().steps;

  it("moves a shut turn's step markers onto the turn row", () => {
    const markers = rowMarkers(all, anchors, steps(), new Set([12]));
    expect(markers.get("step-103")).toBeUndefined();
    expect(markers.get("turn-12")).toEqual({ grade: "Worth fixing", more: 1 });
    expect(markers.get("step-101")).toEqual({ grade: "Worth a look", more: 0 });
  });

  it("puts each marker back on its step when the turn opens", () => {
    const markers = rowMarkers(all, anchors, steps(), new Set());
    expect(markers.get("step-103")).toEqual({ grade: "Worth fixing", more: 0 });
    expect(markers.get("turn-12")).toEqual({ grade: "Did you know", more: 0 });
  });

  it("shows the worst grade even when a milder finding comes first", () => {
    const milder = [
      finding({ id: "a", grade: "Did you know" }),
      finding({ id: "b", grade: "Worth fixing" }),
    ];
    const both = new Map([
      ["a", { step: 101 }],
      ["b", { step: 101 }],
    ]);
    expect(
      rowMarkers(milder, both, steps(), new Set()).get("step-101"),
    ).toEqual({
      grade: "Worth fixing",
      more: 1,
    });
  });

  it("keeps a finding with no anchor out of every row", () => {
    const none = new Map([["a", null]]);
    expect(rowMarkers([all[0]!], none, steps(), new Set()).size).toBe(0);
  });
});

describe("the session list", () => {
  const mixed = [
    finding({ id: "a", grade: "Worth fixing", requestId: 1 }),
    finding({ id: "b", grade: "Worth a look", requestId: 2 }),
    finding({ id: "c", grade: "Did you know", requestId: 99, turnId: 12 }),
  ];

  async function renderList(list = mixed) {
    harness.served.read = list;
    const onShow = vi.fn();
    await harness.render(<FindingsList onShowInSteps={onShow} />);
    return onShow;
  }
  const toggle = () =>
    harness.container.querySelector<HTMLButtonElement>(".findings-toggle");

  it("starts shut with its region in the page and hidden", async () => {
    await renderList();
    const region = harness.container.querySelector("#findings-list-region");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()?.getAttribute("aria-controls")).toBe(region?.id);
    expect(region?.hasAttribute("hidden")).toBe(true);
  });

  it("opens to the cards in the API's order", async () => {
    await renderList();
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    const grades = [...harness.container.querySelectorAll(".finding-grade")];
    expect(grades.map((g) => g.textContent)).toEqual([
      "Worth fixing",
      "Worth a look",
      "Did you know",
    ]);
  });

  it.each([
    [[], null],
    [[mixed[1]!], "1 suggestion"],
    [[mixed[1]!, mixed[2]!], "2 suggestions"],
    [mixed, "3 suggestions · 1 worth fixing"],
  ])("reads %j as %s", async (list, line) => {
    await renderList(list);
    expect(toggle()?.textContent ?? null).toBe(line);
  });

  it("counts only Worth fixing, not every grade", async () => {
    await renderList([mixed[1]!, mixed[2]!]);
    expect(toggle()?.textContent).not.toContain("worth fixing");
  });

  it("opens the step from a card pinned to a step, and only from such a card", async () => {
    const onShow = await renderList([
      mixed[0]!,
      finding({ id: "t", requestId: 99, turnId: 777 }),
    ]);
    act(() => toggle()?.click());
    const shows =
      harness.container.querySelectorAll<HTMLButtonElement>(".finding-show");
    expect(shows).toHaveLength(1);
    act(() => shows[0]?.click());
    expect(onShow).toHaveBeenCalledWith(101);
  });
});

describe("nothing to say", () => {
  it.each([
    ["no findings", []],
    ["a read still loading", "pending"],
    ["a read that failed", 500],
  ] as const)("renders nothing for %s", async (_name, read) => {
    harness.served.read = read as never;
    await harness.render(<FindingsList onShowInSteps={() => undefined} />);
    expect(harness.container.innerHTML).toBe("");
  });

  it("renders nothing once every finding is dismissed", async () => {
    harness.served.read = [finding()];
    await harness.render(<FindingsList onShowInSteps={() => undefined} />);
    act(() =>
      harness.container
        .querySelector<HTMLButtonElement>(".findings-toggle")
        ?.click(),
    );
    await act(async () => {
      harness.container
        .querySelector<HTMLButtonElement>(".finding-dismiss")
        ?.click();
    });
    await harness.settle();
    expect(harness.container.innerHTML).toBe("");
  });
});
