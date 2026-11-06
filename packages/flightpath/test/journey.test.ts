import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import {
  expandedCommandPrompt,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";
import { onlyRow, rowAt } from "./support/rows.js";
import { makeStorageWorld } from "./support/storage.js";
import { iso } from "./support/time.js";

import { ingestEnvelope, type Envelope } from "../src/daemon/ingest.js";
import { redactHookEvent } from "../src/redact/index.js";
import { defaultSettings } from "../src/settings/index.js";
import type { Storage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  createTranscriptFollower,
  encodeProjectPath,
} from "../src/transcripts/index.js";

// Scenario tests for the journey builder, fed through the daemon's
// real ingest path (redaction included) with hand-written event
// sequences in the shapes Claude Code produces.

const T = 1_700_000_000_000;

afterEach(async () => {
  vi.unstubAllEnvs();
  await runCleanups();
});

let envelopeCount = 0;
function feed(
  storage: Storage,
  events: { at: number; event: Record<string, unknown> }[],
): void {
  for (const { at, event } of events) {
    envelopeCount += 1;
    const envelope: Envelope = {
      id: `journey-test-${envelopeCount}`,
      received_at: at,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event,
    };
    expect(ingestEnvelope(storage, envelope)).toBe("stored");
  }
}

function rows(
  read: DatabaseSync,
  sql: string,
  ...params: unknown[]
): Record<string, unknown>[] {
  return read.prepare(sql).all(...(params as never[])) as Record<
    string,
    unknown
  >[];
}

function one(
  read: DatabaseSync,
  sql: string,
  ...params: unknown[]
): Record<string, unknown> {
  const found = rows(read, sql, ...params);
  return onlyRow(found, "a row");
}

/** Feeds a session start and one command's expansion: the
 * opening the command tests share. */
function feedCommandOpening(
  storage: Storage,
  commandName: string,
  after: { at: number; event: Record<string, unknown> }[] = [],
): void {
  feed(storage, [
    { at: T, event: START },
    {
      at: T + 100,
      event: {
        hook_event_name: "UserPromptExpansion",
        session_id: "s1",
        prompt_id: "p1",
        command_name: commandName,
        command_args: "",
      },
    },
    ...after,
  ]);
}

/** Write an enabledPlugins settings file, creating its folder. */
function writePluginsFile(
  path: string,
  plugins: Record<string, boolean>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabledPlugins: plugins }));
}

/** Open a world and start its session inside the project. */
function startProjectSession(project: string): {
  storage: Storage;
  read: DatabaseSync;
} {
  const world = makeStorageWorld(makeTempRoot("flightpath-journey-"));
  feed(world.storage, [{ at: T, event: { ...START, cwd: project } }]);
  return world;
}

/** The plugin names the session conditions recorded. */
function enabledPlugins(read: DatabaseSync): unknown {
  const conditions = one(read, "SELECT * FROM session_conditions");
  return JSON.parse(conditions.enabled_plugins as string);
}

const START = {
  hook_event_name: "SessionStart",
  session_id: "s1",
  source: "startup",
  cwd: "/work/app",
  model: "claude-sonnet-5",
  permission_mode: "default",
};

const INSTRUCTIONS_LOADED = {
  hook_event_name: "InstructionsLoaded",
  session_id: "s1",
  file_path: "/work/app/CLAUDE.md",
  memory_type: "Project",
};

/** Feed the session start and the turn's first prompt. */
function feedStartAndPrompt(storage: Storage, prompt: string): void {
  feed(storage, [
    { at: T, event: START },
    {
      at: T + 100,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p1",
        prompt,
      },
    },
  ]);
}

/** An Agent tool call launching a subagent of the given type. */
function agentCall(toolUseId: string, type: string, at: number) {
  return {
    at,
    event: {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      prompt_id: "p1",
      tool_use_id: toolUseId,
      tool_name: "Agent",
      tool_input: { subagent_type: type, description: type },
    },
  };
}

/** A subagent's start, naming its type. */
function subagentStart(agentId: string, type: string, at: number) {
  return {
    at,
    event: {
      hook_event_name: "SubagentStart",
      session_id: "s1",
      agent_id: agentId,
      agent_type: type,
    },
  };
}

/** The reviewer launch two link tests share, described as a check. */
function reviewerCall(at: number) {
  return {
    at,
    event: {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      prompt_id: "p1",
      tool_use_id: "tA",
      tool_name: "Agent",
      tool_input: { subagent_type: "reviewer", description: "check" },
    },
  };
}

/** A Bash step from an agent no start has named yet. */
function unknownAgentStep(at: number) {
  return {
    at,
    event: {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      prompt_id: "p1",
      agent_id: "a0000000000000001",
      tool_use_id: "tU1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
  };
}

/** A world whose first session noted the host process it
 *  runs in: the shared setup of the host tests. */
function hostWorld(): ReturnType<typeof makeStorageWorld> {
  const world = makeStorageWorld(makeTempRoot("flightpath-journey-"));
  feed(world.storage, [{ at: T, event: hostStart("s1", T) }]);
  return world;
}

/** A start event noting the Claude Code process it runs in. */
function hostStart(
  sessionId: string,
  hostStartedAt: number,
  source = "startup",
): Record<string, unknown> {
  return {
    ...START,
    session_id: sessionId,
    source,
    host_pid: 4321,
    host_started_at: hostStartedAt,
  };
}

/** Import the transcript-only session s-old — two turns in
 *  s1's project, never hooked — into a world rooted at root:
 *  it predates the install stamp, and the import ends it
 *  unseen. The retention window is opened wide, as the
 *  scenario's times sit far in the real clock's past. */
async function importOldSession(storage: Storage, root: string): Promise<void> {
  writeFileSync(join(root, "installed-at"), String(T));
  const configDir = join(root, "claude");
  const projectDir = join(
    configDir,
    "projects",
    encodeProjectPath("/work/app"),
  );
  mkdirSync(projectDir, { recursive: true });
  const entry = (fields: Record<string, unknown>): string =>
    JSON.stringify({ sessionId: "s-old", version: "2.0.0", ...fields });
  const importedTurn = (n: number): string[] => [
    entry({
      type: "user",
      uuid: `u-old-${n}`,
      timestamp: iso(T + n * 2000 - 1000),
      promptId: `p-old-${n}`,
      message: { role: "user", content: `imported prompt ${n}` },
    }),
    entry({
      type: "assistant",
      uuid: `a-old-${n}`,
      timestamp: iso(T + n * 2000),
      requestId: `req-old-${n}`,
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        usage: { input_tokens: 700, output_tokens: 70 },
        content: [{ type: "text", text: "imported answer" }],
      },
    }),
  ];
  writeFileSync(
    join(projectDir, "s-old.jsonl"),
    [...importedTurn(1), ...importedTurn(2)].join("\n") + "\n",
  );
  const settings = { ...defaultSettings(), retentionDays: 3650 };
  const follower = createTranscriptFollower(storage, {
    dataDir: root,
    configDir,
    settings: () => settings,
  });
  await follower.importAll();
}

/** A world whose project the importer may read, with s-old imported. */
async function importOldWorld(): Promise<{
  storage: Storage;
  read: DatabaseSync;
}> {
  const root = makeTempRoot("flightpath-journey-");
  const world = makeStorageWorld(root);
  // A hooked session in the project makes the project one
  // the import may read; s-old itself was never hooked.
  feed(world.storage, [{ at: T, event: START }]);
  await importOldSession(world.storage, root);
  return world;
}

/**
 * Two prompts: the first turn and its step close as inferred
 * when the second prompt arrives; the second turn leaves a
 * step and a branch open.
 */
function feedTwoPromptsAndBranch(storage: Storage): void {
  feedStartAndPrompt(storage, "hello");
  feedBashStep(storage, T + 200);
  feed(storage, [
    {
      at: T + 300,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p2",
        prompt: "next",
      },
    },
    {
      at: T + 400,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p2",
        tool_use_id: "t2",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    },
    {
      at: T + 500,
      event: {
        hook_event_name: "SubagentStart",
        session_id: "s1",
        agent_id: "A1",
        agent_type: "reviewer",
      },
    },
  ]);
}

/** Feed the first turn's Bash step opening. */
function feedBashStep(storage: Storage, at: number): void {
  feed(storage, [
    {
      at,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "make" },
      },
    },
  ]);
}

/** A PostToolBatch event naming the Bash calls it closes. */
function postToolBatchEvent(
  calls: { tool_use_id: string; command: string; response: string }[],
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolBatch",
    session_id: "s1",
    tool_calls: calls.map((call) => ({
      tool_use_id: call.tool_use_id,
      tool_name: "Bash",
      tool_input: { command: call.command },
      tool_response: call.response,
    })),
  };
}

/** Feed a notification: a reviving event that closes nothing itself. */
function feedNotification(storage: Storage, at: number): void {
  feed(storage, [
    {
      at,
      event: {
        hook_event_name: "Notification",
        session_id: "s1",
        notification_type: "idle_prompt",
      },
    },
  ]);
}

/**
 * Feed the two-conclusions sequence: the two prompts and the
 * branch, a conclusion, a revival, real closings between the
 * two conclusions (the step's result, the branch's stop, a
 * new prompt), and a second conclusion.
 */
function feedTwoConclusions(storage: Storage): void {
  feedTwoPromptsAndBranch(storage);
  storage.endSessionUnseen("s1", T + 600);
  feedNotification(storage, T + 5000);
  feed(storage, [
    {
      at: T + 5100,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_use_id: "t2",
        tool_response: "ok",
      },
    },
    {
      at: T + 5200,
      event: {
        hook_event_name: "SubagentStop",
        session_id: "s1",
        agent_id: "A1",
      },
    },
    {
      at: T + 5300,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p3",
        prompt: "third",
      },
    },
  ]);
  storage.endSessionUnseen("s1", T + 5400);
}

/** Feed a Bash step that asks for permission before it runs. */
function feedPermissionRequest(storage: Storage, command: string): void {
  feed(storage, [
    {
      at: T + 200,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_input: { command },
      },
    },
    {
      at: T + 300,
      event: {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_input: { command },
      },
    },
  ]);
}

/** The opening both subagent sequences share: a prompt, an
 *  Agent step that launches, and the subagent's first Read. */
function subagentLaunch(
  prompt: string,
): { at: number; event: Record<string, unknown> }[] {
  return [
    { at: T, event: START },
    {
      at: T + 100,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: "p1",
        prompt,
      },
    },
    {
      at: T + 1000,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "tA",
        tool_name: "Agent",
        tool_input: { subagent_type: "reviewer", description: "review it" },
      },
    },
    {
      at: T + 1500,
      event: {
        hook_event_name: "SubagentStart",
        session_id: "s1",
        agent_id: "A1",
        agent_type: "reviewer",
      },
    },
    {
      at: T + 2000,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "tA",
        tool_name: "Agent",
        tool_response: "launched",
      },
    },
    {
      at: T + 2500,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        agent_id: "A1",
        tool_use_id: "t2",
        tool_name: "Read",
        tool_input: { file_path: "/work/app/convert.ts" },
      },
    },
  ];
}

/** Feed the async-subagent sequence: branch outlives its spawning step. */
function feedAsyncSubagent(storage: Storage): void {
  feed(storage, [
    ...subagentLaunch("review and fix"),
    {
      at: T + 3000,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        agent_id: "A1",
        tool_use_id: "t2",
        tool_name: "Read",
        tool_response: "text",
      },
    },
    {
      at: T + 3500,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t3",
        tool_name: "Edit",
        tool_input: { file_path: "/work/app/convert.ts" },
      },
    },
    {
      at: T + 9000,
      event: {
        hook_event_name: "SubagentStop",
        session_id: "s1",
        agent_id: "A1",
        agent_type: "reviewer",
      },
    },
  ]);
}

/** Feed a subagent step that is still in flight when the main turn stops. */
function feedInFlightSubagent(storage: Storage): void {
  feed(storage, [
    ...subagentLaunch("review it"),
    // The main turn ends while the subagent's tool call is
    // still in flight. Its step must not close here.
    { at: T + 3000, event: { hook_event_name: "Stop", session_id: "s1" } },
  ]);
}

/** Feed the loads, command-expansion and question events of one turn. */
function feedRecordedEvents(storage: Storage): void {
  feed(storage, [
    { at: T, event: START },
    { at: T + 100, event: INSTRUCTIONS_LOADED },
    {
      at: T + 200,
      event: {
        hook_event_name: "UserPromptExpansion",
        session_id: "s1",
        prompt_id: "p1",
        command_name: "review-pr",
        command_args: "42",
      },
    },
    {
      at: T + 300,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t1",
        tool_name: "Skill",
        tool_input: { skill: "add-unit" },
      },
    },
    {
      at: T + 400,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t2",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            { question: "Which ton?", options: [{ label: "Short ton" }] },
          ],
        },
      },
    },
    {
      at: T + 5000,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: "t2",
        tool_name: "AskUserQuestion",
        tool_response: {
          questions: [
            { question: "Which ton?", options: [{ label: "Short ton" }] },
          ],
          answers: { "Which ton?": "Short ton" },
        },
      },
    },
  ]);
}

describe("the journey builder", () => {
  it("builds a normal turn: session, segment, turn, step, prompt", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [
      { at: T, event: START },
      {
        at: T + 1000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p1",
          prompt: "fix the converter",
        },
      },
      {
        at: T + 2000,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "t1",
          tool_name: "Read",
          tool_input: { file_path: "/work/app/convert.ts" },
        },
      },
      {
        at: T + 2600,
        event: {
          hook_event_name: "PostToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "t1",
          tool_name: "Read",
          tool_response: "x".repeat(500),
        },
      },
      { at: T + 3000, event: { hook_event_name: "Stop", session_id: "s1" } },
    ]);

    const session = one(read, "SELECT * FROM sessions");
    expect(session.status).toBe("live");
    expect(session.joined_partway).toBe(0);
    expect(session.project_path).toBe("/work/app");
    expect(session.model).toBe("claude-sonnet-5");

    const segment = one(read, "SELECT * FROM segments");
    expect(segment.kind).toBe("startup");

    const turn = one(read, "SELECT * FROM turns");
    expect(turn.prompt_text).toBe("fix the converter");
    expect(turn.flightpath_command).toBe(0);
    expect(turn.ended_at).toBe(T + 3000);

    const step = one(read, "SELECT * FROM steps");
    expect(step.outcome).toBe("succeeded");
    expect(step.duration_ms).toBe(600);
    expect(step.result_size).toBe(500);
    expect(step.turn_id).toBe(turn.id);

    const kinds = rows(read, "SELECT kind FROM human_events").map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(["prompt"]);

    const conditions = one(read, "SELECT * FROM session_conditions");
    expect(JSON.parse(conditions.sources_seen as string)).toEqual(["hook"]);
    expect(JSON.parse(conditions.permission_modes as string)).toEqual([
      "default",
    ]);
  });

  it("closes parallel steps on the same turn independently", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    const pre = (id: string, name: string, at: number) => ({
      at,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: id,
        tool_name: name,
        tool_input: {},
      },
    });
    const post = (id: string, name: string, at: number) => ({
      at,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        prompt_id: "p1",
        tool_use_id: id,
        tool_name: name,
        tool_response: "done",
      },
    });
    feed(storage, [
      { at: T, event: START },
      {
        at: T + 100,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p1",
          prompt: "both at once",
        },
      },
      pre("t1", "Read", T + 200),
      pre("t2", "Bash", T + 300),
      post("t2", "Bash", T + 900),
      post("t1", "Read", T + 1200),
    ]);
    const steps = rows(read, "SELECT * FROM steps ORDER BY tool_use_id");
    expect(steps.map((s) => s.outcome)).toEqual(["succeeded", "succeeded"]);
    expect(rowAt(steps, 0, "the first step").duration_ms).toBe(1000);
    expect(rowAt(steps, 1, "the second step").duration_ms).toBe(600);
  });

  it("closes a step with no closing event as interrupted at the next turn", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "run the build");
    feed(storage, [
      {
        at: T + 200,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: { command: "pnpm build" },
        },
      },
      {
        at: T + 5000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p2",
          prompt: "never mind",
        },
      },
    ]);
    const step = one(read, "SELECT * FROM steps");
    expect(step.outcome).toBe("interrupted");
    expect(step.outcome_source).toBe("inferred");
    expect(step.ended_at).toBe(T + 5000);
  });

  it("closes a step as rejected when a permission request was its last event", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "push it");
    feedPermissionRequest(storage, "git push");
    feed(storage, [
      { at: T + 4000, event: { hook_event_name: "Stop", session_id: "s1" } },
    ]);
    const step = one(read, "SELECT * FROM steps");
    expect(step.outcome).toBe("rejected");
    const kinds = rows(read, "SELECT kind FROM human_events ORDER BY id").map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(["prompt", "permission_request"]);
  });

  it("infers an approval when the tool runs after a permission request", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "push it");
    feedPermissionRequest(storage, "git push");
    feed(storage, [
      {
        at: T + 2000,
        event: {
          hook_event_name: "PostToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_response: "ok",
        },
      },
    ]);
    const decision = one(
      read,
      "SELECT * FROM human_events WHERE kind = 'permission_decision'",
    );
    expect(decision.decision).toBe("accept");
    expect(decision.decision_source).toBe("inferred");
  });

  it("keeps an async subagent's branch open past its spawning step's close", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedAsyncSubagent(storage);
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.agent_id).toBe("A1");
    expect(branch.kind).toBe("user");
    expect(branch.ended_at).toBe(T + 9000);
    const spawning = one(read, "SELECT * FROM steps WHERE tool_use_id = 'tA'");
    expect(branch.spawning_step_id).toBe(spawning.id);
    expect(spawning.outcome).toBe("succeeded");
  });

  it("assigns a subagent's steps to its branch, and the main turn's steps to none", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedAsyncSubagent(storage);
    const branch = one(read, "SELECT * FROM branches");
    const inner = one(read, "SELECT * FROM steps WHERE tool_use_id = 't2'");
    expect(inner.branch_id).toBe(branch.id);
    const parent = one(read, "SELECT * FROM steps WHERE tool_use_id = 't3'");
    expect(parent.branch_id).toBeNull();
  });
  it("keeps a subagent's in-flight step open when the main turn ends", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedInFlightSubagent(storage);
    const inFlight = one(read, "SELECT * FROM steps WHERE tool_use_id = 't2'");
    expect(inFlight.outcome).toBe("open");
    const turn = one(read, "SELECT * FROM turns WHERE prompt_id = 'p1'");
    expect(turn.ended_at).toBe(T + 3000);
  });

  it("closes a subagent's in-flight step when its result arrives after the main turn", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedInFlightSubagent(storage);
    feed(storage, [
      {
        at: T + 4000,
        event: {
          hook_event_name: "PostToolUse",
          session_id: "s1",
          agent_id: "A1",
          tool_use_id: "t2",
          tool_name: "Read",
          tool_response: "text",
        },
      },
      {
        at: T + 5000,
        event: {
          hook_event_name: "SubagentStop",
          session_id: "s1",
          agent_id: "A1",
          agent_type: "reviewer",
        },
      },
    ]);
    const finished = one(read, "SELECT * FROM steps WHERE tool_use_id = 't2'");
    expect(finished.outcome).toBe("succeeded");
    expect(finished.outcome_source).toBe("hook");
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.ended_at).toBe(T + 5000);
  });
  it("links same-second subagents by type, and same-type subagents by order", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "fan out");
    feed(storage, [
      agentCall("tR", "reviewer", T + 1000),
      agentCall("tW", "writer", T + 1100),
      subagentStart("AW", "writer", T + 1300),
      subagentStart("AR", "reviewer", T + 1400),
      agentCall("tR2", "reviewer", T + 5000),
      agentCall("tR3", "reviewer", T + 5100),
      subagentStart("AR2", "reviewer", T + 5300),
      subagentStart("AR3", "reviewer", T + 5400),
    ]);
    const links = rows(
      read,
      `SELECT b.agent_id AS agent, s.tool_use_id AS step
       FROM branches b JOIN steps s ON s.id = b.spawning_step_id
       ORDER BY b.agent_id`,
    );
    expect(links).toEqual([
      { agent: "AR", step: "tR" },
      { agent: "AR2", step: "tR2" },
      { agent: "AR3", step: "tR3" },
      { agent: "AW", step: "tW" },
    ]);
  });

  it("links launches whose starts arrive seconds later, each to its own step", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "fan out");
    feed(storage, [
      // Four launches together; their starts land up to three
      // seconds later, the two explorers among them.
      agentCall("tP", "planner", T + 1000),
      agentCall("tE1", "explorer", T + 1000),
      agentCall("tG", "general-purpose", T + 1000),
      agentCall("tE2", "explorer", T + 1000),
      subagentStart("AP", "planner", T + 1600),
      subagentStart("AE1", "explorer", T + 2500),
      subagentStart("AE2", "explorer", T + 3200),
      subagentStart("AG", "general-purpose", T + 3900),
    ]);
    const links = rows(
      read,
      `SELECT b.agent_id AS agent, s.tool_use_id AS step
       FROM branches b JOIN steps s ON s.id = b.spawning_step_id
       ORDER BY b.agent_id`,
    );
    expect(links).toEqual([
      { agent: "AE1", step: "tE1" },
      { agent: "AE2", step: "tE2" },
      { agent: "AG", step: "tG" },
      { agent: "AP", step: "tP" },
    ]);
  });

  it("keeps a background subagent's steps in the turn that launched it", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    const prompt = (id: string, at: number) => ({
      at,
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt_id: id,
        prompt: "go",
      },
    });
    const branchStep = (id: string, at: number) => ({
      at,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        agent_id: "A1",
        tool_use_id: id,
        tool_name: "Read",
        tool_input: { file_path: "/x" },
      },
    });
    feed(storage, [
      { at: T, event: START },
      prompt("p1", T + 100),
      reviewerCall(T + 1000),
      subagentStart("A1", "reviewer", T + 1500),
      // Two more turns open while the subagent works; its
      // steps name neither of them, and belong to neither.
      prompt("p2", T + 3000),
      branchStep("t2", T + 4000),
      prompt("p3", T + 5000),
      branchStep("t3", T + 6000),
    ]);
    const launch = one(read, "SELECT id FROM turns WHERE prompt_id = 'p1'");
    const steps = rows(
      read,
      "SELECT tool_use_id, turn_id FROM steps WHERE tool_use_id IN ('t2', 't3') ORDER BY tool_use_id",
    );
    expect(steps).toEqual([
      { tool_use_id: "t2", turn_id: launch.id },
      { tool_use_id: "t3", turn_id: launch.id },
    ]);
  });

  it("fills in the start and the link on a branch recorded before its start", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "go");
    feed(storage, [
      reviewerCall(T + 1000),
      // A stop lands before the start does: the branch is
      // recorded with neither a start time nor a spawning step.
      {
        at: T + 2000,
        event: {
          hook_event_name: "SubagentStop",
          session_id: "s1",
          agent_id: "A1",
          agent_type: "reviewer",
        },
      },
      {
        at: T + 2100,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p2",
          prompt: "meanwhile",
        },
      },
      // A step of the subagent's lands in the open turn while
      // its branch still has no link.
      {
        at: T + 2200,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          agent_id: "A1",
          tool_use_id: "t2",
          tool_name: "Read",
          tool_input: { file_path: "/x" },
        },
      },
      subagentStart("A1", "reviewer", T + 2500),
    ]);
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.started_at).toBe(T + 2500);
    const spawning = one(read, "SELECT id FROM steps WHERE tool_use_id = 'tA'");
    expect(branch.spawning_step_id).toBe(spawning.id);
    // The step that landed in the second turn is re-stamped
    // with the launch turn once the link lands.
    const launch = one(read, "SELECT id FROM turns WHERE prompt_id = 'p1'");
    const step = one(
      read,
      "SELECT turn_id FROM steps WHERE tool_use_id = 't2'",
    );
    expect(step.turn_id).toBe(launch.id);
  });

  it("stores a stop with no start as an internal branch", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [
      { at: T, event: START },
      {
        at: T + 500,
        event: {
          hook_event_name: "SubagentStop",
          session_id: "s1",
          agent_id: "H1",
          agent_type: "",
        },
      },
    ]);
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.kind).toBe("internal");
    expect(branch.started_at).toBeNull();
    expect(branch.ended_at).toBe(T + 500);
  });

  it("files an unknown agent's step under a new internal branch, and closes it from its batch", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "tidy up");
    feed(storage, [
      unknownAgentStep(T + 1000),
      {
        at: T + 1900,
        event: postToolBatchEvent([
          { tool_use_id: "tU1", command: "ls", response: "x" },
          { tool_use_id: "tNever", command: "", response: "" },
        ]),
      },
    ]);
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.agent_id).toBe("a0000000000000001");
    expect(branch.agent_type).toBe("");
    expect(branch.kind).toBe("internal");
    const step = one(read, "SELECT * FROM steps WHERE tool_use_id = 'tU1'");
    expect(step.branch_id).toBe(branch.id);
    expect(step.outcome).toBe("succeeded");
    expect(step.outcome_source).toBe("batch");
    expect(step.ended_at).toBe(T + 1900);
    expect(step.duration_ms).toBe(900);
    // A batch naming a call that was never seen creates nothing.
    expect(rows(read, "SELECT * FROM steps")).toHaveLength(1);
    // The turn's own step list — its steps with no branch — is empty.
    const turn = one(read, "SELECT * FROM turns WHERE prompt_id = 'p1'");
    expect(
      rows(
        read,
        "SELECT * FROM steps WHERE turn_id = ? AND branch_id IS NULL",
        turn.id,
      ),
    ).toEqual([]);
  });

  it("names the branch a step created when its start lands after the step", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "tidy up");
    feed(storage, [
      agentCall("tL1", "reviewer", T + 500),
      unknownAgentStep(T + 1000),
      subagentStart("a0000000000000001", "reviewer", T + 1500),
    ]);
    // The step landed first, so the branch it created stood
    // unnamed and internal; the start names it, and a named
    // agent is the person's subagent. The start also links
    // the branch to the launch that came just before the
    // step, and the step takes that launch's turn.
    const branch = one(read, "SELECT * FROM branches");
    expect(branch.agent_id).toBe("a0000000000000001");
    expect(branch.agent_type).toBe("reviewer");
    expect(branch.kind).toBe("user");
    expect(branch.started_at).toBe(T + 1000);
    const launch = one(read, "SELECT * FROM steps WHERE tool_use_id = 'tL1'");
    expect(branch.spawning_step_id).toBe(launch.id);
    const step = one(read, "SELECT * FROM steps WHERE tool_use_id = 'tU1'");
    expect(step.turn_id).toBe(launch.turn_id);
  });

  it("a batch never overwrites an outcome a post-tool event decided", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "run it");
    feed(storage, [
      {
        at: T + 1000,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "tF1",
          tool_name: "Bash",
          tool_input: { command: "make" },
        },
      },
      {
        at: T + 1500,
        event: {
          hook_event_name: "PostToolUseFailure",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "tF1",
          tool_name: "Bash",
        },
      },
      {
        at: T + 1900,
        event: postToolBatchEvent([
          { tool_use_id: "tF1", command: "make", response: "" },
        ]),
      },
    ]);
    const step = one(read, "SELECT * FROM steps WHERE tool_use_id = 'tF1'");
    expect(step.outcome).toBe("failed");
    expect(step.outcome_source).toBe("hook");
    expect(step.ended_at).toBe(T + 1500);
    expect(step.branch_id).toBeNull();
  });

  it("opens a new segment for compaction and for resume, in the same session", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [
      { at: T, event: START },
      {
        at: T + 60000,
        event: { ...START, source: "compact" },
      },
      {
        at: T + 120000,
        event: {
          ...START,
          source: "resume",
          context_tokens: 42000,
          prompt_cache_likely_expired: true,
        },
      },
    ]);
    const segments = rows(read, "SELECT * FROM segments ORDER BY started_at");
    expect(segments.map((s) => s.kind)).toEqual([
      "startup",
      "compact",
      "resume",
    ]);
    expect(rowAt(segments, 2, "the resume segment").context_tokens).toBe(42000);
    expect(
      rowAt(segments, 2, "the resume segment").prompt_cache_likely_expired,
    ).toBe(1);
    expect(rows(read, "SELECT * FROM sessions")).toHaveLength(1);
  });

  it("marks a session joined partway when its first event is not a start", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [
      {
        at: T,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          tool_use_id: "t1",
          tool_name: "Read",
          tool_input: { file_path: "/work/app/a.ts" },
        },
      },
    ]);
    const session = one(read, "SELECT * FROM sessions");
    expect(session.joined_partway).toBe(1);
    expect(rows(read, "SELECT * FROM segments")).toHaveLength(0);
  });

  it("reads not partway when a start follows InstructionsLoaded", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    // The order the capture shows: the instructions land
    // about a second before the start, and the session row is
    // inserted on that first event.
    feed(storage, [
      {
        at: T,
        event: {
          hook_event_name: "InstructionsLoaded",
          session_id: "s1",
          file_path: "/work/app/CLAUDE.md",
          memory_type: "user",
        },
      },
      {
        at: T + 1000,
        event: sessionStartEvent("startup"),
      },
    ]);
    const session = one(read, "SELECT * FROM sessions");
    expect(session.joined_partway).toBe(0);
  });

  it("a clear start clears the partway mark; a resume leaves it", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    const toolUse = (sessionId: string, at: number) => ({
      at,
      event: {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_use_id: `t-${sessionId}`,
        tool_name: "Read",
        tool_input: { file_path: "/work/app/a.ts" },
      },
    });
    feed(storage, [
      toolUse("s-resume", T),
      { at: T + 1000, event: sessionStartEvent("resume", "s-resume") },
      toolUse("s-clear", T + 2000),
      { at: T + 3000, event: sessionStartEvent("clear", "s-clear") },
    ]);
    const sessions = rows(
      read,
      "SELECT id, joined_partway FROM sessions ORDER BY id",
    );
    expect(sessions).toEqual([
      { id: "s-clear", joined_partway: 0 },
      { id: "s-resume", joined_partway: 1 },
    ]);
  });

  /** A world whose session s1 holds one typed prompt's turn. */
  function worldWithTypedPrompt(): ReturnType<typeof makeStorageWorld> {
    const world = makeStorageWorld(makeTempRoot("flightpath-journey-"));
    feed(world.storage, [
      { at: T, event: sessionStartEvent("startup") },
      {
        at: T + 1000,
        event: userPromptEvent("s1", "fix the converter", {
          prompt_id: "p1",
        }),
      },
    ]);
    return world;
  }

  it("opens no turn for a subagent's hand-back, and stores none of its text", () => {
    const { storage, read } = worldWithTypedPrompt();
    feed(storage, [
      { at: T + 2000, event: { hook_event_name: "Stop", session_id: "s1" } },
      {
        at: T + 3000,
        event: userPromptEvent(
          "s1",
          '<agent-message from="a000000000000002">\n[Subagent hand-back] PLANTED-HANDBACK-REPORT on the files it read.',
          { prompt_id: "p-handback" },
        ),
      },
    ]);
    const turns = rows(read, "SELECT * FROM turns");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt_text).toBe("fix the converter");
    const kinds = rows(read, "SELECT kind FROM human_events").map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(["prompt"]);
    const stored = rows(
      read,
      "SELECT prompt_text FROM turns WHERE prompt_text LIKE '%PLANTED-HANDBACK%'",
    );
    expect(stored).toHaveLength(0);
  });

  /** A prompt submit as the hook sends it with prompt text off: the kind and the figures, never the text. */
  function textOffPrompt(
    kind: string,
    chars: number,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/work/app",
      prompt: { chars },
      prompt_kind: kind,
      prompt_chars: chars,
      prompt_lines: 1,
      ...fields,
    };
  }

  /** A world whose session s1 opened with one text-off prompt of a kind. */
  function worldWithTextOffPrompt(
    kind: string,
    chars: number,
    fields: Record<string, unknown> = {},
  ): ReturnType<typeof makeStorageWorld> {
    const world = makeStorageWorld(makeTempRoot("flightpath-journey-"));
    feed(world.storage, [
      { at: T, event: sessionStartEvent("startup") },
      { at: T + 1000, event: textOffPrompt(kind, chars, fields) },
    ]);
    return world;
  }

  it("opens no turn for a hand-back whose text is off", () => {
    const { read } = worldWithTextOffPrompt("agent-message", 52, {
      prompt_id: "p-handback",
    });
    expect(rows(read, "SELECT * FROM turns")).toHaveLength(0);
    expect(rows(read, "SELECT * FROM human_events")).toHaveLength(0);
  });

  it("opens no turn for a task notification, with its text on or off", () => {
    const onWorld = worldWithTypedPrompt();
    feed(onWorld.storage, [
      {
        at: T + 2000,
        event: userPromptEvent(
          "s1",
          "<task-notification>\n<task-id>t1</task-id>\n</task-notification>",
          {
            prompt_id: "p-note",
            prompt_kind: "task-notification",
            prompt_chars: 62,
            prompt_lines: 3,
          },
        ),
      },
    ]);
    expect(rows(onWorld.read, "SELECT * FROM turns")).toHaveLength(1);
    const offWorld = worldWithTypedPrompt();
    feed(offWorld.storage, [
      {
        at: T + 2000,
        event: textOffPrompt("task-notification", 62, {
          prompt_id: "p-note",
          prompt_lines: 3,
        }),
      },
    ]);
    expect(rows(offWorld.read, "SELECT * FROM turns")).toHaveLength(1);
    const kinds = rows(offWorld.read, "SELECT kind FROM human_events").map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(["prompt"]);
  });

  it("keeps a typed prompt's length when its text is off", () => {
    const { read } = worldWithTextOffPrompt("typed", 20, {
      prompt_id: "p1",
    });
    const turn = one(read, "SELECT * FROM turns");
    expect(turn.prompt_text).toBeNull();
    expect(turn.prompt_chars).toBe(20);
    expect(turn.prompt_lines).toBe(1);
  });

  it("a notification attaches to its turn but never opens one", () => {
    const { storage, read } = worldWithTypedPrompt();
    feed(storage, [
      {
        at: T + 2000,
        event: {
          hook_event_name: "Notification",
          session_id: "s1",
          prompt_id: "p1",
          notification_type: "idle_prompt",
        },
      },
      {
        at: T + 3000,
        event: {
          hook_event_name: "Notification",
          session_id: "s1",
          prompt_id: "p-idle-only",
          notification_type: "idle_prompt",
        },
      },
    ]);
    expect(rows(read, "SELECT * FROM turns")).toHaveLength(1);
    const events = rows(
      read,
      "SELECT kind, turn_id FROM human_events ORDER BY id",
    );
    expect(events).toEqual([
      { kind: "prompt", turn_id: 1 },
      { kind: "waiting", turn_id: 1 },
      { kind: "waiting", turn_id: null },
    ]);
  });

  it("records a command's turn from its expansion, unmarked", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedRecordedEvents(storage);
    const turn = one(read, "SELECT * FROM turns");
    expect(turn.flightpath_command).toBe(0);
  });

  it("makes no turn for a Flightpath command its hook blocked", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedCommandOpening(storage, "flightpath:status");
    expect(rows(read, "SELECT * FROM turns")).toHaveLength(0);
  });

  it("makes no turn for a Flightpath command that arrives already expanded, as a queued one does", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [
      { at: T, event: START },
      {
        at: T + 100,
        event: userPromptEvent("s1", expandedCommandPrompt("flightpath:open")),
      },
    ]);
    expect(rows(read, "SELECT * FROM turns")).toHaveLength(0);
  });

  it("records instruction and skill loads", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedRecordedEvents(storage);
    const loads = rows(read, "SELECT * FROM loads ORDER BY occurred_at");
    expect(
      loads.map((l) => [l.kind, l.name ?? l.file_path, l.trigger]),
    ).toEqual([
      ["instructions", "/work/app/CLAUDE.md", null],
      ["skill", "review-pr", "user_slash"],
      ["skill", "add-unit", "agent"],
    ]);
    const conditions = one(read, "SELECT * FROM session_conditions");
    expect(JSON.parse(conditions.instruction_files as string)).toEqual([
      "/work/app/CLAUDE.md",
    ]);
  });

  it("records no load for Flightpath's own commands", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedCommandOpening(storage, "flightpath:open", [
      {
        at: T + 200,
        event: {
          hook_event_name: "UserPromptExpansion",
          session_id: "s1",
          prompt_id: "p2",
          command_name: "other:deploy",
          command_args: "",
        },
      },
    ]);
    const loads = rows(read, "SELECT * FROM loads ORDER BY occurred_at");
    expect(
      loads.map((l) => [l.kind, l.name ?? l.file_path, l.trigger]),
    ).toEqual([["skill", "other:deploy", "user_slash"]]);
  });

  it("records questions answered", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedRecordedEvents(storage);
    const answered = one(
      read,
      "SELECT * FROM human_events WHERE kind = 'question_answered'",
    );
    expect(JSON.parse(answered.detail as string)).toEqual({
      "Which ton?": "Short ton",
    });
  });
  it("reads enabled plugin names once, from user and project settings", () => {
    const home = makeTempRoot("flightpath-home-");
    const project = makeTempRoot("flightpath-proj-");
    writePluginsFile(join(home, ".claude", "settings.json"), {
      "pdf-tools@market": true,
      "off@x": false,
    });
    const projectSettings = join(project, ".claude", "settings.json");
    writePluginsFile(projectSettings, { "lint@local": true });
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const { storage, read } = startProjectSession(project);
    expect(enabledPlugins(read)).toEqual(["lint", "pdf-tools"]);
    // Read once: changing the file afterwards changes nothing.
    writePluginsFile(projectSettings, { "other@local": true });
    feed(storage, [
      {
        at: T + 1000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p1",
          prompt: "hi",
          cwd: project,
        },
      },
    ]);
    expect(enabledPlugins(read)).toEqual(["lint", "pdf-tools"]);
  });

  it("also reads settings.local.json files and CLAUDE_CONFIG_DIR", () => {
    const home = makeTempRoot("flightpath-home-");
    const config = makeTempRoot("flightpath-config-");
    const project = makeTempRoot("flightpath-proj-");
    // With CLAUDE_CONFIG_DIR set, the home .claude is not read.
    writePluginsFile(join(home, ".claude", "settings.json"), {
      "user@x": true,
    });
    writePluginsFile(join(config, "settings.json"), { "cfg@x": true });
    writePluginsFile(join(config, "settings.local.json"), {
      "cfglocal@x": true,
    });
    writePluginsFile(join(project, ".claude", "settings.local.json"), {
      "projlocal@x": true,
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);

    const { read } = startProjectSession(project);
    expect(enabledPlugins(read)).toEqual(["cfg", "cfglocal", "projlocal"]);
  });

  it("never leaves a step open after the session ends", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "long task");
    feed(storage, [
      {
        at: T + 200,
        event: {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          prompt_id: "p1",
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: { command: "sleep 60" },
        },
      },
      {
        at: T + 300,
        event: { hook_event_name: "SessionEnd", session_id: "s1" },
      },
    ]);
    const step = one(read, "SELECT * FROM steps");
    expect(step.outcome).toBe("interrupted");
    const session = one(read, "SELECT * FROM sessions");
    expect(session.status).toBe("ended");
  });

  it("records pauses and resumes against the session", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feed(storage, [{ at: T, event: START }]);
    storage.recordPause("s1", T + 1000);
    expect(one(read, "SELECT * FROM sessions").status).toBe("paused");
    storage.recordResume("s1", T + 6000);
    expect(one(read, "SELECT * FROM sessions").status).toBe("live");
    const pause = one(read, "SELECT * FROM pauses");
    expect(pause.paused_at).toBe(T + 1000);
    expect(pause.resumed_at).toBe(T + 6000);
  });

  it("stores only what redaction lets through", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    const raw = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt_id: "p1",
      prompt: "deploy with this note attached",
    };
    feed(storage, [{ at: T, event: raw }]);
    const turn = one(read, "SELECT * FROM turns");
    expect(turn.prompt_text).toBe(redactHookEvent(raw).prompt);
  });
});

describe("session ends, seen and unseen", () => {
  it("marks the end as seen when the end event arrives", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "hello");
    feed(storage, [
      {
        at: T + 1000,
        event: { hook_event_name: "SessionEnd", session_id: "s1" },
      },
    ]);
    const session = one(read, "SELECT status, end_seen FROM sessions");
    expect(session.status).toBe("ended");
    expect(session.end_seen).toBe(1);
  });

  it("records the host process a start event notes", () => {
    const { read } = hostWorld();
    const session = one(read, "SELECT host_pid, host_started_at FROM sessions");
    expect(session.host_pid).toBe(4321);
    expect(session.host_started_at).toBe(T);
  });

  it("ends a session unseen at its last event, closing what was open", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "hello");
    feedBashStep(storage, T + 200);
    storage.endSessionUnseen("s1", T + 200);
    const session = one(read, "SELECT status, end_seen FROM sessions");
    expect(session.status).toBe("ended");
    expect(session.end_seen).toBe(0);
    const step = one(
      read,
      "SELECT outcome, outcome_source, ended_at FROM steps",
    );
    expect(step.outcome).toBe("interrupted");
    expect(step.outcome_source).toBe("concluded");
    expect(step.ended_at).toBe(T + 200);
    const turn = one(read, "SELECT ended_at, end_source FROM turns");
    expect(turn.ended_at).toBe(T + 200);
    expect(turn.end_source).toBe("concluded");
  });

  it("restores what the conclusion closed when an event revives the session", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "hello");
    feedBashStep(storage, T + 200);
    // The fallback conclusion closes the running step and the
    // open turn; the step's own result then arrives after all.
    storage.endSessionUnseen("s1", T + 200);
    feed(storage, [
      {
        at: T + 5000,
        event: {
          hook_event_name: "PostToolUse",
          session_id: "s1",
          tool_use_id: "t1",
          tool_response: "ok",
        },
      },
      { at: T + 5100, event: { hook_event_name: "Stop", session_id: "s1" } },
    ]);
    const step = one(
      read,
      "SELECT outcome, outcome_source FROM steps WHERE session_id = 's1'",
    );
    expect(step.outcome).toBe("succeeded");
    expect(step.outcome_source).toBe("hook");
    const turn = one(
      read,
      "SELECT ended_at FROM turns WHERE session_id = 's1'",
    );
    expect(turn.ended_at).toBe(T + 5100);
    const session = one(read, "SELECT status FROM sessions WHERE id = 's1'");
    expect(session.status).toBe("live");
  });

  it("ends the session a newer start in the same process replaced", () => {
    const { storage, read } = hostWorld();
    // /clear starts a new session in the same process: its
    // start notes the process the first session already holds.
    feed(storage, [
      { at: T + 2000, event: hostStart("s2", T + 1000, "clear") },
    ]);
    const replaced = one(
      read,
      "SELECT status, end_seen FROM sessions WHERE id = 's1'",
    );
    expect(replaced.status).toBe("ended");
    expect(replaced.end_seen).toBe(0);
    const current = one(
      read,
      "SELECT status, host_pid FROM sessions WHERE id = 's2'",
    );
    expect(current.status).toBe("live");
    expect(current.host_pid).toBe(4321);
  });

  it("ends the running session when an unseen-ended one resumes into its process", () => {
    const { storage, read } = hostWorld();
    // s1's end was concluded, never reported. s2 runs in
    // another process, and the user resumes s1 inside it:
    // s1's start arrives noting s2's process, and a start is
    // a live event even when it revives its session, so the
    // session it replaces ends the same way.
    storage.endSessionUnseen("s1", T + 100);
    feed(storage, [
      {
        at: T + 2000,
        event: {
          ...START,
          session_id: "s2",
          host_pid: 5555,
          host_started_at: T + 1500,
        },
      },
      {
        at: T + 3000,
        event: {
          ...START,
          session_id: "s1",
          source: "resume",
          host_pid: 5555,
          host_started_at: T + 1500,
        },
      },
    ]);
    const resumed = one(read, "SELECT status FROM sessions WHERE id = 's1'");
    expect(resumed.status).toBe("live");
    const replaced = one(
      read,
      "SELECT status, end_seen FROM sessions WHERE id = 's2'",
    );
    expect(replaced.status).toBe("ended");
    expect(replaced.end_seen).toBe(0);
  });

  it("keeps the earlier session when the id names a different process", () => {
    const { storage, read } = hostWorld();
    // The id was reused half a minute later: a different
    // process, not a replacement of the first session.
    feed(storage, [{ at: T + 40_000, event: hostStart("s2", T + 30_000) }]);
    const first = one(read, "SELECT status FROM sessions WHERE id = 's1'");
    expect(first.status).toBe("live");
  });

  it("clears the noted process when a start cannot note its own", () => {
    const { storage, read } = hostWorld();
    feed(storage, [{ at: T + 1000, event: { ...START, source: "resume" } }]);
    const session = one(
      read,
      "SELECT host_pid, host_started_at FROM sessions WHERE id = 's1'",
    );
    expect(session.host_pid).toBeNull();
    expect(session.host_started_at).toBeNull();
  });

  it("brings a concluded session back to live when an event arrives", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "hello");
    storage.endSessionUnseen("s1", T + 100);
    feed(storage, [
      {
        at: T + 5000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p2",
          prompt: "still here",
        },
      },
    ]);
    const sessions = rows(read, "SELECT status, last_seen_at FROM sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("live");
    expect(sessions[0]?.last_seen_at).toBe(T + 5000);
  });

  it("keeps an imported session's turns when a hook event revives it", async () => {
    const { storage, read } = await importOldWorld();
    const imported = one(
      read,
      "SELECT status, end_seen, joined_partway, project_path FROM sessions WHERE id = 's-old'",
    );
    expect(imported.status).toBe("ended");
    expect(imported.end_seen).toBe(0);
    expect(imported.joined_partway).toBe(1);
    expect(
      rows(read, "SELECT id FROM turns WHERE session_id = 's-old'"),
    ).toHaveLength(2);
    // The user resumes the session under hooks. Its first hook
    // event revives it by status alone: the history the import
    // built is not the hook events' to restate, so it stays.
    feed(storage, [
      {
        at: T + 5000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s-old",
          prompt_id: "p-old-3",
          prompt: "back again",
        },
      },
    ]);
    expect(
      rows(read, "SELECT id FROM turns WHERE session_id = 's-old'"),
    ).toHaveLength(3);
    const session = one(
      read,
      "SELECT status, project_path FROM sessions WHERE id = 's-old'",
    );
    expect(session.status).toBe("live");
    expect(session.project_path).toBe("/work/app");
  });

  it("keeps an imported session's turns and requests through a conclusion and a revival", async () => {
    const { storage, read } = await importOldWorld();
    // The imported session revives under hooks, is concluded
    // unseen while live, and revives again: the turns and
    // requests only its transcript wrote stand throughout.
    feed(storage, [
      {
        at: T + 5000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s-old",
          prompt_id: "p-old-3",
          prompt: "back again",
        },
      },
    ]);
    const importedTurns = rows(
      read,
      "SELECT id, prompt_id, ended_at FROM turns WHERE session_id = 's-old' AND prompt_id IN ('p-old-1', 'p-old-2') ORDER BY sequence",
    );
    expect(importedTurns).toHaveLength(2);
    const importedRequests = rows(
      read,
      "SELECT request_id, turn_id FROM requests WHERE session_id = 's-old' ORDER BY request_id",
    );
    expect(importedRequests.map((row) => row.request_id)).toEqual([
      "req-old-1",
      "req-old-2",
    ]);
    storage.endSessionUnseen("s-old", T + 9000);
    feed(storage, [
      {
        at: T + 12000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s-old",
          prompt_id: "p-old-4",
          prompt: "and again",
        },
      },
    ]);
    const turnsAfter = rows(
      read,
      "SELECT id, prompt_id, ended_at FROM turns WHERE session_id = 's-old' AND prompt_id IN ('p-old-1', 'p-old-2') ORDER BY sequence",
    );
    expect(turnsAfter).toEqual(importedTurns);
    expect(
      rows(
        read,
        "SELECT request_id, turn_id FROM requests WHERE session_id = 's-old' ORDER BY request_id",
      ),
    ).toEqual(expect.arrayContaining(importedRequests));
    const session = one(read, "SELECT status FROM sessions WHERE id = 's-old'");
    expect(session.status).toBe("live");
  });

  it("reopens only what the conclusion closed, and no real closing", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedTwoPromptsAndBranch(storage);
    // The conclusion closes the second step, the second turn
    // and the branch, and marks each closing as its own.
    storage.endSessionUnseen("s1", T + 600);
    // A notification revives the session: it reopens the
    // conclusion's closings and closes nothing itself.
    feedNotification(storage, T + 5000);
    const steps = rows(
      read,
      "SELECT tool_use_id, outcome, outcome_source, ended_at FROM steps ORDER BY started_at",
    );
    // The step the new prompt closed stays closed, as inferred.
    expect(steps[0]).toMatchObject({
      tool_use_id: "t1",
      outcome: "interrupted",
      outcome_source: "inferred",
      ended_at: T + 300,
    });
    // The step the conclusion closed is open again.
    expect(steps[1]).toMatchObject({
      tool_use_id: "t2",
      outcome: "open",
      ended_at: null,
    });
    const turns = rows(
      read,
      "SELECT prompt_id, ended_at, end_source FROM turns ORDER BY sequence",
    );
    expect(turns[0]).toMatchObject({ prompt_id: "p1", ended_at: T + 300 });
    expect(turns[0]?.end_source).toBeNull();
    // The turn the conclusion closed is open again.
    expect(turns[1]).toMatchObject({ prompt_id: "p2", ended_at: null });
    expect(turns[1]?.end_source).toBeNull();
    const branch = one(
      read,
      "SELECT ended_at, end_source FROM branches WHERE session_id = 's1'",
    );
    expect(branch.ended_at).toBeNull();
    expect(branch.end_source).toBeNull();
    const session = one(read, "SELECT status FROM sessions WHERE id = 's1'");
    expect(session.status).toBe("live");
  });

  it("marks what is open at a second conclusion", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedTwoConclusions(storage);
    // The second conclusion marks only what is open at that
    // moment: the third turn, opened after the revival. The
    // second turn keeps the end the third prompt gave it,
    // with no concluded mark.
    const turn = (promptId: string) =>
      one(
        read,
        "SELECT ended_at, end_source FROM turns WHERE prompt_id = ?",
        promptId,
      );
    expect(turn("p3")).toMatchObject({
      ended_at: T + 5400,
      end_source: "concluded",
    });
    expect(turn("p2")).toMatchObject({
      ended_at: T + 5300,
      end_source: null,
    });
    const session = one(read, "SELECT status, end_seen FROM sessions");
    expect(session.status).toBe("ended");
    expect(session.end_seen).toBe(0);
  });

  it("reopens exactly what a second conclusion marked", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedTwoConclusions(storage);
    feedNotification(storage, T + 6000);
    // The second revival reopens the third turn, the one
    // row the second conclusion marked. Every real closing
    // between the two conclusions stands.
    const turn = (promptId: string) =>
      one(
        read,
        "SELECT ended_at, end_source FROM turns WHERE prompt_id = ?",
        promptId,
      );
    expect(turn("p3")).toMatchObject({ ended_at: null, end_source: null });
    expect(turn("p2")).toMatchObject({
      ended_at: T + 5300,
      end_source: null,
    });
    const step = one(
      read,
      "SELECT outcome, outcome_source FROM steps WHERE tool_use_id = 't2'",
    );
    expect(step.outcome).toBe("succeeded");
    expect(step.outcome_source).toBe("hook");
    const branch = one(
      read,
      "SELECT ended_at, end_source FROM branches WHERE session_id = 's1'",
    );
    expect(branch.ended_at).toBe(T + 5200);
    expect(branch.end_source).toBeNull();
    const session = one(read, "SELECT status FROM sessions WHERE id = 's1'");
    expect(session.status).toBe("live");
  });

  it("keeps an end event's closings when a later event arrives", () => {
    const { storage, read } = makeStorageWorld(
      makeTempRoot("flightpath-journey-"),
    );
    feedStartAndPrompt(storage, "hello");
    feedBashStep(storage, T + 200);
    feed(storage, [
      {
        at: T + 1000,
        event: { hook_event_name: "SessionEnd", session_id: "s1" },
      },
      {
        at: T + 5000,
        event: {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt_id: "p2",
          prompt: "after the end",
        },
      },
    ]);
    // The end was reported, so nothing the end closed reopens:
    // the step stays interrupted as inferred, the turn stays
    // ended at the end event's time.
    const step = one(
      read,
      "SELECT outcome, outcome_source, ended_at FROM steps WHERE session_id = 's1'",
    );
    expect(step.outcome).toBe("interrupted");
    expect(step.outcome_source).toBe("inferred");
    expect(step.ended_at).toBe(T + 1000);
    const firstTurn = one(
      read,
      "SELECT ended_at, end_source FROM turns WHERE prompt_id = 'p1'",
    );
    expect(firstTurn.ended_at).toBe(T + 1000);
    expect(firstTurn.end_source).toBeNull();
  });
});
