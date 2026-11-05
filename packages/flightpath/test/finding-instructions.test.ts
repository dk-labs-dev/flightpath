import { afterEach, describe, expect, it } from "vitest";

import { sessionFindings } from "../src/api/index.js";
import { instructionsWording } from "../src/api/finding-wording.js";
import type { Finding } from "../src/api/payloads.js";
import { runCleanups } from "./support/cleanup.js";
import { NO_CATEGORIES } from "./support/context-report.js";
import {
  seedBranch,
  seedLoad,
  seedRequestExact,
  seedSession,
  seedTurn,
} from "./support/seed.js";
import { makeSeedWorld } from "./support/storage.js";

afterEach(async () => {
  await runCleanups();
});

const SESSION = "sess-instructions";
const MODEL = "claude-sonnet-5-5";
const FIRST_REQUEST_AT = 10_000;
const AT_START = 5_000;
const AFTER_FIRST_REQUEST = 15_000;
const REPORT_AT = 20_000;

// At 2.9 characters per token, 14,500 bytes are 5,000 tokens
// and 14,497 are 4,999.
const FIVE_THOUSAND_TOKENS = 14_500;

type World = ReturnType<typeof makeSeedWorld>;

/** An instruction file a subagent's transcript named. */
function subagentLoadsFile(
  world: World,
  filePath: string,
  sizeBytes: number,
  occurredAt: number,
): void {
  const branchId = seedBranch(world.db, { sessionId: SESSION });
  seedLoad(world.db, {
    sessionId: SESSION,
    kind: "instructions",
    filePath,
    sizeBytes,
    occurredAt,
    source: "transcript",
    branchId,
  });
}

function startSession(world: World, joinedPartway = false): World {
  seedSession(world.db, { id: SESSION, model: MODEL, joinedPartway });
  seedTurn(world.db, { sessionId: SESSION, endedAt: 9_000 });
  seedRequestExact(world.db, {
    id: 1,
    sessionId: SESSION,
    model: MODEL,
    startedAt: FIRST_REQUEST_AT,
    input: 1_000,
    output: 500,
    cacheRead: 0,
    cacheWrite1h: 20_000,
  });
  return world;
}

function loadFile(
  world: World,
  filePath: string,
  sizeBytes: number | null,
  occurredAt = AT_START,
): void {
  seedLoad(world.db, {
    sessionId: SESSION,
    kind: "instructions",
    filePath,
    sizeBytes,
    occurredAt,
  });
}

function reportMemoryFiles(
  world: World,
  memoryFiles: number | null,
  model = MODEL,
  reportedAt = REPORT_AT,
): void {
  world.storage.recordContextReport(
    SESSION,
    {
      model,
      window: 1_000_000,
      autocompactBuffer: 33_000,
      ...NO_CATEGORIES,
      memoryFiles,
    },
    reportedAt,
  );
}

function instructionFindings(world: World): Finding[] {
  const found = sessionFindings(world.storage, SESSION);
  if (found === undefined) throw new Error("session did not seed");
  return found.filter((finding) => finding.kind === "instructions");
}

function onlyFinding(world: World): Finding {
  const [finding, ...rest] = instructionFindings(world);
  if (finding === undefined || rest.length > 0) {
    throw new Error("expected exactly one instructions finding");
  }
  return finding;
}

function seedWorld(): World {
  return startSession(makeSeedWorld("flightpath-instructions-"));
}

describe("the instruction files loaded at session start", () => {
  it("are one finding worded with an estimate when no report sizes them", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 35_830);
    expect(instructionFindings(world)).toEqual([
      {
        id: "instructions",
        kind: "instructions",
        grade: "Worth a look",
        at: FIRST_REQUEST_AT,
        requestId: null,
        turnId: null,
        headline:
          "Trim the files Claude reads at the start of every session · about 12.4K tokens across 1 file",
        body: "Always-loaded instruction files are sent with every request. You could move rarely needed parts into skills, which load only when used.",
        list: ["/home/example/proj/CLAUDE.md · about 12.4K tokens"],
        doc: {
          label: "Costs: move instructions from CLAUDE.md to skills",
          url: "https://code.claude.com/docs/en/costs#move-instructions-from-claude-md-to-skills",
        },
        measure: { tokens: 12_356, basis: "estimated" },
        copy: null,
      },
    ]);
  });

  it.each([
    [FIVE_THOUSAND_TOKENS - 3, 0],
    [FIVE_THOUSAND_TOKENS, 1],
  ])("of %i bytes in all give %i findings", (bytes, count) => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", bytes);
    expect(instructionFindings(world)).toHaveLength(count);
  });

  it("say files in the plural for two", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/.claude/CLAUDE.md", 8_000);
    loadFile(world, "/home/example/proj/CLAUDE.md", 8_000);
    expect(onlyFinding(world).headline).toBe(
      "Trim the files Claude reads at the start of every session · about 5.5K tokens across 2 files",
    );
  });

  it("list the five largest, largest first, and count the rest", () => {
    const world = seedWorld();
    [4_000, 9_000, 2_000, 12_000, 6_000, 1_000, 3_000].forEach((bytes, index) =>
      loadFile(world, `/p/file-${index}.md`, bytes),
    );
    const { headline, list } = onlyFinding(world);
    expect(headline).toContain("across 7 files");
    expect(list).toEqual([
      "/p/file-3.md · about 4.1K tokens",
      "/p/file-1.md · about 3.1K tokens",
      "/p/file-4.md · about 2.1K tokens",
      "/p/file-0.md · about 1.4K tokens",
      "/p/file-6.md · about 1.0K tokens",
      "and 2 more",
    ]);
  });
});

describe("the total from a /context report", () => {
  it("is used instead of the sum when the report names the memory files", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 1_000);
    reportMemoryFiles(world, 6_000);
    expect(onlyFinding(world)).toMatchObject({
      headline:
        "Trim the files Claude reads at the start of every session · 6.0K tokens across 1 file",
      measure: { tokens: 6_000, basis: "from-context" },
    });
  });

  it("lists each file as an estimate even when the total is measured", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 2_900);
    reportMemoryFiles(world, 6_000);
    expect(onlyFinding(world).list).toEqual([
      "/home/example/proj/CLAUDE.md · about 1.0K tokens",
    ]);
  });

  it.each([
    [4_999, 0],
    [5_000, 1],
  ])("of %i tokens gives %i findings", (memoryFiles, count) => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 40_000);
    reportMemoryFiles(world, memoryFiles);
    expect(instructionFindings(world)).toHaveLength(count);
  });

  it("is set aside for the sum when a file loaded between the first request and the report", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", FIVE_THOUSAND_TOKENS);
    loadFile(
      world,
      "/home/example/proj/src/CLAUDE.md",
      3_000,
      AFTER_FIRST_REQUEST,
    );
    reportMemoryFiles(world, 4_000);
    expect(onlyFinding(world).measure).toEqual({
      tokens: 5_000,
      basis: "estimated",
    });
  });

  it("stands when the only later load came after the report", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 1_000);
    loadFile(world, "/home/example/proj/src/CLAUDE.md", 3_000, REPORT_AT + 1);
    reportMemoryFiles(world, 6_000);
    expect(onlyFinding(world).measure.basis).toBe("from-context");
  });

  it("stands when the only later load was a subagent's file", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 1_000);
    subagentLoadsFile(
      world,
      "/home/example/proj/beds/CLAUDE.md",
      3_000,
      AFTER_FIRST_REQUEST,
    );
    reportMemoryFiles(world, 6_000);
    expect(onlyFinding(world).measure.basis).toBe("from-context");
  });

  it("is not taken from a report for another model", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 1_000);
    reportMemoryFiles(world, 6_000, "claude-opus-5-5");
    expect(instructionFindings(world)).toEqual([]);
  });

  it("is not used when the report lists no memory files row", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", FIVE_THOUSAND_TOKENS);
    reportMemoryFiles(world, null);
    expect(onlyFinding(world).measure.basis).toBe("estimated");
  });
});

describe("an instruction file with no recorded size", () => {
  it("gives no finding without a measured total, however large the others", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/.claude/CLAUDE.md", 40_000);
    loadFile(world, "/home/example/proj/CLAUDE.md", null);
    expect(instructionFindings(world)).toEqual([]);
  });

  it("is listed as not recorded, never as zero, beside a measured total", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/.claude/CLAUDE.md", 2_900);
    loadFile(world, "/home/example/proj/CLAUDE.md", null);
    reportMemoryFiles(world, 6_000);
    expect(onlyFinding(world).list).toEqual([
      "/home/example/.claude/CLAUDE.md · about 1.0K tokens",
      "/home/example/proj/CLAUDE.md · size not recorded",
    ]);
  });
});

describe("which instruction files count as loaded at the start", () => {
  it("counts a file loaded twice once", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 8_000);
    loadFile(world, "/home/example/proj/CLAUDE.md", 8_000, AT_START + 1);
    expect(instructionFindings(world)).toEqual([]);
  });

  it("takes the size from whichever load of a file recorded one", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", null);
    loadFile(world, "/home/example/proj/CLAUDE.md", 40_000, AT_START + 1);
    expect(onlyFinding(world).headline).toContain("across 1 file");
  });

  it("leaves out a file loaded after the first request", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 10_000);
    loadFile(
      world,
      "/home/example/proj/src/CLAUDE.md",
      10_000,
      AFTER_FIRST_REQUEST,
    );
    expect(instructionFindings(world)).toEqual([]);
  });

  it("leaves out a file only a subagent loaded", () => {
    const world = seedWorld();
    loadFile(world, "/home/example/proj/CLAUDE.md", 10_000);
    subagentLoadsFile(
      world,
      "/home/example/proj/beds/CLAUDE.md",
      10_000,
      AT_START,
    );
    expect(instructionFindings(world)).toEqual([]);
  });

  it("gives nothing for a measured total when no file load was recorded", () => {
    const world = seedWorld();
    reportMemoryFiles(world, 6_000);
    expect(instructionFindings(world)).toEqual([]);
  });

  it("gives nothing for a session joined partway", () => {
    const world = startSession(makeSeedWorld("flightpath-instructions-"), true);
    loadFile(world, "/home/example/proj/CLAUDE.md", 35_830);
    expect(instructionFindings(world)).toEqual([]);
  });

  it("gives nothing before the session's first request", () => {
    const world = makeSeedWorld("flightpath-instructions-");
    seedSession(world.db, { id: SESSION, model: MODEL });
    loadFile(world, "/home/example/proj/CLAUDE.md", 35_830);
    expect(instructionFindings(world)).toEqual([]);
  });
});

describe("the instruction files wording", () => {
  it("links the page it was checked against", () => {
    expect(
      instructionsWording({
        tokens: 6_000,
        estimated: false,
        files: [],
        more: 0,
      }).doc.url,
    ).toBe(
      "https://code.claude.com/docs/en/costs#move-instructions-from-claude-md-to-skills",
    );
  });
});
