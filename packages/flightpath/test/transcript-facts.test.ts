import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import {
  apiRequestLine,
  apiRequestShapeLine,
  CACHE_CONTROL_1H,
  compactBoundaryLine,
  compactFileReferenceLine,
  commandPermissionsLine,
  fileAttachmentLine,
  recordHookEvent,
  transcriptAssistantLine,
  transcriptUserLine,
} from "./support/events.js";
import { onlyRow } from "./support/rows.js";
import {
  allStoredText,
  openAtLatestVersion,
  queryRows,
} from "./support/storage.js";
import { telemetryExport, telemetryRecord } from "./support/telemetry.js";
import { iso } from "./support/time.js";
import {
  followLines,
  makeTelemetryWorld,
  makeTranscriptWorld,
} from "./support/worlds.js";

import { ingestEnvelope, type Envelope } from "../src/daemon/ingest.js";
import { FILL_REQUEST_EFFORT_SQL } from "../src/journey/index.js";
import {
  createTranscriptFollower,
  readAutoCompactWindow,
} from "../src/transcripts/index.js";
import { DELETE_PROMPT_ATTACHMENTS_SQL } from "../src/transcripts/ingest.js";
import { defaultSettings } from "../src/settings/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { MIGRATIONS } from "../src/storage/schema.js";
import { createTelemetryIntake } from "../src/telemetry/index.js";

// What the transcript reader records for the lenses: which
// request first carried each step's result, instruction-file
// sizes, what a prompt carried (counts and sizes, never
// contents), the effort a request ran at, and the shape of
// each request. Fixtures model what Claude Code v2.1.311
// writes: a request's shape, blob and request entries come
// before its response entries, one request writes several
// response entries, and attached files arrive as their own
// entries. A pasted image is a base64 block inside the typed
// prompt's own entry, followed by a companion entry that names
// the image's temp file.

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const USAGE = { input_tokens: 100, output_tokens: 20 };

afterEach(async () => {
  await runCleanups();
});

type World = ReturnType<typeof makeTranscriptWorld>;

function dbRows(world: World, sql: string): Record<string, unknown>[] {
  return queryRows(join(world.dataDir, "flightpath.db"), sql);
}

function seedSession(world: World, projectPath: string): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-live",
      source: "startup",
      cwd: projectPath,
      version: "2.0.0",
    },
    T0,
  );
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-live",
      prompt_id: "p-1",
      prompt: "write the report",
    },
    T0 + 1000,
  );
}

/** A second session, recorded only so a test can forget it. */
function seedOtherSession(world: World): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-other",
      source: "startup",
      cwd: "/home/user/proj-b",
      version: "2.0.0",
    },
    T0 + 500,
  );
}

/** The shape namings as stored: which sessions named which shape. */
function shapeNamings(world: World): Record<string, unknown>[] {
  return dbRows(
    world,
    "SELECT session_id, hash FROM session_shapes ORDER BY session_id",
  );
}

/** The stored shapes' hashes, in the order they were stored. */
function storedShapeHashes(world: World): unknown[] {
  return dbRows(world, "SELECT hash FROM request_shapes").map(
    (row) => row.hash,
  );
}

/** The one stored shape stands, named by the live session alone. */
function expectShapeNamedByLive(world: World): void {
  expect(shapeNamings(world)).toEqual([
    { session_id: "sess-live", hash: "a".repeat(64) },
  ]);
  expect(storedShapeHashes(world)).toEqual(["a".repeat(64)]);
}

/**
 * The opening of a shape follow: a prompt, the shape entry,
 * and a request entry naming the shape, with cache control.
 * The response entry has not landed yet.
 */
function shapeOpeningLines(): string[] {
  return [
    transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
    textShapeLine(T0 + 3500, "sys"),
    apiRequestLine(T0 + 3700, "client-1", {
      cacheControl: CACHE_CONTROL_1H,
    }),
  ];
}

function seedStep(
  world: World,
  toolUseId: string,
  toolName: string,
  at: number,
): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-live",
      prompt_id: "p-1",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: {},
    },
    at,
  );
}

function resultLine(
  at: number,
  toolUseId: string,
  content: unknown,
  isError = false,
  extra: Record<string, unknown> = {},
): string {
  return transcriptUserLine(at, {
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    ],
    extra,
  });
}

function toolUseLine(
  at: number,
  requestId: string,
  requestRef: string,
  toolUseId: string,
  toolName: string,
): string {
  return transcriptAssistantLine(at, requestId, USAGE, {
    content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
    extra: { requestRef },
  });
}

const SAVED_OUTPUT_NOTICE =
  "<persisted-output>\nOutput too large (31.0KB). Full output saved to: /home/user/.claude/projects/proj-a/sess-live/tool-results/toolu_saved.txt\n</persisted-output>";

/** A shape entry whose system prompt is one text block, no tools. */
function textShapeLine(at: number, systemText: string): string {
  return apiRequestShapeLine(at, {
    system: [{ type: "text", text: systemText }],
    tools: [],
  });
}

function apiRequestBlobLine(at: number, content: unknown[]): string {
  return JSON.stringify({
    type: "api-request-blob",
    sessionId: "sess-live",
    hash: "c".repeat(64),
    timestamp: iso(at),
    version: "2.1.311",
    message: { role: "user", content },
  });
}

describe("step result links", () => {
  it("links each step to the first request recorded after its result lands", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    seedStep(world, "toolu_b", "Read", T0 + 2100);
    seedStep(world, "toolu_task", "Task", T0 + 2200);
    seedStep(world, "toolu_late", "Read", T0 + 2300);
    seedStep(world, "toolu_stop", "Read", T0 + 2400);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      // One request writes several response entries. The first
      // result lands between two of them: it belongs to the
      // next request, not to the request that issued the call.
      toolUseLine(T0 + 4000, "req-1", "client-1", "toolu_a", "Read"),
      resultLine(T0 + 5000, "toolu_a", "a"),
      toolUseLine(T0 + 6000, "req-1", "client-1", "toolu_b", "Read"),
      // A parallel pair: both results land in one entry, so the
      // next request carries both.
      transcriptUserLine(T0 + 7000, {
        content: [
          { type: "tool_result", tool_use_id: "toolu_b", content: "b" },
          { type: "tool_result", tool_use_id: "toolu_task", content: "task" },
        ],
      }),
      transcriptAssistantLine(T0 + 8000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
      // This result lands only after req-2 was recorded, so
      // req-3 is the request that carries it.
      resultLine(T0 + 9000, "toolu_late", "late"),
      toolUseLine(T0 + 10000, "req-3", "client-3", "toolu_stop", "Read"),
      resultLine(
        T0 + 11000,
        "toolu_stop",
        "[Request interrupted by user for tool use]",
        true,
      ),
      transcriptAssistantLine(T0 + 12000, "req-4", USAGE, {
        extra: { requestRef: "client-4" },
      }),
    ]);
    const requests = dbRows(
      world,
      "SELECT id, request_id FROM requests ORDER BY id",
    );
    const idOf = (requestId: string): unknown =>
      onlyRow(
        requests.filter((row) => row.request_id === requestId),
        "a request",
      ).id;
    const steps = dbRows(
      world,
      "SELECT tool_use_id, result_request_id FROM steps ORDER BY tool_use_id",
    );
    const linkOf = (toolUseId: string): unknown =>
      onlyRow(
        steps.filter((row) => row.tool_use_id === toolUseId),
        "a step",
      ).result_request_id;
    expect(linkOf("toolu_a")).toBe(idOf("req-2"));
    expect(linkOf("toolu_b")).toBe(idOf("req-2"));
    expect(linkOf("toolu_task")).toBe(idOf("req-2"));
    expect(linkOf("toolu_late")).toBe(idOf("req-3"));
    // The interrupted step's marker result links nothing.
    expect(linkOf("toolu_stop")).toBeNull();
  });

  it("settles links in a subagent's own transcript, per file", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_sub", "Read", T0 + 2000);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-live",
        agent_id: "a1",
        agent_type: "explore",
      },
      T0 + 2500,
    );
    const subagentsDir = join(world.root, "sess-live", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "agent-a1.jsonl"),
      [
        toolUseLine(T0 + 4000, "req-s1", "client-s1", "toolu_sub", "Read"),
        resultLine(T0 + 5000, "toolu_sub", "sub result"),
        // A second entry of the same request settles nothing.
        transcriptAssistantLine(T0 + 6000, "req-s1", USAGE, {
          extra: { requestRef: "client-s1" },
        }),
        transcriptAssistantLine(T0 + 7000, "req-s2", USAGE, {
          extra: { requestRef: "client-s2" },
        }),
      ].join("\n") + "\n",
    );
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
    ]);
    const step = onlyRow(
      dbRows(
        world,
        "SELECT r.request_id AS carrier FROM steps s JOIN requests r ON r.id = s.result_request_id WHERE s.tool_use_id = 'toolu_sub'",
      ),
      "a linked step",
    );
    expect(step.carrier).toBe("req-s2");
  });

  it("leaves the link null for a session hooks recorded without a transcript", () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    const step = onlyRow(
      dbRows(world, "SELECT tool_name, result_request_id FROM steps"),
      "a step",
    );
    expect(step.tool_name).toBe("Read");
    expect(step.result_request_id).toBeNull();
  });
});

describe("step result sizes as sent", () => {
  /** A step's stored sizes and link, by its tool-use id. */
  function stepFacts(world: World, toolUseId: string): Record<string, unknown> {
    const steps = dbRows(
      world,
      "SELECT tool_use_id, result_size, result_request_id, context_chars, context_images, async_launch, saved_output_bytes FROM steps",
    );
    return onlyRow(
      steps.filter((row) => row.tool_use_id === toolUseId),
      "a step",
    );
  }

  /**
   * The lines of one step's journey: the prompt, the tool
   * use, the given result entries, then the request whose
   * input takes the results in.
   */
  function journeyLines(
    toolUseId: string,
    toolName: string,
    results: { at: number; content: string | unknown[] }[],
  ): string[] {
    return [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      toolUseLine(T0 + 4000, "req-1", "client-1", toolUseId, toolName),
      ...results.map((result) =>
        resultLine(result.at, toolUseId, result.content),
      ),
      transcriptAssistantLine(T0 + 9000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ];
  }

  it("stores a result's characters as sent, for string content and for text blocks", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_str", "Read", T0 + 2000);
    seedStep(world, "toolu_blocks", "Read", T0 + 2100);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      toolUseLine(T0 + 4000, "req-1", "client-1", "toolu_str", "Read"),
      resultLine(T0 + 5000, "toolu_str", "s".repeat(1200)),
      toolUseLine(T0 + 6000, "req-1", "client-1", "toolu_blocks", "Read"),
      resultLine(T0 + 7000, "toolu_blocks", [
        { type: "text", text: "b".repeat(300) },
        { type: "text", text: "c".repeat(500) },
      ]),
      transcriptAssistantLine(T0 + 8000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ]);
    expect(stepFacts(world, "toolu_str").context_chars).toBe(1200);
    expect(stepFacts(world, "toolu_str").context_images).toBe(0);
    expect(stepFacts(world, "toolu_blocks").context_chars).toBe(800);
    expect(stepFacts(world, "toolu_blocks").context_images).toBe(0);
  });

  it("stores the size a saved-output notice gives, beside the notice's own characters", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_saved", "Bash", T0 + 2000);
    seedStep(world, "toolu_plain", "Bash", T0 + 2100);
    await followLines(world, [
      ...journeyLines("toolu_saved", "Bash", [
        { at: T0 + 5000, content: SAVED_OUTPUT_NOTICE },
        { at: T0 + 5100, content: "x".repeat(40) },
      ]),
    ]);
    const saved = stepFacts(world, "toolu_saved");
    expect(saved.saved_output_bytes).toBe(31_000);
    expect(saved.context_chars).toBe(SAVED_OUTPUT_NOTICE.length);
    expect(stepFacts(world, "toolu_plain").saved_output_bytes).toBeNull();
  });

  it("stores the saved size on a step only the transcript saw", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(
      world,
      journeyLines("toolu_unseen", "Bash", [
        { at: T0 + 5000, content: SAVED_OUTPUT_NOTICE },
      ]),
    );
    expect(stepFacts(world, "toolu_unseen").saved_output_bytes).toBe(31_000);
  });

  it("reads a result that only quotes the notice's words as sent whole", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_quote", "Bash", T0 + 2000);
    await followLines(
      world,
      journeyLines("toolu_quote", "Bash", [
        { at: T0 + 5000, content: `see ${SAVED_OUTPUT_NOTICE}` },
      ]),
    );
    expect(stepFacts(world, "toolu_quote").saved_output_bytes).toBeNull();
  });

  it("stores a short reference as the short size, beside the raw size", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_big", "Bash", T0 + 2000);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PostToolUse",
        session_id: "sess-live",
        tool_name: "Bash",
        tool_use_id: "toolu_big",
        tool_response: "r".repeat(234_000),
      },
      T0 + 2500,
    );
    await followLines(
      world,
      journeyLines("toolu_big", "Bash", [
        { at: T0 + 5000, content: "q".repeat(180) },
      ]),
    );
    const step = stepFacts(world, "toolu_big");
    expect(step.result_size).toBe(234_000);
    expect(step.context_chars).toBe(180);
  });

  it("counts an image inside a result, and never reads it", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_img", "Read", T0 + 2000);
    const imageData = "aW1hZ2VkYXRh" + "Z".repeat(120);
    await followLines(
      world,
      journeyLines("toolu_img", "Read", [
        {
          at: T0 + 5000,
          content: [
            { type: "text", text: "t".repeat(64) },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageData,
              },
            },
          ],
        },
      ]),
    );
    const step = stepFacts(world, "toolu_img");
    expect(step.context_chars).toBe(64);
    expect(step.context_images).toBe(1);
    expect(allStoredText(world.storage)).not.toContain(imageData);
  });

  it("leaves both sizes null for a session no transcript names", () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    const step = stepFacts(world, "toolu_a");
    expect(step.context_chars).toBeNull();
    expect(step.context_images).toBeNull();
    expect(step.async_launch).toBeNull();
  });

  it("keeps the transcript's sizes when the step's hook record lands after its result", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    // The hook was buffered while the daemon was down: the
    // transcript's result is read first, and the settle
    // builds the step itself, closed with its sizes.
    await followLines(
      world,
      journeyLines("toolu_late", "Read", [
        { at: T0 + 5000, content: "x".repeat(50) },
      ]),
    );
    // The hook record lands late: it fills what the
    // transcript could not know and leaves the settled
    // facts — the link and both sizes — exactly as they are.
    seedStep(world, "toolu_late", "Read", T0 + 7000);
    const step = stepFacts(world, "toolu_late");
    expect(step.result_request_id).not.toBeNull();
    expect(step.context_chars).toBe(50);
    expect(step.context_images).toBe(0);
  });

  /** Follow an Agent step whose result entry carries the given entry-level fields. */
  async function followAgentResult(
    world: World,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_agent", "Agent", T0 + 2000);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      toolUseLine(T0 + 4000, "req-1", "client-1", "toolu_agent", "Agent"),
      resultLine(T0 + 5000, "toolu_agent", "n".repeat(1132), false, extra),
      transcriptAssistantLine(T0 + 9000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ]);
    return stepFacts(world, "toolu_agent");
  }

  it("marks a result that only announced a background subagent", async () => {
    const step = await followAgentResult(makeTranscriptWorld(), {
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "a0000000000000001",
        description: "d".repeat(20),
        resolvedModel: "claude-sonnet-5-5",
        prompt: "p".repeat(200),
      },
    });
    expect(step.async_launch).toBe(1);
    expect(step.context_chars).toBe(1132);
  });

  it("leaves a result that carried the answer unmarked", async () => {
    const withAnswer = await followAgentResult(makeTranscriptWorld(), {
      toolUseResult: { status: "completed", agentId: "a0000000000000001" },
    });
    expect(withAnswer.async_launch).toBe(0);
    const withNoField = await followAgentResult(makeTranscriptWorld(), {});
    expect(withNoField.async_launch).toBe(0);
  });

  it("does not mark either of two results sharing one entry", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_one", "Agent", T0 + 2000);
    seedStep(world, "toolu_two", "Read", T0 + 2100);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        content: [
          { type: "tool_use", id: "toolu_one", name: "Agent", input: {} },
          { type: "tool_use", id: "toolu_two", name: "Read", input: {} },
        ],
        extra: { requestRef: "client-1" },
      }),
      transcriptUserLine(T0 + 5000, {
        content: [
          { type: "tool_result", tool_use_id: "toolu_one", content: "a" },
          { type: "tool_result", tool_use_id: "toolu_two", content: "b" },
        ],
        extra: { toolUseResult: { status: "async_launched" } },
      }),
      transcriptAssistantLine(T0 + 9000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ]);
    expect(stepFacts(world, "toolu_one").async_launch).toBe(0);
    expect(stepFacts(world, "toolu_two").async_launch).toBe(0);
  });

  it("keeps the first size when a transcript repeats a result entry", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    await followLines(
      world,
      journeyLines("toolu_a", "Read", [
        { at: T0 + 5000, content: "f".repeat(100) },
        // A resumed session's transcript repeats the entry,
        // carrying a different size the second time.
        { at: T0 + 5500, content: "g".repeat(999) },
      ]),
    );
    expect(stepFacts(world, "toolu_a").context_chars).toBe(100);
  });

  it("keeps the first landing's size when a transcript repeats a result entry", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const path = join(world.root, "sess-live.jsonl");
    // The result lands and the next request settles it
    // before any hook record exists: the settle builds the
    // step from the transcript, closed with the first
    // landing's size, and drops the call's record.
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      toolUseLine(T0 + 4000, "req-1", "client-1", "toolu_a", "Read"),
      resultLine(T0 + 5000, "toolu_a", "f".repeat(100)),
      transcriptAssistantLine(T0 + 9000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ]);
    // The step's hook record arrives late (its hooks were
    // buffered) and leaves the built step as it stands. The
    // transcript then repeats the result entry carrying a
    // different size: the first landing's size stands — the
    // link keeps the first request that carried the result,
    // and no second step is built from the repeat.
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    appendFileSync(
      path,
      [
        resultLine(T0 + 10_000, "toolu_a", "g".repeat(999)),
        transcriptAssistantLine(T0 + 11_000, "req-3", USAGE, {
          extra: { requestRef: "client-3" },
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", path);
    expect(stepFacts(world, "toolu_a").context_chars).toBe(100);
  });

  it("keeps a transcript-built step closed when its closing hook event never lands", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    // The hooks were buffered while the daemon was down:
    // the transcript settles the call first and builds its
    // step, closed with its sizes.
    await followLines(
      world,
      journeyLines("toolu_dropped", "Read", [
        { at: T0 + 5000, content: "x".repeat(50) },
      ]),
    );
    // The buffered PreToolUse lands late, and its
    // PostToolUse never does — the buffer is bounded, and
    // an event can be dropped. The step stays closed with
    // its sizes rather than sticking at Running.
    seedStep(world, "toolu_dropped", "Read", T0 + 7000);
    const step = onlyRow(
      dbRows(
        world,
        "SELECT outcome, ended_at, context_chars, context_images FROM steps WHERE tool_use_id = 'toolu_dropped'",
      ),
      "a step",
    );
    expect(step.outcome).toBe("succeeded");
    expect(step.ended_at).toBe(T0 + 5000);
    expect(step.context_chars).toBe(50);
    expect(step.context_images).toBe(0);
  });

  /** Seed and link one step whose result was 42 characters and one image. */
  async function followSizedStep(world: World): Promise<void> {
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    await followLines(
      world,
      journeyLines("toolu_a", "Read", [
        {
          at: T0 + 5000,
          content: [
            { type: "text", text: "s".repeat(42) },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aW1n",
              },
            },
          ],
        },
      ]),
    );
  }

  it("carries the sizes on the full step load", async () => {
    const world = makeTranscriptWorld();
    await followSizedStep(world);
    const step = onlyRow(world.storage.stepRows("sess-live"), "a step");
    expect(step.contextChars).toBe(42);
    expect(step.contextImages).toBe(1);
  });

  it("carries the sizes on the step rows read since a mark", async () => {
    const world = makeTranscriptWorld();
    await followSizedStep(world);
    const step = onlyRow(world.storage.stepRowsSince("sess-live", 0), "a step");
    expect(step.contextChars).toBe(42);
    expect(step.contextImages).toBe(1);
  });

  it("carries the sizes on the step read by id", async () => {
    const world = makeTranscriptWorld();
    await followSizedStep(world);
    const loaded = onlyRow(world.storage.stepRows("sess-live"), "a step");
    const step = world.storage.stepRowById(loaded.id);
    expect(step?.contextChars).toBe(42);
    expect(step?.contextImages).toBe(1);
  });
});

describe("instruction file sizes", () => {
  it("records the size the daemon statted at arrival, and null once the file is gone", async () => {
    const world = makeTranscriptWorld();
    const project = join(world.root, "proj");
    mkdirSync(project, { recursive: true });
    const filePath = join(project, "CLAUDE.md");
    const contents = "# Rules\n\nBe careful.\n";
    writeFileSync(filePath, contents);
    const feed = (at: number, event: Record<string, unknown>): void => {
      const envelope: Envelope = {
        id: `env-${at}`,
        received_at: at,
        redaction_version: 1,
        plugin_version: "0.0.0",
        event,
      };
      expect(ingestEnvelope(world.storage, envelope)).toBe("stored");
    };
    feed(T0, {
      hook_event_name: "SessionStart",
      session_id: "sess-live",
      source: "startup",
      cwd: project,
    });
    feed(T0 + 100, {
      hook_event_name: "InstructionsLoaded",
      session_id: "sess-live",
      file_path: filePath,
      memory_type: "Project",
    });
    const load = onlyRow(
      dbRows(world, "SELECT size_bytes FROM loads"),
      "a load",
    );
    expect(load.size_bytes).toBe(contents.length);

    rmSync(filePath);
    feed(T0 + 200, {
      hook_event_name: "InstructionsLoaded",
      session_id: "sess-live",
      file_path: filePath,
      memory_type: "Project",
    });
    const loads = dbRows(world, "SELECT size_bytes FROM loads ORDER BY id");
    expect(loads.map((row) => row.size_bytes)).toEqual([contents.length, null]);
  });
});

describe("prompt facts", () => {
  it("records counts and sizes for images, attached files and the prompt, never the contents", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const imageOne = "iVBORw0KGgo" + "A".repeat(90);
    const imageTwo = "/9j/4AAQSkZJRg" + "B".repeat(30);
    const promptText = "look at these\nand the attached file";
    const fileContent = "ATTACHED-FILE-CONTENT-MARKER\nsecond line\n";
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: [
          { type: "text", text: promptText },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageOne },
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageTwo,
            },
          },
        ],
      }),
      fileAttachmentLine(T0 + 3100, {
        displayPath: "report.pdf",
        filename: "report.pdf",
        content: fileContent,
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const turn = onlyRow(
      dbRows(world, "SELECT image_count, image_bytes FROM turns"),
      "a turn",
    );
    expect(turn.image_count).toBe(2);
    expect(turn.image_bytes).toBe(imageOne.length + imageTwo.length);
    const attachments = dbRows(
      world,
      "SELECT kind, name, size_bytes, line_count FROM prompt_attachments ORDER BY id",
    );
    expect(attachments).toEqual([
      {
        kind: "image",
        name: "image/png",
        size_bytes: imageOne.length,
        line_count: null,
      },
      {
        kind: "image",
        name: "image/jpeg",
        size_bytes: imageTwo.length,
        line_count: null,
      },
      {
        kind: "prompt",
        name: null,
        size_bytes: Buffer.byteLength(promptText, "utf8"),
        line_count: 2,
      },
      {
        kind: "file",
        name: "report.pdf",
        size_bytes: Buffer.byteLength(fileContent, "utf8"),
        line_count: null,
      },
    ]);
    const stored = allStoredText(world.storage);
    expect(stored).not.toContain(imageOne);
    expect(stored).not.toContain(imageTwo);
    // The attached file's content reaches no table, raw_events
    // included: only its name and size are recorded.
    expect(stored).not.toContain("ATTACHED-FILE-CONTENT-MARKER");
  });

  it("records a pasted image once, and lets its companion entry make no turn, row or path", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const imageSize = 218_732;
    const tempPath =
      "C:\\Users\\example\\AppData\\Local\\Temp\\claude\\example-temp-dir\\images\\1.png";
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: [
          { type: "text", text: "[Image #1] describe the picture" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "A".repeat(imageSize),
            },
          },
        ],
        extra: {
          origin: { kind: "human" },
          promptSource: "typed",
          imagePasteIds: [1],
        },
      }),
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        uuid: "u-companion",
        content: [{ type: "text", text: `[Image: source: ${tempPath}]` }],
        extra: { isMeta: true, turnCompanion: true },
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const turn = onlyRow(
      dbRows(world, "SELECT image_count, image_bytes FROM turns"),
      "a turn",
    );
    expect(turn).toEqual({ image_count: 1, image_bytes: imageSize });
    expect(
      dbRows(world, "SELECT kind FROM prompt_attachments ORDER BY id"),
    ).toEqual([{ kind: "image" }, { kind: "prompt" }]);
    const stored = allStoredText(world.storage);
    expect(stored).not.toContain("example-temp-dir");
    expect(stored).not.toContain("Image: source");
  });

  it("stores no word from the prompt text when prompt text is off", async () => {
    const world = makeTranscriptWorld({ storePromptText: false });
    const project = join(world.root, "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "notes.md"), "short notes\n");
    seedSession(world, project);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: "ping @notes.md and @SECRETWORD-ghp_1234567890abcdef please",
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    // The prompt's own size row is the only fact: no @token in
    // the text becomes an attachment, and no path is statted.
    const attachments = dbRows(
      world,
      "SELECT kind, name FROM prompt_attachments ORDER BY id",
    );
    expect(attachments).toEqual([{ kind: "prompt", name: null }]);
    expect(allStoredText(world.storage)).not.toContain("SECRETWORD");
  });

  it("keeps the prompt's length on its turn when prompt text is off", async () => {
    const world = makeTranscriptWorld({ storePromptText: false });
    // A turn an older hook left with no length: its prompt
    // arrived as a size alone, and nothing measured it.
    const seededEvents = [
      {
        hook_event_name: "SessionStart",
        session_id: "sess-live",
        source: "startup",
        cwd: "/home/user/proj-a",
        version: "2.0.0",
      },
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-live",
        prompt_id: "p-1",
        prompt: { chars: 30 },
      },
    ];
    seededEvents.forEach((event, index) => {
      recordHookEvent(world.storage, event, T0 + index * 1000);
    });
    const promptText = "a prompt whose words stay home";
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: promptText,
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const turn = onlyRow(
      dbRows(
        world,
        "SELECT prompt_text, prompt_chars, prompt_lines FROM turns",
      ),
      "a turn",
    );
    expect(turn.prompt_text).toBeNull();
    expect(turn.prompt_chars).toBe(promptText.length);
    expect(turn.prompt_lines).toBe(1);
  });

  it("never replaces a length the hook already kept", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: "a much longer transcript wording of the same prompt",
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const turn = onlyRow(
      dbRows(world, "SELECT prompt_text, prompt_chars FROM turns"),
      "a turn",
    );
    expect(turn.prompt_text).toBe("write the report");
    expect(turn.prompt_chars).toBe(16);
  });

  it("stores a token-shaped display path scrubbed, and the token nowhere", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const token = "ghp_" + "a".repeat(36);
    const displayPath = `/home/user/${token}/notes.md`;
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: "see the attached file",
      }),
      fileAttachmentLine(T0 + 3100, {
        displayPath,
        filename: "notes.md",
        content: "file body\n",
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const attachment = onlyRow(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
      "a file attachment",
    );
    // The path is stored as the prompt's fact, with the token
    // replaced and the rest of the path intact.
    expect(attachment.name).not.toContain(token);
    expect(attachment.name).toContain("[redacted:");
    expect(attachment.name).toContain("notes.md");
    expect(allStoredText(world.storage)).not.toContain(token);
  });
});

describe("request shape and effort", () => {
  it("stores sizes and names from the shape entry, and effort from the request entry", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const systemBlocks = [
      { type: "text", text: "SYSTEM-PROMPT-MARKER" },
      { type: "text", text: "tail" },
    ];
    const tools = [
      {
        name: "Read",
        description: "TOOL-DESCRIPTION-MARKER",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__srv__lookup",
        description: "lookup",
        input_schema: { type: "object" },
      },
    ];
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      apiRequestShapeLine(T0 + 3500, { system: systemBlocks, tools }),
      apiRequestBlobLine(T0 + 3600, [
        { type: "text", text: "BLOB-TEXT-MARKER" },
      ]),
      apiRequestLine(T0 + 3700, "client-1", {
        effort: "high",
        cacheControl: CACHE_CONTROL_1H,
        edits: [{ type: "clear_tool_uses" }],
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        extra: { requestRef: "client-1" },
      }),
    ]);
    const request = onlyRow(
      dbRows(world, "SELECT effort, shape_hash FROM requests"),
      "a request",
    );
    expect(request.effort).toBe("high");
    // The shape row is keyed by the hash the transcript's own
    // entries name, and the request points straight at it.
    expect(request.shape_hash).toBe("a".repeat(64));
    const shape = onlyRow(
      queryRows(
        join(world.dataDir, "flightpath.db"),
        "SELECT system_bytes, tools FROM request_shapes WHERE hash = ?",
        request.shape_hash,
      ),
      "a shape",
    );
    expect(shape.system_bytes).toBe(
      Buffer.byteLength("SYSTEM-PROMPT-MARKER" + "tail", "utf8"),
    );
    expect(JSON.parse(shape.tools as string)).toEqual([
      {
        name: "Read",
        bytes: Buffer.byteLength(JSON.stringify(tools[0]), "utf8"),
        mcp: false,
      },
      {
        name: "mcp__srv__lookup",
        bytes: Buffer.byteLength(JSON.stringify(tools[1]), "utf8"),
        mcp: true,
      },
    ]);
    const stored = allStoredText(world.storage);
    expect(stored).not.toContain("SYSTEM-PROMPT-MARKER");
    expect(stored).not.toContain("TOOL-DESCRIPTION-MARKER");
    expect(stored).not.toContain("BLOB-TEXT-MARKER");
  });

  it("stores the cache lifetimes and edits on the request row", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      apiRequestLine(T0 + 3700, "client-1", {
        cacheControl: [
          ...CACHE_CONTROL_1H,
          { path: ["system", 1], value: { type: "ephemeral" } },
        ],
        edits: [{ type: "clear_tool_uses" }],
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        extra: { requestRef: "client-1" },
      }),
    ]);
    // The lifetimes and edits are facts of the one request,
    // read from its request entry: they sit on the request
    // row, whether or not any shape row is stored — this
    // follow read no shape entry at all.
    const request = onlyRow(
      dbRows(
        world,
        "SELECT cache_lifetimes, context_edits, shape_hash FROM requests",
      ),
      "a request",
    );
    expect(JSON.parse(request.cache_lifetimes as string)).toEqual(["1h", "5m"]);
    expect(JSON.parse(request.context_edits as string)).toEqual([
      "clear_tool_uses",
    ]);
    expect(request.shape_hash).toBeNull();
    expect(dbRows(world, "SELECT hash FROM request_shapes")).toEqual([]);
  });

  it("stores the shape and blob entries as their parsed forms", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      apiRequestShapeLine(T0 + 3500, {
        system: [{ type: "text", text: "SYSTEM-PROMPT-MARKER" }],
        tools: [
          {
            name: "Read",
            description: "TOOL-DESCRIPTION-MARKER",
            input_schema: { type: "object", properties: { path: {} } },
          },
        ],
      }),
      apiRequestBlobLine(T0 + 3600, [
        { type: "text", text: "BLOB-TEXT-MARKER" },
      ]),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    // The stored copies are sizes, names and hash — not the
    // entries' outlines, which repeat every key of every
    // tool's input schema.
    const rawBodies = dbRows(
      world,
      "SELECT body FROM raw_events WHERE source = 'transcript'",
    ).map((row) => row.body as string);
    const shapeBody = JSON.parse(
      rawBodies.find((body) => body.includes("api-request-shape")) ?? "{}",
    ) as Record<string, unknown>;
    expect(shapeBody.shapeHash).toBe("a".repeat(64));
    expect(shapeBody.systemBytes).toBe(
      Buffer.byteLength("SYSTEM-PROMPT-MARKER", "utf8"),
    );
    expect(JSON.stringify(shapeBody)).not.toContain("input_schema");
    const blobBody = JSON.parse(
      rawBodies.find((body) => body.includes("api-request-blob")) ?? "{}",
    ) as { message: { blocks: { type: string; bytes: number }[] } };
    expect(blobBody.message.blocks).toEqual([
      { type: "text", bytes: Buffer.byteLength("BLOB-TEXT-MARKER", "utf8") },
    ]);
  });

  it("links a shape only to the request whose own entry names it", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      textShapeLine(T0 + 3500, "sys"),
      // req-1 lands with no request entry naming the shape:
      // a shape read earlier in the file is not inherited.
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
      // req-2's own entry names the shape the shape entry wrote.
      apiRequestLine(T0 + 4500, "client-2", {}),
      transcriptAssistantLine(T0 + 5000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
      // req-3's entry names a shape no shape entry wrote.
      apiRequestLine(T0 + 5500, "client-3", { shapeHash: "d".repeat(64) }),
      transcriptAssistantLine(T0 + 6000, "req-3", USAGE, {
        extra: { requestRef: "client-3" },
      }),
    ]);
    const requests = dbRows(
      world,
      "SELECT request_id, shape_hash FROM requests ORDER BY id",
    );
    const shapeOf = (requestId: string): unknown =>
      onlyRow(
        requests.filter((row) => row.request_id === requestId),
        "a request",
      ).shape_hash;
    const stored = onlyRow(
      dbRows(world, "SELECT hash FROM request_shapes"),
      "a shape",
    );
    expect(shapeOf("req-1")).toBeNull();
    expect(shapeOf("req-2")).toBe(stored.hash);
    expect(shapeOf("req-3")).toBeNull();
  });

  it("keeps following a shape after another session is forgotten", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedOtherSession(world);
    const path = join(world.root, "sess-live.jsonl");
    await followLines(world, [
      ...shapeOpeningLines(),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        extra: { requestRef: "client-1" },
      }),
    ]);
    world.storage.forgetSession("sess-other");
    // The forgotten session's cleanup leaves the shape the
    // live follow's request references, and the follow goes
    // on naming it: one request carrying cache control, one
    // without — neither may fail, and neither may record a
    // shape of nothing.
    appendFileSync(
      path,
      [
        apiRequestLine(T0 + 4500, "client-2", {
          cacheControl: CACHE_CONTROL_1H,
        }),
        transcriptAssistantLine(T0 + 5000, "req-2", USAGE, {
          extra: { requestRef: "client-2" },
        }),
        apiRequestLine(T0 + 5500, "client-3", {}),
        transcriptAssistantLine(T0 + 6000, "req-3", USAGE, {
          extra: { requestRef: "client-3" },
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", path);
    const shape = onlyRow(
      dbRows(world, "SELECT hash, system_bytes, tools FROM request_shapes"),
      "a shape",
    );
    expect(shape.hash).toBe("a".repeat(64));
    expect(shape.system_bytes).toBe(Buffer.byteLength("sys", "utf8"));
    expect(JSON.parse(shape.tools as string)).toEqual([]);
    const requests = dbRows(
      world,
      "SELECT request_id, shape_hash, cache_lifetimes FROM requests ORDER BY id",
    );
    const byId = new Map(requests.map((row) => [row.request_id, row]));
    expect(byId.get("req-2")?.shape_hash).toBe("a".repeat(64));
    expect(JSON.parse(byId.get("req-2")?.cache_lifetimes as string)).toEqual([
      "1h",
    ]);
    expect(byId.get("req-3")?.shape_hash).toBe("a".repeat(64));
    expect(JSON.parse(byId.get("req-3")?.cache_lifetimes as string)).toEqual(
      [],
    );
  });

  it("keeps a shape no request names yet when another session is forgotten inside the window", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedOtherSession(world);
    const path = join(world.root, "sess-live.jsonl");
    // The shape entry and the request entry are read, but the
    // response entry has not landed: the shape is stored, the
    // session names it, and no request references it yet. That
    // window lasts as long as the model takes to answer.
    await followLines(world, shapeOpeningLines());
    expect(dbRows(world, "SELECT id FROM requests")).toEqual([]);
    expect(shapeNamings(world)).toEqual([
      { session_id: "sess-live", hash: "a".repeat(64) },
    ]);
    // The forget's cleanup runs inside the window: the shape
    // the live follow still needs must survive it.
    world.storage.forgetSession("sess-other");
    const shape = onlyRow(
      dbRows(world, "SELECT hash, system_bytes FROM request_shapes"),
      "a shape",
    );
    expect(shape.hash).toBe("a".repeat(64));
    // The response lands, and a second request names the same
    // shape (no new shape entry is written): both link to it.
    appendFileSync(
      path,
      [
        transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
          extra: { requestRef: "client-1" },
        }),
        apiRequestLine(T0 + 4500, "client-2", {}),
        transcriptAssistantLine(T0 + 5000, "req-2", USAGE, {
          extra: { requestRef: "client-2" },
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", path);
    const requests = dbRows(
      world,
      "SELECT request_id, shape_hash FROM requests ORDER BY id",
    );
    expect(requests.map((row) => row.request_id)).toEqual(["req-1", "req-2"]);
    for (const request of requests) {
      expect(request.shape_hash).toBe("a".repeat(64));
    }
  });

  it("keeps a shape the forgotten session named too, while a live follow still names it", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedOtherSession(world);
    // Both sessions name the same shape: same version, same
    // project, same tools. The other session's follow reads
    // its shape entry and goes no further.
    const otherPath = join(world.root, "sess-other.jsonl");
    writeFileSync(
      otherPath,
      apiRequestShapeLine(
        T0 + 3200,
        { system: [{ type: "text", text: "sys" }], tools: [] },
        "sess-other",
      ) + "\n",
    );
    await world.follower.follow("sess-other", otherPath);
    const path = join(world.root, "sess-live.jsonl");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      textShapeLine(T0 + 3500, "sys"),
      apiRequestLine(T0 + 3700, "client-1", {}),
    ]);
    expect(shapeNamings(world)).toEqual([
      { session_id: "sess-live", hash: "a".repeat(64) },
      { session_id: "sess-other", hash: "a".repeat(64) },
    ]);
    // Forgetting the other session removes its naming, not
    // the shape: this session still names it, mid-window.
    world.storage.forgetSession("sess-other");
    expectShapeNamedByLive(world);
    appendFileSync(
      path,
      [
        transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
          extra: { requestRef: "client-1" },
        }),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", path);
    const request = onlyRow(
      dbRows(world, "SELECT shape_hash FROM requests"),
      "a request",
    );
    expect(request.shape_hash).toBe("a".repeat(64));
  });

  it("links a shape stored before a follower restart to the request that names it after", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const path = join(world.root, "sess-live.jsonl");
    writeFileSync(
      path,
      [
        transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
        textShapeLine(T0 + 3500, "sys"),
      ].join("\n") + "\n",
    );
    await world.follower.follow("sess-live", path);
    // A new follower over the same store: the daemon
    // restarted between the shape entry and the request that
    // names the shape. The shape row is in the store, so the
    // link needs nothing the restart took with it.
    const restarted = createTranscriptFollower(world.storage, {
      dataDir: world.dataDir,
      configDir: world.configDir,
      settings: () => defaultSettings(),
    });
    appendFileSync(
      path,
      [
        apiRequestLine(T0 + 3700, "client-1", {}),
        transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
          extra: { requestRef: "client-1" },
        }),
      ].join("\n") + "\n",
    );
    await restarted.follow("sess-live", path);
    const request = onlyRow(
      dbRows(world, "SELECT shape_hash FROM requests"),
      "a request",
    );
    expect(request.shape_hash).toBe("a".repeat(64));
  });

  it("measures a shape's sizes in bytes, not characters", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const systemText = "système — ünïcode";
    const tools = [
      { name: "Read", description: "lire le fichier — ü", input_schema: {} },
    ];
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      apiRequestShapeLine(T0 + 3500, {
        system: [{ type: "text", text: systemText }],
        tools,
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const shape = onlyRow(
      dbRows(world, "SELECT system_bytes, tools FROM request_shapes"),
      "a shape",
    );
    expect(shape.system_bytes).toBe(Buffer.byteLength(systemText, "utf8"));
    expect(shape.system_bytes).not.toBe(systemText.length);
    expect(JSON.parse(shape.tools as string)).toEqual([
      {
        name: "Read",
        bytes: Buffer.byteLength(JSON.stringify(tools[0]), "utf8"),
        mcp: false,
      },
    ]);
  });

  it("normalizes the effort each source reports, and stores none for an unknown level", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      apiRequestLine(T0 + 3500, "client-1", { effort: " High " }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        extra: { requestRef: "client-1" },
      }),
      apiRequestLine(T0 + 4500, "client-2", { effort: "turbo" }),
      transcriptAssistantLine(T0 + 5000, "req-2", USAGE, {
        extra: { requestRef: "client-2" },
      }),
    ]);
    const efforts = dbRows(
      world,
      "SELECT request_id, effort FROM requests ORDER BY id",
    );
    expect(efforts).toEqual([
      { request_id: "req-1", effort: "high" },
      { request_id: "req-2", effort: null },
    ]);

    const telemetryWorld = makeTelemetryWorld();
    recordHookEvent(
      telemetryWorld.storage,
      {
        hook_event_name: "SessionStart",
        session_id: "sess-t",
        source: "startup",
        cwd: "/home/user/proj-a",
        version: "2.0.0",
      },
      T0,
    );
    recordHookEvent(
      telemetryWorld.storage,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-t",
        prompt_id: "p-1",
        prompt: "run the build",
      },
      T0 + 1000,
    );
    const intake = createTelemetryIntake();
    intake.processExport(
      telemetryWorld.storage,
      telemetryExport([
        telemetryRecord(
          "claude_code.api_request",
          {
            "session.id": "sess-t",
            "prompt.id": "p-1",
            request_id: "req-t1",
            model: "claude-sonnet",
            query_source: "repl_main_thread",
            input_tokens: 100,
            output_tokens: 10,
            effort: " LOW ",
          },
          T0 + 2000,
          1,
        ),
      ]),
      { settings: defaultSettings(), receivedAt: T0 + 3000 },
    );
    const telemetryRequest = onlyRow(
      queryRows(
        join(telemetryWorld.dataDir, "flightpath.db"),
        "SELECT effort FROM requests",
      ),
      "a request",
    );
    expect(telemetryRequest.effort).toBe("low");
  });

  it("fills effort from a hook payload where the transcript names none, and the transcript wins", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    ]);
    const before = onlyRow(
      dbRows(world, "SELECT effort FROM requests"),
      "a request",
    );
    expect(before.effort).toBeNull();
    const envelope: Envelope = {
      id: "env-effort",
      received_at: T0 + 5000,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "PostToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Read",
        tool_use_id: "toolu_a",
        effort: { level: " Medium " },
      },
    };
    expect(ingestEnvelope(world.storage, envelope)).toBe("stored");
    const filled = onlyRow(
      dbRows(world, "SELECT effort FROM requests"),
      "a request",
    );
    expect(filled.effort).toBe("medium");
    // An effort payload for a prompt no hook recorded fills
    // nothing and creates no turn.
    const unseen: Envelope = {
      id: "env-effort-unseen",
      received_at: T0 + 5500,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "PostToolUse",
        session_id: "sess-live",
        prompt_id: "p-unseen",
        tool_name: "Read",
        tool_use_id: "toolu_a",
        effort: { level: "high" },
      },
    };
    expect(ingestEnvelope(world.storage, unseen)).toBe("stored");
    expect(dbRows(world, "SELECT COUNT(*) AS n FROM turns")[0]?.n).toBe(1);
    const stillFilled = onlyRow(
      dbRows(world, "SELECT effort FROM requests"),
      "a request",
    );
    expect(stillFilled.effort).toBe("medium");
    // The transcript names the effort later, as the file grows:
    // the request entry arrives, and a further entry of the
    // same request applies it over the hook's fallback.
    const path = join(world.root, "sess-live.jsonl");
    appendFileSync(
      path,
      apiRequestLine(T0 + 6000, "client-1", { effort: "high" }) +
        "\n" +
        transcriptAssistantLine(T0 + 7000, "req-1", USAGE, {
          extra: { requestRef: "client-1" },
        }) +
        "\n",
    );
    await world.follower.follow("sess-live", path);
    const named = onlyRow(
      dbRows(world, "SELECT effort FROM requests"),
      "a request",
    );
    expect(named.effort).toBe("high");
  });

  it("runs the hook effort fill on the turn index, never a scan", () => {
    const world = makeTranscriptWorld();
    const db = new DatabaseSync(join(world.dataDir, "flightpath.db"));
    try {
      const plan = (
        db
          .prepare(`EXPLAIN QUERY PLAN ${FILL_REQUEST_EFFORT_SQL}`)
          .all("high", "sess-live", 1) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("SEARCH requests USING INDEX requests_turn");
      expect(plan).not.toContain("SCAN requests");
    } finally {
      db.close();
    }
  });

  it("deletes a turn's attachments on the session-turn index, never a scan", () => {
    const world = makeTranscriptWorld();
    const db = new DatabaseSync(join(world.dataDir, "flightpath.db"));
    try {
      const plan = (
        db
          .prepare(`EXPLAIN QUERY PLAN ${DELETE_PROMPT_ATTACHMENTS_SQL}`)
          .all("sess-live", 1) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain(
        "SEARCH prompt_attachments USING COVERING INDEX prompt_attachments_turn",
      );
      expect(plan).not.toContain("SCAN prompt_attachments");
    } finally {
      db.close();
    }
  });
});

describe("prompt attachments", () => {
  it("records what a prompt carried, by kind", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const fileContent = "attached text\n";
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: [
          { type: "text", text: "see attached" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo",
            },
          },
        ],
      }),
      fileAttachmentLine(T0 + 3100, {
        displayPath: "report.pdf",
        filename: "report.pdf",
        content: fileContent,
      }),
    ]);
    const kinds = dbRows(
      world,
      "SELECT kind FROM prompt_attachments ORDER BY id",
    ).map((row) => row.kind);
    expect(kinds).toEqual(["image", "prompt", "file"]);
    // The attachments point at the session's one turn.
    const turns = dbRows(
      world,
      "SELECT DISTINCT turn_id FROM prompt_attachments",
    );
    expect(turns).toHaveLength(1);
  });
});

describe("a skill's text and files", () => {
  const SKILL_TEXT_AT = T0 + 5000;

  /** The text Claude Code adds once a skill loads, of the given length. */
  const skillTextLine = (
    at: number,
    length: number,
    folder = "/skills/code-style",
  ): string =>
    transcriptUserLine(at, {
      content: [
        {
          type: "text",
          text: `Base directory for this skill: ${folder}\n`.padEnd(
            length,
            "S",
          ),
        },
      ],
      extra: { isMeta: true },
    });

  const skillFileLine = (at: number, path: string, lines: number): string =>
    fileAttachmentLine(at, {
      displayPath: path,
      filename: `/home/user/proj-a/${path}`,
      content: "FILE-MARKER".padEnd(lines * 10, "f"),
      lines,
    });

  /** A skill call and its result, as the hooks and the transcript record them. */
  function skillCallLines(): string[] {
    return [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      toolUseLine(T0 + 4000, "req-1", "client-1", "toolu_skill", "Skill"),
      resultLine(T0 + 4500, "toolu_skill", "Launching skill: code-style"),
    ];
  }

  function seedSkill(world: World, name = "code-style"): void {
    seedSession(world, "/home/user/proj-a");
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Skill",
        tool_use_id: "toolu_skill",
        tool_input: { skill: name },
      },
      T0 + 2000,
    );
  }

  const nextRequest = (): string =>
    transcriptAssistantLine(T0 + 9000, "req-2", USAGE, {
      extra: { requestRef: "client-2" },
    });

  const loadsOf = (world: World, kind: string) =>
    dbRows(
      world,
      `SELECT id, file_path, size_bytes, line_count, parent_load_id, occurred_at FROM loads WHERE kind = '${kind}' ORDER BY id`,
    );

  it("sizes the skill's load from the text that follows its result", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      nextRequest(),
    ]);
    expect(loadsOf(world, "skill")).toMatchObject([{ size_bytes: 14_000 }]);
    expect(allStoredText(world.storage)).not.toContain("SSSS");
  });

  it("measures the skill's text in bytes, not characters", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world, "é");
    await followLines(world, [
      ...skillCallLines(),
      transcriptUserLine(SKILL_TEXT_AT, {
        content: [
          { type: "text", text: "Base directory for this skill: /skills/é" },
        ],
        extra: { isMeta: true },
      }),
    ]);
    expect(loadsOf(world, "skill")).toMatchObject([{ size_bytes: 41 }]);
  });

  it("leaves a size the skill's load already has", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    world.storage.recordSkillText({
      name: "code-style",
      sessionId: "sess-live",
      bytes: 9_000,
      at: SKILL_TEXT_AT,
    });
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
    ]);
    expect(loadsOf(world, "skill")).toMatchObject([{ size_bytes: 9_000 }]);
  });

  it("records the files a skill attached as its own loads, not the turn's", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 600),
      skillFileLine(SKILL_TEXT_AT, "docs/b.md", 40),
      skillFileLine(SKILL_TEXT_AT, "docs/c.md", 12),
      nextRequest(),
    ]);
    const [skill] = loadsOf(world, "skill");
    expect(loadsOf(world, "skill-file")).toMatchObject([
      {
        file_path: "docs/a.md",
        size_bytes: 6_000,
        line_count: 600,
        parent_load_id: skill?.id,
        occurred_at: SKILL_TEXT_AT,
      },
      { file_path: "docs/b.md", size_bytes: 400, line_count: 40 },
      { file_path: "docs/c.md", size_bytes: 120, line_count: 12 },
    ]);
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([]);
    expect(allStoredText(world.storage)).not.toContain("FILE-MARKER");
  });

  it("records the files a skill attached though they are stamped before its text", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    const stamped = [
      { at: SKILL_TEXT_AT - 14, path: "docs/a.md", lines: 600 },
      { at: SKILL_TEXT_AT - 12, path: "docs/b.md", lines: 40 },
      { at: SKILL_TEXT_AT - 11, path: "docs/c.md", lines: 12 },
    ];
    let parentUuid = `u-${SKILL_TEXT_AT}`;
    const fileLines = stamped.map(({ at, path, lines }) => {
      const line = fileAttachmentLine(at, {
        displayPath: path,
        filename: `/home/user/proj-a/${path}`,
        content: "FILE-MARKER".padEnd(lines * 10, "f"),
        lines,
        parentUuid,
      });
      parentUuid = `att-${at}-${path}`;
      return line;
    });
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      ...fileLines,
      commandPermissionsLine(SKILL_TEXT_AT),
      nextRequest(),
    ]);
    const [skill] = loadsOf(world, "skill");
    expect(loadsOf(world, "skill-file")).toMatchObject([
      { file_path: "docs/a.md", line_count: 600, parent_load_id: skill?.id },
      { file_path: "docs/b.md", line_count: 40, parent_load_id: skill?.id },
      { file_path: "docs/c.md", line_count: 12, parent_load_id: skill?.id },
    ]);
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([]);
  });

  it("keeps a file that follows the next request as the turn's", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      nextRequest(),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
    ]);
    expect(loadsOf(world, "skill-file")).toEqual([]);
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([{ name: "docs/a.md" }]);
  });

  it("gives a skill run by a slash command the same treatment", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "UserPromptExpansion",
        session_id: "sess-live",
        prompt_id: "p-1",
        command_name: "code-style",
        command_args: "",
      },
      T0 + 2000,
    );
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      skillTextLine(SKILL_TEXT_AT, 5_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
      nextRequest(),
    ]);
    expect(loadsOf(world, "skill")).toMatchObject([{ size_bytes: 5_000 }]);
    expect(loadsOf(world, "skill-file")).toMatchObject([
      { file_path: "docs/a.md" },
    ]);
  });

  it("attaches the text and files to the latest skill, not an earlier one", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world, "first-skill");
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Skill",
        tool_use_id: "toolu_second",
        tool_input: { skill: "code-style" },
      },
      T0 + 4000,
    );
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
    ]);
    const [first, second] = loadsOf(world, "skill");
    expect(first?.size_bytes).toBeNull();
    expect(second?.size_bytes).toBe(14_000);
    expect(loadsOf(world, "skill-file")).toMatchObject([
      { parent_load_id: second?.id },
    ]);
  });

  it("records the load from the text when the hooks never reported the skill", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
    ]);
    const [skill] = loadsOf(world, "skill");
    expect(loadsOf(world, "skill")).toMatchObject([
      { size_bytes: 14_000, occurred_at: SKILL_TEXT_AT },
    ]);
    expect(
      dbRows(
        world,
        "SELECT name, trigger, source FROM loads WHERE kind = 'skill'",
      ),
    ).toEqual([{ name: "code-style", trigger: null, source: "transcript" }]);
    expect(loadsOf(world, "skill-file")).toMatchObject([
      { file_path: "docs/a.md", parent_load_id: skill?.id },
    ]);
  });

  it("restates the files when the transcript is read again from the start", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    const lines = [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
      nextRequest(),
    ];
    await followLines(world, [
      ...lines,
      transcriptUserLine(T0 + 20_000, { content: "x".repeat(2_000) }),
    ]);
    await followLines(world, lines);
    expect(loadsOf(world, "skill-file")).toHaveLength(1);
  });

  it("deletes a skill's files with its session", async () => {
    const world = makeTranscriptWorld();
    seedSkill(world);
    await followLines(world, [
      ...skillCallLines(),
      skillTextLine(SKILL_TEXT_AT, 14_000),
      skillFileLine(SKILL_TEXT_AT, "docs/a.md", 30),
    ]);
    world.storage.forgetSession("sess-live");
    expect(dbRows(world, "SELECT COUNT(*) AS n FROM loads")).toEqual([
      { n: 0 },
    ]);
  });
});

describe("files put back after a compaction", () => {
  const fileOf = (displayPath: string, length: number): string =>
    fileAttachmentLine(T0 + 6200, {
      displayPath,
      filename: `C:\\work\\app\\${displayPath}`,
      content: "CONTENT-MARKER".padEnd(length, "x"),
    });

  const typedPrompt = (at: number, promptId: string): string =>
    transcriptUserLine(at, {
      promptId,
      content: "Summarise what we did.",
      extra: { origin: { kind: "human" }, promptSource: "typed" },
    });

  // Claude Code's order: the boundary, the summary entry, the
  // files it put back (two read again, one only named), and
  // only later the prompt the person types.
  const compactionLines = (): string[] => [
    transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
    transcriptAssistantLine(T0 + 4000, "req-1", USAGE),
    compactBoundaryLine(T0 + 6000),
    transcriptUserLine(T0 + 6100, {
      promptId: "p-1",
      content: "SUMMARY-MARKER",
      extra: { isCompactSummary: true },
    }),
    compactFileReferenceLine(T0 + 6200, "data\\orders.csv"),
    fileOf("test\\totals.test.js", 1_032),
    fileOf("src\\totals.js", 694),
    typedPrompt(T0 + 9000, "p-2"),
    transcriptAssistantLine(T0 + 9500, "req-2", USAGE),
  ];

  it("records them as the compaction's, never as the next prompt's attachments", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, compactionLines());
    expect(
      dbRows(
        world,
        "SELECT at, name, size_bytes, reread FROM compaction_files ORDER BY id",
      ),
    ).toEqual([
      { at: T0 + 6000, name: "data\\orders.csv", size_bytes: null, reread: 0 },
      {
        at: T0 + 6000,
        name: "test\\totals.test.js",
        size_bytes: 1_032,
        reread: 1,
      },
      { at: T0 + 6000, name: "src\\totals.js", size_bytes: 694, reread: 1 },
    ]);
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([]);
    const stored = allStoredText(world.storage);
    expect(stored).not.toContain("CONTENT-MARKER");
  });

  it("keeps a file attached to the next prompt as that prompt's own", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      ...compactionLines().slice(0, -1),
      fileAttachmentLine(T0 + 9100, {
        displayPath: "notes.md",
        filename: "C:\\work\\app\\notes.md",
        content: "x".repeat(120),
      }),
      transcriptAssistantLine(T0 + 9500, "req-2", USAGE),
    ]);
    expect(dbRows(world, "SELECT COUNT(*) AS n FROM compaction_files")).toEqual(
      [{ n: 3 }],
    );
    expect(
      dbRows(
        world,
        "SELECT name, size_bytes FROM prompt_attachments WHERE kind = 'file'",
      ),
    ).toEqual([{ name: "notes.md", size_bytes: 120 }]);
  });

  it("gives each compaction its own files, a file read again by both under each", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      ...compactionLines(),
      compactBoundaryLine(T0 + 20_000),
      fileAttachmentLine(T0 + 20_200, {
        displayPath: "src\\totals.js",
        filename: "C:\\work\\app\\src\\totals.js",
        content: "x".repeat(700),
      }),
      transcriptAssistantLine(T0 + 21_000, "req-3", USAGE),
    ]);
    expect(
      dbRows(
        world,
        "SELECT at, size_bytes FROM compaction_files WHERE name = 'src\\totals.js' ORDER BY at",
      ),
    ).toEqual([
      { at: T0 + 6000, size_bytes: 694 },
      { at: T0 + 20_000, size_bytes: 700 },
    ]);
  });

  it("ends the files at the next request when no typed prompt comes first", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      compactBoundaryLine(T0 + 6000),
      transcriptAssistantLine(T0 + 6100, "req-2", USAGE),
      fileAttachmentLine(T0 + 6200, {
        displayPath: "notes.md",
        filename: "C:\\work\\app\\notes.md",
        content: "x".repeat(120),
      }),
    ]);
    expect(dbRows(world, "SELECT COUNT(*) AS n FROM compaction_files")).toEqual(
      [{ n: 0 }],
    );
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([{ name: "notes.md" }]);
  });

  it("records no file for a name-only reference outside a compaction", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      compactFileReferenceLine(T0 + 3100, "data\\orders.csv"),
      transcriptAssistantLine(T0 + 3500, "req-1", USAGE),
    ]);
    expect(dbRows(world, "SELECT COUNT(*) AS n FROM compaction_files")).toEqual(
      [{ n: 0 }],
    );
    expect(
      dbRows(world, "SELECT name FROM prompt_attachments WHERE kind = 'file'"),
    ).toEqual([]);
  });

  describe("with no display path", () => {
    const withoutDisplayPath = (line: string, filename: string): string => {
      const entry = JSON.parse(line) as {
        attachment: Record<string, unknown>;
      };
      delete entry.attachment.displayPath;
      entry.attachment.filename = filename;
      return JSON.stringify(entry);
    };

    const followUnnamed = async (folder: string) => {
      const world = makeTranscriptWorld();
      seedSession(world, "/home/user/proj-a");
      await followLines(world, [
        transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
        compactBoundaryLine(T0 + 6000),
        withoutDisplayPath(
          compactFileReferenceLine(T0 + 6200, "x"),
          `${folder}/orders.csv`,
        ),
        withoutDisplayPath(fileOf("x", 40), `${folder}/totals.js`),
        transcriptAssistantLine(T0 + 6500, "req-1", USAGE),
      ]);
      return dbRows(
        world,
        "SELECT name, size_bytes, reread FROM compaction_files ORDER BY id",
      );
    };

    it("names a restored file by its path inside the project folder", async () => {
      expect(await followUnnamed("/home/user/proj-a/data")).toEqual([
        { name: join("data", "orders.csv"), size_bytes: null, reread: 0 },
        { name: join("data", "totals.js"), size_bytes: 40, reread: 1 },
      ]);
    });

    it("keeps the whole path of a file outside the project folder", async () => {
      expect(await followUnnamed("/home/user/notes")).toEqual([
        { name: "/home/user/notes/orders.csv", size_bytes: null, reread: 0 },
        { name: "/home/user/notes/totals.js", size_bytes: 40, reread: 1 },
      ]);
    });
  });

  it("restates a file recorded again, keeping one row with the latest size", () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const file = { at: T0 + 6000, name: "src\\totals.js", reread: false };
    world.storage.addCompactionFile("sess-live", { ...file, sizeBytes: null });
    world.storage.addCompactionFile("sess-live", { ...file, sizeBytes: 694 });
    expect(
      dbRows(world, "SELECT size_bytes, reread FROM compaction_files"),
    ).toEqual([{ size_bytes: 694, reread: 0 }]);
  });
});

describe("revival without replay", () => {
  // The event that revives the concluded session: a fresh
  // prompt, stored through the daemon's ingest path.
  const reviveWithPrompt = (
    world: World,
    id: string,
    at: number,
    promptId: string,
  ): void => {
    const envelope: Envelope = {
      id,
      received_at: at,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-live",
        prompt_id: promptId,
        prompt: "still here",
      },
    };
    expect(ingestEnvelope(world.storage, envelope)).toBe("stored");
  };

  const feedTelemetry = (
    world: World,
    records: Record<string, unknown>[],
    receivedAt: number,
  ): void => {
    createTelemetryIntake().processExport(
      world.storage,
      telemetryExport(records),
      { settings: defaultSettings(), receivedAt },
    );
  };

  // Telemetry's prompt at T0 + 4500, fed at T0 + 4600: the
  // record that creates a turn inside a concluded window.
  const feedWindowPrompt = (world: World): void => {
    feedTelemetry(
      world,
      [
        telemetryRecord(
          "claude_code.user_prompt",
          { "session.id": "sess-live", "prompt.id": "p-2", prompt_length: "5" },
          T0 + 4500,
          1,
        ),
      ],
      T0 + 4600,
    );
  };

  const secondTurn = (world: World): Record<string, unknown> =>
    onlyRow(
      dbRows(
        world,
        "SELECT ended_at, end_source FROM turns WHERE prompt_id = 'p-2'",
      ),
      "the second turn",
    );

  const sessionRow = (world: World): Record<string, unknown> =>
    onlyRow(dbRows(world, "SELECT status FROM sessions"), "a session");

  const expectReopened = (world: World): void => {
    const turn = secondTurn(world);
    expect(turn.ended_at).toBeNull();
    expect(turn.end_source).toBeNull();
    const session = sessionRow(world);
    expect(session.status).toBe("live");
  };

  it("revives a concluded session with its transcript requests and samples intact", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    // A real transcript through the follower: one request and
    // its context sample, on the seeded session's turn.
    await followLines(world, [
      apiRequestLine(T0 + 3700, "client-1", {}),
      transcriptAssistantLine(T0 + 4000, "req-1", USAGE, {
        extra: { requestRef: "client-1" },
      }),
    ]);
    const requestsBefore = dbRows(
      world,
      "SELECT id, request_id, turn_id, branch_id FROM requests",
    );
    expect(requestsBefore).toHaveLength(1);
    const samplesBefore = dbRows(
      world,
      "SELECT id, request_id, context_tokens, source FROM context_samples",
    );
    expect(samplesBefore).toHaveLength(1);
    // The daemon concludes the session ended, unseen.
    world.storage.endSessionUnseen("sess-live", T0 + 5000);
    // The next prompt is stored, the session is live, and the
    // rows the transcript wrote are exactly as they were.
    reviveWithPrompt(world, "env-revival", T0 + 6000, "p-2");
    const session = sessionRow(world);
    expect(session.status).toBe("live");
    expect(
      dbRows(world, "SELECT id, request_id, turn_id, branch_id FROM requests"),
    ).toEqual(requestsBefore);
    expect(
      dbRows(
        world,
        "SELECT id, request_id, context_tokens, source FROM context_samples",
      ),
    ).toEqual(samplesBefore);
  });

  it("keeps what telemetry wrote through a revival", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PermissionRequest",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_use_id: "toolu_a",
        tool_name: "Read",
      },
      T0 + 2100,
    );
    // Telemetry records a permission decision for the step
    // and closes it with a failure.
    feedTelemetry(
      world,
      [
        telemetryRecord(
          "claude_code.tool_decision",
          {
            "session.id": "sess-live",
            tool_use_id: "toolu_a",
            decision: "accept",
            source: "user_accept",
          },
          T0 + 2500,
          1,
        ),
        telemetryRecord(
          "claude_code.tool_result",
          {
            "session.id": "sess-live",
            tool_use_id: "toolu_a",
            success: "false",
            duration_ms: "120",
          },
          T0 + 3000,
          2,
        ),
      ],
      T0 + 6000,
    );
    const decisionsBefore = dbRows(
      world,
      "SELECT step_id, decision, decision_source FROM human_events WHERE kind = 'permission_decision'",
    );
    expect(decisionsBefore).toHaveLength(1);
    world.storage.endSessionUnseen("sess-live", T0 + 7000);
    reviveWithPrompt(world, "env-revival-2", T0 + 8000, "p-3");
    // The telemetry decision stands exactly as recorded.
    expect(
      dbRows(
        world,
        "SELECT step_id, decision, decision_source FROM human_events WHERE kind = 'permission_decision'",
      ),
    ).toEqual(decisionsBefore);
    // The step telemetry closed stays closed, as telemetry's.
    const step = onlyRow(
      dbRows(
        world,
        "SELECT outcome, outcome_source, duration_ms FROM steps WHERE tool_use_id = 'toolu_a'",
      ),
      "the step",
    );
    expect(step.outcome).toBe("failed");
    expect(step.outcome_source).toBe("telemetry");
    expect(step.duration_ms).toBe(120);
  });

  it("keeps a transcript interrupt and a source's turn end that land while the session is concluded", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    world.storage.endSessionUnseen("sess-live", T0 + 3000);
    // While the session sits concluded, the follower reads
    // the interrupt the transcript recorded for the step.
    const path = join(world.root, "sess-live.jsonl");
    writeFileSync(
      path,
      resultLine(
        T0 + 4000,
        "toolu_a",
        "[Request interrupted by user for tool use]",
        true,
      ) + "\n",
    );
    await world.follower.follow("sess-live", path);
    // And telemetry's next prompt ends the turn the
    // conclusion ended, at the prompt's own time.
    feedWindowPrompt(world);
    reviveWithPrompt(world, "env-revival-3", T0 + 6000, "p-3");
    // The interrupt stands: the revival did not reopen the
    // step the transcript closed.
    const step = onlyRow(
      dbRows(
        world,
        "SELECT outcome, outcome_source, ended_at FROM steps WHERE tool_use_id = 'toolu_a'",
      ),
      "the step",
    );
    expect(step.outcome).toBe("interrupted");
    expect(step.outcome_source).toBe("transcript");
    expect(step.ended_at).toBe(T0 + 4000);
    // The turn keeps the end the source gave it, not the
    // conclusion's, and carries no concluded mark.
    const turn = onlyRow(
      dbRows(
        world,
        "SELECT ended_at, end_source FROM turns WHERE prompt_id = 'p-1'",
      ),
      "the first turn",
    );
    expect(turn.ended_at).toBe(T0 + 4500);
    expect(turn.end_source).toBeNull();
    const session = sessionRow(world);
    expect(session.status).toBe("live");
  });

  it("reopens the turn created in the concluded window when the reviving hook is a prompt for that turn", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    world.storage.endSessionUnseen("sess-live", T0 + 3000);
    // Telemetry's prompt creates the turn inside the
    // concluded window: already closed at its own start,
    // marked concluded.
    feedWindowPrompt(world);
    const created = secondTurn(world);
    expect(created.ended_at).toBe(T0 + 4500);
    expect(created.end_source).toBe("concluded");
    // The hook event that revives the session is a prompt
    // submit for that same prompt: the turn the window
    // created reopens with the session — it is not left
    // closed behind the revival, and no second turn for
    // the prompt appears.
    reviveWithPrompt(world, "env-revival-6", T0 + 6000, "p-2");
    expectReopened(world);
  });

  it("keeps telemetry's branch end that lands while the session is concluded", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "SubagentStart",
        session_id: "sess-live",
        agent_id: "A1",
        agent_type: "reviewer",
      },
      T0 + 2000,
    );
    world.storage.endSessionUnseen("sess-live", T0 + 3000);
    // Telemetry's completion for the branch arrives inside
    // the concluded window, with its own end time.
    feedTelemetry(
      world,
      [
        telemetryRecord(
          "claude_code.subagent_completed",
          {
            "session.id": "sess-live",
            agent_type: "reviewer",
            total_tokens: 4321,
          },
          T0 + 4000,
          1,
        ),
      ],
      T0 + 4600,
    );
    reviveWithPrompt(world, "env-revival-4", T0 + 6000, "p-2");
    // The branch keeps telemetry's end and its totals: the
    // revival did not reopen it or restore the conclusion's
    // end time.
    const branch = onlyRow(
      dbRows(world, "SELECT ended_at, end_source, total_tokens FROM branches"),
      "the branch",
    );
    expect(branch.ended_at).toBe(T0 + 4000);
    expect(branch.end_source).toBeNull();
    expect(branch.total_tokens).toBe(4321);
  });

  it("closes a turn created while the session is concluded", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    seedStep(world, "toolu_a", "Read", T0 + 2000);
    world.storage.endSessionUnseen("sess-live", T0 + 3000);
    const sessionState = (): Record<string, unknown> =>
      onlyRow(
        dbRows(world, "SELECT status, end_seen FROM sessions"),
        "a session",
      );
    // The follower reads in the concluded window — the
    // interrupt, as in the test above. A transcript read
    // does not revive the session.
    const path = join(world.root, "sess-live.jsonl");
    writeFileSync(
      path,
      resultLine(
        T0 + 4000,
        "toolu_a",
        "[Request interrupted by user for tool use]",
        true,
      ) + "\n",
    );
    await world.follower.follow("sess-live", path);
    expect(sessionState().status).toBe("ended");
    expect(sessionState().end_seen).toBe(0);
    // Telemetry's next prompt creates a turn in the same
    // window. The turn goes in already closed — at its own
    // start, marked concluded — and telemetry does not
    // revive the session either: only a hook event does.
    feedWindowPrompt(world);
    const turn = secondTurn(world);
    expect(turn.ended_at).toBe(T0 + 4500);
    expect(turn.end_source).toBe("concluded");
    expect(sessionState().status).toBe("ended");
    expect(sessionState().end_seen).toBe(0);
  });

  it("reopens a turn created in the concluded window when a hook event revives the session", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    world.storage.endSessionUnseen("sess-live", T0 + 3000);
    feedWindowPrompt(world);
    // The reviving event is a notification, so no new
    // prompt ends the reopened turn again on its way in.
    const envelope: Envelope = {
      id: "env-revival-5",
      received_at: T0 + 6000,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "Notification",
        session_id: "sess-live",
        notification_type: "idle_prompt",
      },
    };
    expect(ingestEnvelope(world.storage, envelope)).toBe("stored");
    expectReopened(world);
  });
});

describe("migration", () => {
  it("applies to a database holding rows in the previous schema's shape and leaves them intact", () => {
    const dataDir = makeTempRoot("flightpath-migration-");
    const dbPath = join(dataDir, "flightpath.db");
    const db = new DatabaseSync(dbPath);
    // The schema this test guards is version 7: build through
    // it, so the open applies migration 8 against it (and the
    // later ones after it, which add nothing these rows touch).
    for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration.sql);
    db.exec("PRAGMA user_version = 7");
    // The session's host columns are migration 7's: a row
    // holding them must survive the upgrade with its values.
    db.prepare(
      "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway, host_pid, host_started_at) VALUES ('sess-old', 'ended', 100, 200, 0, 4242, 90)",
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, sequence, started_at) VALUES ('sess-old', 1, 110)",
    ).run();
    db.prepare(
      "INSERT INTO steps (session_id, tool_use_id, tool_name) VALUES ('sess-old', 'toolu_1', 'Read')",
    ).run();
    db.prepare(
      "INSERT INTO requests (session_id, request_id, model) VALUES ('sess-old', 'req-1', 'claude-sonnet')",
    ).run();
    db.prepare(
      "INSERT INTO loads (session_id, kind, occurred_at, source) VALUES ('sess-old', 'instructions', 120, 'hook')",
    ).run();
    db.close();

    const storage = openAtLatestVersion(dataDir);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const session = onlyRow(
      check
        .prepare("SELECT host_pid, host_started_at FROM sessions")
        .all() as Record<string, unknown>[],
      "a session",
    );
    expect(session.host_pid).toBe(4242);
    expect(session.host_started_at).toBe(90);
    const turn = onlyRow(
      check
        .prepare("SELECT image_count, image_bytes FROM turns")
        .all() as Record<string, unknown>[],
      "a turn",
    );
    expect(turn.image_count).toBeNull();
    expect(turn.image_bytes).toBeNull();
    const step = onlyRow(
      check
        .prepare("SELECT tool_name, result_request_id FROM steps")
        .all() as Record<string, unknown>[],
      "a step",
    );
    expect(step.tool_name).toBe("Read");
    expect(step.result_request_id).toBeNull();
    const request = onlyRow(
      check
        .prepare("SELECT model, effort, shape_hash FROM requests")
        .all() as Record<string, unknown>[],
      "a request",
    );
    expect(request.model).toBe("claude-sonnet");
    expect(request.effort).toBeNull();
    expect(request.shape_hash).toBeNull();
    const load = onlyRow(
      check.prepare("SELECT kind, size_bytes FROM loads").all() as Record<
        string,
        unknown
      >[],
      "a load",
    );
    expect(load.kind).toBe("instructions");
    expect(load.size_bytes).toBeNull();
    check.close();
    storage.close();
  });

  it("adds the end_source columns to a version 8 database and leaves its rows intact", () => {
    const dataDir = makeTempRoot("flightpath-migration-");
    const dbPath = join(dataDir, "flightpath.db");
    const db = new DatabaseSync(dbPath);
    // Build through version 8, so the open applies migration
    // 9 alone against it.
    for (const migration of MIGRATIONS.slice(0, 8)) db.exec(migration.sql);
    db.exec("PRAGMA user_version = 8");
    db.prepare(
      "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-old', 'ended', 100, 200, 0)",
    ).run();
    db.prepare(
      "INSERT INTO turns (session_id, sequence, started_at, ended_at) VALUES ('sess-old', 1, 110, 190)",
    ).run();
    db.prepare(
      "INSERT INTO branches (session_id, agent_id, started_at, ended_at) VALUES ('sess-old', 'agent-1', 120, 190)",
    ).run();
    db.close();

    const storage = openAtLatestVersion(dataDir);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const turn = onlyRow(
      check.prepare("SELECT ended_at, end_source FROM turns").all() as Record<
        string,
        unknown
      >[],
      "a turn",
    );
    expect(turn.ended_at).toBe(190);
    expect(turn.end_source).toBeNull();
    const branch = onlyRow(
      check
        .prepare("SELECT ended_at, end_source FROM branches")
        .all() as Record<string, unknown>[],
      "a branch",
    );
    expect(branch.ended_at).toBe(190);
    expect(branch.end_source).toBeNull();
    check.close();
    storage.close();
  });
});

describe("the auto-compact window setting", () => {
  function settingsDir(contents?: string): string {
    const dir = makeTempRoot("flightpath-autocompact-");
    if (contents !== undefined) {
      writeFileSync(join(dir, "settings.json"), contents);
    }
    return dir;
  }

  it("is no setting when the folder has no settings file", () => {
    expect(readAutoCompactWindow(settingsDir())).toBeNull();
  });

  it("is no setting when the file has no such key", () => {
    expect(readAutoCompactWindow(settingsDir("{}"))).toBeNull();
  });

  it("is no setting when the value is not a number", () => {
    expect(
      readAutoCompactWindow(settingsDir('{"autoCompactWindow": "80000"}')),
    ).toBeNull();
  });

  it("is no setting when the value is zero", () => {
    expect(
      readAutoCompactWindow(settingsDir('{"autoCompactWindow": 0}')),
    ).toBeNull();
  });

  it("is the value the user set", () => {
    expect(
      readAutoCompactWindow(settingsDir('{"autoCompactWindow": 80000}')),
    ).toBe(80_000);
  });
});

describe("a skill's text that arrives before its hook", () => {
  const TEXT_AT = T0 + 5000;
  const NAME = "house-style";

  const textLine = (at: number, length = 6_000, folder = `/skills/${NAME}`) =>
    transcriptUserLine(at, {
      content: [
        {
          type: "text",
          text: `Base directory for this skill: ${folder}\n`.padEnd(
            length,
            "S",
          ),
        },
      ],
      extra: { isMeta: true },
    });

  const fileLine = (at: number, path: string) =>
    fileAttachmentLine(at, {
      displayPath: path,
      filename: `/home/user/proj-a/${path}`,
      content: "FILE-MARKER".padEnd(300, "f"),
      lines: 30,
    });

  const openTurn = transcriptUserLine(T0 + 3000, { promptId: "p-1" });

  function hookSkillTool(world: World, name: string, at: number): void {
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Skill",
        tool_use_id: `toolu_${at}`,
        tool_input: { skill: name },
      },
      at,
    );
  }

  function hookSlash(world: World, name: string, at: number): void {
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "UserPromptExpansion",
        session_id: "sess-live",
        prompt_id: "p-1",
        command_name: name,
        command_args: "",
      },
      at,
    );
  }

  const skills = (world: World) =>
    dbRows(
      world,
      "SELECT id, name, trigger, source, size_bytes, occurred_at FROM loads WHERE kind = 'skill' ORDER BY id",
    );

  const filesOf = (world: World) =>
    dbRows(
      world,
      "SELECT file_path, parent_load_id FROM loads WHERE kind = 'skill-file' ORDER BY id",
    );

  it("gives the trigger to the load the text recorded when the Skill tool follows", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    hookSkillTool(world, NAME, TEXT_AT + 640);
    expect(skills(world)).toMatchObject([
      { name: NAME, trigger: "agent", source: "transcript", size_bytes: 6_000 },
    ]);
  });

  it("gives the trigger and the files to one load when a slash command follows", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [
      openTurn,
      textLine(TEXT_AT),
      fileLine(TEXT_AT, "docs/a.md"),
      fileLine(TEXT_AT, "docs/b.md"),
    ]);
    hookSlash(world, NAME, TEXT_AT + 190);
    const [skill] = skills(world);
    expect(skills(world)).toMatchObject([
      { trigger: "user_slash", size_bytes: 6_000 },
    ]);
    expect(filesOf(world)).toMatchObject([
      { file_path: "docs/a.md", parent_load_id: skill?.id },
      { file_path: "docs/b.md", parent_load_id: skill?.id },
    ]);
  });

  it("sizes each of two loads of one skill a minute apart with its own text and files", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const first = [
      openTurn,
      textLine(TEXT_AT, 6_000),
      fileLine(TEXT_AT, "docs/a.md"),
    ];
    await followLines(world, first);
    hookSkillTool(world, NAME, TEXT_AT + 640);
    await followLines(world, [
      ...first,
      textLine(TEXT_AT + 60_000, 9_000),
      fileLine(TEXT_AT + 60_000, "docs/b.md"),
    ]);
    hookSkillTool(world, NAME, TEXT_AT + 60_640);
    const [one, two] = skills(world);
    expect(skills(world)).toMatchObject([
      { trigger: "agent", size_bytes: 6_000 },
      { trigger: "agent", size_bytes: 9_000 },
    ]);
    expect(filesOf(world)).toMatchObject([
      { file_path: "docs/a.md", parent_load_id: one?.id },
      { file_path: "docs/b.md", parent_load_id: two?.id },
    ]);
  });

  it("leaves another skill's load alone and records the text's own", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    hookSkillTool(world, "release-notes", TEXT_AT - 1000);
    await followLines(world, [
      openTurn,
      textLine(TEXT_AT),
      fileLine(TEXT_AT, "docs/a.md"),
    ]);
    const [other, own] = skills(world);
    expect(other).toMatchObject({ name: "release-notes", size_bytes: null });
    expect(own).toMatchObject({ name: NAME, size_bytes: 6_000 });
    expect(filesOf(world)).toMatchObject([{ parent_load_id: own?.id }]);
  });

  it("takes the nearer of two loads of one skill for the text", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    hookSkillTool(world, NAME, TEXT_AT - 6000);
    hookSkillTool(world, NAME, TEXT_AT - 1000);
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    expect(skills(world)).toMatchObject([
      { size_bytes: null },
      { size_bytes: 6_000 },
    ]);
  });

  it("treats a hook more than ten seconds after the text as a load of its own", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    hookSkillTool(world, NAME, TEXT_AT + 10_001);
    expect(skills(world)).toMatchObject([
      { source: "transcript", trigger: null },
      { source: "hook", trigger: "agent" },
    ]);
  });

  it("records one load when the transcript is read again from the start", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    const lines = [openTurn, textLine(TEXT_AT), fileLine(TEXT_AT, "docs/a.md")];
    await followLines(world, [
      ...lines,
      transcriptUserLine(T0 + 20_000, { content: "x".repeat(2_000) }),
    ]);
    await followLines(world, lines);
    expect(skills(world)).toHaveLength(1);
    expect(filesOf(world)).toHaveLength(1);
  });

  it("sizes a plugin skill the hook reported first under the hook's full name", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    hookSkillTool(world, `house-tools:${NAME}`, TEXT_AT - 640);
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    expect(skills(world)).toMatchObject([
      { name: `house-tools:${NAME}`, trigger: "agent", size_bytes: 6_000 },
    ]);
  });

  it("renames the load the text recorded to the plugin skill's full name when the hook follows", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    hookSlash(world, `house-tools:${NAME}`, TEXT_AT + 190);
    expect(skills(world)).toMatchObject([
      { name: `house-tools:${NAME}`, trigger: "user_slash", size_bytes: 6_000 },
    ]);
  });

  it("takes the nearer load for the text when a plugin skill of the same name loaded earlier", async () => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    hookSkillTool(world, `other-tools:${NAME}`, TEXT_AT - 1000);
    hookSkillTool(world, NAME, TEXT_AT - 200);
    await followLines(world, [openTurn, textLine(TEXT_AT)]);
    expect(skills(world)).toMatchObject([
      { name: `other-tools:${NAME}`, size_bytes: null },
      { name: NAME, size_bytes: 6_000 },
    ]);
  });

  it.each([
    ["a POSIX folder", "/home/user/proj-a/.claude/skills/house-style"],
    ["a Windows folder", "C:\\work\\proj-a\\.claude\\skills\\house-style"],
    ["a folder with a trailing separator", "/skills/house-style/"],
  ])("names the skill from the last part of %s", async (_, folder) => {
    const world = makeTranscriptWorld();
    seedSession(world, "/home/user/proj-a");
    await followLines(world, [openTurn, textLine(TEXT_AT, 6_000, folder)]);
    expect(skills(world)).toMatchObject([{ name: NAME }]);
  });
});
