import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import {
  DAEMON_SUITE,
  dataDirFor,
  makeRoot,
  startDaemon,
  stopCleanly,
  stopDaemon,
  waitFor,
} from "./support/daemon.js";
import {
  recordHookEvent,
  transcriptAssistantLine,
  transcriptUserLine,
} from "./support/events.js";
import { NO_CATEGORIES } from "./support/context-report.js";
import { firstRow, onlyRow } from "./support/rows.js";
import { allStoredText, queryRows } from "./support/storage.js";
import { iso } from "./support/time.js";
import {
  IMPORT_INSTALL,
  followLines,
  importTranscriptLines,
  makeTranscriptWorld,
  makeTranscriptWorldFailingOnce,
  seedImportWorld,
} from "./support/worlds.js";

import { defaultSettings } from "../src/settings/index.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import {
  createTranscriptFollower,
  encodeProjectPath,
  type TranscriptFollower,
} from "../src/transcripts/index.js";
import { parseTranscriptLine } from "../src/transcripts/parse.js";

// The transcript reader (ADR-0019): requests and context samples
// from hand-written synthetic transcripts, live follow from the
// last offset, and the import of sessions hooks never captured.
// No fixture here is a real transcript. The /context report in
// its describe below is laid out as Claude Code writes it, under
// an example server name; every other line is written for this
// test.

const T0 = Date.parse("2026-10-24T10:00:00.000Z");

afterEach(async () => {
  await runCleanups();
});

const FULL_USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 50,
  cache_creation: {
    ephemeral_5m_input_tokens: 40,
    ephemeral_1h_input_tokens: 10,
  },
};

/** Seed the live session and follow its one-request transcript. */
async function recordOneRequest(
  world: ReturnType<typeof makeTranscriptWorld>,
): Promise<string> {
  seedLiveSession(world.storage);
  const mainPath = join(world.root, "sess-live.jsonl");
  writeFileSync(
    mainPath,
    transcriptUserLine(T0 + 1000, { promptId: "p-1" }) +
      "\n" +
      transcriptAssistantLine(T0 + 2000, "req-1", FULL_USAGE) +
      "\n",
  );
  expect((await world.follower.follow("sess-live", mainPath)).requests).toBe(1);
  return mainPath;
}

/** The live session's opening: a start and its first turn. */
function seedOpening(storage: Storage): void {
  recordHookEvent(
    storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-live",
      source: "startup",
      cwd: "/home/user/proj-a",
      version: "2.0.0",
    },
    T0,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-live",
      prompt_id: "p-1",
      prompt: "write the report",
    },
    T0 + 1000,
  );
}

/** Seed the live session's journey: one turn, one step, one branch. */
function seedLiveSession(storage: Storage): void {
  seedOpening(storage);
  recordHookEvent(
    storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-live",
      prompt_id: "p-1",
      tool_name: "Read",
      tool_use_id: "toolu_1",
      tool_input: { file_path: "/home/user/proj-a/a.ts" },
    },
    T0 + 2000,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-live",
      prompt_id: "p-1",
      tool_name: "Agent",
      tool_use_id: "toolu_agent",
      tool_input: { subagent_type: "explore" },
    },
    T0 + 3000,
  );
  recordHookEvent(
    storage,
    {
      hook_event_name: "SubagentStart",
      session_id: "sess-live",
      agent_id: "a1",
      agent_type: "explore",
    },
    T0 + 3500,
  );
}

describe("parseTranscriptLine", () => {
  it("keeps the cache-write total in the 5m column when no split is reported", async () => {
    const parsed = parseTranscriptLine(
      transcriptAssistantLine(T0, "req-1", {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 7,
      }),
      { keepPromptText: false },
    );
    expect(parsed.kind).toBe("request");
    if (parsed.kind !== "request") throw new Error("unreachable");
    expect(parsed.usage.cacheWrite5mTokens).toBe(7);
    expect(parsed.usage.cacheWrite1hTokens).toBeNull();
    expect(parsed.usage.cacheReadTokens).toBeNull();
  });

  it("recognizes both interrupt markers and no other text", async () => {
    for (const marker of [
      "[Request interrupted by user]",
      "[Request interrupted by user for tool use]",
    ]) {
      const parsed = parseTranscriptLine(
        JSON.stringify({
          type: "user",
          timestamp: iso(T0),
          message: { role: "user", content: marker },
        }),
        { keepPromptText: false },
      );
      expect(parsed.kind).toBe("user");
      if (parsed.kind !== "user") throw new Error("unreachable");
      expect(parsed.isInterrupt).toBe(true);
    }
    const ordinary = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        timestamp: iso(T0),
        message: { role: "user", content: "[Request interrupted" },
      }),
      { keepPromptText: false },
    );
    expect(ordinary.kind).toBe("user");
    if (ordinary.kind !== "user") throw new Error("unreachable");
    expect(ordinary.isInterrupt).toBe(false);
  });

  it("reads the two ids a task notification names, and nothing else of it", () => {
    const parsed = parseTranscriptLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: iso(T0),
        content: [
          "<task-notification>",
          "<task-id>a00000000000000aa</task-id>",
          "<tool-use-id>toolu_made_up_1</tool-use-id>",
          "<summary>Agent finished: SOME SUMMARY</summary>",
          "</task-notification>",
        ].join("\n"),
      }),
      { keepPromptText: false },
    );
    expect(parsed.kind).toBe("task-notification");
    if (parsed.kind !== "task-notification") throw new Error("unreachable");
    expect(parsed.taskId).toBe("a00000000000000aa");
    expect(parsed.toolUseId).toBe("toolu_made_up_1");
    // The stored copy carries the content's size, never its text.
    expect(JSON.stringify(parsed.redacted)).not.toContain("SOME SUMMARY");
    // A queue entry carrying anything else stays unrecognized.
    const other = parseTranscriptLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "dequeue",
        timestamp: iso(T0),
      }),
      { keepPromptText: false },
    );
    expect(other.kind).toBe("other");
  });
});

// A /context report as it lands in the transcript: a user
// entry with isMeta set whose text is the report. These are
// its first 25 lines, laid out as Claude Code writes them;
// the MCP rows' server is "example". The two trailing spaces
// after the model id are a Markdown line break, as captured.
const CONTEXT_REPORT = [
  "## Context Usage",
  "",
  // Two trailing spaces, as captured.
  "**Model:** claude-sonnet-5-5" + "  ",
  "**Tokens:** 82.7k / 1m (8%)",
  "",
  "### Estimated usage by category",
  "",
  "| Category | Tokens | Percentage |",
  "|----------|--------|------------|",
  "| System prompt | 2.8k | 0.3% |",
  "| System tools | 19.6k | 2.0% |",
  "| MCP server instructions | 1.3k | 0.1% |",
  "| MCP tools (deferred) | 35.6k | 3.6% |",
  "| System tools (deferred) | 23.7k | 2.4% |",
  "| Memory files | 2.3k | 0.2% |",
  "| Skills | 8.3k | 0.8% |",
  "| Messages | 48.4k | 4.8% |",
  "| Free space | 884.3k | 88.4% |",
  "| Autocompact buffer | 33k | 3.3% |",
  "",
  "### MCP Tools",
  "",
  "| Tool | Server | Tokens |",
  "|------|--------|--------|",
  "| mcp__example__tool1 | example | 75 |",
].join("\n");

describe("the /context report", () => {
  /** Parse one meta user entry carrying the given text. */
  function parseReport(content: string) {
    const parsed = parseTranscriptLine(
      transcriptUserLine(T0, { content, extra: { isMeta: true } }),
      { keepPromptText: false },
    );
    if (parsed.kind !== "user") throw new Error("unreachable");
    return parsed;
  }

  it("parses the report in its real format, the buffer and categories included", () => {
    expect(parseReport(CONTEXT_REPORT).contextReport).toEqual({
      model: "claude-sonnet-5-5",
      window: 1_000_000,
      autocompactBuffer: 33_000,
      systemPrompt: 2_800,
      systemTools: 19_600,
      mcpInstructions: 1_300,
      memoryFiles: 2_300,
      skills: 8_300,
    });
  });

  it("reads Memory files, and none when the report lists no such row", () => {
    expect(parseReport(CONTEXT_REPORT).contextReport?.memoryFiles).toBe(2_300);
    const without = CONTEXT_REPORT.replace(
      "| Memory files | 2.3k | 0.2% |\n",
      "",
    );
    expect(parseReport(without).contextReport).toMatchObject({
      memoryFiles: null,
      skills: 8_300,
    });
  });

  it("reads System tools, never the System tools (deferred) row beside it", () => {
    expect(parseReport(CONTEXT_REPORT).contextReport?.systemTools).toBe(19_600);
    const onlyDeferred = CONTEXT_REPORT.replace(
      "| System tools | 19.6k",
      "| Other | 19.6k",
    );
    expect(parseReport(onlyDeferred).contextReport?.systemTools).toBeNull();
  });

  it("reads a category row written in another form as none, and keeps the rest", () => {
    const changed = CONTEXT_REPORT.replace(
      "| Skills | 8.3k | 0.8% |",
      "| Skills | about 8k | 0.8% |",
    );
    expect(parseReport(changed).contextReport).toMatchObject({
      skills: null,
      mcpInstructions: 1_300,
    });
  });

  it("reads a category size under a thousand written without a unit", () => {
    const changed = CONTEXT_REPORT.replace(
      "| MCP server instructions | 1.3k | 0.1% |",
      "| MCP server instructions | 640 | 0.1% |",
    );
    expect(parseReport(changed).contextReport).toMatchObject({
      mcpInstructions: 640,
      systemPrompt: 2_800,
      skills: 8_300,
    });
  });

  it("leaves the report null when a line does not match the format", () => {
    const changed = CONTEXT_REPORT.replace(
      "**Tokens:** 82.7k / 1m (8%)",
      "**Tokens:** 82.7k of the window used",
    );
    expect(parseReport(changed).contextReport).toBeNull();
  });

  it("reads no report from a typed prompt that pastes one", () => {
    const parsed = parseTranscriptLine(
      transcriptUserLine(T0, { content: CONTEXT_REPORT }),
      { keepPromptText: false },
    );
    if (parsed.kind !== "user") throw new Error("unreachable");
    expect(parsed.isMeta).toBe(false);
    expect(parsed.contextReport).toBeNull();
  });

  it("measures the report's length as the command's output", () => {
    const parsed = parseReport(CONTEXT_REPORT);
    expect(parsed.commandOutput).toEqual({
      command: "/context",
      chars: CONTEXT_REPORT.length,
    });
  });

  it("still measures a report whose lines do not match the format", () => {
    const changed = CONTEXT_REPORT.replace(
      "**Tokens:** 82.7k / 1m (8%)",
      "**Tokens:** 82.7k of the window used",
    );
    expect(parseReport(changed).commandOutput?.chars).toBe(changed.length);
  });

  it("measures nothing from a typed prompt that pastes a report", () => {
    const parsed = parseTranscriptLine(
      transcriptUserLine(T0, { content: CONTEXT_REPORT }),
      { keepPromptText: false },
    );
    if (parsed.kind !== "user") throw new Error("unreachable");
    expect(parsed.commandOutput).toBeNull();
  });

  it("stores the report as a load named by its command, size only", async () => {
    const world = makeTranscriptWorld();
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-live",
        source: "startup",
        cwd: "/home/user/proj-a",
        version: "2.0.0",
      },
      T0,
    );
    // The recorded report ran to 9,662 characters; the rest
    // past the cut lines is a marker no stored text may hold.
    const tail = "MARKERFILLER"
      .repeat(900)
      .slice(0, 9_662 - CONTEXT_REPORT.length - 1);
    const report = `${CONTEXT_REPORT}\n${tail}`;
    await followLines(world, [
      transcriptUserLine(T0 + 1_000, {
        content: report,
        extra: { isMeta: true },
      }),
      transcriptUserLine(T0 + 5_000, {
        content: report,
        extra: { isMeta: true },
      }),
    ]);
    const loads = world.storage
      .loadRows("sess-live")
      .map(({ kind, name, sizeBytes, occurredAt, source }) => ({
        kind,
        name,
        sizeBytes,
        occurredAt,
        source,
      }));
    // Each report entered the conversation on its own.
    expect(loads).toEqual([
      {
        kind: "command-output",
        name: "/context",
        sizeBytes: 9_662,
        occurredAt: T0 + 1_000,
        source: "transcript",
      },
      {
        kind: "command-output",
        name: "/context",
        sizeBytes: 9_662,
        occurredAt: T0 + 5_000,
        source: "transcript",
      },
    ]);
    expect(allStoredText(world.storage)).not.toContain("MARKERFILLER");
  });

  it("keeps the latest report per model when followed", async () => {
    const world = makeTranscriptWorld();
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-live",
        source: "startup",
        cwd: "/home/user/proj-a",
        version: "2.0.0",
      },
      T0,
    );
    // The same report shape as the fixture, with the values
    // a later report for the same model must replace, and a
    // second model's report it must not touch.
    const report = (
      model: string,
      tokens: string,
      buffer: string,
      skills: string,
    ): string =>
      [
        "## Context Usage",
        "",
        `**Model:** ${model}`,
        `**Tokens:** ${tokens}`,
        "",
        "| Skills | " + skills + " | 0.8% |",
        "| Autocompact buffer | " + buffer + " | 3.3% |",
      ].join("\n");
    await followLines(world, [
      transcriptUserLine(T0 + 1_000, {
        content: report("claude-sonnet-5-5", "82.7k / 1m (8%)", "33k", "8.3k"),
        extra: { isMeta: true },
      }),
      transcriptUserLine(T0 + 2_000, {
        content: report("claude-sonnet-5-5", "120k / 1m (12%)", "45k", "9.1k"),
        extra: { isMeta: true },
      }),
      transcriptUserLine(T0 + 3_000, {
        content: report("claude-opus-5-5", "10k / 1m (1%)", "33k", "2k"),
        extra: { isMeta: true },
      }),
    ]);
    expect(world.storage.contextReportsFor("sess-live")).toEqual([
      {
        model: "claude-sonnet-5-5",
        window: 1_000_000,
        autocompactBuffer: 45_000,
        ...NO_CATEGORIES,
        skills: 9_100,
        reportedAt: T0 + 2_000,
      },
      {
        model: "claude-opus-5-5",
        window: 1_000_000,
        autocompactBuffer: 33_000,
        ...NO_CATEGORIES,
        skills: 2_000,
        reportedAt: T0 + 3_000,
      },
    ]);
  });
});

/** Write the live session's main and subagent transcripts, then follow. */
async function followSeededTranscripts(): Promise<{
  world: ReturnType<typeof makeTranscriptWorld>;
  result: Awaited<ReturnType<TranscriptFollower["follow"]>>;
}> {
  const world = makeTranscriptWorld();
  seedLiveSession(world.storage);
  const projectDir = join(world.root, "projects", "proj-a");
  mkdirSync(join(projectDir, "sess-live", "subagents"), { recursive: true });
  const mainPath = join(projectDir, "sess-live.jsonl");
  writeFileSync(
    mainPath,
    [
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
      transcriptAssistantLine(T0 + 2000, "req-1", FULL_USAGE, {
        content: [
          { type: "text", text: "PLANTED-ASSISTANT-TEXT" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/x", content: "PLANTED-TOOL-INPUT" },
          },
        ],
      }),
      JSON.stringify({
        type: "user",
        sessionId: "sess-live",
        uuid: "u-result",
        timestamp: iso(T0 + 2500),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "PLANTED-TOOL-RESULT",
            },
          ],
        },
      }),
      transcriptAssistantLine(T0 + 4000, "req-2", {
        input_tokens: 1100,
        output_tokens: 150,
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(projectDir, "sess-live", "subagents", "agent-a1.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-live",
        uuid: "a-sub",
        timestamp: iso(T0 + 5000),
        requestId: "req-sub-1",
        message: {
          role: "assistant",
          model: "claude-haiku",
          usage: { input_tokens: 400, output_tokens: 90 },
          content: [{ type: "text", text: "PLANTED-SUBAGENT-TEXT" }],
        },
      }),
    ].join("\n") + "\n",
  );
  const result = await world.follower.follow("sess-live", mainPath);
  return { world, result };
}

describe("live follow", () => {
  it("stores exact requests linked to the turn and the branch", async () => {
    const { world, result } = await followSeededTranscripts();
    expect(result.requests).toBe(3);
    expect(result.skippedUnknown).toBe(0);

    const requests = queryRows(
      world.storage.dbPath,
      "SELECT * FROM requests WHERE session_id = 'sess-live' ORDER BY started_at",
    );
    expect(requests).toHaveLength(3);
    const [first, second, sub] = requests as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(first.request_id).toBe("req-1");
    expect(first.input_tokens).toBe(1000);
    expect(first.output_tokens).toBe(200);
    expect(first.cache_read_tokens).toBe(300);
    expect(first.cache_write_5m_tokens).toBe(40);
    expect(first.cache_write_1h_tokens).toBe(10);
    expect(first.token_source).toBe("transcript");
    expect(first.query_source).toBe("main");
    expect(first.branch_id).toBeNull();
    const turn = queryRows(
      world.storage.dbPath,
      "SELECT id FROM turns WHERE session_id = 'sess-live' AND prompt_id = 'p-1'",
    ) as { id: number }[];
    expect(first.turn_id).toBe(onlyRow(turn, "the turn for p-1").id);
    expect(second.request_id).toBe("req-2");
    expect(sub.request_id).toBe("req-sub-1");
    expect(sub.query_source).toBe("subagent");
    expect(sub.model).toBe("claude-haiku");
    const branch = queryRows(
      world.storage.dbPath,
      "SELECT id FROM branches WHERE session_id = 'sess-live' AND agent_id = 'a1'",
    ) as { id: number }[];
    expect(sub.branch_id).toBe(onlyRow(branch, "the branch for a1").id);
  });

  it("samples context from the stored requests", async () => {
    const { world } = await followSeededTranscripts();
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT * FROM requests WHERE session_id = 'sess-live' ORDER BY started_at",
    );
    const samples = queryRows(
      world.storage.dbPath,
      "SELECT * FROM context_samples WHERE session_id = 'sess-live' ORDER BY sampled_at",
    );
    expect(samples).toHaveLength(3);
    expect(firstRow(samples, "the first context sample").context_tokens).toBe(
      1000 + 300 + 40 + 10,
    );
    expect(firstRow(samples, "the first context sample").request_id).toBe(
      firstRow(requests, "the first request row").id,
    );
  });

  it("records the transcript as a seen source without storing its text", async () => {
    const { world } = await followSeededTranscripts();
    const stored = allStoredText(world.storage);
    expect(stored).not.toContain("PLANTED-ASSISTANT-TEXT");
    expect(stored).not.toContain("PLANTED-TOOL-INPUT");
    expect(stored).not.toContain("PLANTED-TOOL-RESULT");
    expect(stored).not.toContain("PLANTED-SUBAGENT-TEXT");

    const conditions = queryRows(
      world.storage.dbPath,
      "SELECT sources_seen FROM session_conditions WHERE session_id = 'sess-live'",
    ) as { sources_seen: string }[];
    expect(
      JSON.parse(onlyRow(conditions, "the session conditions").sources_seen),
    ).toContain("transcript");
  });

  it("reads only what was appended, tolerates a truncated last line, and never re-reads", async () => {
    const world = makeTranscriptWorld();
    const mainPath = await recordOneRequest(world);
    expect(await world.follower.follow("sess-live", mainPath)).toEqual({
      entries: 0,
      requests: 0,
      skippedUnknown: 0,
    });
    // Half a line lands: nothing is read yet.
    const line = transcriptAssistantLine(T0 + 3000, "req-2", {
      input_tokens: 5,
      output_tokens: 6,
    });
    appendFileSync(mainPath, line.slice(0, 40));
    expect((await world.follower.follow("sess-live", mainPath)).requests).toBe(
      0,
    );
    // The rest of the line completes it.
    appendFileSync(mainPath, line.slice(40) + "\n");
    expect((await world.follower.follow("sess-live", mainPath)).requests).toBe(
      1,
    );
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT request_id FROM requests WHERE session_id = 'sess-live' ORDER BY started_at",
    ) as { request_id: string }[];
    expect(requests.map((row) => row.request_id)).toEqual(["req-1", "req-2"]);
  });

  it("closes the interrupted step from the transcript marker", async () => {
    const world = makeTranscriptWorld();
    seedLiveSession(world.storage);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Bash",
        tool_use_id: "toolu_9",
        tool_input: { command: "sleep 60" },
      },
      T0 + 4000,
    );
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      [
        transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
        transcriptAssistantLine(
          T0 + 4000,
          "req-9",
          { input_tokens: 10, output_tokens: 10 },
          {
            content: [
              { type: "tool_use", id: "toolu_9", name: "Bash", input: {} },
            ],
          },
        ),
        // The real shape: the interrupted tool IS answered, by an
        // error result carrying the marker as its content, and
        // only then does the marker entry itself arrive.
        JSON.stringify({
          type: "user",
          sessionId: "sess-live",
          uuid: "u-result-9",
          timestamp: iso(T0 + 5000),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_9",
                is_error: true,
                content: "[Request interrupted by user for tool use]",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "sess-live",
          uuid: "u-interrupt",
          timestamp: iso(T0 + 6000),
          message: {
            role: "user",
            content: "[Request interrupted by user for tool use]",
          },
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", mainPath);
    const steps = queryRows(
      world.storage.dbPath,
      "SELECT outcome, outcome_source FROM steps WHERE session_id = 'sess-live' AND tool_use_id = 'toolu_9'",
    );
    expect(steps).toHaveLength(1);
    expect(firstRow(steps, "the first step").outcome).toBe("interrupted");
    expect(firstRow(steps, "the first step").outcome_source).toBe("transcript");
  });

  it("builds a step from the transcript for a call the hooks never reported", async () => {
    const world = makeTranscriptWorld();
    seedLiveSession(world.storage);
    await followLines(world, [
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
      transcriptAssistantLine(T0 + 2000, "req-1", FULL_USAGE, {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/home/user/proj-a/a.ts" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Read",
            input: { file_path: "/home/user/proj-a/b.ts" },
          },
        ],
      }),
      transcriptUserLine(T0 + 2500, {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "first result",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "second result text",
          },
        ],
      }),
      transcriptAssistantLine(T0 + 4000, "req-2", {
        input_tokens: 1100,
        output_tokens: 150,
      }),
    ]);
    // toolu_2 fired no hooks: the follower built its step from
    // the transcript, closed by the result the file carried.
    const built = queryRows(
      world.storage.dbPath,
      "SELECT * FROM steps WHERE session_id = 'sess-live' AND tool_use_id = 'toolu_2'",
    );
    expect(built).toHaveLength(1);
    const step = firstRow(built, "the transcript-built step");
    expect(step.tool_name).toBe("Read");
    expect(step.outcome).toBe("succeeded");
    expect(step.outcome_source).toBe("transcript");
    expect(step.started_at).toBe(T0 + 2000);
    expect(step.ended_at).toBe(T0 + 2500);
    expect(step.duration_ms).toBe(500);
    expect(step.branch_id).toBeNull();
    expect(step.context_chars).toBe(18);
    const turn = queryRows(
      world.storage.dbPath,
      "SELECT id FROM turns WHERE session_id = 'sess-live' AND prompt_id = 'p-1'",
    );
    expect(step.turn_id).toBe(onlyRow(turn, "the turn for p-1").id);
    const second = queryRows(
      world.storage.dbPath,
      "SELECT id FROM requests WHERE session_id = 'sess-live' AND request_id = 'req-2'",
    );
    expect(step.result_request_id).toBe(
      onlyRow(second, "the second request").id,
    );
    // toolu_1 has a hook step: the follower adds no second one.
    const hooked = queryRows(
      world.storage.dbPath,
      "SELECT outcome_source FROM steps WHERE session_id = 'sess-live' AND tool_use_id = 'toolu_1'",
    );
    expect(hooked).toHaveLength(1);
    expect(firstRow(hooked, "the hook step").outcome_source).toBe("hook");
  });

  it("files a subagent entry without isSidechain under its subagent's branch", async () => {
    const world = makeTranscriptWorld();
    const projectDir = join(world.root, "projects", "proj-a");
    const subagentsDir = join(projectDir, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    // The line builder writes no isSidechain key: the entry is
    // the subagent's because it sits in the subagent's file,
    // and nothing in the reader may decide otherwise from the
    // missing field.
    writeFileSync(
      join(subagentsDir, "agent-a1.jsonl"),
      transcriptAssistantLine(
        T0 + 3000,
        "req-sub-9",
        { input_tokens: 100, output_tokens: 10 },
        { uuid: "a-sub-noside" },
      ) + "\n",
    );
    const mainPath = join(projectDir, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }) +
        "\n" +
        transcriptAssistantLine(T0 + 2000, "req-1", FULL_USAGE) +
        "\n",
    );
    seedLiveSession(world.storage);
    await world.follower.follow("sess-live", mainPath);
    const branch = queryRows(
      world.storage.dbPath,
      "SELECT id FROM branches WHERE session_id = 'sess-live' AND agent_id = 'a1'",
    );
    const sub = queryRows(
      world.storage.dbPath,
      "SELECT branch_id, query_source FROM requests WHERE session_id = 'sess-live' AND request_id = 'req-sub-9'",
    );
    expect(sub).toHaveLength(1);
    expect(firstRow(sub, "the subagent request").branch_id).toBe(
      onlyRow(branch, "the branch for a1").id,
    );
    expect(firstRow(sub, "the subagent request").query_source).toBe("subagent");
  });

  it("takes the newest entry's values when one request spans several entries", async () => {
    const world = makeTranscriptWorld();
    seedLiveSession(world.storage);
    const mainPath = join(world.root, "sess-multi.jsonl");
    // One response, written as one entry per content block, all
    // sharing a request id; the early entries carry mid-stream
    // output counts, the last one the final count.
    writeFileSync(
      mainPath,
      [
        transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
        transcriptAssistantLine(T0 + 2000, "req-multi", {
          input_tokens: 100,
          output_tokens: 4,
        }),
        transcriptAssistantLine(T0 + 2500, "req-multi", {
          input_tokens: 100,
          output_tokens: 17,
          cache_read_input_tokens: 200,
        }),
        transcriptAssistantLine(T0 + 3000, "req-multi", {
          input_tokens: 100,
          output_tokens: 42,
          cache_read_input_tokens: 500,
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", mainPath);
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT output_tokens, started_at FROM requests WHERE session_id = 'sess-live' AND request_id = 'req-multi'",
    );
    expect(requests).toHaveLength(1);
    expect(firstRow(requests, "the first request row").output_tokens).toBe(42);
    // The start stays the first entry's.
    expect(firstRow(requests, "the first request row").started_at).toBe(
      T0 + 2000,
    );
    // The context sample moves with the newest entry too.
    const samples = queryRows(
      world.storage.dbPath,
      "SELECT context_tokens FROM context_samples WHERE session_id = 'sess-live'",
    );
    expect(samples).toHaveLength(1);
    expect(firstRow(samples, "the first context sample").context_tokens).toBe(
      600,
    );
  });

  it("re-reads lines whose applying failed, on the next follow", async () => {
    // The request write fails once: the offset must not move
    // past the lines that failed.
    const world = makeTranscriptWorldFailingOnce("req-1");
    seedLiveSession(world.storage);
    const { follower } = world;
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      "{not json" +
        "\n" +
        transcriptUserLine(T0 + 1000, { promptId: "p-1" }) +
        "\n" +
        transcriptAssistantLine(T0 + 2000, "req-1", FULL_USAGE) +
        "\n",
    );
    await expect(follower.follow("sess-live", mainPath)).rejects.toThrow(
      "storage is down",
    );
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT request_id FROM requests WHERE session_id = 'sess-live'",
      ),
    ).toHaveLength(0);
    // The next follow reads the same lines again, and they land.
    expect((await follower.follow("sess-live", mainPath)).requests).toBe(1);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT request_id FROM requests WHERE session_id = 'sess-live'",
      ),
    ).toEqual([{ request_id: "req-1" }]);
    // The unknown line ahead of the failure marked the session
    // partial inside the rolled-back transaction: the re-read
    // must write that mark again, not trust the in-memory flag
    // the failed chunk left behind.
    const sessions = queryRows(
      world.storage.dbPath,
      "SELECT tokens_partial FROM sessions WHERE id = 'sess-live'",
    ) as { tokens_partial: number }[];
    expect(onlyRow(sessions, "the session row").tokens_partial).toBe(1);
  });

  it("resumes from the persisted offset after a restart, and re-follows active sessions", async () => {
    const world = makeTranscriptWorld();
    const mainPath = await recordOneRequest(world);
    expect(existsSync(join(world.dataDir, "transcript-offsets.json"))).toBe(
      true,
    );
    // A new follower over the same folders (the daemon's next
    // run) does not re-read from the start: the appended entry
    // is the only one it processes.
    const restarted = createTranscriptFollower(world.storage, {
      dataDir: world.dataDir,
      configDir: world.configDir,
      settings: () => ({ ...defaultSettings() }),
    });
    appendFileSync(
      mainPath,
      transcriptAssistantLine(T0 + 3000, "req-2", FULL_USAGE) + "\n",
    );
    const afterRestart = await restarted.follow("sess-live", mainPath);
    expect(afterRestart.entries).toBe(1);
    expect(afterRestart.requests).toBe(1);
    // Entries appended without any hook event are picked up for
    // a session that was recently active...
    appendFileSync(
      mainPath,
      transcriptAssistantLine(T0 + 4000, "req-3", FULL_USAGE) + "\n",
    );
    await restarted.refollowActive();
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT request_id FROM requests WHERE session_id = 'sess-live' ORDER BY started_at",
    ) as { request_id: string }[];
    expect(requests.map((row) => row.request_id)).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
    // ...but not once the session has been quiet for a minute.
    appendFileSync(
      mainPath,
      transcriptAssistantLine(T0 + 5000, "req-4", FULL_USAGE) + "\n",
    );
    await restarted.refollowActive(Date.now() + 61_000);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT request_id FROM requests WHERE session_id = 'sess-live' AND request_id = 'req-4'",
      ),
    ).toHaveLength(0);
  });

  it("marks the session partial on shapes it cannot use, without inventing numbers", async () => {
    const world = makeTranscriptWorld();
    seedLiveSession(world.storage);
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      [
        transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
        // An assistant entry with no usage at all.
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-live",
          uuid: "a-broken",
          timestamp: iso(T0 + 2000),
          message: { role: "assistant", model: "claude-sonnet", content: [] },
        }),
        "{not json",
        transcriptAssistantLine(T0 + 3000, "req-ok", {
          input_tokens: 42,
          output_tokens: 8,
        }),
      ].join("\n") + "\n",
    );
    const result = await world.follower.follow("sess-live", mainPath);
    expect(result.skippedUnknown).toBe(2);
    expect(result.requests).toBe(1);
    const sessions = queryRows(
      world.storage.dbPath,
      "SELECT tokens_partial FROM sessions WHERE id = 'sess-live'",
    ) as { tokens_partial: number }[];
    expect(onlyRow(sessions, "the session row").tokens_partial).toBe(1);
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT request_id, input_tokens FROM requests WHERE session_id = 'sess-live'",
    );
    expect(requests).toHaveLength(1);
    expect(firstRow(requests, "the first request row").request_id).toBe(
      "req-ok",
    );
    expect(firstRow(requests, "the first request row").input_tokens).toBe(42);
  });
});

describe("subagent launch links", () => {
  function agentLaunch(
    storage: Storage,
    toolUseId: string,
    type: string,
    at: number,
    agentId?: string,
  ): void {
    recordHookEvent(
      storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        ...(agentId === undefined
          ? { prompt_id: "p-1" }
          : { agent_id: agentId }),
        tool_name: "Agent",
        tool_use_id: toolUseId,
        tool_input: { subagent_type: type },
      },
      at,
    );
  }

  function agentStart(
    storage: Storage,
    agentId: string,
    type: string,
    at: number,
  ): void {
    recordHookEvent(
      storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-live",
        agent_id: agentId,
        agent_type: type,
      },
      at,
    );
  }

  /** The step id a branch is linked to, or null when unlinked. */
  function branchLink(storage: Storage, agentId: string): unknown {
    const branches = queryRows(
      storage.dbPath,
      "SELECT spawning_step_id FROM branches WHERE session_id = 'sess-live' AND agent_id = ?",
      agentId,
    );
    return onlyRow(branches, `the branch for ${agentId}`).spawning_step_id;
  }

  function stepId(storage: Storage, toolUseId: string): unknown {
    const steps = queryRows(
      storage.dbPath,
      "SELECT id FROM steps WHERE session_id = 'sess-live' AND tool_use_id = ?",
      toolUseId,
    );
    return onlyRow(steps, `the step for ${toolUseId}`).id;
  }

  /** A task notification as it is queued in the main transcript. */
  function notificationLine(taskId: string, toolUseId: string): string {
    return JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "sess-live",
      uuid: `u-notification-${toolUseId}`,
      timestamp: iso(T0 + 20000),
      content: [
        "<task-notification>",
        `<task-id>${taskId}</task-id>`,
        `<tool-use-id>${toolUseId}</tool-use-id>`,
        "<status>completed</status>",
        "<summary>Agent finished: PLANTED-NOTIFICATION-TEXT</summary>",
        "</task-notification>",
      ].join("\n"),
    });
  }

  /** Write the main transcript carrying one task notification per call. */
  function writeMainWithNotifications(
    world: ReturnType<typeof makeTranscriptWorld>,
    taskId: string,
    toolUseIds: string[],
  ): string {
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }) +
        "\n" +
        toolUseIds.map((id) => notificationLine(taskId, id) + "\n").join(""),
    );
    return mainPath;
  }

  /** Follow the main transcript carrying the notification. */
  async function followNotification(
    world: ReturnType<typeof makeTranscriptWorld>,
  ): Promise<void> {
    const mainPath = writeMainWithNotifications(world, "a00000000000000aa", [
      "toolu_made_up_1",
    ]);
    await world.follower.follow("sess-live", mainPath);
  }

  it("links an unlinked branch from its task notification", async () => {
    const world = makeTranscriptWorld();
    seedOpening(world.storage);
    agentLaunch(world.storage, "toolu_made_up_1", "explorer", T0 + 3000);
    // The start lands eleven seconds after the launch — past
    // the link window — so the branch stands unlinked.
    agentStart(world.storage, "a00000000000000aa", "explorer", T0 + 14000);
    expect(branchLink(world.storage, "a00000000000000aa")).toBeNull();

    await followNotification(world);

    expect(branchLink(world.storage, "a00000000000000aa")).toBe(
      stepId(world.storage, "toolu_made_up_1"),
    );
    // Nothing of the notification but its two ids is kept.
    expect(allStoredText(world.storage)).not.toContain(
      "PLANTED-NOTIFICATION-TEXT",
    );
  });

  it("keeps a launched subagent's link and turn when a resume's notification names another call", async () => {
    const world = makeTranscriptWorld();
    seedOpening(world.storage);
    agentLaunch(world.storage, "toolu_A1", "explorer", T0 + 3000);
    agentStart(world.storage, "a1", "explorer", T0 + 3500);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        agent_id: "a1",
        tool_name: "Read",
        tool_use_id: "toolu_R1",
        tool_input: { file_path: "/home/user/proj-a/notes.md" },
      },
      T0 + 4000,
    );
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-live",
        prompt_id: "p-2",
        prompt: "ask it again",
      },
      T0 + 10000,
    );
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-2",
        tool_name: "SendMessage",
        tool_use_id: "toolu_S1",
        tool_input: {},
      },
      T0 + 11000,
    );
    const launch = stepId(world.storage, "toolu_A1");
    const turnOf = (toolUseId: string): unknown =>
      onlyRow(
        queryRows(
          world.storage.dbPath,
          "SELECT turn_id FROM steps WHERE session_id = 'sess-live' AND tool_use_id = ?",
          toolUseId,
        ),
        `the step for ${toolUseId}`,
      ).turn_id;
    expect(branchLink(world.storage, "a1")).toBe(launch);
    expect(turnOf("toolu_R1")).toBe(turnOf("toolu_A1"));
    expect(turnOf("toolu_S1")).not.toBe(turnOf("toolu_A1"));

    await world.follower.follow(
      "sess-live",
      writeMainWithNotifications(world, "a1", ["toolu_A1", "toolu_S1"]),
    );

    expect(branchLink(world.storage, "a1")).toBe(launch);
    expect(turnOf("toolu_R1")).toBe(turnOf("toolu_A1"));
  });

  /** Seed a planner and its child explorer's two launches. */
  function seedNestedLaunches(
    world: ReturnType<typeof makeTranscriptWorld>,
  ): void {
    seedOpening(world.storage);
    agentLaunch(world.storage, "toolu_parent", "planner", T0 + 2000);
    agentStart(world.storage, "a0000000000000001", "planner", T0 + 2500);
    // Inside the planner, two explorer launches; the child's
    // start lands nine seconds after the first of them, so
    // the window links it to the first. Its meta names the
    // second launch exactly.
    agentLaunch(
      world.storage,
      "toolu_first",
      "explorer",
      T0 + 3000,
      "a0000000000000001",
    );
    agentLaunch(
      world.storage,
      "toolu_made_up_7",
      "explorer",
      T0 + 4000,
      "a0000000000000001",
    );
    agentStart(world.storage, "a0000000000000002", "explorer", T0 + 12000);
  }

  /** Write the child's meta and transcript, and the main file. */
  function writeNestedMetaFiles(
    world: ReturnType<typeof makeTranscriptWorld>,
  ): string {
    const projectDir = join(world.root, "projects", "proj-a");
    const subagentsDir = join(projectDir, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "agent-a0000000000000002.meta.json"),
      JSON.stringify({
        agentId: "a0000000000000002",
        agentType: "explorer",
        toolUseId: "toolu_made_up_7",
        parentAgentId: "a0000000000000001",
        spawnDepth: 2,
      }),
    );
    writeFileSync(
      join(subagentsDir, "agent-a0000000000000002.jsonl"),
      transcriptAssistantLine(T0 + 13000, "req-sub-2", {
        input_tokens: 400,
        output_tokens: 90,
      }) + "\n",
    );
    const mainPath = join(projectDir, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }) + "\n",
    );
    return mainPath;
  }

  it("links a nested subagent from its meta, past the window's guess", async () => {
    const world = makeTranscriptWorld();
    seedNestedLaunches(world);
    expect(branchLink(world.storage, "a0000000000000002")).toBe(
      stepId(world.storage, "toolu_first"),
    );
    await world.follower.follow("sess-live", writeNestedMetaFiles(world));
    expect(branchLink(world.storage, "a0000000000000002")).toBe(
      stepId(world.storage, "toolu_made_up_7"),
    );
  });

  it("nests a meta-linked child under its parent, in the parent's turn", async () => {
    const world = makeTranscriptWorld();
    seedNestedLaunches(world);
    await world.follower.follow("sess-live", writeNestedMetaFiles(world));
    // The launching step sits in the parent's branch: the
    // child is nested under the planner, and its requests run
    // in the planner's launching turn.
    const parent = queryRows(
      world.storage.dbPath,
      "SELECT id FROM branches WHERE session_id = 'sess-live' AND agent_id = 'a0000000000000001'",
    );
    const launch = queryRows(
      world.storage.dbPath,
      "SELECT branch_id FROM steps WHERE session_id = 'sess-live' AND tool_use_id = 'toolu_made_up_7'",
    );
    expect(onlyRow(launch, "the nested launch").branch_id).toBe(
      onlyRow(parent, "the parent branch").id,
    );
    const child = queryRows(
      world.storage.dbPath,
      "SELECT id FROM branches WHERE session_id = 'sess-live' AND agent_id = 'a0000000000000002'",
    );
    const turn = queryRows(
      world.storage.dbPath,
      "SELECT id FROM turns WHERE session_id = 'sess-live' AND prompt_id = 'p-1'",
    );
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT branch_id, turn_id FROM requests WHERE session_id = 'sess-live' AND request_id = 'req-sub-2'",
    );
    const request = onlyRow(requests, "the child's request");
    expect(request.branch_id).toBe(onlyRow(child, "the child branch").id);
    expect(request.turn_id).toBe(onlyRow(turn, "the first turn").id);
  });

  /** Two explorer launches over the session's opening: the
   *  shared start of the meta-link tests below. */
  function seedTwoExplorerLaunches(
    world: ReturnType<typeof makeTranscriptWorld>,
  ): void {
    seedOpening(world.storage);
    agentLaunch(world.storage, "toolu_first", "explorer", T0 + 3000);
    agentLaunch(world.storage, "toolu_second", "explorer", T0 + 4000);
  }

  /** Write one subagent's meta and transcript, and the main
   *  file, for a meta-link test; returns both paths, so a
   *  test can rewrite the meta between passes. */
  function writeMetaFiles(
    world: ReturnType<typeof makeTranscriptWorld>,
    agentId: string,
    toolUseId: string,
    requestId: string,
  ): { mainPath: string; metaPath: string } {
    const subagentsDir = join(world.root, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
    writeFileSync(
      metaPath,
      JSON.stringify({ agentId, agentType: "explorer", toolUseId }),
    );
    writeFileSync(
      join(subagentsDir, `agent-${agentId}.jsonl`),
      transcriptAssistantLine(T0 + 5000, requestId, {
        input_tokens: 300,
        output_tokens: 60,
      }) + "\n",
    );
    const mainPath = join(world.root, "sess-live.jsonl");
    writeFileSync(
      mainPath,
      transcriptUserLine(T0 + 1000, { promptId: "p-1" }) + "\n",
    );
    return { mainPath, metaPath };
  }

  it("links a subagent from its meta on a later pass, once its branch exists", async () => {
    const world = makeTranscriptWorld();
    // Two explorer launches; the meta names the second. The
    // subagent's file is followed before any start lands, so
    // its branch does not exist yet and the meta's link
    // cannot land on this pass.
    seedTwoExplorerLaunches(world);
    const { mainPath } = writeMetaFiles(
      world,
      "a0000000000000003",
      "toolu_second",
      "req-sub-3",
    );
    await world.follower.follow("sess-live", mainPath);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM branches WHERE session_id = 'sess-live' AND agent_id = 'a0000000000000003'",
      ),
    ).toHaveLength(0);

    // The start lands: its branch is created, and the window
    // links it to the earliest launch of its type —
    // the meta's exact link lands on the next pass, not this one.
    agentStart(world.storage, "a0000000000000003", "explorer", T0 + 12000);
    expect(branchLink(world.storage, "a0000000000000003")).toBe(
      stepId(world.storage, "toolu_first"),
    );

    // The next pass reads the meta again, and this time the
    // link lands on the call the meta names.
    await world.follower.follow("sess-live", mainPath);
    expect(branchLink(world.storage, "a0000000000000003")).toBe(
      stepId(world.storage, "toolu_second"),
    );
  });

  it("settles the meta read when its call has no step, keeping the window link", async () => {
    const world = makeTranscriptWorld();
    // Two explorer launches; the meta names a third call
    // that no step carries — a launch from before recording
    // began, or one whose hook was lost.
    seedTwoExplorerLaunches(world);
    const { mainPath, metaPath } = writeMetaFiles(
      world,
      "a0000000000000004",
      "toolu_unrecorded",
      "req-sub-4",
    );
    await world.follower.follow("sess-live", mainPath);

    // The start lands: its branch is created, and the
    // window links it to the earliest launch of its type.
    agentStart(world.storage, "a0000000000000004", "explorer", T0 + 12000);
    expect(branchLink(world.storage, "a0000000000000004")).toBe(
      stepId(world.storage, "toolu_first"),
    );

    // The next pass reads the meta: the branch exists and
    // no step carries the call it names, so the read
    // settles and the branch keeps its window link.
    await world.follower.follow("sess-live", mainPath);
    expect(branchLink(world.storage, "a0000000000000004")).toBe(
      stepId(world.storage, "toolu_first"),
    );

    // The meta is not read again: rewriting it to name a
    // recorded call changes nothing on the next pass.
    writeFileSync(
      metaPath,
      JSON.stringify({
        agentId: "a0000000000000004",
        agentType: "explorer",
        toolUseId: "toolu_second",
      }),
    );
    await world.follower.follow("sess-live", mainPath);
    expect(branchLink(world.storage, "a0000000000000004")).toBe(
      stepId(world.storage, "toolu_first"),
    );
  });
});

describe("typed prompts", () => {
  /** One user entry in a placed transcript, in the shapes
   *  the captures hold: an origin when Claude Code recorded
   *  one, meta when it flagged the entry as its own. */
  function typedLine(
    at: number,
    fields: {
      content: string | { type: string; text: string }[];
      origin?: Record<string, unknown>;
      isMeta?: boolean;
    },
  ): string {
    return JSON.stringify({
      type: "user",
      sessionId: "sess-typed",
      uuid: `u-${at}`,
      timestamp: iso(at),
      version: "2.0.0",
      ...(fields.origin !== undefined ? { origin: fields.origin } : {}),
      ...(fields.isMeta !== undefined ? { isMeta: fields.isMeta } : {}),
      message: { role: "user", content: fields.content },
    });
  }

  const importTyped = (lines: string[]) =>
    importTranscriptLines("sess-typed", lines);

  function turnTexts(
    world: ReturnType<typeof makeTranscriptWorld>,
  ): (string | null)[] {
    const turns = queryRows(
      world.storage.dbPath,
      "SELECT prompt_text FROM turns WHERE session_id = 'sess-typed' ORDER BY sequence",
    ) as { prompt_text: string | null }[];
    return turns.map((turn) => turn.prompt_text);
  }

  it("opens no turn for a local command's entries", async () => {
    const world = await importTyped([
      // The entries as a transcript holds them: a
      // command's invocation, its caveat and its output, none
      // carrying an origin.
      typedLine(T0 + 1000, {
        content:
          "<command-name>/flightpath:open</command-name>\n<command-message>flightpath:open</command-message>",
      }),
      typedLine(T0 + 2000, {
        content:
          "<local-command-caveat>The command below was run directly in the terminal.</local-command-caveat>",
      }),
      typedLine(T0 + 3000, {
        content: "<command-name>/model</command-name>",
      }),
      typedLine(T0 + 4000, {
        content: "<local-command-stdout>model set</local-command-stdout>",
      }),
      typedLine(T0 + 5000, {
        content: "<command-name>/context</command-name>",
      }),
      typedLine(T0 + 6000, {
        content: "Run the tests.",
        origin: { kind: "human" },
      }),
    ]);
    expect(turnTexts(world)).toEqual(["Run the tests."]);
  });

  it("opens no turn for a task notification", async () => {
    const world = await importTyped([
      typedLine(T0 + 1000, {
        content:
          "<task-notification>\n<task-id>t1</task-id>\n</task-notification>",
        origin: { kind: "task-notification", producer: "session-task" },
      }),
      typedLine(T0 + 2000, {
        content: "Run the tests.",
        origin: { kind: "human" },
      }),
    ]);
    expect(turnTexts(world)).toEqual(["Run the tests."]);
  });

  it("opens no turn for a hand-back entry, and stores none of its text", async () => {
    const world = await importTyped([
      // The hand-back as captured: a peer origin, meta, and
      // text that opens with the session's framing, not with
      // the marker itself.
      typedLine(T0 + 1000, {
        content:
          'Another Claude session sent a message: <agent-message from="a0000000000000000">\n[Subagent hand-back] PLANTED-HANDBACK-REPORT on the files it read.',
        isMeta: true,
        origin: {
          kind: "peer",
          from: "a0000000000000000",
          name: "Explore",
          handback: true,
        },
      }),
      typedLine(T0 + 2000, {
        content: "Run the tests.",
        origin: { kind: "human" },
      }),
    ]);
    expect(turnTexts(world)).toEqual(["Run the tests."]);
    expect(allStoredText(world.storage)).not.toContain(
      "PLANTED-HANDBACK-REPORT",
    );
  });

  it("without an origin, the text decides", async () => {
    const world = await importTyped([
      typedLine(T0 + 1000, {
        content: "<command-name>/usage</command-name>",
      }),
      typedLine(T0 + 2000, { content: "a question typed by hand" }),
    ]);
    expect(turnTexts(world)).toEqual(["a question typed by hand"]);
  });

  it("with an origin, the origin decides", async () => {
    const world = await importTyped([
      // A peer entry whose text would pass the text rule:
      // only the origin keeps it from opening a turn.
      typedLine(T0 + 1000, {
        content: "a progress report from the subagent",
        origin: { kind: "peer", from: "a0000000000000000" },
      }),
    ]);
    expect(turnTexts(world)).toEqual([]);
  });

  it("opens no turn for a command entry whatever its origin", async () => {
    const world = await importTyped([
      // The captures hold command entries with no origin at
      // all, so the text decides either way: a command entry
      // is a command even when an origin calls it human.
      typedLine(T0 + 1000, {
        content: "<command-name>/model</command-name>",
        origin: { kind: "human" },
      }),
    ]);
    expect(turnTexts(world)).toEqual([]);
  });

  it("opens no turn for a command's stderr entry", async () => {
    const world = await importTyped([
      // A failed command's error output, carrying no origin:
      // one of Claude Code's openings, not a typed prompt.
      typedLine(T0 + 1000, {
        content:
          "<local-command-stderr>error: unknown option '--bogus'</local-command-stderr>",
      }),
      typedLine(T0 + 2000, { content: "a question typed by hand" }),
    ]);
    expect(turnTexts(world)).toEqual(["a question typed by hand"]);
  });

  it("reads only the first text block for the openings", async () => {
    // Typed text first and a command's marker second — an
    // image and then pasted text, say: only the opening
    // block counts, so this is a typed prompt, and no
    // command entry either.
    const line = typedLine(T0 + 1000, {
      content: [
        { type: "text", text: "a question typed by hand" },
        { type: "text", text: "<command-name>/model</command-name>" },
      ],
    });
    const world = await importTyped([line]);
    expect(turnTexts(world)).toEqual([
      "a question typed by hand\n<command-name>/model</command-name>",
    ]);
    const parsed = parseTranscriptLine(line, { keepPromptText: false });
    expect(parsed.kind).toBe("user");
    if (parsed.kind !== "user") throw new Error("unreachable");
    expect(parsed.isCommandEntry).toBe(false);
  });
});

describe("the requests upsert (shared with telemetry)", () => {
  it("merges transcript and telemetry into one row, telemetry the source, in either order", async () => {
    const world = makeTranscriptWorld();
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-merge",
        source: "startup",
        cwd: "/home/user/proj-a",
      },
      T0,
    );
    const base = {
      sessionId: "sess-merge",
      requestId: "req-x",
      turnId: null,
      branchId: null,
      model: "claude-sonnet",
      querySource: "main",
      cacheReadTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      startedAt: T0,
      durationMs: null,
    };
    world.storage.upsertRequest({
      ...base,
      inputTokens: 100,
      outputTokens: 10,
      tokenSource: "transcript",
    });
    world.storage.upsertRequest({
      ...base,
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 900,
      tokenSource: "telemetry",
    });
    // Second session: telemetry first, transcript second.
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-merge-2",
        source: "startup",
        cwd: "/home/user/proj-a",
      },
      T0,
    );
    world.storage.upsertRequest({
      ...base,
      sessionId: "sess-merge-2",
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 900,
      tokenSource: "telemetry",
    });
    world.storage.upsertRequest({
      ...base,
      sessionId: "sess-merge-2",
      inputTokens: 999,
      outputTokens: 999,
      tokenSource: "transcript",
    });
    for (const sessionId of ["sess-merge", "sess-merge-2"]) {
      const rows = queryRows(
        world.storage.dbPath,
        "SELECT * FROM requests WHERE session_id = ?",
        sessionId,
      );
      expect(rows).toHaveLength(1);
      expect(onlyRow(rows, "the merged request row").token_source).toBe(
        "telemetry",
      );
      expect(onlyRow(rows, "the merged request row").input_tokens).toBe(100);
      expect(onlyRow(rows, "the merged request row").duration_ms).toBe(900);
    }
  });
});

describe("import", () => {
  const INSTALL = IMPORT_INSTALL;

  /** Place the fresh control transcript and import everything:
   *  the control imports, the named session does not. */
  async function expectOnlyFreshImports(
    world: ReturnType<typeof makeTranscriptWorld>,
    excludedId: string,
  ): Promise<void> {
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-fresh",
      transcriptFor("sess-fresh", Date.now() - 120_000),
      Date.now(),
    );
    const result = await world.follower.importAll();
    expect(result.importedSessions).toBe(1);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM sessions WHERE id = ?",
        "sess-fresh",
      ),
    ).toHaveLength(1);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM sessions WHERE id = ?",
        excludedId,
      ),
    ).toHaveLength(0);
  }

  function placeTranscript(
    world: ReturnType<typeof makeTranscriptWorld>,
    projectPath: string,
    sessionId: string,
    lines: string[],
    mtime: number,
  ): string {
    const dir = join(
      world.configDir,
      "projects",
      encodeProjectPath(projectPath),
    );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, lines.join("\n") + "\n");
    const when = new Date(mtime);
    utimesSync(path, when, when);
    return path;
  }

  function transcriptFor(sessionId: string, base = T0): string[] {
    return [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: `u-${sessionId}`,
        timestamp: iso(base + 1000),
        promptId: `p-${sessionId}`,
        version: "2.0.0",
        message: { role: "user", content: "an imported prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: `a-${sessionId}`,
        timestamp: iso(base + 2000),
        requestId: `req-${sessionId}`,
        version: "2.0.0",
        message: {
          role: "assistant",
          model: "claude-sonnet",
          usage: { input_tokens: 700, output_tokens: 70 },
          content: [{ type: "text", text: "imported answer" }],
        },
      }),
    ];
  }

  function pausedTranscriptLines(): string[] {
    return [
      JSON.stringify({
        type: "user",
        sessionId: "sess-paused",
        uuid: "u-paused",
        timestamp: iso(T0 + 1000),
        promptId: "p-paused",
        message: { role: "user", content: "before the pause" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-paused",
        uuid: "a-inside",
        timestamp: iso(T0 + 2000),
        requestId: "req-inside-pause",
        message: {
          role: "assistant",
          model: "claude-sonnet",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [],
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-paused",
        uuid: "a-outside",
        timestamp: iso(T0 + 4000),
        requestId: "req-outside-pause",
        message: {
          role: "assistant",
          model: "claude-sonnet",
          usage: { input_tokens: 2, output_tokens: 2 },
          content: [],
        },
      }),
    ];
  }

  it("imports only recorded projects, only files modified since install", async () => {
    const world = seedImportWorld();
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-new",
      transcriptFor("sess-new"),
      INSTALL + 60_000,
    );
    placeTranscript(
      world,
      "/home/user/proj-b",
      "sess-stranger",
      transcriptFor("sess-stranger"),
      INSTALL + 60_000,
    );
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-old",
      transcriptFor("sess-old"),
      INSTALL - 60_000,
    );
    const result = await world.follower.importAll();
    expect(result.importedSessions).toBe(1);
    const sessions = queryRows(
      world.storage.dbPath,
      "SELECT id, joined_partway, status, first_seen_at, last_seen_at FROM sessions WHERE id = 'sess-new'",
    );
    expect(sessions).toHaveLength(1);
    expect(onlyRow(sessions, "the session row").joined_partway).toBe(1);
    // Imported sessions are finished sessions: ended, bounded
    // by their own first and last entries, not by the import.
    expect(onlyRow(sessions, "the session row").status).toBe("ended");
    expect(onlyRow(sessions, "the session row").first_seen_at).toBe(T0 + 1000);
    expect(onlyRow(sessions, "the session row").last_seen_at).toBe(T0 + 2000);
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT request_id, input_tokens FROM requests WHERE session_id = 'sess-new'",
    );
    expect(requests).toHaveLength(1);
    expect(firstRow(requests, "the first request row").input_tokens).toBe(700);
    const turns = queryRows(
      world.storage.dbPath,
      "SELECT prompt_text FROM turns WHERE session_id = 'sess-new'",
    ) as { prompt_text: string }[];
    expect(turns).toHaveLength(1);
    expect(onlyRow(turns, "the imported turn").prompt_text).toBe(
      "an imported prompt",
    );
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM sessions WHERE id = 'sess-stranger'",
      ),
    ).toHaveLength(0);
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM sessions WHERE id = 'sess-old'",
      ),
    ).toHaveLength(0);
  });

  it("does not import a purged session", async () => {
    const world = seedImportWorld();
    // A recorded session retention has since purged: its rows
    // are gone, the purge marker stands, and its transcript is
    // still on disk.
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-purged",
        source: "startup",
        cwd: "/home/user/proj-a",
      },
      T0,
    );
    world.storage.purgeSession("sess-purged", T0);
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-purged",
      transcriptFor("sess-purged", Date.now() - 120_000),
      Date.now(),
    );
    await expectOnlyFreshImports(world, "sess-purged");
  });

  it("does not import a transcript older than the retention window", async () => {
    const world = seedImportWorld();
    // A transcript whose last entry is 30 days old, past the
    // 15-day window.
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-aged",
      transcriptFor("sess-aged", Date.now() - 30 * 24 * 60 * 60 * 1000),
      Date.now(),
    );
    await expectOnlyFreshImports(world, "sess-aged");
  });

  it("opens import turns only for entries that are prompts", async () => {
    const world = seedImportWorld();
    const entry = (
      at: number,
      extra: Record<string, unknown>,
      message: Record<string, unknown>,
    ): string =>
      JSON.stringify({
        type: "user",
        sessionId: "sess-turns",
        uuid: `u-${at}`,
        timestamp: iso(at),
        version: "2.0.0",
        message,
        ...extra,
      });
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-turns",
      [
        // A real prompt, with an id.
        entry(
          T0 + 1000,
          { promptId: "p-1" },
          { role: "user", content: "first" },
        ),
        // An assistant reply that calls a tool.
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-turns",
          uuid: "a-1",
          timestamp: iso(T0 + 2000),
          requestId: "req-t1",
          version: "2.0.0",
          message: {
            role: "assistant",
            model: "claude-sonnet",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "tool_use", id: "toolu_t", name: "Read", input: {} },
            ],
          },
        }),
        // The tool result coming back: not a prompt.
        entry(
          T0 + 3000,
          {},
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_t", content: "ok" },
            ],
          },
        ),
        // A housekeeping entry: not a prompt.
        entry(T0 + 4000, { isMeta: true }, { role: "user", content: "meta" }),
        // An interrupt marker: not a prompt.
        entry(
          T0 + 5000,
          {},
          {
            role: "user",
            content: "[Request interrupted by user]",
          },
        ),
        // A real prompt without an id still opens a turn.
        entry(T0 + 6000, {}, { role: "user", content: "second" }),
      ],
      INSTALL + 60_000,
    );
    const result = await world.follower.importAll();
    expect(result.importedSessions).toBe(1);
    const turns = queryRows(
      world.storage.dbPath,
      "SELECT prompt_text FROM turns WHERE session_id = 'sess-turns' ORDER BY sequence",
    ) as { prompt_text: string }[];
    expect(turns.map((turn) => turn.prompt_text)).toEqual(["first", "second"]);
  });

  it("a start after the import clears the partway mark the import left", async () => {
    const world = seedImportWorld();
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-new",
      transcriptFor("sess-new"),
      INSTALL + 60_000,
    );
    const result = await world.follower.importAll();
    expect(result.importedSessions).toBe(1);
    const before = queryRows(
      world.storage.dbPath,
      "SELECT joined_partway FROM sessions WHERE id = 'sess-new'",
    );
    expect(onlyRow(before, "the imported row").joined_partway).toBe(1);
    // The session's own start arrives afterwards (its hooks
    // were recorded late): a startup proves the beginning was
    // seen, whichever source inserted the row first.
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-new",
        source: "startup",
        cwd: "/home/user/proj-a",
      },
      T0 + 3000,
    );
    const after = queryRows(
      world.storage.dbPath,
      "SELECT joined_partway FROM sessions WHERE id = 'sess-new'",
    );
    expect(onlyRow(after, "the imported row").joined_partway).toBe(0);
  });

  it("never imports a forgotten session", async () => {
    const world = seedImportWorld();
    // A forgotten marker exists, so the transcript stays unread.
    world.storage.forgetSession("sess-forgotten", T0);
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-forgotten",
      transcriptFor("sess-forgotten"),
      INSTALL + 60_000,
    );
    await world.follower.importAll();
    expect(
      queryRows(
        world.storage.dbPath,
        "SELECT id FROM sessions WHERE id = 'sess-forgotten'",
      ),
    ).toHaveLength(0);
  });

  it("never imports requests from a paused period", async () => {
    const world = seedImportWorld();
    // Requests inside the pause window are not filled in; the
    // session itself, and its request after the resume, import.
    world.storage.recordPause("sess-paused", T0 + 1500);
    world.storage.recordResume("sess-paused", T0 + 3000);
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-paused",
      pausedTranscriptLines(),
      INSTALL + 60_000,
    );
    const result = await world.follower.importAll();
    expect(result.importedSessions).toBe(1);
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT request_id FROM requests WHERE session_id = 'sess-paused'",
    ) as { request_id: string }[];
    expect(requests.map((row) => row.request_id)).toEqual([
      "req-outside-pause",
    ]);
  });

  it("never imports a session from an excluded folder", async () => {
    const excluded = seedImportWorld({
      excludedFolders: ["/home/user/proj-a"],
    });
    placeTranscript(
      excluded,
      "/home/user/proj-a",
      "sess-excluded",
      transcriptFor("sess-excluded"),
      INSTALL + 60_000,
    );
    expect((await excluded.follower.importAll()).importedSessions).toBe(0);
  });

  it("stores only the prompt's length when storePromptText is off", async () => {
    const world = seedImportWorld({ storePromptText: false });
    placeTranscript(
      world,
      "/home/user/proj-a",
      "sess-quiet",
      [
        JSON.stringify({
          type: "user",
          sessionId: "sess-quiet",
          uuid: "u-quiet",
          timestamp: iso(T0 + 1000),
          promptId: "p-quiet",
          message: { role: "user", content: "PLANTED-PROMPT-TEXT" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-quiet",
          uuid: "a-quiet",
          timestamp: iso(T0 + 2000),
          requestId: "req-quiet",
          message: {
            role: "assistant",
            model: "claude-sonnet",
            usage: { input_tokens: 3, output_tokens: 4 },
            content: [],
          },
        }),
      ],
      INSTALL + 60_000,
    );
    await world.follower.importAll();
    const turns = queryRows(
      world.storage.dbPath,
      "SELECT prompt_text FROM turns WHERE session_id = 'sess-quiet'",
    ) as { prompt_text: string | null }[];
    expect(turns).toHaveLength(1);
    expect(onlyRow(turns, "the imported turn").prompt_text).toBeNull();
    expect(allStoredText(world.storage)).not.toContain("PLANTED-PROMPT-TEXT");
  });
});

describe("daemon wiring", DAEMON_SUITE, () => {
  /** Seed a recorded session, its transcript, and one buffered prompt. */
  function seedDaemonTranscript(): { root: string; dataDir: string } {
    const { root } = makeRoot("flightpath-transcripts-daemon-");
    const dataDir = dataDirFor(root);
    mkdirSync(join(dataDir, "buffer"), { recursive: true });
    // A recorded session and its transcript, both in place
    // before the daemon starts.
    const seed = openStorage({ dataDir });
    recordHookEvent(
      seed,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-live",
        source: "startup",
        cwd: "/home/user/proj-a",
        version: "2.0.0",
      },
      T0,
    );
    recordHookEvent(
      seed,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-live",
        prompt_id: "p-1",
        prompt: "write the report",
      },
      T0 + 1000,
    );
    seed.close();
    const transcriptPath = join(root, "sess-live.jsonl");
    writeFileSync(
      transcriptPath,
      [
        transcriptUserLine(T0 + 1000, { promptId: "p-1" }),
        transcriptAssistantLine(T0 + 2000, "req-daemon", {
          input_tokens: 64,
          output_tokens: 12,
        }),
      ].join("\n") + "\n",
    );
    // One more prompt arrives through the buffer while the
    // daemon is down; its drain triggers the follow.
    const envelope = {
      id: "env-drain-1",
      received_at: T0 + 3000,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-live",
        prompt_id: "p-1",
        prompt: "write the report",
        cwd: "/home/user/proj-a",
        transcript_path: transcriptPath,
      },
    };
    writeFileSync(
      join(dataDir, "buffer", "env-drain-1.json"),
      JSON.stringify(envelope),
    );
    return { root, dataDir };
  }

  /** Poll the daemon's database until the followed request lands. */
  async function waitForDaemonRequest(dbPath: string): Promise<void> {
    await waitFor(() => {
      if (!existsSync(dbPath)) return false;
      const rows = queryRows(
        dbPath,
        "SELECT request_id FROM requests WHERE session_id = 'sess-live'",
      );
      return rows.some((row) => row.request_id === "req-daemon");
    });
  }

  it("follows transcripts as buffered hook events drain", async () => {
    const { root, dataDir } = seedDaemonTranscript();
    const child = startDaemon(root);
    await waitForDaemonRequest(join(dataDir, "flightpath.db"));
    await stopDaemon(child);
  });

  it("reads a subagent's waiting file when the session's end event drains", async () => {
    const { root, dataDir } = seedDaemonTranscript();
    const subagentsDir = join(root, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "agent-a1.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: iso(T0 + 2500),
        message: { role: "user", content: "look into the notes" },
      }) + "\n",
    );
    writeFileSync(
      join(dataDir, "buffer", "env-drain-2.json"),
      JSON.stringify({
        id: "env-drain-2",
        received_at: T0 + 4000,
        redaction_version: 1,
        plugin_version: "0.0.0",
        event: {
          hook_event_name: "SessionEnd",
          session_id: "sess-live",
          transcript_path: join(root, "sess-live.jsonl"),
        },
      }),
    );
    const child = startDaemon(root);
    await waitFor(() => {
      const dbPath = join(dataDir, "flightpath.db");
      if (!existsSync(dbPath)) return false;
      return (
        queryRows(
          dbPath,
          "SELECT id FROM raw_events WHERE session_id = 'sess-live' AND source = 'transcript' AND event_at = ?",
          T0 + 2500,
        ).length > 0
      );
    });
    await stopDaemon(child);
  });

  it("stops with the daemon", async () => {
    const { root, dataDir } = seedDaemonTranscript();
    const child = startDaemon(root);
    await waitForDaemonRequest(join(dataDir, "flightpath.db"));
    await stopCleanly(child, dataDir);
    expect(readFileSync(join(dataDir, "logs", "daemon.log"), "utf8")).toContain(
      "exited",
    );
  });
});
