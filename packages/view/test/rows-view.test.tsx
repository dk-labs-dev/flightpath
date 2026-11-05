// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRows, rowAction, type Row } from "../src/session/rows.js";
import { RowView } from "../src/session/rows-view.js";
import { useSessionStore } from "../src/session/store.js";
import { fixtureSnapshot } from "./fixtures.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function rowsFromStore(): Row[] {
  const state = useSessionStore.getState();
  return buildRows(
    {
      turns: state.turns,
      steps: state.steps,
      humans: state.humans,
      branches: state.branches,
      events: state.events,
      samples: state.samples,
      stepsByTurn: state.stepsByTurn,
      humansByTurn: state.humansByTurn,
      stepsByBranch: state.stepsByBranch,
      openStepIds: state.openStepIds,
    },
    {
      collapsedTurns: state.collapsedTurns,
      collapsedBranches: state.collapsedBranches,
      failuresOnly: state.failuresOnly,
      steppedInOnly: state.steppedInOnly,
      search: state.search,
      waiting: null,
    },
  );
}

function renderRows(
  handlers: {
    onActivate?: (row: Row) => void;
    onToggle?: (row: Row) => void;
  } = {},
) {
  const rows = rowsFromStore();
  act(() => {
    root.render(
      <>
        {rows.map((row: Row, index: number) => (
          <RowView
            key={row.key}
            row={row}
            tabIndex={index === 0 ? 0 : -1}
            onActivate={handlers.onActivate ?? (() => undefined)}
            onToggle={handlers.onToggle ?? (() => undefined)}
          />
        ))}
      </>,
    );
  });
  return rows;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useSessionStore.setState({
    collapsedBranches: new Set(),
    failuresOnly: false,
    steppedInOnly: false,
    search: "",
    detail: null,
  });
  useSessionStore.getState().begin("s1", "token");
  useSessionStore.getState().snapshot(fixtureSnapshot());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the rows", () => {
  it("render each kind with its sentence and state", () => {
    renderRows();
    expect(container.textContent).toContain("Ran npm test");
    expect(container.textContent).toContain("You approved this step");
    const failed = container.querySelector('[data-row-key="step-102"]');
    expect(failed?.textContent).toContain("failed");
    const human = container.querySelector('[data-row-key="human-22"]');
    expect(human?.textContent).toContain("You approved this step");
    const branch = container.querySelector('[data-row-key="step-103"]');
    expect(branch?.getAttribute("aria-expanded")).toBe("true");
  });
});

/** A row's meta line as its parts read, joined the way the
 * line lays them out: the parts' own text carries no spacing,
 * so the test names the joins itself. */
function metaTextOf(key: string): string {
  return [
    ...container.querySelectorAll(`[data-row-key="${key}"] .trow-meta-part`),
  ]
    .map((part) => part.textContent)
    .join(" · ");
}

describe("a turn row's meta", () => {
  function metaOfFirstTurn(carried: { images: number; files: number }): string {
    const snapshot = fixtureSnapshot();
    const first = snapshot.turns[0]!;
    snapshot.turns[0] = { ...first, steps: [], ...carried };
    act(() => useSessionStore.getState().snapshot(snapshot));
    renderRows();
    return metaTextOf("turn-11");
  }

  it("says nothing of images or files when the prompt carried none", () => {
    expect(metaOfFirstTurn({ images: 0, files: 0 })).not.toMatch(/image|file/);
  });

  it("counts the images in the singular for one and the plural for two", () => {
    expect(metaOfFirstTurn({ images: 1, files: 0 })).toMatch(/ · 1 image$/);
    expect(metaOfFirstTurn({ images: 2, files: 0 })).toContain("2 images");
  });

  it("counts the attached files in the singular for one and the plural for two", () => {
    expect(metaOfFirstTurn({ images: 0, files: 1 })).toMatch(/ · 1 file$/);
    expect(metaOfFirstTurn({ images: 0, files: 2 })).toContain("2 files");
  });

  it("puts the images, then the files, after the rest of the meta", () => {
    expect(metaOfFirstTurn({ images: 1, files: 2 })).toMatch(
      /you stepped in · 1 image · 2 files$/,
    );
  });
});

describe("a turn row's subagent time", () => {
  function metaOfFirstTurnWith(branchEndedAt: number | null): string {
    const snapshot = fixtureSnapshot();
    const first = snapshot.turns[0]!;
    const fixtureBranch = snapshot.branches[0]!;
    snapshot.turns[0] = {
      ...first,
      startedAt: 1000,
      endedAt: 31_000,
      failures: 0,
      steppedIn: 0,
      steps: [
        ...first.steps,
        {
          id: 107,
          toolName: "Read",
          outcome: "succeeded",
          startedAt: 2000,
          endedAt: 2100,
          durationMs: 100,
          branchId: null,
          resultRequestId: null,
          sentence: "Read a file",
        },
        {
          id: 108,
          toolName: "Read",
          outcome: "succeeded",
          startedAt: 2200,
          endedAt: 2300,
          durationMs: 100,
          branchId: null,
          resultRequestId: null,
          sentence: "Read another file",
        },
      ],
    };
    snapshot.branches = [
      fixtureBranch,
      {
        id: 32,
        agentId: "agent-2",
        agentType: "Explore",
        kind: "user",
        spawningStepId: 101,
        startedAt: 1000,
        endedAt: branchEndedAt,
        totalTokens: 9000,
        steps: 3,
        requests: 2,
        sentence: "Explore · 3 steps",
      },
    ];
    act(() => useSessionStore.getState().snapshot(snapshot));
    renderRows();
    return metaTextOf("turn-11");
  }

  it("adds how long the turn's subagents ran on past its end", () => {
    expect(metaOfFirstTurnWith(1000 + 12 * 60_000)).toContain(
      "4 steps · 30s · subagents ran 12m",
    );
  });

  it("says the subagents are running while one still runs", () => {
    expect(metaOfFirstTurnWith(null)).toContain(
      "4 steps · 30s · subagents running",
    );
  });

  it("says nothing of subagents when none ran on past the turn", () => {
    const snapshot = fixtureSnapshot();
    act(() => useSessionStore.getState().snapshot(snapshot));
    renderRows();
    const meta = metaTextOf("turn-11");
    expect(meta).not.toContain("subagents");
  });
});

describe("a row whose reader keeps its own folds", () => {
  function shownWith(key: string, expanded: boolean): Element | null {
    const row = rowsFromStore().find((candidate) => candidate.key === key);
    if (row === undefined) throw new Error(`no row ${key}`);
    act(() => {
      root.render(
        <RowView
          row={row}
          tabIndex={0}
          expanded={expanded}
          onActivate={() => undefined}
          onToggle={() => undefined}
        />,
      );
    });
    return container.querySelector(`[data-row-key="${key}"]`);
  }

  it("shows a branch shut or open as the reader says, whatever the store holds", () => {
    expect(shownWith("step-103", false)?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    useSessionStore.setState({ collapsedBranches: new Set([31]) });
    expect(shownWith("step-103", true)?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("shows a turn shut or open as the reader says, whatever the store holds", () => {
    expect(shownWith("turn-11", false)?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    useSessionStore.setState({ collapsedTurns: new Set([11]) });
    expect(shownWith("turn-11", true)?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});

describe("a burst of live steps", () => {
  it("re-renders only the new rows and their turn's header", async () => {
    renderRows();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    act(() => {
      const state = useSessionStore.getState();
      state.change({
        event: "step",
        data: {
          sessionId: "s1",
          turnId: 12,
          step: {
            id: 199,
            toolName: "Bash",
            outcome: "succeeded",
            startedAt: 9100,
            endedAt: 9200,
            durationMs: 100,
            branchId: null,
            resultRequestId: null,
            sentence: "Ran npm run build",
          },
        },
      });
      state.change({
        event: "turn",
        data: {
          sessionId: "s1",
          turn: {
            id: 12,
            sequence: 2,
            startedAt: 5000,
            endedAt: 9200,
            failures: 0,
            steppedIn: 1,
            images: 0,
            files: 0,
          },
        },
      });
    });
    renderRows();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    observer.disconnect();

    // The new step's siblings are touched too, and only in
    // their set size: the turn's set grew from four rows to
    // five, and a screen reader hears the true count — the
    // sibling counts the rows carry leave no other trace.
    const allowed = new Set([
      "step-199",
      "turn-12",
      "step-103",
      "human-23",
      "step-104",
    ]);
    const touched = new Set<string>();
    for (const record of records) {
      const target =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      const own = target
        ?.closest("[data-row-key]")
        ?.getAttribute("data-row-key");
      if (own) {
        touched.add(own);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          const key =
            node.getAttribute("data-row-key") ??
            node.querySelector("[data-row-key]")?.getAttribute("data-row-key");
          if (key) {
            touched.add(key);
          }
        }
      }
    }
    expect(touched.size).toBeGreaterThan(0);
    for (const key of touched) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(container.querySelector('[data-row-key="step-199"]')).not.toBeNull();
  });
});

describe("the rows' clickable cues", () => {
  it("gives steps an open chevron and parents a toggle, and neither to the rest", () => {
    renderRows();
    const step = container.querySelector('[data-row-key="step-101"]');
    expect(step?.classList.contains("trow-openable")).toBe(true);
    expect(step?.querySelector(".trow-open svg")).not.toBeNull();
    expect(step?.querySelector(".trow-toggle svg")).toBeNull();
    const turn = container.querySelector('[data-row-key="turn-11"]');
    expect(turn?.classList.contains("trow-parent")).toBe(true);
    expect(turn?.querySelector(".trow-toggle svg")).not.toBeNull();
    expect(turn?.querySelector(".trow-open svg")).toBeNull();
    const human = container.querySelector('[data-row-key="human-22"]');
    expect(human?.classList.contains("trow-static")).toBe(true);
    expect(human?.querySelector(".trow-open svg")).toBeNull();
    expect(human?.querySelector(".trow-toggle svg")).toBeNull();
    const event = container.querySelector('[data-row-key="event-segment:41"]');
    expect(event?.classList.contains("trow-static")).toBe(true);
    expect(event?.querySelector(".trow-open svg")).toBeNull();
  });
});

/** The fixture's second turn, with the given moments added to it. */
function showMoments(
  moments: { id: number; kind: string; occurredAt: number; sentence: string }[],
): void {
  const snapshot = fixtureSnapshot();
  snapshot.turns[1]?.humanMoments.push(...moments);
  useSessionStore.getState().snapshot(snapshot);
}

function rowText(key: string): string {
  return container.querySelector(`[data-row-key="${key}"]`)?.textContent ?? "";
}

describe("what Claude Code and subagents said", () => {
  beforeEach(() => {
    showMoments([
      {
        id: 31,
        kind: "command",
        occurredAt: 5500,
        sentence: "You ran `/context`",
      },
      {
        id: 32,
        kind: "handback",
        occurredAt: 5600,
        sentence: "Explore reported back · about 1.9K tokens est.",
      },
      {
        id: 33,
        kind: "notice",
        occurredAt: 5700,
        sentence: "Claude Code added a notice · 866 characters",
      },
    ]);
  });

  it("shows a command in the person's words, tagged You", () => {
    renderRows();
    expect(rowText("human-31")).toContain("You ran `/context`");
    expect(
      container.querySelector('[data-row-key="human-31"] .pill')?.textContent,
    ).toBe("You");
  });

  it("shows a hand-back with its size, tagged as from a subagent", () => {
    renderRows();
    expect(rowText("human-32")).toContain(
      "Explore reported back · about 1.9K tokens est.",
    );
    expect(
      container.querySelector('[data-row-key="human-32"] .pill')?.textContent,
    ).toBe("From a subagent");
  });

  it("shows a notice with its size, tagged as from Claude Code", () => {
    renderRows();
    expect(rowText("human-33")).toContain(
      "Claude Code added a notice · 866 characters",
    );
    expect(
      container.querySelector('[data-row-key="human-33"] .pill')?.textContent,
    ).toBe("From Claude Code");
  });

  it("opens no details for any of the three", () => {
    renderRows();
    for (const id of [31, 32, 33]) {
      const row = container.querySelector(`[data-row-key="human-${id}"]`);
      expect(row?.classList.contains("trow-static")).toBe(true);
      expect(row?.querySelector(".trow-open svg")).toBeNull();
    }
    expect(
      rowsFromStore()
        .filter(
          (row) => row.kind === "human" && [31, 32, 33].includes(row.humanId),
        )
        .map(rowAction),
    ).toEqual([null, null, null]);
  });
});

describe("a turn whose prompt's wording was not kept", () => {
  it("quotes the prompt's length in place of its words", () => {
    const snapshot = fixtureSnapshot();
    const moment = snapshot.turns[0]?.humanMoments.find(
      (candidate) => candidate.kind === "prompt",
    );
    if (moment === undefined) throw new Error("fixture lost its prompt");
    moment.sentence = "You asked a question (20 characters, wording not kept)";
    act(() => useSessionStore.getState().snapshot(snapshot));
    renderRows();
    expect(rowText("turn-11")).toContain(
      "“You asked a question (20 characters, wording not kept)”",
    );
  });
});

describe("a subagent's closing step", () => {
  it("is tiled with the Agent step's letter, not the tool name's first", () => {
    const snapshot = fixtureSnapshot();
    const closing = snapshot.turns[1]?.steps.find((step) => step.id === 106);
    if (closing === undefined) throw new Error("fixture lost its step");
    closing.toolName = "SubagentHandback";
    closing.sentence = "Handed its report back";
    act(() => useSessionStore.getState().snapshot(snapshot));
    renderRows();
    const row = container.querySelector('[data-row-key="step-106"]');
    expect(row?.textContent).toContain("Handed its report back");
    expect(row?.querySelector(".trow-tile")?.textContent).toBe("A");
  });
});

describe("a subagent's one row", () => {
  it("carries the starting step's duration and when it began", () => {
    renderRows();
    expect(metaTextOf("step-103")).toContain("2 steps · 1 request · 2s");
  });

  it("says the starting step failed", () => {
    const snapshot = fixtureSnapshot();
    const starter = snapshot.turns[1]?.steps.find((step) => step.id === 103);
    if (starter !== undefined) starter.outcome = "failed";
    useSessionStore.getState().snapshot(snapshot);
    renderRows();
    const row = container.querySelector('[data-row-key="step-103"]');
    expect(row?.textContent).toContain("failed");
    expect(row?.querySelector(".tile-failure")).not.toBeNull();
  });

  it("opens through the row and folds through the chevron", () => {
    const activated: string[] = [];
    const toggled: string[] = [];
    renderRows({
      onActivate: (row) => activated.push(row.key),
      onToggle: (row) => toggled.push(row.key),
    });
    const row = container.querySelector('[data-row-key="step-103"]');
    expect(row?.classList.contains("trow-openable")).toBe(true);
    expect(row?.querySelector(".trow-open svg")).not.toBeNull();
    act(() => {
      row?.querySelector<HTMLElement>(".trow-toggle")?.click();
    });
    expect(toggled).toEqual(["step-103"]);
    expect(activated).toEqual([]);
    act(() => {
      row?.querySelector<HTMLElement>(".trow-text")?.click();
    });
    expect(activated).toEqual(["step-103"]);
  });
});
