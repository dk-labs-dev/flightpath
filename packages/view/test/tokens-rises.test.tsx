// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type {
  Rise,
  RiseItem,
  TurnTokens,
} from "@flightpath/flightpath/api/payloads";
import { formatClock } from "@flightpath/flightpath/format";

import { jsonResponse } from "./fixtures.js";
import {
  container,
  history,
  renderLens,
  setResponder,
  setupTokensLensTests,
  T0,
  texts,
} from "./support/tokens-lens-harness.js";
import { plantedTokenHistory } from "./tokens-history-fixture.js";

// The rises list and the turns table, against the lens they
// ship in. The fixture is the daemon's own payload for the
// planted session — generated from the planted seed (the
// daemon's tests keep it from drifting) — so the list is
// checked against what the daemon actually says, and the
// expected labels and figures below are spelled out as
// literals, never borrowed from the component under test.

setupTokensLensTests(() =>
  Promise.resolve(jsonResponse(200, plantedTokenHistory)),
);

function handRise(id: string, delta: number): Rise {
  return {
    id,
    fromRequestId: 1,
    toRequestId: 2,
    at: T0,
    delta,
    link: "exact",
    items: [{ kind: "other", tokens: delta, estimated: true }],
  };
}

/** Open one planted rise's row and return its item rows. */
async function openRise(index: number): Promise<Element[]> {
  const head = container.querySelectorAll(".tokens-rise-head")[index];
  await act(async () => {
    (head as HTMLButtonElement).click();
  });
  return [
    ...(head?.closest(".tokens-rise")?.querySelectorAll(".tokens-rise-item") ??
      []),
  ];
}

describe("the planted fixture's rises", () => {
  it("counts the rises over the floor", async () => {
    // The fixture's own sanity: the planted session's
    // history, as the daemon builds it today.
    expect(plantedTokenHistory.rises).toHaveLength(8);
    await renderLens();
    expect(texts(".tokens-rises-count")).toEqual(["8 rises over 2K tokens"]);
  });

  it("reads each rise's delta in the short form", async () => {
    await renderLens();
    expect(texts(".tokens-rise-delta")).toEqual([
      "+100K",
      "+35K",
      "+18K",
      "+12K",
      "+8K",
      "+5K",
      "+4K",
      "+2K",
    ]);
  });

  it("words each rise's link the way it was found", async () => {
    await renderLens();
    expect(texts(".tokens-rise-link")).toEqual([
      "steps linked",
      "steps linked",
      "steps linked",
      "steps linked",
      "no step linked",
      "no step linked",
      "steps linked",
      "no step linked",
    ]);
  });

  it("stands each rise's head on its time and its turn", async () => {
    await renderLens();
    // The turn each rise landed in, spelled out: the turn
    // of the point the rise ends on, read off the fixture.
    const turns = [3, 1, 1, 2, 3, 3, 3, 3];
    const expected = plantedTokenHistory.rises.map(
      (rise, index) => `${formatClock(rise.at)} · turn ${turns[index]}`,
    );
    const metas = [...container.querySelectorAll(".tokens-rise-meta")].map(
      (el) => el.textContent?.trim(),
    );
    expect(metas).toEqual(expected);
  });

  it("names every rise's items, spelled out", async () => {
    await renderLens();
    const expectedLabels: Record<string, string[]> = {
      "rise-8": ["Read a file", "Claude's reply to the request before"],
      "rise-2": ["Read a file", "Claude's reply to the request before"],
      "rise-3": [
        "Read a file",
        "Ran a command",
        "Claude's reply to the request before",
      ],
      "rise-5": ["Started a subagent", "Claude's reply to the request before"],
      "rise-7": [
        "other (system, tools, history)",
        "Claude's reply to the request before",
        "Your prompt, turn 3",
      ],
      "rise-10": [
        "other (system, tools, history)",
        "Claude's reply to the request before",
        "Loaded the deep-research skill",
      ],
      "rise-9": ["Ran a command", "Claude's reply to the request before"],
      "rise-14": [
        "other (system, tools, history)",
        "Claude's reply to the request before",
      ],
    };
    for (const [index, rise] of plantedTokenHistory.rises.entries()) {
      const rows = await openRise(index);
      expect(
        rows.map(
          (row) =>
            row.querySelector(".tokens-rise-item-name")?.textContent ?? "",
        ),
      ).toEqual(expectedLabels[rise.id]);
    }
  });

  it("sizes every rise's items in their own voices", async () => {
    await renderLens();
    const expectedValues: Record<
      string,
      { text: string; tag: "est." | "measured" | null }[]
    > = {
      "rise-8": [
        { text: "99,400 tokens", tag: "measured" },
        { text: "600 tokens", tag: null },
      ],
      "rise-2": [
        { text: "34,700 tokens", tag: "measured" },
        { text: "300 tokens", tag: null },
      ],
      "rise-3": [
        { text: "about 16.0K tokens", tag: "est." },
        { text: "about 2.0K tokens", tag: "est." },
        { text: "400 tokens", tag: null },
      ],
      "rise-5": [
        { text: "about 12.0K tokens", tag: "est." },
        { text: "200 tokens", tag: null },
      ],
      "rise-7": [
        { text: "about 7.8K tokens", tag: "est." },
        { text: "200 tokens", tag: null },
        { text: "about 50 tokens", tag: "est." },
      ],
      "rise-10": [
        { text: "about 4.7K tokens", tag: "est." },
        { text: "300 tokens", tag: null },
        { text: "size not known", tag: null },
      ],
      "rise-9": [
        { text: "3,300 tokens", tag: "measured" },
        { text: "700 tokens", tag: null },
      ],
      "rise-14": [
        { text: "about 1.7K tokens", tag: "est." },
        { text: "300 tokens", tag: null },
      ],
    };
    for (const [index, rise] of plantedTokenHistory.rises.entries()) {
      const rows = await openRise(index);
      const expected = expectedValues[rise.id] ?? [];
      expect(rows).toHaveLength(expected.length);
      for (const [itemIndex, value] of expected.entries()) {
        const row = rows[itemIndex];
        expect(row?.textContent).toContain(value.text);
        const tag = row?.querySelector(".tokens-est, .tokens-measured");
        expect(tag?.textContent ?? null).toBe(value.tag);
      }
    }
  });

  it("marks the selected rise's two points on the curve", async () => {
    await renderLens();
    expect(container.querySelectorAll(".tokens-rise-point")).toHaveLength(0);
    const head = container.querySelector(".tokens-rise-head");
    await act(async () => {
      (head as HTMLButtonElement).click();
    });
    expect(container.querySelectorAll(".tokens-rise-point")).toHaveLength(2);
    expect(
      container
        .querySelector(".tokens-rise")
        ?.classList.contains("tokens-rise-selected"),
    ).toBe(true);
  });
});

/** The one-line label of each rise, as the list reads it. */
function headlines(): string[] {
  return [
    ...container.querySelectorAll(".tokens-rise-main > span:first-child"),
  ].map((el) => el.textContent ?? "");
}

describe("a rise's headline", () => {
  // A CSV read whose unnamed remainder is the largest item,
  // and the read is what the rise was.
  const csvRise: Rise = {
    id: "rise-4",
    fromRequestId: 3,
    toRequestId: 4,
    at: T0,
    delta: 23_600,
    link: "exact",
    items: [
      { kind: "other", tokens: 14_000, estimated: true },
      {
        kind: "step",
        stepId: 7,
        label: "Read table.csv",
        chars: 27_800,
        rawChars: null,
        tokens: 9_600,
        estimated: true,
      },
      { kind: "reply", requestId: 3, tokens: 210, estimated: false },
    ],
  };

  it("leads with the largest named item, not the unnamed remainder", async () => {
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [csvRise] }))),
    );
    await renderLens();
    expect(headlines()).toEqual(["Read table.csv, and 2 more"]);
  });

  it("keeps the items in size order when the rise opens", async () => {
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [csvRise] }))),
    );
    await renderLens();
    const rows = await openRise(0);
    expect(
      rows.map(
        (row) => row.querySelector(".tokens-rise-item-name")?.textContent,
      ),
    ).toEqual([
      "other (system, tools, history)",
      "Read table.csv",
      "Claude's reply to the request before",
    ]);
  });

  it("gives a rise with one item that item alone", async () => {
    const rise: Rise = {
      ...csvRise,
      items: [csvRise.items[1]!],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    expect(headlines()).toEqual(["Read table.csv"]);
  });

  it("says a rise with only the remainder was not named", async () => {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ rises: [handRise("rise-2", 3_100)] })),
      ),
    );
    await renderLens();
    expect(headlines()).toEqual(["not named"]);
  });

  it("names a command's report by the command", async () => {
    const rise: Rise = {
      ...csvRise,
      items: [
        {
          kind: "load",
          loadId: 5,
          loadKind: "command-output",
          name: "/context",
          bytes: 9_662,
          tokens: 3_300,
          files: null,
          estimated: true,
        },
        { kind: "other", tokens: 100, estimated: true },
      ],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    expect(headlines()).toEqual(["Output of /context, and 1 more"]);
  });
});

describe("a skill's files in a rise", () => {
  const skillRise = (skill: RiseItem): Rise => ({
    ...handRise("rise-2", 40_000),
    items: [skill, { kind: "other", tokens: 9_000, estimated: true }],
  });

  const SKILL_ITEM: RiseItem = {
    kind: "load",
    loadId: 1,
    loadKind: "skill",
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
          lines: 300,
          tokens: 4_100,
        },
      ],
    },
    estimated: true,
  };

  async function renderSkillRise(item: RiseItem): Promise<void> {
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [skillRise(item)] }))),
    );
    await renderLens();
    await openRise(0);
  }

  it("lists the skill by its own size and its files as one line beneath", async () => {
    await renderSkillRise(SKILL_ITEM);
    expect(texts(".tokens-rise-item")).toEqual([
      "Loaded the code-style skillabout 3.2K tokens est.",
      "other (system, tools, history)about 9.0K tokens est.",
    ]);
    expect(texts(".skill-files-head")).toEqual([
      "+ 3 files it attachedabout 21.6K tokensest.",
    ]);
  });

  it("opens the files by path, lines and size", async () => {
    await renderSkillRise(SKILL_ITEM);
    const head =
      container.querySelector<HTMLButtonElement>(".skill-files-head");
    expect(
      container.querySelector<HTMLElement>(".skill-files-list")?.hidden,
    ).toBe(true);
    await act(async () => {
      head?.click();
    });
    expect(
      container.querySelector<HTMLElement>(".skill-files-list")?.hidden,
    ).toBe(false);
    expect(texts(".skill-files-path")).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
    ]);
    expect(texts(".skill-files-detail")).toEqual([
      "600 lines · 29.0 KB",
      "400 lines · 21.8 KB",
      "300 lines · 11.9 KB",
    ]);
  });

  it("leaves a skill that attached nothing as a single row", async () => {
    await renderSkillRise({ ...SKILL_ITEM, files: null });
    expect(container.querySelector(".skill-files")).toBeNull();
  });

  it("names a skill whose own size is not known and whose files are", async () => {
    await renderSkillRise({ ...SKILL_ITEM, bytes: null, tokens: null });
    expect(texts(".tokens-rise-item")[0]).toBe(
      "Loaded the code-style skillsize not known",
    );
    expect(texts(".skill-files-head")).toEqual([
      "+ 3 files it attachedabout 21.6K tokensest.",
    ]);
  });
});

describe("a rise's item voices", () => {
  it("keeps measured, estimated and unknown visibly apart", async () => {
    const rise: Rise = {
      id: "rise-2",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 50_000,
      link: "exact",
      items: [
        {
          kind: "step",
          stepId: 9,
          label: "A tool read a big file",
          chars: 4_800,
          rawChars: 182_000,
          tokens: 1_200,
          estimated: true,
        },
        {
          kind: "step",
          stepId: 8,
          label: "A tool read a file",
          chars: 36_800,
          rawChars: null,
          tokens: 9_200,
          estimated: true,
        },
        { kind: "reply", requestId: 1, tokens: 2_140, estimated: false },
        {
          kind: "attachment",
          turnId: 1,
          attachmentKind: "image",
          name: null,
          bytes: 312_000,
          tokens: null,
          estimated: true,
        },
      ],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    const head = container.querySelector(".tokens-rise-head");
    await act(async () => {
      (head as HTMLButtonElement).click();
    });
    const rows = [...container.querySelectorAll(".tokens-rise-item")];
    expect(rows).toHaveLength(4);
    // The cut-down step says what stayed out, both sizes
    // through the formatter.
    expect(rows[0]?.textContent).toContain(
      "only 4.8 KB of the output’s 182.0 KB entered context",
    );
    // Estimated: the secondary colour and the tag.
    expect(rows[1]?.querySelector(".tokens-rise-est")).not.toBeNull();
    expect(rows[1]?.querySelector(".tokens-est")?.textContent).toBe("est.");
    expect(rows[1]?.querySelector(".tokens-est")?.getAttribute("title")).toBe(
      "Worked out from the number of characters, at about 2.9 per token. Close, not exact.",
    );
    expect(rows[1]?.textContent).toContain("about 9.2K tokens");
    // Measured: plain, exact, untagged.
    expect(rows[2]?.querySelector(".tokens-rise-est")).toBeNull();
    expect(rows[2]?.querySelector(".tokens-est")).toBeNull();
    expect(rows[2]?.textContent).toContain("2,140 tokens");
    // An image's tokens aren't in any figure: said so, never a number.
    expect(rows[3]?.textContent).toContain("tokens not measured");
    expect(rows[3]?.textContent).not.toContain("size not known");
    expect(rows[3]?.querySelector(".tokens-est")).toBeNull();
  });

  it("estimates a text file attachment from its bytes", async () => {
    const rise: Rise = {
      id: "rise-2",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 2_040,
      link: "exact",
      items: [
        {
          kind: "attachment",
          turnId: 1,
          attachmentKind: "file",
          name: "data\\orders.csv",
          bytes: 2_000,
          tokens: 690,
          estimated: true,
        },
      ],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    const rows = await openRise(0);
    expect(rows[0]?.textContent).toContain("about 690 tokens");
    expect(rows[0]?.textContent).not.toContain("not known");
    expect(rows[0]?.querySelector(".tokens-est")?.textContent).toBe("est.");
  });

  it("reads an estimate under a thousand as a plain count", async () => {
    const rise: Rise = {
      id: "rise-2",
      fromRequestId: 1,
      toRequestId: 2,
      at: T0,
      delta: 2_040,
      link: "exact",
      items: [{ kind: "other", tokens: 40, estimated: true }],
    };
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ rises: [rise] }))),
    );
    await renderLens();
    const rows = await openRise(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("about 40 tokens");
    expect(rows[0]?.querySelector(".tokens-est")?.textContent).toBe("est.");
  });
});

describe("the rises explanation", () => {
  it("opens from its button, with the measuring words", async () => {
    await renderLens();
    const button = container.querySelector(
      'button[aria-label="What is a rise?"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(
      "Totals are measured from Claude Code's own usage figures. " +
        "A tool result that arrives alone is measured from its rise. " +
        "Other sizes are estimated at about 2.9 characters per token, " +
        "so they won't add up exactly; the difference is shown as other.",
    );
  });

  it("explains the link words beside the first rise's own", async () => {
    await renderLens();
    const button = [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === "What is a rise's link?",
    ) as HTMLButtonElement;
    expect(button).not.toBeUndefined();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const note = button.closest(".tokens-rise")?.querySelector(".explain-note");
    expect(note?.textContent).toBe(
      "Steps linked: Claude Code's transcript says which step's result " +
        "went into this request. Found by time: the steps that finished " +
        "between the two requests.",
    );
  });
});

describe("show all", () => {
  it("shows ten rises, then every one on the ask", async () => {
    const rises = Array.from({ length: 12 }, (_, index) =>
      handRise(`rise-${index + 2}`, 13_000 - index * 1_000),
    );
    setResponder(() => Promise.resolve(jsonResponse(200, history({ rises }))));
    await renderLens();
    expect(texts(".tokens-rises-count")).toEqual(["12 rises over 2K tokens"]);
    expect(container.querySelectorAll(".tokens-rise")).toHaveLength(10);
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Show all 12 rises",
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => {
      button.click();
    });
    expect(container.querySelectorAll(".tokens-rise")).toHaveLength(12);
    expect(
      [...container.querySelectorAll("button")].some((candidate) =>
        candidate.textContent?.includes("Show all"),
      ),
    ).toBe(false);
    // The button unmounted as it was pressed: focus lands
    // on the first newly shown rise's head, not the body.
    const heads = container.querySelectorAll(".tokens-rise-head");
    expect(document.activeElement).toBe(heads[10]);
  });
});

const TABLE_TURNS: TurnTokens[] = [
  {
    turnId: 1,
    sequence: 1,
    input: 100,
    output: 900,
    cacheRead: 500,
    cacheWrite: 50,
    contextStart: 10_000,
    contextEnd: 12_000,
    contextChange: 2_000,
    promptLine: "Fix the bug",
    promptChars: 11,
  },
  {
    turnId: 2,
    sequence: 2,
    input: 300,
    output: 100,
    cacheRead: 900,
    cacheWrite: 20,
    contextStart: 20_000,
    contextEnd: 15_000,
    contextChange: -5_000,
    promptLine: null,
    promptChars: 74_210,
  },
  {
    turnId: 3,
    sequence: 3,
    input: 200,
    output: 500,
    cacheRead: 100,
    cacheWrite: 80,
    contextStart: null,
    contextEnd: null,
    contextChange: null,
    promptLine: null,
    promptChars: null,
  },
];

function rowSequences(): number[] {
  return [...container.querySelectorAll(".tokens-turns-table tbody tr")].map(
    (row) => Number(row.querySelector("td")?.textContent),
  );
}

async function clickHeader(label: string): Promise<void> {
  const button = [
    ...container.querySelectorAll(".tokens-turns-table th button"),
  ].find((candidate) => candidate.textContent?.includes(label) ?? false) as
    HTMLButtonElement | undefined;
  if (button === undefined) throw new Error(`no header button ${label}`);
  await act(async () => {
    button.click();
  });
}

function sortedTh(label: string): Element | undefined {
  return [...container.querySelectorAll(".tokens-turns-table th")].find(
    (candidate) => candidate.textContent?.includes(label) ?? false,
  );
}

describe("the turns table", () => {
  function seedTable(): void {
    setResponder(() =>
      Promise.resolve(
        jsonResponse(200, history({ turns: TABLE_TURNS, rises: [] })),
      ),
    );
  }

  it("heads the table with its caption and column scopes", async () => {
    seedTable();
    await renderLens();
    expect(
      container.querySelector(".tokens-turns-table caption")?.textContent,
    ).toBe("Turns, in tokens");
    expect(
      [...container.querySelectorAll(".tokens-turns-table th")].every(
        (th) => th.getAttribute("scope") === "col",
      ),
    ).toBe(true);
  });

  it("lists the turns in the payload's order until sorted", async () => {
    seedTable();
    await renderLens();
    expect(rowSequences()).toEqual([1, 2, 3]);
  });

  it("reads the payload's prompt fields into its cells", async () => {
    seedTable();
    await renderLens();
    expect(texts(".tokens-turns-prompt")).toEqual([
      "Fix the bug",
      "length 74,210",
      "not kept",
    ]);
  });

  it("reads each turn's figures as plain counts", async () => {
    seedTable();
    await renderLens();
    const firstRow = [
      ...container.querySelectorAll(".tokens-turns-table tbody tr"),
    ][0];
    const cells = [...(firstRow?.querySelectorAll("td") ?? [])].map((td) =>
      td.textContent?.trim(),
    );
    expect([cells[0], cells[2], cells[3], cells[4], cells[5]]).toEqual([
      "1",
      "100",
      "900",
      "500",
      "50",
    ]);
  });

  it("signs the change the same way, a dash when there is none", async () => {
    seedTable();
    await renderLens();
    const changeCells = [
      ...container.querySelectorAll(".tokens-turns-table tbody tr"),
    ].map((row) => row.querySelectorAll("td")[6]?.textContent?.trim());
    expect(changeCells).toEqual(["+2,000", "−5,000", "—"]);
  });

  const SORT_CASES: [string, number[], number[]][] = [
    ["Input", [1, 3, 2], [2, 3, 1]],
    ["Output", [2, 3, 1], [1, 3, 2]],
    ["Cache read", [3, 1, 2], [2, 1, 3]],
    ["Cache write", [2, 1, 3], [3, 1, 2]],
    // "not kept" stands last in both directions, so the
    // Prompt column's descending run is [2, 1, 3], not a
    // plain reversal.
    ["Prompt", [1, 2, 3], [2, 1, 3]],
    ["Context change", [2, 1, 3], [1, 2, 3]],
  ];

  it.each(SORT_CASES)(
    "sorts the %s column both ways, aria-sort following",
    async (label, ascending, descending) => {
      seedTable();
      await renderLens();
      await clickHeader(label);
      expect(sortedTh(label)?.getAttribute("aria-sort")).toBe("ascending");
      expect(rowSequences()).toEqual(ascending);
      await clickHeader(label);
      expect(sortedTh(label)?.getAttribute("aria-sort")).toBe("descending");
      expect(rowSequences()).toEqual(descending);
      await clickHeader(label);
      expect(sortedTh(label)?.getAttribute("aria-sort")).toBe("ascending");
    },
  );

  it("sorts length-only prompts by their length, not their words", async () => {
    // The cells read "length 74,210" and "length 9,000":
    // as words the longer prompt sorts first, as lengths
    // it sorts last. The column sorts by the length.
    const promptChars: (number | null)[] = [74_210, 9_000, null];
    const turns: TurnTokens[] = TABLE_TURNS.map((turn, index) => ({
      ...turn,
      promptLine: null,
      promptChars: promptChars[index] ?? null,
    }));
    setResponder(() =>
      Promise.resolve(jsonResponse(200, history({ turns, rises: [] }))),
    );
    await renderLens();
    await clickHeader("Prompt");
    expect(rowSequences()).toEqual([2, 1, 3]);
    await clickHeader("Prompt");
    expect(rowSequences()).toEqual([1, 2, 3]);
  });

  it("sorts the Turn column from its standing order, aria-sort following", async () => {
    seedTable();
    await renderLens();
    // The table stands in turn order, so the Turn column
    // is the one already sorted: its first click turns the
    // order around instead of setting it.
    await clickHeader("Turn");
    expect(sortedTh("Turn")?.getAttribute("aria-sort")).toBe("descending");
    expect(rowSequences()).toEqual([3, 2, 1]);
    await clickHeader("Turn");
    expect(sortedTh("Turn")?.getAttribute("aria-sort")).toBe("ascending");
    expect(rowSequences()).toEqual([1, 2, 3]);
    await clickHeader("Turn");
    expect(sortedTh("Turn")?.getAttribute("aria-sort")).toBe("descending");
  });
});
