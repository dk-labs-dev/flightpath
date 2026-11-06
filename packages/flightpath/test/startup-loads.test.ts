import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  contextAtStep,
  loadSessionData,
  sessionFindings,
} from "../src/api/index.js";
import type { ContextAtStep } from "../src/api/payloads.js";
import { defaultSettings } from "../src/settings/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { createTranscriptFollower } from "../src/transcripts/index.js";
import { registerCleanup, runCleanups } from "./support/cleanup.js";
import { recordHookEvent, transcriptAssistantLine } from "./support/events.js";
import { startupSplit } from "./support/startup.js";
import {
  seedRequestExact,
  seedRequestShape,
  seedStep,
} from "./support/seed.js";
import { allStoredText } from "./support/storage.js";
import { iso } from "./support/time.js";
import {
  followLines,
  makeTranscriptWorld,
  type TranscriptWorld,
} from "./support/worlds.js";

import { parseTranscriptLine } from "../src/transcripts/parse.js";

// What Claude Code adds at session start, named: the parse
// of the startup attachment kinds, the loads the follower
// writes from them, and the instruction file's size filled
// from its transcript entry. The entries are an example
// session's startup entries in the order a transcript
// carries them: a hook's output of 1,200 characters (its
// stdout runs to 1,201, which is not what reaches the
// model), an empty second hook, the system message, the
// first prompt, the deferred tools' delta (100 names, lines
// summing to 4,000), the agent listing (lines summing to
// 2,500), two servers' instructions of 1,500 each, a skills
// listing of 20,000 characters over 40 skills, and an
// instruction file of 6,000. Contents are a marker filler
// of the same lengths, so a leak of any content is
// greppable; names are example names.

const T0 = Date.parse("2026-10-30T14:58:39.192Z");
const INSTRUCTIONS_PATH = "C:\\Users\\example\\.claude\\CLAUDE.md";

afterEach(async () => {
  await runCleanups();
});

/** Same-length filler carrying a marker no stored text may hold. */
function filler(length: number): string {
  return "MARKERFILLER".repeat(Math.ceil(length / 12)).slice(0, length);
}

function attachmentLine(at: number, attachment: Record<string, unknown>) {
  return JSON.stringify({
    type: "attachment",
    timestamp: iso(at),
    attachment,
  });
}

const HOOK_LINE = attachmentLine(T0, {
  type: "hook_success",
  hookName: "SessionStart:startup",
  hookEvent: "SessionStart",
  content: filler(1_200),
  stdout: filler(1_201),
  stderr: "",
  exitCode: 0,
  command: '"${CLAUDE_PLUGIN_ROOT}/hooks/start"',
  durationMs: 1_372,
});

const EMPTY_HOOK_LINE = attachmentLine(T0 + 2_701, {
  type: "hook_success",
  hookName: "SessionStart:startup",
  hookEvent: "SessionStart",
  content: "",
  stdout: filler(80),
  stderr: "",
  exitCode: 0,
  command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/notice.js"',
  durationMs: 4_051,
});

const SYSTEM_MESSAGE_LINE = attachmentLine(T0 + 2_701, {
  type: "hook_system_message",
  content: filler(59),
  hookName: "SessionStart:startup",
  hookEvent: "SessionStart",
});

/** The prompt's filler: its own marker, because a prompt's
 * text is kept by design — only attachment contents must
 * never be stored. */
function promptFiller(length: number): string {
  return "PROMPTFILLER".repeat(Math.ceil(length / 12)).slice(0, length);
}

const PROMPT_ID = "95066140-0000-4000-8000-000000000001";

const PROMPT_LINE = JSON.stringify({
  type: "user",
  timestamp: iso(T0 + 204_756),
  promptId: PROMPT_ID,
  message: { role: "user", content: promptFiller(37) },
  origin: { kind: "human" },
});

/** The deferred tools' lines: 100 of 40 characters. */
const DEFERRED_LINE_LENGTHS = Array.from({ length: 100 }, () => 40);

const DEFERRED_LINE = attachmentLine(T0 + 204_753, {
  type: "deferred_tools_delta",
  addedNames: Array.from({ length: 100 }, (_, i) => `example_tool_${i + 1}`),
  addedLines: DEFERRED_LINE_LENGTHS.map(filler),
  removedNames: [],
  wireHiddenNames: [],
  readdedNames: [],
  pendingMcpServers: [],
  failedMcpServers: [
    { name: "example-server", errorCode: "AUTH_HEADER_REJECTED" },
  ],
  surfacedNames: ["example_tool_1", "example_tool_2", "example_tool_3"],
  surfacedDefinitions: [],
});

const AGENT_LINE = attachmentLine(T0 + 204_753, {
  addedTypes: [
    "example-agent-1",
    "example-agent-2",
    "example-agent-3",
    "example-agent-4",
    "example-agent-5",
    "example-agent-6",
  ],
  addedLines: [100, 1_000, 500, 400, 300, 200].map(filler),
  builtInTypes: [6, 17, 7, 15, 4, 16].map((n) => "x".repeat(n)),
  builtInPluginTypes: [],
  removedTypes: [],
  isInitial: true,
  showConcurrencyNote: true,
  type: "agent_listing_delta",
});

const MCP_LINE = attachmentLine(T0 + 204_753, {
  type: "mcp_instructions_delta",
  addedNames: ["example-server-1", "example-server-2"],
  addedBlocks: [filler(1_500), filler(1_500)],
  removedNames: [],
});

const SKILL_NAMES = Array.from(
  { length: 40 },
  (_, i) => `example-skill-${i + 1}`,
);

const SKILL_LINE = attachmentLine(T0 + 204_753, {
  type: "skill_listing",
  content: filler(20_000),
  skillCount: 40,
  isInitial: true,
  names: SKILL_NAMES,
});

const INSTRUCTIONS_LINE = attachmentLine(T0 + 204_901, {
  type: "instructions",
  files: [{ type: "User", path: INSTRUCTIONS_PATH, content: filler(6_000) }],
});

const STARTUP_LINES = [
  HOOK_LINE,
  EMPTY_HOOK_LINE,
  SYSTEM_MESSAGE_LINE,
  PROMPT_LINE,
  DEFERRED_LINE,
  AGENT_LINE,
  MCP_LINE,
  SKILL_LINE,
  INSTRUCTIONS_LINE,
];

function parse(line: string) {
  return parseTranscriptLine(line, { keepPromptText: false });
}

describe("the startup attachments, parsed", () => {
  it("names each kind with its count and the size that reached the model", () => {
    const cases: [string, unknown][] = [
      [
        SKILL_LINE,
        {
          kind: "skill-listing",
          name: null,
          count: 40,
          chars: 20_000,
          names: SKILL_NAMES,
        },
      ],
      [
        MCP_LINE,
        { kind: "mcp-instructions", name: null, count: 2, chars: 3_000 },
      ],
      [
        AGENT_LINE,
        { kind: "agent-listing", name: null, count: null, chars: 2_500 },
      ],
      [
        DEFERRED_LINE,
        {
          kind: "deferred-tool-names",
          name: null,
          count: 100,
          chars: 4_000,
        },
      ],
      [
        HOOK_LINE,
        {
          kind: "hook-output",
          name: "SessionStart:startup",
          count: null,
          chars: 1_200,
        },
      ],
      [
        INSTRUCTIONS_LINE,
        {
          kind: "instructions",
          files: [{ path: INSTRUCTIONS_PATH, chars: 6_000 }],
        },
      ],
    ];
    for (const [line, item] of cases) {
      const parsed = parse(line);
      expect(parsed.kind).toBe("startup-item");
      if (parsed.kind !== "startup-item") throw new Error("unreachable");
      expect(parsed.item).toEqual(item);
    }
  });

  it("counts a delta's names at one and two, and counts none when it names nothing", () => {
    const delta = (names: string[], blocks: string[]) =>
      attachmentLine(T0, {
        type: "mcp_instructions_delta",
        addedNames: names,
        addedBlocks: blocks,
        removedNames: [],
      });
    const countOf = (line: string) => {
      const parsed = parse(line);
      if (parsed.kind !== "startup-item") throw new Error("unreachable");
      if (parsed.item.kind === "instructions") throw new Error("unreachable");
      return parsed.item.count;
    };
    // Text arrives but no server is named: the count is
    // none, so the panel prints no "0 servers".
    expect(countOf(delta([], [filler(10)]))).toBeNull();
    expect(countOf(delta(["example-server-1"], [filler(10)]))).toBe(1);
    expect(
      countOf(delta(["example-server-1", "example-server-2"], [filler(10)])),
    ).toBe(2);
  });

  it("skips a hook whose output is empty, and keeps the system message out", () => {
    expect(parse(EMPTY_HOOK_LINE).kind).toBe("other");
    expect(parse(SYSTEM_MESSAGE_LINE).kind).toBe("other");
  });

  it("carries no content out of the parse", () => {
    for (const line of STARTUP_LINES) {
      expect(JSON.stringify(parse(line))).not.toContain("MARKERFILLER");
    }
  });
});

/** The session's start, as its SessionStart hook recorded it. */
function seedSessionStart(world: ReturnType<typeof makeTranscriptWorld>): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-live",
      source: "startup",
      cwd: "/home/example/garden",
    },
    T0,
  );
}

/** The instruction file's hook, with no size: the file was
 * already gone when the daemon tried to stat it. */
function seedInstructionsHook(
  world: ReturnType<typeof makeTranscriptWorld>,
): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "InstructionsLoaded",
      session_id: "sess-live",
      file_path: INSTRUCTIONS_PATH,
      memory_type: "User",
    },
    T0 + 100,
  );
}

/** The example start, followed; and a step after the
 * entries, measured by a request carrying a recorded shape
 * at 75,000 tokens. */
async function replayWorld(): Promise<TranscriptWorld> {
  const world = makeTranscriptWorld();
  seedSessionStart(world);
  seedInstructionsHook(world);
  // The prompt's own hook, carrying the entry's prompt id:
  // the turn is the hook's to open, the entry resolves to it.
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-live",
      prompt_id: PROMPT_ID,
      prompt: promptFiller(37),
    },
    T0 + 204_756,
  );
  await followLines(world, STARTUP_LINES);
  const db = new DatabaseSync(world.storage.dbPath);
  registerCleanup(() => db.close());
  seedRequestShape(db, {
    hash: "shape-replay",
    systemBytes: 40_000,
    tools: [
      { name: "Read", bytes: 4_000, mcp: false },
      { name: "Bash", bytes: 2_000, mcp: false },
    ],
  });
  const followed = loadSessionData(world.storage, "sess-live");
  const turnId = followed?.turns[0]?.id;
  if (turnId === undefined) throw new Error("the prompt opened no turn");
  seedRequestExact(db, {
    id: 1,
    sessionId: "sess-live",
    turnId,
    startedAt: T0 + 240_000,
    input: 75_000,
    output: 100,
    shapeHash: "shape-replay",
  });
  seedStep(db, {
    id: 1,
    sessionId: "sess-live",
    turnId,
    toolName: "Bash",
    startedAt: T0 + 250_000,
    endedAt: T0 + 260_000,
    resultSize: 123_945,
    resultRequestId: 1,
  });
  return world;
}

/** The replay world's step, read back through the read API. */
function readReplayStep(world: TranscriptWorld): ContextAtStep {
  const data = loadSessionData(world.storage, "sess-live");
  if (data === undefined) throw new Error("session did not load");
  const result = contextAtStep(data, 1);
  if (result === null) throw new Error("step did not read");
  return result;
}

describe("the startup attachments, followed", () => {
  function seedSession(world: ReturnType<typeof makeTranscriptWorld>): void {
    seedSessionStart(world);
    seedInstructionsHook(world);
  }

  it("writes one load per addition, fills the file's size, and stores no content", async () => {
    const world = makeTranscriptWorld();
    seedSession(world);
    await followLines(world, STARTUP_LINES);
    const loads = world.storage
      .loadRows("sess-live")
      .map(({ kind, name, filePath, sizeBytes, itemCount, source }) => ({
        kind,
        name,
        filePath,
        sizeBytes,
        itemCount,
        source,
      }));
    expect(loads).toEqual([
      {
        kind: "hook-output",
        name: "SessionStart:startup",
        filePath: null,
        sizeBytes: 1_200,
        itemCount: null,
        source: "transcript",
      },
      {
        kind: "instructions",
        name: null,
        filePath: INSTRUCTIONS_PATH,
        // No size from the hook; the transcript entry's
        // 6,000 filled it.
        sizeBytes: 6_000,
        itemCount: null,
        source: "hook",
      },
      {
        kind: "deferred-tool-names",
        name: null,
        filePath: null,
        sizeBytes: 4_000,
        itemCount: 100,
        source: "transcript",
      },
      {
        kind: "agent-listing",
        name: null,
        filePath: null,
        sizeBytes: 2_500,
        itemCount: null,
        source: "transcript",
      },
      {
        kind: "mcp-instructions",
        name: null,
        filePath: null,
        sizeBytes: 3_000,
        itemCount: 2,
        source: "transcript",
      },
      {
        kind: "skill-listing",
        name: null,
        filePath: null,
        sizeBytes: 20_000,
        itemCount: 40,
        source: "transcript",
      },
    ]);
    // No content anywhere in the store: not in the loads,
    // and not in the stored entries either.
    expect(allStoredText(world.storage)).not.toContain("MARKERFILLER");
  });

  it("replays the example start: the step after the entries reads the split by name", async () => {
    const world = await replayWorld();
    const result = readReplayStep(world);
    expect(result.fixedLoad).toEqual(
      startupSplit({
        instructions: 1,
        skill: 6,
        deferred: 3,
        mcp: 5,
        agent: 4,
        hook: 2,
        instructionsName: INSTRUCTIONS_PATH,
      }),
    );
  });

  it("replays the example start: the remainder counts each part once", async () => {
    const world = await replayWorld();
    const result = readReplayStep(world);
    // The named share, from the followed entries alone:
    // the items (the prompt's 13, the reply's 100 and the
    // step's 42,740; the file is sized in the panel, not
    // here) and the panel's 28,522 with the file's 2,069
    // leave 3,625.
    expect(result.totals).toEqual({
      measured: 75_000,
      items: 42_853,
      named: 71_375,
      other: 3_625,
    });
  });

  it("never overwrites a size the hook did record", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "sess-live",
        file_path: INSTRUCTIONS_PATH,
        memory_type: "User",
        file_size_bytes: 111,
      },
      T0 + 100,
    );
    await followLines(world, [INSTRUCTIONS_LINE]);
    const load = world.storage
      .loadRows("sess-live")
      .find((row) => row.kind === "instructions");
    expect(load?.sizeBytes).toBe(111);
  });
});

describe("the skills listing's names, followed", () => {
  const listing = (at: number, names: string[]) =>
    attachmentLine(at, {
      type: "skill_listing",
      content: filler(1_000),
      skillCount: names.length,
      names,
    });

  it("stores the names beside the listing's count and size", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    await followLines(world, [SKILL_LINE]);
    const [row] = world.storage
      .loadRows("sess-live")
      .filter((load) => load.kind === "skill-listing");
    expect(row).toMatchObject({ itemCount: 40, names: SKILL_NAMES });
  });

  it("builds the finding from the first of three listings", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    await followLines(world, [
      listing(T0 + 200, ["first-a", "first-b"]),
      listing(T0 + 300, ["subagent-a"]),
      listing(T0 + 400, ["after-compaction-a"]),
    ]);
    recordHookEvent(
      world.storage,
      { hook_event_name: "SessionEnd", session_id: "sess-live" },
      T0 + 500,
    );
    expect(sessionFindings(world.storage, "sess-live")).toMatchObject([
      {
        id: "skills-unused",
        list: ["first-a", "first-b"],
      },
    ]);
  });
});

describe("a subagent's startup listings, followed", () => {
  it("records a subagent file's listing against its branch and the main file's against none, even at the same moment", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-live",
        agent_id: "a1",
        agent_type: "explore",
      },
      T0 + 100,
    );
    const subagentsDir = join(world.root, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-a1.jsonl"), SKILL_LINE + "\n");
    await followLines(world, [SKILL_LINE]);
    const [branch] = world.storage.branchRows("sess-live");
    if (branch === undefined) throw new Error("the hook opened no branch");
    const listings = world.storage
      .loadRows("sess-live")
      .filter((load) => load.kind === "skill-listing");
    expect(listings).toHaveLength(2);
    expect(listings.map((load) => load.branchId)).toEqual(
      expect.arrayContaining([branch.id, null]),
    );
  });
});

/** One user entry of a subagent's transcript. */
function userLine(
  at: number,
  length: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(at),
    message: { role: "user", content: filler(length) },
    ...extra,
  });
}

const SUBAGENT_FILES = [
  { path: "/home/example/garden/CLAUDE.md", length: 1_200 },
  { path: "/home/example/garden/beds/CLAUDE.md", length: 6_000 },
];

/** A meta user entry of the given length that opens as given. */
function metaLine(at: number, opening: string, length: number): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(at),
    isMeta: true,
    message: {
      role: "user",
      content: (opening + filler(length)).slice(0, length),
    },
  });
}

const preloadedSkillLine = (at: number, name: string, length: number) =>
  metaLine(at, `<command-message>${name}</command-message>`, length);

const reminderLine = (at: number) => metaLine(at, "<system-reminder>", 400);

const instructionsLine = (at: number) =>
  attachmentLine(at, {
    type: "instructions",
    files: SUBAGENT_FILES.map(({ path, length }) => ({
      type: "Project",
      path,
      content: filler(length),
    })),
  });

/** What a subagent's file opens with: the task, the skills it
 * preloads (meta entries), a reminder and the instruction files
 * it loaded. */
function subagentOpening(): string[] {
  return [
    userLine(T0 + 110, 1_100),
    preloadedSkillLine(T0 + 115, "house-style", 8_000),
    preloadedSkillLine(T0 + 118, "release-notes", 3_000),
    reminderLine(T0 + 120),
    instructionsLine(T0 + 130),
  ];
}

/** A session with a subagent started. */
function startSubagentWorld(): TranscriptWorld {
  const world = makeTranscriptWorld();
  seedSessionStart(world);
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SubagentStart",
      session_id: "sess-live",
      agent_id: "a1",
      agent_type: "explore",
    },
    T0 + 100,
  );
  return world;
}

/** The subagent's file written and the session followed; the
 * subagent's branch id is returned. */
async function followSubagent(
  world: TranscriptWorld,
  lines: string[],
): Promise<number> {
  const subagentsDir = join(world.root, "sess-live", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(join(subagentsDir, "agent-a1.jsonl"), lines.join("\n") + "\n");
  await followLines(world, [EMPTY_HOOK_LINE]);
  const [branch] = world.storage.branchRows("sess-live");
  if (branch === undefined) throw new Error("the hook opened no branch");
  return branch.id;
}

/** The kinds of the loads recorded for one subagent, in order. */
function loadKindsOf(world: TranscriptWorld, branchId: number): string[] {
  return world.storage
    .loadRows("sess-live")
    .filter((load) => load.branchId === branchId)
    .map((load) => load.kind);
}

describe("a subagent's start, followed", () => {
  it("records its task, preloaded skills and instruction files as sizes against its branch", async () => {
    const world = startSubagentWorld();
    const branchId = await followSubagent(world, [
      ...subagentOpening(),
      attachmentLine(T0 + 140, {
        type: "skill_listing",
        content: filler(5_000),
        skillCount: 8,
        names: ["skill-a"],
      }),
    ]);
    const start = world.storage
      .loadRows("sess-live")
      .filter((load) => load.branchId === branchId)
      .map(({ kind, name, filePath, sizeBytes }) => ({
        kind,
        name,
        filePath,
        sizeBytes,
      }));
    expect(start).toEqual([
      { kind: "task-prompt", name: null, filePath: null, sizeBytes: 1_100 },
      {
        kind: "preloaded-skill",
        name: "house-style",
        filePath: null,
        sizeBytes: 8_000,
      },
      {
        kind: "preloaded-skill",
        name: "release-notes",
        filePath: null,
        sizeBytes: 3_000,
      },
      {
        kind: "instructions",
        name: null,
        filePath: SUBAGENT_FILES[0]?.path,
        sizeBytes: 1_200,
      },
      {
        kind: "instructions",
        name: null,
        filePath: SUBAGENT_FILES[1]?.path,
        sizeBytes: 6_000,
      },
      { kind: "skill-listing", name: null, filePath: null, sizeBytes: 5_000 },
    ]);
    expect(allStoredText(world.storage)).not.toContain("MARKERFILLER");
  });

  it("records no skill for a subagent that preloads none, the reminder being no load", async () => {
    const world = startSubagentWorld();
    const branchId = await followSubagent(world, [
      userLine(T0 + 110, 1_100),
      reminderLine(T0 + 120),
      instructionsLine(T0 + 130),
    ]);
    const kinds = loadKindsOf(world, branchId);
    expect(kinds).toEqual(["task-prompt", "instructions", "instructions"]);
  });

  it("takes a meta entry after the first assistant entry for no preloaded skill", async () => {
    const world = startSubagentWorld();
    const branchId = await followSubagent(world, [
      userLine(T0 + 110, 1_100),
      reminderLine(T0 + 120),
      transcriptAssistantLine(T0 + 200, "req-sub", {
        input_tokens: 100,
        output_tokens: 20,
      }),
      preloadedSkillLine(T0 + 300, "house-style", 2_000),
    ]);
    const kinds = loadKindsOf(world, branchId);
    expect(kinds).toEqual(["task-prompt"]);
  });

  it("leaves the main thread's instruction row without a size when only a subagent's file names it", async () => {
    const world = startSubagentWorld();
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "sess-live",
        file_path: SUBAGENT_FILES[0]?.path,
        memory_type: "Project",
      },
      T0 + 50,
    );
    await followSubagent(world, subagentOpening());
    const main = world.storage
      .loadRows("sess-live")
      .filter((load) => load.branchId === null);
    expect(main.map((load) => load.sizeBytes)).toEqual([null]);
  });

  it("takes only the first plain entry as the task and each skill-opening meta entry as a preloaded skill", async () => {
    const world = startSubagentWorld();
    const branchId = await followSubagent(world, [
      ...subagentOpening(),
      userLine(T0 + 200, 300, { isMeta: true }),
      userLine(T0 + 210, 400),
    ]);
    const sizes = world.storage
      .loadRows("sess-live")
      .filter((load) => load.branchId === branchId)
      .filter((load) => load.kind !== "instructions")
      .map(({ kind, sizeBytes }) => ({ kind, sizeBytes }));
    expect(sizes).toEqual([
      { kind: "task-prompt", sizeBytes: 1_100 },
      { kind: "preloaded-skill", sizeBytes: 8_000 },
      { kind: "preloaded-skill", sizeBytes: 3_000 },
    ]);
  });

  it("does not take a skill-opening meta entry for a preloaded skill when a follow resumes past the start", async () => {
    const world = startSubagentWorld();
    const branchId = await followSubagent(world, subagentOpening());
    const resumed = createTranscriptFollower(world.storage, {
      dataDir: world.dataDir,
      configDir: world.configDir,
      settings: () => defaultSettings(),
    });
    appendFileSync(
      join(world.root, "sess-live", "subagents", "agent-a1.jsonl"),
      preloadedSkillLine(T0 + 300, "late-skill", 300) + "\n",
    );
    await resumed.follow("sess-live", join(world.root, "sess-live.jsonl"));
    const skills = world.storage
      .loadRows("sess-live")
      .filter(
        (load) => load.branchId === branchId && load.kind === "preloaded-skill",
      );
    expect(skills.map((load) => load.name)).toEqual([
      "house-style",
      "release-notes",
    ]);
  });
});

/** A subagent's file as Claude Code writes it before the start event. */
function writeEarlySubagentFile(world: TranscriptWorld): void {
  const subagentsDir = join(world.root, "sess-live", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const lines = [
    ...subagentOpening(),
    attachmentLine(T0 + 140, {
      type: "skill_listing",
      content: filler(5_000),
      skillCount: 8,
      names: ["skill-a"],
    }),
  ];
  writeFileSync(join(subagentsDir, "agent-a1.jsonl"), lines.join("\n") + "\n");
}

describe("a subagent's file that appears before its start", () => {
  it("waits for the start, then lands as the subagent's own", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    writeEarlySubagentFile(world);
    await followLines(world, [EMPTY_HOOK_LINE]);
    expect(world.storage.loadRows("sess-live")).toEqual([]);

    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-live",
        agent_id: "a1",
        agent_type: "explore",
      },
      T0 + 100,
    );
    await followLines(world, [EMPTY_HOOK_LINE]);
    const [branch] = world.storage.branchRows("sess-live");
    if (branch === undefined) throw new Error("the hook opened no branch");
    const loads = world.storage.loadRows("sess-live");
    expect(loads.map((load) => load.kind)).toEqual([
      "task-prompt",
      "preloaded-skill",
      "preloaded-skill",
      "instructions",
      "instructions",
      "skill-listing",
    ]);
    expect(loads.map((load) => load.branchId)).toEqual(
      loads.map(() => branch.id),
    );
  });

  it("is read by the follow after the session ends when no start ever came", async () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    writeEarlySubagentFile(world);
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(mainPath, EMPTY_HOOK_LINE + "\n");
    await world.follower.follow("sess-live", mainPath);
    expect(world.storage.loadRows("sess-live")).toEqual([]);

    await world.follower.follow("sess-live", mainPath, undefined, true);
    const loads = world.storage.loadRows("sess-live");
    expect(loads.map((load) => load.kind)).toContain("skill-listing");
    expect(loads.map((load) => load.branchId)).toEqual(loads.map(() => null));
  });
});

describe("the startup load write", () => {
  it("ignores a re-read of the same line, and takes a later repeat as its own load", () => {
    const world = makeTranscriptWorld();
    seedSessionStart(world);
    const input = {
      sessionId: "sess-live",
      kind: "skill-listing",
      name: null,
      count: 40,
      names: null,
      chars: 20_000,
      at: T0 + 400,
      branchId: null,
    };
    world.storage.recordTranscriptLoad(input);
    world.storage.recordTranscriptLoad(input);
    // A compaction's re-send is the same listing at a new
    // moment: a load of its own, not a duplicate.
    world.storage.recordTranscriptLoad({ ...input, at: T0 + 90_000 });
    const rows = world.storage
      .loadRows("sess-live")
      .filter((row) => row.kind === "skill-listing");
    expect(rows.map((row) => row.occurredAt)).toEqual([T0 + 400, T0 + 90_000]);
  });
});
