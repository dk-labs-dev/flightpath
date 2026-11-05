// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ContextAtStep,
  ContextItem,
  FixedLoad,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { SnapshotLens } from "../src/session/snapshot-lens.js";
import { useSessionStore } from "../src/session/store.js";
import type { StepRow } from "../src/session/types.js";
import {
  CONTEXT_AT_STEP_4,
  CONTEXT_AT_STEP_6,
  CONTEXT_AT_STEP_8,
} from "./context-fixture.js";
import { fixtureSnapshot, tokenPoint } from "./fixtures.js";
import { history } from "./support/tokens-lens-harness.js";

// The snapshot lens against the read API's own answers for
// the planted fixture (see context-fixture.ts), with the
// fetch a stand-in answering the one read the lens makes.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let payloads: Map<number, ContextAtStep>;
let requestPayloads: Map<number, ContextAtStep>;
let tokenHistory: TokenHistory;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function stepRow(overrides: Partial<StepRow>): StepRow {
  return {
    id: 4,
    toolName: "Task",
    outcome: "succeeded",
    startedAt: 12_000,
    endedAt: 20_000,
    durationMs: null,
    branchId: null,
    resultRequestId: null,
    sentence: "Started a subagent",
    turnId: 11,
    ...overrides,
  };
}

/** The store as a session screen holds it: the fixture
 * snapshot, plus the planted fixture's steps 4, 6 and 8
 * as rows of their own, and the given selection. Step 6
 * is named the store's latest step. */
function seedStore(selected: number | null): void {
  const state = useSessionStore.getState();
  state.begin("sess-snap", "token-1");
  state.snapshot(fixtureSnapshot());
  const steps = new Map(useSessionStore.getState().steps);
  steps.set(4, stepRow({ id: 4 }));
  steps.set(
    6,
    stepRow({
      id: 6,
      toolName: "Bash",
      sentence: "Ran a command",
      startedAt: 37_000,
      endedAt: 38_000,
      turnId: 12,
    }),
  );
  steps.set(
    8,
    stepRow({
      id: 8,
      toolName: "Bash",
      sentence: "Ran a command",
      startedAt: 77_000,
      endedAt: 78_000,
      turnId: 12,
    }),
  );
  useSessionStore.setState({ steps, latestStepId: 6 });
  if (selected !== null) state.selectStep(selected);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settleUntil(expectation: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expectation();
  });
}

async function renderLens(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <SnapshotLens />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function texts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map(
    (el) => el.textContent ?? "",
  );
}

function expandAllGroups(): void {
  for (const head of container.querySelectorAll<HTMLButtonElement>(
    ".snapshot-group-head",
  )) {
    if (head.getAttribute("aria-expanded") === "false") {
      act(() => head.click());
    }
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  payloads = new Map([
    [4, CONTEXT_AT_STEP_4],
    [6, CONTEXT_AT_STEP_6],
    [8, CONTEXT_AT_STEP_8],
  ]);
  requestPayloads = new Map();
  tokenHistory = history();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/tokens")) {
        return Promise.resolve(jsonResponse(200, tokenHistory));
      }
      const params = new URLSearchParams(url.split("?")[1]);
      const request = params.get("request");
      if (request !== null) {
        const found = requestPayloads.get(Number(request));
        return Promise.resolve(
          found === undefined
            ? jsonResponse(404, {})
            : jsonResponse(200, found),
        );
      }
      const step = Number(params.get("step"));
      const payload = payloads.get(step) ?? {
        ...CONTEXT_AT_STEP_4,
        stepId: step,
      };
      return Promise.resolve(jsonResponse(200, payload));
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the snapshot lens on the planted fixture", () => {
  it("lists step 4's items grouped, in order, at the fixture's sizes", async () => {
    seedStore(4);
    await renderLens();
    expect(texts(".snapshot-group-title")).toEqual([
      "Your prompts",
      "Images and files",
      "Instructions (CLAUDE.md)",
      "Skills",
      "Command output",
      "Files read",
      "Tool results",
      "Subagent results",
      "Claude's replies",
    ]);
    expandAllGroups();
    const rows = texts(".snapshot-row");
    // Files read, largest first, at the fixture's estimates.
    const files = rows.filter((row) => row.includes("a file"));
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("34.7K tokens");
    expect(files[1]).toContain("about 16.0K tokens");
    // The prompts by their turns, largest first; a size
    // under a thousand tokens is counted, not rounded away.
    const prompts = rows.filter((row) => row.includes("prompt"));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Turn 2 prompt");
    expect(prompts[0]).toContain("about 8 tokens");
    expect(prompts[1]).toContain("Turn 1 prompt");
    expect(prompts[1]).toContain("about 6 tokens");
    expect(rows.some((row) => row.includes("Started a subagent"))).toBe(true);
    // The size at the step, and what the list doesn't explain.
    expect(container.textContent).toContain("85K");
    expect(container.textContent).toContain("of 1M (9%)");
    expect(container.textContent).toContain(
      "Named: ? about 66.1K of 85,000 measured ? (78%)",
    );
    // The fixture's fixed load is one unsplit total, so
    // the remainder still holds the system prompt and
    // tools, and its label says so.
    expect(
      rows.some((row) => row.includes("Other (system, tools, history)")),
    ).toBe(true);
    expect(rows.some((row) => row.includes("about 18.9K tokens"))).toBe(true);
    // The plain line, verbatim.
    expect(container.textContent).toContain(
      "Flightpath keeps names and sizes. File contents and tool output stay in Claude Code. For the categories of the current moment, run /context.",
    );
  });

  it("lists step 6's larger context at the fixture's sizes", async () => {
    seedStore(6);
    await renderLens();
    expandAllGroups();
    const rows = texts(".snapshot-row");
    const files = rows.filter((row) => row.includes("a file"));
    expect(files).toHaveLength(3);
    expect(files[0]).toContain("99.4K tokens");
    expect(container.textContent).toContain(
      "Named: ? about 170.6K of 197,000 measured ? (87%)",
    );
    // Eight replies by then, summed measured.
    const repliesHead = [
      ...container.querySelectorAll(".snapshot-group-head"),
    ].find((head) => head.textContent?.includes("Claude's replies"));
    expect(repliesHead?.textContent).toContain("3,100 tokens");
  });

  it("reads each group's count with the group's own noun", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        { kind: "prompt", turnId: 1, sequence: 1, chars: 21, tokens: 6 },
        { kind: "reply", requestId: 1, tokens: 300 },
        { kind: "reply", requestId: 2, tokens: 400 },
      ],
    });
    await renderLens();
    const count = (title: string) =>
      [...container.querySelectorAll(".snapshot-group-head")]
        .find(
          (head) =>
            head.querySelector(".snapshot-group-title")?.textContent === title,
        )
        ?.querySelector(".snapshot-group-count")?.textContent;
    expect(count("Your prompts")).toBe("1 prompt");
    expect(count("Claude's replies")).toBe("2 replies");
  });

  it("reads an empty group as none, once, with no sum", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [{ kind: "prompt", turnId: 1, sequence: 1, chars: 21, tokens: 6 }],
    });
    await renderLens();
    const skills = [...container.querySelectorAll(".snapshot-group-head")].find(
      (head) =>
        head.querySelector(".snapshot-group-title")?.textContent === "Skills",
    );
    expect(skills?.querySelector(".snapshot-group-count")?.textContent).toBe(
      "none",
    );
    expect(skills?.textContent?.match(/none/g)).toHaveLength(1);
    expect(skills?.querySelector(".snapshot-sum")).toBeNull();
    expect(skills?.textContent).not.toContain("—");
  });

  it("keeps measured, estimated and unknown visibly and textually apart", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        { kind: "reply", requestId: 1, tokens: 300 },
        {
          kind: "file-read",
          stepId: 1,
          path: "src/app.ts",
          chars: 36_800,
          tokens: 9_200,
          measured: false,
        },
        {
          kind: "tool-result",
          stepId: 2,
          label: "Ran a command",
          chars: 7_000,
          tokens: 2_600,
          measured: true,
        },
        { kind: "image", turnId: 1, name: null, bytes: 312_000, tokens: null },
      ],
      totals: { measured: 85_000, items: 12_100, named: 12_100, other: null },
    });
    await renderLens();
    expandAllGroups();
    const rows = [...container.querySelectorAll(".snapshot-row")];
    const byText = (text: string) =>
      rows.find((row) => row.textContent?.includes(text));
    // Estimated: the tag and the secondary class, on the value.
    const read = byText("src/app.ts");
    expect(read?.querySelector(".snapshot-est")?.textContent).toBe("est.");
    expect(read?.querySelector(".snapshot-est")?.getAttribute("title")).toBe(
      "Worked out from the number of characters, at about 2.9 per token. Close, not exact.",
    );
    expect(read?.querySelector(".snapshot-est-value")?.textContent).toBe(
      "about 9.2K tokens",
    );
    // Measured: an exact count, no tag, no estimate class.
    const reply = byText("Claude's reply");
    expect(reply?.querySelector(".snapshot-measured")?.textContent).toBe(
      "300 tokens",
    );
    expect(reply?.querySelector(".snapshot-est")).toBeNull();
    // Measured from the rise: plain, tagged, and not "about".
    const result = byText("Ran a command");
    expect(result?.querySelector(".snapshot-measured")?.textContent).toBe(
      "2.6K tokens",
    );
    const tag = result?.querySelector(".snapshot-from-context");
    expect(tag?.textContent).toBe("measured");
    expect(tag?.getAttribute("title")).toBe(
      "This result arrived on its own, so its size is exact: how much the context grew, minus Claude's reply.",
    );
    expect(result?.querySelector(".snapshot-est")).toBeNull();
    expect(result?.textContent).not.toContain("about");
    // An image's tokens are in no figure: its bytes are
    // shown, its tokens named not measured, never a number.
    const image = byText("an image");
    expect(image?.querySelector(".snapshot-unknown")?.textContent).toBe(
      "tokens not measured",
    );
    expect(image?.textContent).toContain("312.0 KB");
  });

  it("reads a group whose every size is measured in the measured voice", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        {
          kind: "file-read",
          stepId: 1,
          path: "data/words.csv",
          chars: 68_440,
          tokens: 23_600,
          measured: true,
        },
      ],
      totals: { measured: 85_000, items: 23_600, named: 23_600, other: null },
    });
    await renderLens();
    const head = [...container.querySelectorAll(".snapshot-group-head")].find(
      (el) =>
        el.querySelector(".snapshot-group-title")?.textContent === "Files read",
    );
    expect(head?.querySelector(".snapshot-measured")?.textContent).toBe(
      "23.6K tokens",
    );
    expect(head?.querySelector(".snapshot-from-context")?.textContent).toBe(
      "measured",
    );
    expect(head?.querySelector(".snapshot-est")).toBeNull();
    expect(head?.textContent).not.toContain("about");
  });

  it("keeps a group's sum an estimate while one of its sizes is", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        {
          kind: "file-read",
          stepId: 1,
          path: "data/words.csv",
          chars: 68_440,
          tokens: 23_600,
          measured: true,
        },
        {
          kind: "file-read",
          stepId: 2,
          path: "src/app.ts",
          chars: 36_800,
          tokens: 9_200,
          measured: false,
        },
      ],
      totals: { measured: 85_000, items: 32_800, named: 32_800, other: null },
    });
    await renderLens();
    const head = [...container.querySelectorAll(".snapshot-group-head")].find(
      (el) =>
        el.querySelector(".snapshot-group-title")?.textContent === "Files read",
    );
    expect(head?.querySelector(".snapshot-est-value")?.textContent).toBe(
      "about 32.8K tokens",
    );
    expect(head?.querySelector(".snapshot-measured")).toBeNull();
  });

  it("names the branch a branch step ran inside", async () => {
    payloads.set(4, {
      ...CONTEXT_AT_STEP_6,
      stepId: 4,
      scope: { kind: "branch", branchId: 3, agentType: "Explore" },
      measured: null,
      items: [],
      totals: { measured: null, items: 0, named: 0, other: null },
    });
    seedStore(4);
    await renderLens();
    expect(container.textContent).toContain("inside the subagent explore");
    expect(container.textContent).toContain(
      "Context size not recorded for this step.",
    );
  });

  it("shows the latest step, and says so, when none is selected", async () => {
    seedStore(null);
    await renderLens();
    expect(container.textContent).toContain(
      "Showing the latest step. Pick another in the list below or in Steps.",
    );
    // Step 6 starts last among the store's rows.
    expect(texts(".snapshot-picker-name")).toEqual(["Ran a command"]);
    expect(container.textContent).toContain("of 197,000 measured");
  });

  it("says when the step's size was not recorded", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, measured: null });
    await renderLens();
    expect(container.textContent).toContain(
      "Context size not recorded for this step.",
    );
    expect(container.textContent).not.toContain("measured (");
  });

  it("shows the plain statements the record's flags call for", async () => {
    seedStore(4);
    await renderLens();
    // The planted fixture is partial and joined partway,
    // with telemetry: exactly two statements.
    expect(texts(".session-note")).toHaveLength(2);
    expect(container.textContent).toContain(
      "Part of this session’s transcript couldn’t be read",
    );
    expect(container.textContent).toContain(
      "Flightpath started recording partway through this session",
    );
  });

  it("picks a step in the picker and folds the list again", async () => {
    seedStore(4);
    await renderLens();
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pick another step",
    );
    act(() => toggle?.click());
    // The turns stand in the list; their steps are the rows
    // the steps lens draws, under the picker's own folds.
    expect(texts(".snapshot-picker-list .trow-turn")).toHaveLength(2);
    const stepRowEl = container.querySelector(
      ".snapshot-picker-list [data-row-key='step-101']",
    );
    expect(stepRowEl).not.toBeNull();
    act(() => {
      (stepRowEl as HTMLElement).click();
    });
    expect(useSessionStore.getState().selectedStepId).toBe(101);
    expect(container.querySelector(".snapshot-picker-list")).toBeNull();
  });

  it("keeps the picker's folds its own, clear of the steps tree's", async () => {
    seedStore(4);
    // The steps tree's place: both turns folded there, and
    // its toolbar filtering to failures. Neither is the
    // picker's business.
    useSessionStore.setState({
      collapsedTurns: new Set([11, 12]),
      failuresOnly: true,
    });
    await renderLens();
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pick another step",
    );
    act(() => toggle?.click());
    // Every step stands in the list: the shown step's turn
    // open, the other turn shut at first.
    expect(
      container.querySelector(
        ".snapshot-picker-list [data-row-key='step-101']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        ".snapshot-picker-list [data-row-key='step-103']",
      ),
    ).toBeNull();
    // Opening the other turn in the picker leaves the
    // steps tree's folds exactly as they were.
    const turnRow = container.querySelector(
      ".snapshot-picker-list [data-row-key='turn-12']",
    );
    act(() => {
      (turnRow as HTMLElement).click();
    });
    expect(
      container.querySelector(
        ".snapshot-picker-list [data-row-key='step-103']",
      ),
    ).not.toBeNull();
    expect(useSessionStore.getState().collapsedTurns).toEqual(
      new Set([11, 12]),
    );
  });

  it("gives two unnamed images in one turn two rows of their own", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        { kind: "image", turnId: 1, name: null, bytes: 1_000, tokens: null },
        { kind: "image", turnId: 1, name: null, bytes: 2_000, tokens: null },
      ],
    });
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await renderLens();
    expandAllGroups();
    const images = texts(".snapshot-row").filter((row) =>
      row.includes("an image"),
    );
    expect(images).toHaveLength(2);
    expect(images[0]).toContain("1.0 KB");
    expect(images[1]).toContain("2.0 KB");
    // No two rows shared a key: React says so when they do.
    const warned = errors.mock.calls.some((call) =>
      call.map(String).join(" ").includes("same key"),
    );
    errors.mockRestore();
    expect(warned).toBe(false);
  });

  it("estimates a text file from its bytes and shows no byte size beside an unknown", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        {
          kind: "file",
          turnId: 1,
          name: "data\\orders.csv",
          bytes: 498,
          tokens: 172,
        },
        { kind: "file", turnId: 1, name: null, bytes: null, tokens: null },
        { kind: "image", turnId: 1, name: null, bytes: 1_000, tokens: null },
      ],
    });
    await renderLens();
    expandAllGroups();
    const rows = texts(".snapshot-row");
    const csv = rows.find((row) => row.includes("data\\orders.csv"));
    expect(csv).toContain("about 172 tokens");
    expect(csv).not.toContain("498");
    const unnamed = rows.find((row) => row.includes("a file"));
    expect(unnamed).toContain("size not known");
    const image = rows.find((row) => row.includes("an image"));
    expect(image).toContain("1.0 KB");
    expect(image).toContain("tokens not measured");
    expect(image).not.toContain("size not known");
  });

  it("names a group of images alone as not measured", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [
        { kind: "image", turnId: 1, name: null, bytes: 1_000, tokens: null },
      ],
    });
    await renderLens();
    const head = [...container.querySelectorAll(".snapshot-group-head")].find(
      (candidate) => candidate.textContent?.includes("Images and files"),
    );
    expect(head?.textContent).toContain("tokens not measured");
  });

  it("keeps a turn that lands after the lens opens shut in the picker", async () => {
    seedStore(4);
    await renderLens();
    // A turn lands on the live session while the lens is
    // open: its shell, its step row, and its steps by turn.
    act(() => {
      const state = useSessionStore.getState();
      const turns = new Map(state.turns);
      turns.set(13, {
        id: 13,
        sequence: 3,
        startedAt: 40_000,
        endedAt: null,
        failures: 0,
        steppedIn: 0,
        images: 0,
        files: 0,
        promptSentence: null,
      });
      const late = stepRow({ id: 107, turnId: 13, sentence: "Ran late" });
      const steps = new Map(state.steps);
      steps.set(107, late);
      const stepsByTurn = new Map(state.stepsByTurn);
      stepsByTurn.set(13, [late]);
      useSessionStore.setState({ turns, steps, stepsByTurn });
    });
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pick another step",
    );
    act(() => toggle?.click());
    // The late turn stands in the list, shut: its step is
    // not drawn until the person opens the turn.
    expect(
      container.querySelector(".snapshot-picker-list [data-row-key='turn-13']"),
    ).not.toBeNull();
    expect(
      container.querySelector(
        ".snapshot-picker-list [data-row-key='step-107']",
      ),
    ).toBeNull();
  });

  it("leaves the tab stop on the turn row when the shown step's turn folds", async () => {
    seedStore(101);
    await renderLens();
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pick another step",
    );
    act(() => toggle?.click());
    // The shown step's row holds the stop while it stands.
    const stepEl = container.querySelector(
      ".snapshot-picker-list [data-row-key='step-101']",
    );
    expect((stepEl as HTMLElement).tabIndex).toBe(0);
    // Fold its turn: the step row leaves the list, and the
    // stop falls to the nearest row still shown — the turn.
    const turnEl = container.querySelector(
      ".snapshot-picker-list [data-row-key='turn-11']",
    );
    act(() => {
      (turnEl as HTMLElement).click();
    });
    expect(
      container.querySelector(
        ".snapshot-picker-list [data-row-key='step-101']",
      ),
    ).toBeNull();
    const folded = container.querySelector(
      ".snapshot-picker-list [data-row-key='turn-11']",
    );
    expect((folded as HTMLElement).tabIndex).toBe(0);
  });

  async function openPicker(): Promise<void> {
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pick another step",
    );
    act(() => toggle?.click());
  }

  function pickerRow(key: string): HTMLElement {
    const found = container.querySelector(
      `.snapshot-picker-list [data-row-key='${key}']`,
    );
    if (!(found instanceof HTMLElement)) throw new Error(`No row ${key}`);
    return found;
  }

  it("picks the step a subagent's row stands for, and folds the list", async () => {
    seedStore(4);
    await renderLens();
    await openPicker();
    act(() => pickerRow("turn-12").click());
    act(() => pickerRow("step-103").click());
    expect(useSessionStore.getState().selectedStepId).toBe(103);
    expect(container.querySelector(".snapshot-picker-list")).toBeNull();
  });

  it("leaves the tab stop on the subagent's row when its branch folds", async () => {
    seedStore(105);
    await renderLens();
    await openPicker();
    expect(pickerRow("step-105").tabIndex).toBe(0);
    act(() =>
      pickerRow("step-103").querySelector<HTMLElement>(".trow-toggle")?.click(),
    );
    const subagent = pickerRow("step-103");
    expect(container.querySelector("[data-row-key='step-105']")).toBeNull();
    expect(subagent.tabIndex).toBe(0);
  });

  it("draws the bar's named share from the payload, with nothing left over when it fills the total", async () => {
    seedStore(4);
    // The payload caps what it names at the measured total:
    // the named segment fills the measured share and the
    // rest is nothing, not a negative width.
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      measured: {
        requestId: 5,
        tokens: 1_000,
        window: { tokens: 100_000, source: "model-list", reportedAt: null },
        share: 0.01,
      },
      totals: { measured: 1_000, items: 1_500, named: 1_000, other: null },
    });
    await renderLens();
    const listed = container.querySelector<HTMLElement>(".snapshot-bar-listed");
    const rest = container.querySelector<HTMLElement>(".snapshot-bar-rest");
    expect(listed?.style.width).toBe("1%");
    expect(rest?.style.width).toBe("0%");
  });

  it("shows the size alone when the window isn't known: no of …, no bar", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      measured: {
        requestId: 5,
        tokens: 85_000,
        window: { tokens: null, source: "unknown", reportedAt: null },
        share: null,
      },
    });
    await renderLens();
    const line = container.querySelector(".snapshot-size-line");
    expect(line?.textContent).toContain("85K");
    expect(line?.textContent).not.toContain("of");
    expect(container.querySelector(".snapshot-bar")).toBeNull();
  });
});

describe("the snapshot lens's explanations", () => {
  /** Open the note behind the "?" with the given name, and
   * read what it says. */
  async function openNote(name: string): Promise<string> {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === name,
    ) as HTMLButtonElement;
    expect(button).not.toBeUndefined();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const note = button.closest(".explain")?.querySelector(".explain-note");
    return note?.textContent ?? "";
  }

  const EXPLANATIONS = [
    {
      title: "explains Named beside the word",
      button: "What is Named?",
      sentence:
        "How much of the context Flightpath can put a name to. " +
        "The rest is listed as Other.",
    },
    {
      title: "explains measured beside the word",
      button: "What is measured?",
      sentence:
        "This result arrived on its own, so its size is exact: " +
        "how much the context grew, minus Claude's reply.",
    },
    {
      title: "explains Other beside the row",
      button: "What is Other?",
      sentence:
        "The part of the context Flightpath can't name, " +
        "mostly earlier conversation.",
    },
    {
      title: "explains est. beside the Other row's size",
      button: "What is est.?",
      sentence:
        "Worked out from the number of characters, at about 2.9 " +
        "per token. Close, not exact.",
    },
    {
      title: "explains Sent on every request beside the heading",
      button: "What is sent on every request?",
      sentence:
        "What Claude Code sends with every request before any work: " +
        "its instructions, tool descriptions, CLAUDE.md and the skills list.",
    },
  ];

  it.each(EXPLANATIONS)("$title", async ({ button, sentence }) => {
    seedStore(4);
    await renderLens();
    expect(await openNote(button)).toBe(sentence);
  });
});

/** Turn 13, which ran no step: its one request is in the
 * token history, and a compaction before it is in the events. */
function seedRepliedTurn(): void {
  const state = useSessionStore.getState();
  const turns = new Map(state.turns);
  turns.set(13, {
    id: 13,
    sequence: 3,
    startedAt: 90_000,
    endedAt: 91_000,
    failures: 0,
    steppedIn: 0,
    images: 0,
    files: 0,
    promptSentence: null,
  });
  const events = new Map(state.events);
  events.set("segment:41", {
    kind: "segment",
    id: 41,
    at: 85_000,
    sentence: "Compacted the conversation",
    segmentKind: "compact",
  });
  useSessionStore.setState({ turns, events });
  tokenHistory = history({
    main: [
      { ...tokenPoint(50, 80_000, 60_000), turnId: 12 },
      { ...tokenPoint(51, 90_500, 20_000), turnId: 13 },
    ],
  });
  requestPayloads.set(51, {
    ...CONTEXT_AT_STEP_8,
    stepId: null,
    measured: { ...CONTEXT_AT_STEP_8.measured!, requestId: 51 },
  });
}

async function openPicker(): Promise<void> {
  const toggle = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Pick another step",
  );
  act(() => toggle?.click());
  await settle();
}

describe("the snapshot lens at a request", () => {
  it("names a request by its turn, and loads the context asked at it", async () => {
    seedStore(null);
    seedRepliedTurn();
    act(() => useSessionStore.getState().selectRequest(51));
    await renderLens();
    expect(texts(".snapshot-picker-label")).toEqual(["At request"]);
    expect(texts(".snapshot-picker-name")).toEqual(["Turn 3 · Claude replied"]);
    expect(texts(".snapshot-picker-meta")).toEqual([formatClock(90_500)]);
    expect(container.textContent).toContain("Before the compaction");
    expect(container.textContent).toContain("Restored after it");
    expect(container.textContent).not.toContain("Showing the latest step");
  });

  it("lists a turn that ran no step as its request, and picks it", async () => {
    seedStore(4);
    seedRepliedTurn();
    await renderLens();
    await openPicker();
    const row = container.querySelector<HTMLElement>(
      ".snapshot-picker-list [data-row-key='turn-13']",
    );
    expect(row?.textContent).toContain("Turn 3 · Claude replied");
    expect(row?.hasAttribute("aria-expanded")).toBe(false);
    act(() => row?.click());
    await settle();
    expect(useSessionStore.getState().selectedRequestId).toBe(51);
    expect(useSessionStore.getState().selectedStepId).toBeNull();
    expect(container.querySelector(".snapshot-picker-list")).toBeNull();
    expect(texts(".snapshot-picker-name")).toEqual(["Turn 3 · Claude replied"]);
  });

  it("still folds a turn that ran steps", async () => {
    seedStore(4);
    seedRepliedTurn();
    await renderLens();
    await openPicker();
    const row = container.querySelector<HTMLElement>(
      ".snapshot-picker-list [data-row-key='turn-12']",
    );
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    act(() => row?.click());
    expect(useSessionStore.getState().selectedRequestId).toBeNull();
    expect(row?.getAttribute("aria-expanded")).toBe("true");
  });

  it("names a request in a turn that ran steps by what it is, not as a reply", async () => {
    seedStore(null);
    seedRepliedTurn();
    requestPayloads.set(50, {
      ...CONTEXT_AT_STEP_8,
      stepId: null,
      measured: { ...CONTEXT_AT_STEP_8.measured!, requestId: 50 },
    });
    act(() => useSessionStore.getState().selectRequest(50));
    await renderLens();
    expect(texts(".snapshot-picker-name")).toEqual([
      "Turn 2 · first request after the compaction",
    ]);
  });

  it("keeps a tab stop in the list while the shown request is not in the history yet", async () => {
    seedStore(null);
    seedRepliedTurn();
    tokenHistory = history({ main: [] });
    act(() => useSessionStore.getState().selectRequest(51));
    await renderLens();
    await openPicker();
    const stops = container.querySelectorAll(
      ".snapshot-picker-list [data-row-key][tabindex='0']",
    );
    expect(stops).toHaveLength(1);
  });

  it("selecting a step puts the request away", () => {
    seedStore(null);
    act(() => useSessionStore.getState().selectRequest(51));
    act(() => useSessionStore.getState().selectStep(4));
    expect(useSessionStore.getState().selectedRequestId).toBeNull();
    expect(useSessionStore.getState().selectedStepId).toBe(4);
  });

  it("says when the request is not in the recordings", async () => {
    seedStore(null);
    act(() => useSessionStore.getState().selectRequest(999));
    await renderLens();
    expect(container.textContent).toContain(
      "This request isn’t in the recordings.",
    );
  });
});

/** A session that ran no step: each turn answered in text
 * alone, so the store holds turns and the history holds their
 * requests, and nothing else. */
function seedStepFreeSession(
  turns: { id: number; requests: number[] }[],
): void {
  const state = useSessionStore.getState();
  const fixture = fixtureSnapshot();
  state.begin("sess-snap", "token-1");
  state.snapshot({
    ...fixture,
    turns: turns.map((turn, index) => ({
      ...fixture.turns[0]!,
      id: turn.id,
      sequence: index + 1,
      steps: [],
      humanMoments: [],
    })),
  });
  tokenHistory = history({
    main: turns.flatMap((turn) =>
      turn.requests.map((requestId) => ({
        ...tokenPoint(requestId, requestId * 1_000, 50_000),
        turnId: turn.id,
      })),
    ),
  });
}

const PASTED_IMAGE: ContextItem = {
  kind: "image",
  turnId: 1,
  name: "image/png",
  bytes: 218_732,
  tokens: null,
};

describe("the snapshot lens in a session that ran no step", () => {
  it("shows what Claude knew at the last request of the latest turn", async () => {
    seedStepFreeSession([
      { id: 1, requests: [7] },
      { id: 2, requests: [8, 9] },
    ]);
    requestPayloads.set(9, {
      ...CONTEXT_AT_STEP_8,
      stepId: null,
      measured: { ...CONTEXT_AT_STEP_8.measured!, requestId: 9 },
    });
    await renderLens();
    expect(texts(".snapshot-picker-label")).toEqual(["At request"]);
    expect(texts(".snapshot-picker-name")).toEqual(["Turn 2 · Claude replied"]);
    expect(texts(".snapshot-picker-meta")).toEqual([formatClock(9_000)]);
    expect(container.textContent).not.toContain("No steps recorded");
  });

  it("lists the prompt's image among the images and files", async () => {
    seedStepFreeSession([{ id: 1, requests: [7] }]);
    requestPayloads.set(7, {
      ...CONTEXT_AT_STEP_8,
      stepId: null,
      items: [PASTED_IMAGE],
      compaction: null,
    });
    await renderLens();
    await settleUntil(() => {
      expandAllGroups();
      expect(texts(".snapshot-row")[0]).toContain("image/png");
    });
  });

  it("keeps showing a step the person selected", async () => {
    seedStepFreeSession([{ id: 1, requests: [7] }]);
    const steps = new Map([[4, stepRow({ id: 4, turnId: 1 })]]);
    useSessionStore.setState({ steps });
    act(() => useSessionStore.getState().selectStep(4));
    await renderLens();
    expect(texts(".snapshot-picker-label")).toEqual(["At step"]);
  });

  it("says it is loading, not that nothing was recorded, while the history is still on its way", async () => {
    seedStepFreeSession([{ id: 1, requests: [7] }]);
    requestPayloads.set(7, { ...CONTEXT_AT_STEP_8, stepId: null });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = fetch;
    vi.stubGlobal("fetch", (url: string) =>
      url.endsWith("/tokens") ? gate.then(() => answer(url)) : answer(url),
    );
    await renderLens();
    expect(container.textContent).toContain("Loading the snapshot…");
    expect(container.textContent).not.toContain("No steps recorded");
    release();
    await settleUntil(() =>
      expect(texts(".snapshot-picker-name")).toEqual([
        "Turn 1 · Claude replied",
      ]),
    );
    expect(container.textContent).not.toContain("Loading the snapshot…");
  });

  it("skips a request that belongs to no turn", async () => {
    seedStepFreeSession([{ id: 1, requests: [7] }]);
    tokenHistory = history({
      main: [
        ...tokenHistory.main,
        { ...tokenPoint(8, 8_000, 50_000), turnId: null },
      ],
    });
    requestPayloads.set(7, { ...CONTEXT_AT_STEP_8, stepId: null });
    await renderLens();
    expect(texts(".snapshot-picker-name")).toEqual(["Turn 1 · Claude replied"]);
    expect(texts(".snapshot-picker-meta")).toEqual([formatClock(7_000)]);
  });

  it("shows the previous turn's request while the latest turn is unanswered", async () => {
    seedStepFreeSession([
      { id: 1, requests: [7] },
      { id: 2, requests: [] },
    ]);
    requestPayloads.set(7, { ...CONTEXT_AT_STEP_8, stepId: null });
    await renderLens();
    expect(texts(".snapshot-picker-name")).toEqual(["Turn 1 · Claude replied"]);
    expect(container.textContent).not.toContain("No steps recorded");
  });

  it("says so only when the session has sent no request", async () => {
    seedStepFreeSession([{ id: 1, requests: [] }]);
    await renderLens();
    expect(container.textContent).toContain(
      "No steps recorded for this session yet.",
    );
  });
});

/** A recorded shape's split, in the API's own terms: seven
 * tools, two MCP servers, an instruction file whose size
 * wasn't recorded, and the five things added at session
 * start at the sizes a real session recorded. */
const SPLIT_LOAD: FixedLoad = {
  kind: "split",
  requestId: 5,
  total: 30_641,
  system: { chars: 34_000, tokens: 8_500, fromContext: false },
  tools: [
    { name: "Task", chars: 36_700, tokens: 9_175 },
    { name: "Bash", chars: 4_000, tokens: 1_000 },
    { name: "Read", chars: 2_000, tokens: 500 },
    { name: "Edit", chars: 1_600, tokens: 400 },
    { name: "Grep", chars: 1_200, tokens: 300 },
    { name: "Glob", chars: 800, tokens: 200 },
    { name: "Write", chars: 400, tokens: 100 },
  ],
  toolsReported: null,
  mcp: [
    { server: "notes", tools: 3, chars: 2_400, tokens: 600 },
    { server: "files", tools: 1, chars: 600, tokens: 150 },
  ],
  instructions: [
    { loadId: 1, name: "CLAUDE.md", bytes: 2_400, tokens: 600 },
    { loadId: 2, name: "team.md", bytes: null, tokens: null },
  ],
  startup: [
    {
      loadId: 3,
      kind: "skill-listing",
      name: null,
      count: 49,
      chars: 24_851,
      tokens: 6_213,
      fromContext: false,
    },
    {
      loadId: 4,
      kind: "mcp-instructions",
      name: null,
      count: 2,
      chars: 3_715,
      tokens: 929,
      fromContext: false,
    },
    {
      loadId: 5,
      kind: "agent-listing",
      name: null,
      count: null,
      chars: 2_527,
      tokens: 632,
      fromContext: false,
    },
    {
      loadId: 6,
      kind: "deferred-tool-names",
      name: null,
      count: 132,
      chars: 4_160,
      tokens: 1_040,
      fromContext: false,
    },
    {
      loadId: 7,
      kind: "hook-output",
      name: "SessionStart:startup",
      count: null,
      chars: 1_207,
      tokens: 302,
      fromContext: false,
    },
  ],
};

describe("the fixed load and the compaction", () => {
  it("shows the split: system, five tools, the rest on request, servers, files", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, fixedLoad: SPLIT_LOAD });
    await renderLens();
    const panel = container.querySelector(".snapshot-fixed");
    expect(panel).not.toBeNull();
    const rows = [...panel!.querySelectorAll(".snapshot-row")].map(
      (row) => row.textContent ?? "",
    );
    // The panel's total is every part's estimate summed.
    expect(panel!.textContent).toContain("Sent on every request");
    expect(panel!.textContent).toContain("about 30.6K tokens");
    // The system prompt first, then the five largest tools.
    expect(rows[0]).toContain("System prompt");
    expect(rows[0]).toContain("about 8.5K tokens");
    expect(
      rows.slice(1, 6).map((row) => row.split("about")[0]?.trim()),
    ).toEqual(["Task", "Bash", "Read", "Edit", "Grep"]);
    expect(rows.some((row) => row.includes("Glob"))).toBe(false);
    // The rest stand behind the one button, which counts them.
    const button = [...panel!.querySelectorAll("button")].find(
      (el) => el.textContent === "Show all 7 tools",
    );
    expect(button).not.toBeUndefined();
    act(() => button!.click());
    const after = [...panel!.querySelectorAll(".snapshot-row")].map(
      (row) => row.textContent ?? "",
    );
    expect(after.some((row) => row.includes("Glob"))).toBe(true);
    expect(after.some((row) => row.includes("Write"))).toBe(true);
    expect(
      [...panel!.querySelectorAll("button")].some(
        (el) => el.textContent === "Show all 7 tools",
      ),
    ).toBe(false);
    // Each MCP server with its tool count; each instruction
    // file, the unrecorded one named unknown.
    expect(after.some((row) => row.includes("MCP · notes · 3 tools"))).toBe(
      true,
    );
    expect(after.some((row) => row.includes("MCP · files · 1 tool"))).toBe(
      true,
    );
    const claude = after.find((row) => row.includes("CLAUDE.md"));
    expect(claude).toContain("about 600 tokens");
    const team = after.find((row) => row.includes("team.md"));
    expect(team).toContain("size not known");
    // What was added at session start stands after the
    // instruction files, each under its own name and count.
    const skills = after.find((row) => row.includes("Skills listing"));
    expect(skills).toContain("Skills listing · 49 skills");
    expect(skills).toContain("about 6.2K tokens");
    const servers = after.find((row) =>
      row.includes("MCP server instructions"),
    );
    expect(servers).toContain("MCP server instructions · 2 servers");
    expect(servers).toContain("about 929 tokens");
    const agents = after.find((row) => row.includes("Subagent types"));
    expect(agents).toContain("Subagent types listing");
    expect(agents).toContain("about 632 tokens");
    const names = after.find((row) => row.includes("loaded on demand"));
    expect(names).toContain("Names of tools loaded on demand · 132");
    expect(names).toContain("about 1.0K tokens");
    const hook = after.find((row) => row.includes("Hook output"));
    expect(hook).toContain("Hook output · SessionStart:startup");
    expect(hook).toContain("about 302 tokens");
  });

  it.each([
    ["the main conversation", null, "Task from your conversation"],
    ["another subagent", "planner", "Task from planner"],
  ])(
    "words a subagent's preloaded skill and a task launched from %s",
    async (_from, parent, task) => {
      seedStore(4);
      payloads.set(4, {
        ...CONTEXT_AT_STEP_4,
        fixedLoad: {
          ...SPLIT_LOAD,
          startup: [
            {
              loadId: 8,
              kind: "preloaded-skill",
              name: "house-style",
              count: null,
              chars: 9_000,
              tokens: 3_104,
              fromContext: false,
            },
            {
              loadId: 9,
              kind: "task-prompt",
              name: parent,
              count: null,
              chars: 2_000,
              tokens: 690,
              fromContext: false,
            },
          ],
        },
      });
      await renderLens();
      const rows = texts(".snapshot-fixed .snapshot-row");
      const skill = rows.find((row) => row.includes("Skill loaded at start"));
      expect(skill).toContain("Skill loaded at start · house-style");
      expect(skill).toContain("about 3.1K tokens");
      expect(skill).toContain("est.");
      expect(rows.join("\n")).not.toContain("Agent definition");
      const sent = rows.find((row) => row.startsWith("Task from"));
      expect(sent).toContain(task);
      expect(sent).toContain("about 690 tokens");
    },
  );

  it("marks a size from the /context report, plain and apart from the estimates", async () => {
    seedStore(4);
    const [skills, ...others] = SPLIT_LOAD.startup;
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: {
        ...SPLIT_LOAD,
        system: { chars: 34_000, tokens: 2_800, fromContext: true },
        startup: [{ ...skills!, tokens: 8_300, fromContext: true }, ...others],
      },
    });
    await renderLens();
    const rows = texts(".snapshot-fixed .snapshot-row");
    const system = rows.find((row) => row.includes("System prompt"));
    expect(system).toContain("2.8K tokens");
    expect(system).toContain("from /context");
    expect(system).not.toContain("est.");
    const reported = rows.find((row) => row.includes("Skills listing"));
    expect(reported).toContain("8.3K tokens");
    expect(reported).not.toContain("about");
    const servers = rows.find((row) => row.includes("MCP server instructions"));
    expect(servers).toContain("about 929 tokens");
    expect(servers).toContain("est.");
    expect(servers).not.toContain("from /context");
  });

  it("keeps the keyboard's place on the tools toggle", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, fixedLoad: SPLIT_LOAD });
    await renderLens();
    const panel = container.querySelector(".snapshot-fixed");
    const toggle = [...panel!.querySelectorAll("button")].find(
      (el) => el.textContent === "Show all 7 tools",
    );
    expect(toggle).not.toBeUndefined();
    // Enter presses a focused button: the tools open, and
    // the toggle — still on the panel, now offering the
    // top few — holds the focus the keyboard left on it.
    act(() => toggle!.focus());
    act(() => toggle!.click());
    const folded = [...panel!.querySelectorAll("button")].find(
      (el) => el.textContent === "Show the top 5",
    );
    expect(folded).not.toBeUndefined();
    expect(folded!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(folded);
    // The same control folds the tools away again, and
    // keeps the focus through that press too.
    act(() => folded!.click());
    const again = [...panel!.querySelectorAll("button")].find(
      (el) => el.textContent === "Show all 7 tools",
    );
    expect(again).not.toBeUndefined();
    expect(again!.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(again);
  });

  it("names the remainder as history alone when the load is split", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, fixedLoad: SPLIT_LOAD });
    await renderLens();
    // Split, the panel names the system prompt and tools
    // itself, so what is left is history only.
    expect(
      texts(".snapshot-row").some((row) =>
        row.includes("Other (history Flightpath can’t name)"),
      ),
    ).toBe(true);
    expect(
      texts(".snapshot-row").some((row) =>
        row.includes("Other (system, tools, history)"),
      ),
    ).toBe(false);
  });

  it("reads a startup count of one with the singular noun", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: {
        ...SPLIT_LOAD,
        startup: [
          {
            loadId: 3,
            kind: "skill-listing",
            name: null,
            count: 1,
            chars: 400,
            tokens: 100,
            fromContext: false,
          },
          {
            loadId: 4,
            kind: "mcp-instructions",
            name: null,
            count: 1,
            chars: 400,
            tokens: 100,
            fromContext: false,
          },
        ],
      },
    });
    await renderLens();
    const panel = container.querySelector(".snapshot-fixed");
    expect(panel?.textContent).toContain("Skills listing · 1 skill");
    expect(panel?.textContent).toContain("MCP server instructions · 1 server");
  });

  it("prints no count on a startup line whose load counts nothing", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: {
        ...SPLIT_LOAD,
        startup: [
          {
            loadId: 3,
            kind: "skill-listing",
            name: null,
            count: null,
            chars: 400,
            tokens: 100,
            fromContext: false,
          },
          {
            loadId: 4,
            kind: "mcp-instructions",
            name: null,
            count: null,
            chars: 400,
            tokens: 100,
            fromContext: false,
          },
          {
            loadId: 6,
            kind: "deferred-tool-names",
            name: null,
            count: null,
            chars: 400,
            tokens: 100,
            fromContext: false,
          },
        ],
      },
    });
    await renderLens();
    const panel = container.querySelector(".snapshot-fixed");
    const names = [...panel!.querySelectorAll(".snapshot-row")].map((row) =>
      (row.textContent ?? "").split("about")[0]?.trim(),
    );
    // Each line stands bare under its exact name: no count
    // follows it — no "·", and no "0" standing in for none.
    expect(names).toContain("Skills listing");
    expect(names).toContain("MCP server instructions");
    expect(names).toContain("Names of tools loaded on demand");
  });

  it("shows the total as one line when the load was not split", async () => {
    seedStore(4);
    await renderLens();
    // The planted fixture's own answer: no shape recorded,
    // so the base total stands as one line.
    expect(container.textContent).toContain(
      "Fixed load: about 20.0K tokens, not split (this Claude Code version doesn’t record it).",
    );
    expect(container.querySelector(".snapshot-fixed")).not.toBeNull();
    expect(
      texts(".snapshot-row").some((row) => row.includes("System prompt")),
    ).toBe(false);
  });

  it("leaves the panel out when no fixed load was recorded", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, fixedLoad: null });
    await renderLens();
    expect(container.querySelector(".snapshot-fixed")).toBeNull();
    expect(container.textContent).not.toContain("Sent on every request");
  });

  it("shows no compaction panel at a step the compaction hadn't reached", async () => {
    seedStore(6);
    await renderLens();
    expect(container.querySelector(".snapshot-compaction")).toBeNull();
    expect(container.textContent).not.toContain("After the compaction");
  });

  it("shows the before, greyed and folded, and what was restored", async () => {
    seedStore(8);
    await renderLens();
    const panel = container.querySelector(".snapshot-compaction");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain(
      `After the compaction at ${formatClock(76_000)}`,
    );
    // The step's own snapshot still stands above the panel.
    expect(container.textContent).toContain("of 27,000 measured");
    // Folded: the head carries the count and the estimate,
    // and none of the groups stand open yet.
    const before = panel!.querySelector(".snapshot-before");
    expect(before).not.toBeNull();
    const head = before!.querySelector(".snapshot-group-head");
    expect(head?.textContent).toContain("Before the compaction");
    expect(head?.textContent).toContain("23 items");
    expect(head?.textContent).toContain("about 246.8K tokens");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(before!.querySelectorAll(".snapshot-group").length).toBe(1);
    // Asked for, the stretch stands in the grouped list.
    act(() => (head as HTMLButtonElement).click());
    const titles = [...before!.querySelectorAll(".snapshot-group-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toContain("Files read");
    expect(titles).toContain("Claude's replies");
    // Restored: each item as the payload gives it, the
    // skill named a skill, every one with the note, and
    // the docs link under them.
    const restored = [...panel!.querySelectorAll(".snapshot-row")].map(
      (row) => row.textContent ?? "",
    );
    const file = restored.find((row) => row.includes("a file"));
    expect(file).toContain("restored by Claude Code (per its docs)");
    const skill = restored.find((row) => row.includes("deep-research"));
    expect(skill).toContain("deep-research (skill)");
    expect(skill).toContain("restored by Claude Code (per its docs)");
    const link = panel!.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://code.claude.com/docs/en/context-window#what-survives-compaction",
    );
    expect(link?.textContent).toBe("How compaction works");
  });

  it("says whether Claude Code read a recorded file again or only named it", async () => {
    seedStore(8);
    payloads.set(8, {
      ...CONTEXT_AT_STEP_8,
      compaction: {
        ...CONTEXT_AT_STEP_8.compaction!,
        restored: [
          {
            kind: "file",
            ref: 1,
            name: "data\\orders.csv",
            reread: false,
            tokens: null,
          },
          {
            kind: "file",
            ref: 2,
            name: "src\\totals.js",
            reread: true,
            tokens: 240,
          },
          { kind: "skill", ref: 1, name: "deep-research" },
        ],
      },
    });
    await renderLens();
    const rows = [
      ...container.querySelectorAll(".snapshot-compaction .snapshot-row"),
    ].map((row) => row.textContent ?? "");
    const named = rows.find((row) => row.includes("orders.csv"));
    expect(named).toContain("named only, not re-read");
    expect(named).not.toContain("tokens");
    const reread = rows.find((row) => row.includes("totals.js"));
    expect(reread).toContain("re-read by Claude Code");
    expect(reread).toContain("about 240 tokens");
    const skill = rows.find((row) => row.includes("deep-research"));
    expect(skill).toContain("restored by Claude Code (per its docs)");
  });

  it("counts one item before the compaction as one item", async () => {
    seedStore(8);
    const compaction = CONTEXT_AT_STEP_8.compaction!;
    payloads.set(8, {
      ...CONTEXT_AT_STEP_8,
      compaction: { ...compaction, before: compaction.before.slice(0, 1) },
    });
    await renderLens();
    const head = container.querySelector(
      ".snapshot-before .snapshot-group-head",
    );
    expect(head?.textContent).toContain("1 item");
    expect(head?.textContent).not.toContain("1 items");
  });

  it("counts two items before the compaction as two items", async () => {
    seedStore(8);
    const compaction = CONTEXT_AT_STEP_8.compaction!;
    payloads.set(8, {
      ...CONTEXT_AT_STEP_8,
      compaction: { ...compaction, before: compaction.before.slice(0, 2) },
    });
    await renderLens();
    const head = container.querySelector(
      ".snapshot-before .snapshot-group-head",
    );
    expect(head?.textContent).toContain("2 items");
  });
});

describe("a skill and the files it attached", () => {
  const SKILL: ContextItem = {
    kind: "skill",
    loadId: 1,
    name: "code-style",
    bytes: 9_280,
    tokens: 3_200,
    files: {
      tokens: 21_600,
      items: [
        {
          loadId: 2,
          path: "docs/a.md",
          bytes: 29_000,
          lines: 600,
          tokens: 10_000,
        },
        {
          loadId: 3,
          path: "docs/b.md",
          bytes: 21_750,
          lines: 400,
          tokens: 7_500,
        },
        {
          loadId: 4,
          path: "docs/c.md",
          bytes: 11_890,
          lines: 1,
          tokens: 4_100,
        },
      ],
    },
  };

  async function renderSkill(item: ContextItem): Promise<void> {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, items: [item] });
    await renderLens();
    expandAllGroups();
  }

  const filesHead = (): HTMLButtonElement | null =>
    container.querySelector(".skill-files-head");

  it("lists the files beneath the skill, with their own estimated size", async () => {
    await renderSkill(SKILL);
    const row = container.querySelector(".snapshot-row");
    expect(row?.textContent).toBe("code-styleabout 3.2K tokensest.");
    expect(filesHead()?.textContent).toBe(
      "+ 3 files it attachedabout 21.6K tokensest.",
    );
  });

  it("counts the files in the skill group's sum", async () => {
    await renderSkill(SKILL);
    const skills = [...container.querySelectorAll(".snapshot-group-head")].find(
      (head) =>
        head.querySelector(".snapshot-group-title")?.textContent === "Skills",
    );
    expect(skills?.querySelector(".snapshot-sum")?.textContent).toBe(
      "about 24.8K tokensest.",
    );
  });

  it("orders a skill among its group by its text and its files together", async () => {
    seedStore(4);
    const other: ContextItem = {
      kind: "skill",
      loadId: 5,
      name: "naming",
      bytes: 14_500,
      tokens: 5_000,
      files: null,
    };
    payloads.set(4, { ...CONTEXT_AT_STEP_4, items: [other, SKILL] });
    await renderLens();
    expandAllGroups();
    const names = [...container.querySelectorAll(".snapshot-row")].map((row) =>
      row.textContent?.slice(0, 5),
    );
    expect(names.slice(0, 2)).toEqual(["code-", "namin"]);
  });

  it("opens the files by path, lines and size", async () => {
    await renderSkill(SKILL);
    const head = filesHead();
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector<HTMLElement>(".skill-files-list");
    expect(list?.hidden).toBe(true);
    act(() => head?.click());
    expect(head?.getAttribute("aria-expanded")).toBe("true");
    expect(list?.hidden).toBe(false);
    expect(head?.getAttribute("aria-controls")).toBe(list?.id);
    expect(texts(".skill-files-path")).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
    ]);
    expect(texts(".skill-files-detail")).toEqual([
      "600 lines · 29.0 KB",
      "400 lines · 21.8 KB",
      "1 line · 11.9 KB",
    ]);
  });

  it("says one file in the singular, and an unmeasured file's size is not known", async () => {
    await renderSkill({
      ...SKILL,
      files: {
        tokens: 0,
        items: [
          {
            loadId: 2,
            path: "docs/a.md",
            bytes: null,
            lines: null,
            tokens: null,
          },
        ],
      },
    });
    expect(filesHead()?.textContent).toBe("+ 1 file it attachedsize not known");
    expect(texts(".skill-files-file")).toEqual(["docs/a.mdsize not known"]);
  });

  it("shows a skill that attached nothing as a plain row", async () => {
    await renderSkill({ ...SKILL, files: null });
    expect(filesHead()).toBeNull();
  });
});

describe("one honest total, and the instruction file once", () => {
  const INSTRUCTION_ITEM: ContextItem = {
    kind: "instructions",
    loadId: 1,
    name: "CLAUDE.md",
    bytes: 2_400,
    tokens: null,
    files: null,
  };

  function instructionHead(): string {
    const head = [...container.querySelectorAll(".snapshot-group-head")].find(
      (el) => el.textContent?.includes("Instructions (CLAUDE.md)"),
    );
    return head?.textContent ?? "";
  }

  it("prints the API's named total, fixed load included, against the measured count", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: SPLIT_LOAD,
      totals: { measured: 85_000, items: 25_400, named: 68_000, other: 17_000 },
    });
    await renderLens();
    expect(container.textContent).toContain(
      "Named: ? about 68K of 85,000 measured ? (80%)",
    );
    expect(container.textContent).not.toContain("Listed items");
  });

  it("reads 100% when nothing is left unexplained", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      totals: { measured: 85_000, items: 40_000, named: 85_000, other: null },
    });
    await renderLens();
    expect(container.textContent).toContain(
      "Named: ? about 85K of 85,000 measured ? (100%)",
    );
  });

  it("names an instruction file in the list with no size when the fixed load sizes it", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: SPLIT_LOAD,
      items: [INSTRUCTION_ITEM],
    });
    await renderLens();
    expect(instructionHead()).toContain("1 instruction file · counted above");
    expect(instructionHead()).not.toContain("tokens");
    expandAllGroups();
    const row = texts(".snapshot-group .snapshot-row").find((r) =>
      r.includes("CLAUDE.md"),
    );
    expect(row).not.toContain("tokens");
    const fixed = texts(".snapshot-fixed .snapshot-row");
    expect(fixed.filter((r) => r.includes("CLAUDE.md"))).toEqual([
      expect.stringContaining("about 600 tokens"),
    ]);
  });

  it("sizes the instruction file in the list when the fixed load is one total", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      items: [{ ...INSTRUCTION_ITEM, tokens: 600 }],
    });
    await renderLens();
    expect(instructionHead()).not.toContain("counted above");
    expect(instructionHead()).toContain("about 600 tokens");
  });

  it("says where the tools' total came from, and keeps each row an estimate", async () => {
    seedStore(4);
    payloads.set(4, {
      ...CONTEXT_AT_STEP_4,
      fixedLoad: { ...SPLIT_LOAD, toolsReported: 25_300 },
    });
    await renderLens();
    expect(texts(".snapshot-tools-reported")).toEqual([
      "Tools: 25.3K from /context, shared out by definition size",
    ]);
    const task = texts(".snapshot-fixed .snapshot-row").find((r) =>
      r.startsWith("Task"),
    );
    expect(task).toContain("est.");
  });

  it("omits the line when no report gave the tools", async () => {
    seedStore(4);
    payloads.set(4, { ...CONTEXT_AT_STEP_4, fixedLoad: SPLIT_LOAD });
    await renderLens();
    expect(container.querySelector(".snapshot-tools-reported")).toBeNull();
  });

  it("tags a measured result and prints it without about", async () => {
    seedStore(4);
    await renderLens();
    expandAllGroups();
    const measured = texts(".snapshot-row").find((r) =>
      r.includes("34.7K tokens"),
    );
    expect(measured).toContain("measured");
    expect(measured).not.toContain("about");
    expect(measured).not.toContain("est.");
  });
});
