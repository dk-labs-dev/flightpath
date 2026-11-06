import { afterEach, describe, expect, it } from "vitest";

import { dismissFinding, sessionFindings } from "../src/api/index.js";
import {
  effortWording,
  expiredWording,
  modelWording,
  toolsWording,
} from "../src/api/finding-wording.js";
import type { Finding } from "../src/api/payloads.js";
import { runCleanups } from "./support/cleanup.js";
import { seedWarmPair, type PairSeed } from "./support/rebuild-pair.js";
import {
  seedBranch,
  seedOneTurn,
  seedRequestExact,
  seedRequestShape,
  seedSegment,
  seedSession,
} from "./support/seed.js";
import { makeSeedWorld } from "./support/storage.js";

afterEach(async () => {
  await runCleanups();
});

const MINUTE = 60_000;

// The first request writes for an hour, so a gap past that is an expiry.
const ONE_HOUR_CACHE: PairSeed = { cacheWrite1h: 5_000 };
// A gap of 71.48 minutes, which the finding words as 1h 11m.
const EXPIRED_71_MINUTES: PairSeed = {
  startedAt: 1_000 + 4_288_800,
  cacheWrite1h: 62_380,
};
// Nothing is read from the cache and everything is written: a
// rebuild of exactly `written` tokens, whatever else changed.
const rewrite = (written: number): PairSeed => ({
  model: "claude-opus",
  input: 0,
  cacheRead: 0,
  cacheWrite1h: written,
});

type World = ReturnType<typeof makeSeedWorld>;

function findingsOf(world: World, sessionId: string): Finding[] {
  const found = sessionFindings(world.storage, sessionId);
  if (found === undefined) throw new Error("session did not seed");
  return found;
}

/** A request `gap` after the one before it, at `after`; unless told
 * otherwise it reads nothing and writes nothing. Returns its start. */
function seedNext(
  world: World,
  sessionId: string,
  next: { id: number; after: number; gap?: number } & PairSeed,
): number {
  const { id, after, gap = MINUTE, ...fields } = next;
  const startedAt = after + gap;
  seedRequestExact(world.db, {
    id,
    sessionId,
    input: 1_000,
    output: 500,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...fields,
    startedAt,
  });
  return startedAt;
}

/** After the pair's expiry, a read and then a second expiry. */
function seedSecondExpiry(world: World, sessionId: string): void {
  const third = seedNext(world, sessionId, {
    id: 3,
    after: 4_289_800,
    cacheRead: 68_000,
  });
  seedNext(world, sessionId, {
    id: 4,
    after: third,
    gap: 71 * MINUTE,
    cacheRead: 5_000,
    cacheWrite1h: 62_000,
  });
}

describe("a rebuild after the cache expired", () => {
  it("is one finding that names the size and the time away", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-expired", ONE_HOUR_CACHE, {
      ...EXPIRED_71_MINUTES,
      turnId: 1,
    });
    expect(findingsOf(world, "sess-expired")).toEqual([
      {
        id: "rebuild-2",
        kind: "expired",
        grade: "Worth a look",
        at: 4_289_800,
        requestId: 2,
        turnId: 1,
        headline:
          "Compact before a long break · 62.4K tokens written again after 1h 11m away",
        body: "The cache had expired, so the next message wrote the conversation again. You could run /compact before stepping away, or start a fresh session if you are not coming back to this work.",
        list: [],
        more: [],
        doc: {
          label: "Prompt caching: how long the cache lasts",
          url: "https://code.claude.com/docs/en/prompt-caching#cache-lifetime",
        },
        measure: { tokens: 62_380, basis: "measured" },
        copy: null,
      },
    ]);
  });

  it("grades the second one in a session Worth fixing, and the first Worth a look", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-twice", ONE_HOUR_CACHE, EXPIRED_71_MINUTES);
    seedSecondExpiry(world, "sess-twice");
    expect(findingsOf(world, "sess-twice").map((f) => [f.id, f.grade])).toEqual(
      [
        ["rebuild-4", "Worth fixing"],
        ["rebuild-2", "Worth a look"],
      ],
    );
  });
});

describe("a rebuild after a model switch", () => {
  const sonnet = { model: "claude-sonnet-5-5" };
  const opus = { model: "claude-opus-5-5" };

  it("is one finding that names both models", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-model", sonnet, opus);
    const [finding] = findingsOf(world, "sess-model");
    expect(finding).toMatchObject({
      kind: "model",
      grade: "Worth a look",
      headline:
        "Pick your model at the start of a session · 60.0K tokens written again after the switch",
      body: "Switching from claude-sonnet-5-5 to claude-opus-5-5 could not reuse the cache, so the conversation was written again. You could choose the model before the first message.",
      doc: {
        url: "https://code.claude.com/docs/en/prompt-caching#switching-models",
      },
    });
  });

  it("is a model finding alone when effort changed with the model", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(
      world.db,
      "sess-both",
      { ...sonnet, effort: "medium" },
      { ...opus, effort: "low" },
    );
    expect(findingsOf(world, "sess-both").map((f) => f.kind)).toEqual([
      "model",
    ]);
  });
});

describe("a rebuild after an effort change", () => {
  it.each([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
  ])(
    "is a finding on %s, where the docs say the cache starts over",
    (model) => {
      const world = makeSeedWorld("flightpath-findings-");
      seedWarmPair(
        world.db,
        "sess-effort",
        { model, effort: "low" },
        { model, effort: "high" },
      );
      const [finding] = findingsOf(world, "sess-effort");
      expect(finding).toMatchObject({
        kind: "effort",
        headline:
          "Set effort at the start of a session · 60.0K tokens written again after the change",
        body: `Changing effort from low to high on ${model} started the cache over. You could pick it before the first message.`,
        doc: {
          url: "https://code.claude.com/docs/en/prompt-caching#changing-effort-level",
        },
      });
    },
  );

  it.each([
    "claude-opus-5-5",
    "claude-model-nobody-captured",
    "claude-opus-4-6-fast",
  ])(
    "is no finding on %s, where the docs say the cache is kept or say nothing",
    (model) => {
      const world = makeSeedWorld("flightpath-findings-");
      seedWarmPair(
        world.db,
        "sess-kept",
        { model, effort: "low" },
        { model, effort: "high" },
      );
      expect(findingsOf(world, "sess-kept")).toEqual([]);
    },
  );
});

describe("a rebuild after the tool list changed", () => {
  const read = { name: "Read", bytes: 100, mcp: false };
  const grep = { name: "Grep", bytes: 100, mcp: false };
  const github = { name: "mcp__github__create_issue", bytes: 300, mcp: true };
  const jira = { name: "mcp__jira__search", bytes: 200, mcp: true };

  function toolsFindings(
    before: (typeof read)[],
    after: (typeof read)[],
  ): Finding[] {
    const world = makeSeedWorld("flightpath-findings-");
    seedRequestShape(world.db, { hash: "shape-a", tools: before });
    seedRequestShape(world.db, { hash: "shape-b", tools: after });
    seedWarmPair(
      world.db,
      "sess-tools",
      { shapeHash: "shape-a" },
      { shapeHash: "shape-b" },
    );
    return findingsOf(world, "sess-tools");
  }

  it("names the server whose tool was added", () => {
    const [finding] = toolsFindings([read], [read, github]);
    expect(finding).toMatchObject({
      kind: "tools",
      headline:
        "Add or remove tool servers at the start of a session · 60.0K tokens written again after github changed",
      body: "Changing the tool list started the cache over. You could connect the servers you need before the first message.",
      doc: {
        url: "https://code.claude.com/docs/en/prompt-caching#connecting-or-removing-an-mcp-server",
      },
    });
  });

  it("names the server whose tool was removed", () => {
    expect(toolsFindings([read, jira], [read]).map((f) => f.headline)).toEqual([
      "Add or remove tool servers at the start of a session · 60.0K tokens written again after jira changed",
    ]);
  });

  it("names every server that changed", () => {
    const [finding] = toolsFindings([read], [read, jira, github]);
    expect(finding?.headline).toMatch(/after github and jira changed$/);
  });

  it("is no finding when only the hash changed", () => {
    expect(toolsFindings([read, github], [read, github])).toEqual([]);
  });

  it("is no finding when only a built-in tool changed", () => {
    expect(toolsFindings([read, github], [read, github, grep])).toEqual([]);
  });
});

describe("a rebuild that is not a finding", () => {
  it("is none after a compaction, which explains the rewrite", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-compact", {}, { model: "claude-opus" });
    seedSegment(world.db, {
      id: 7,
      sessionId: "sess-compact",
      kind: "compact",
      startedAt: 30_000,
    });
    expect(findingsOf(world, "sess-compact")).toEqual([]);
  });

  it("is none when no cause matched", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-unknown", {}, {});
    expect(findingsOf(world, "sess-unknown")).toEqual([]);
  });

  it("is none when the request before it read nothing from the cache", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(
      world.db,
      "sess-cold",
      { input: 81_000, cacheRead: 0 },
      { model: "claude-opus" },
    );
    expect(findingsOf(world, "sess-cold")).toEqual([]);
  });

  it("is none from a subagent's request or a title request", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedOneTurn(world.db, "sess-side");
    seedBranch(world.db, { id: 1, sessionId: "sess-side" });
    seedRequestExact(world.db, {
      id: 1,
      sessionId: "sess-side",
      startedAt: 1_000,
      input: 1_000,
      cacheRead: 80_000,
    });
    seedNext(world, "sess-side", {
      id: 2,
      after: 1_000,
      ...rewrite(60_000),
      branchId: 1,
    });
    seedNext(world, "sess-side", {
      id: 3,
      after: 1_000,
      ...rewrite(60_000),
      querySource: "title",
    });
    expect(findingsOf(world, "sess-side")).toEqual([]);
  });

  it("is none for a session with no requests", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedSession(world.db, { id: "sess-empty" });
    expect(findingsOf(world, "sess-empty")).toEqual([]);
  });
});

describe("the size a rebuild must reach", () => {
  it.each([
    [4_999, 0],
    [5_000, 1],
  ])("is a rewrite of %i tokens %i findings", (written, count) => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(world.db, "sess-floor", {}, rewrite(written));
    expect(findingsOf(world, "sess-floor")).toHaveLength(count);
  });

  it("is no finding for a partial rewrite of 26,000 of a 55,000 context", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedWarmPair(
      world.db,
      "sess-partial",
      {},
      { model: "claude-opus", cacheRead: 28_000, cacheWrite1h: 26_000 },
    );
    expect(findingsOf(world, "sess-partial")).toEqual([]);
  });

  it.each([
    [1_000, 1],
    [999, 0],
  ])(
    "flags a partial rewrite once input and writes reach 100,000 tokens: %i input beside 99,000 written gives %i findings",
    (input, count) => {
      const world = makeSeedWorld("flightpath-findings-");
      seedWarmPair(
        world.db,
        "sess-break",
        {},
        {
          model: "claude-opus",
          input,
          cacheRead: 160_000,
          cacheWrite1h: 99_000,
        },
      );
      expect(findingsOf(world, "sess-break")).toHaveLength(count);
    },
  );
});

describe("the findings list", () => {
  it("is ordered by grade, then tokens written, then time", () => {
    const world = makeSeedWorld("flightpath-findings-");
    const S = "sess-order";
    const away = 70 * MINUTE;
    seedWarmPair(world.db, S, ONE_HOUR_CACHE, {
      startedAt: 1_000 + away,
      cacheRead: 5_000,
      cacheWrite1h: 40_000,
    });
    let at = seedNext(world, S, {
      id: 3,
      after: 1_000 + away,
      cacheRead: 46_000,
    });
    at = seedNext(world, S, {
      id: 4,
      after: at,
      gap: away,
      cacheRead: 2_000,
      cacheWrite1h: 20_000,
    });
    at = seedNext(world, S, { id: 5, after: at, cacheRead: 23_000 });
    at = seedNext(world, S, { id: 6, after: at, ...rewrite(62_000) });
    at = seedNext(world, S, {
      id: 7,
      after: at,
      cacheRead: 63_000,
      model: "claude-opus",
    });
    seedNext(world, S, {
      id: 8,
      after: at,
      ...rewrite(40_000),
      model: "claude-sonnet",
    });
    expect(findingsOf(world, S).map((f) => [f.id, f.grade])).toEqual([
      ["rebuild-4", "Worth fixing"],
      ["rebuild-6", "Worth a look"],
      ["rebuild-2", "Worth a look"],
      ["rebuild-8", "Worth a look"],
    ]);
  });
});

describe("dismissing a finding", () => {
  function seedModelSwitch(world: World): void {
    seedWarmPair(world.db, "sess-dismiss", {}, { model: "claude-opus" });
  }

  it("hides it from the list, and doing it again changes nothing", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedModelSwitch(world);
    expect(dismissFinding(world.storage, "sess-dismiss", "rebuild-2")).toBe(
      true,
    );
    expect(dismissFinding(world.storage, "sess-dismiss", "rebuild-2")).toBe(
      true,
    );
    expect(findingsOf(world, "sess-dismiss")).toEqual([]);
    expect(world.storage.listDismissals("sess-dismiss")).toEqual(["rebuild-2"]);
  });

  it("refuses a finding the session does not produce, and a session that is unknown", () => {
    const world = makeSeedWorld("flightpath-findings-");
    seedModelSwitch(world);
    expect(dismissFinding(world.storage, "sess-dismiss", "rebuild-9")).toBe(
      false,
    );
    expect(dismissFinding(world.storage, "sess-nope", "rebuild-2")).toBe(false);
    expect(world.storage.listDismissals("sess-dismiss")).toEqual([]);
    expect(sessionFindings(world.storage, "sess-nope")).toBeUndefined();
  });

  it("leaves a later expired rebuild Worth fixing when the first was dismissed", () => {
    const world = makeSeedWorld("flightpath-findings-");
    const S = "sess-escalated";
    seedWarmPair(world.db, S, ONE_HOUR_CACHE, EXPIRED_71_MINUTES);
    seedSecondExpiry(world, S);
    dismissFinding(world.storage, S, "rebuild-2");
    expect(findingsOf(world, S).map((f) => [f.id, f.grade])).toEqual([
      ["rebuild-4", "Worth fixing"],
    ]);
  });
});

describe("the finding wording", () => {
  it("links the four doc pages the wording was checked against", () => {
    const rebuild = { tokens: 10_000, from: "a", to: "b", model: "m" };
    expect([
      expiredWording({ tokens: 10_000, gapMinutes: 70 }).doc.url,
      modelWording(rebuild).doc.url,
      effortWording(rebuild).doc.url,
      toolsWording({ tokens: 10_000, servers: ["github"] }).doc.url,
    ]).toEqual([
      "https://code.claude.com/docs/en/prompt-caching#cache-lifetime",
      "https://code.claude.com/docs/en/prompt-caching#switching-models",
      "https://code.claude.com/docs/en/prompt-caching#changing-effort-level",
      "https://code.claude.com/docs/en/prompt-caching#connecting-or-removing-an-mcp-server",
    ]);
  });
});
