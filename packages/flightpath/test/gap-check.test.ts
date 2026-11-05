import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { recordHookEvent } from "./support/events.js";
import { iso } from "./support/time.js";

// The gap check (scripts/gap-check.mjs) compares a recorded
// session with its transcript and prints the differences. It
// runs as a child process against the built dist, like the
// exit-test run it exists for.

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "gap-check.mjs");
const T0 = Date.parse("2026-10-24T10:00:00.000Z");

afterEach(async () => {
  await runCleanups();
});

function runGapCheck(
  dataDir: string,
  sessionId: string,
  transcriptPath?: string,
): { status: number; stdout: string } {
  const args = [script, sessionId];
  if (transcriptPath !== undefined) args.push(transcriptPath);
  args.push("--data-dir", dataDir);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout };
}

function userLine(at: number, promptId: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(at),
    promptId,
    message: { role: "user", content: "a prompt" },
  });
}

function assistantLine(
  at: number,
  requestId: string,
  content: Record<string, unknown>[],
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(at),
    requestId,
    message: {
      role: "assistant",
      model: "claude-sonnet",
      usage: { input_tokens: 10, output_tokens: 5 },
      content,
    },
  });
}

function toolUse(id: string): Record<string, unknown> {
  return { type: "tool_use", id, name: "Read", input: {} };
}

function insertRequests(
  db: DatabaseSync,
  sessionId: string,
  rows: readonly (readonly [string, number])[],
): void {
  for (const [requestId, at] of rows) {
    db.prepare(
      "INSERT INTO requests (session_id, request_id, input_tokens, output_tokens, token_source, started_at) VALUES (?, ?, 10, 5, 'transcript', ?)",
    ).run(sessionId, requestId, T0 + at);
  }
}

interface RecordingStart {
  root: string;
  dataDir: string;
  storage: ReturnType<typeof openStorage>;
  transcriptPath: string;
  base: Record<string, unknown>;
}

/** Open a recording and record the opening every builder
 *  shares: the session start, the first prompt, its Read. */
function openRecording(prefix: string, sessionId: string): RecordingStart {
  const root = makeTempRoot(prefix);
  const dataDir = join(root, "data");
  const storage = openStorage({ dataDir });
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const base = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: "/home/user/proj-a",
  };
  recordHookEvent(
    storage,
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    T0,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt_id: "p-1",
      prompt: "one",
    },
    T0 + 1000,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      prompt_id: "p-1",
      tool_name: "Read",
      tool_use_id: "toolu_1",
      tool_input: { file_path: "/x" },
    },
    T0 + 2000,
  );
  return { root, dataDir, storage, transcriptPath, base };
}

/** Record the second prompt and its Read step. */
function recordSecondPrompt(
  start: RecordingStart,
  at: number,
  toolUseId: string,
): void {
  const { storage, base } = start;
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt_id: "p-2",
      prompt: "two",
    },
    at,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      prompt_id: "p-2",
      tool_name: "Read",
      tool_use_id: toolUseId,
      tool_input: { file_path: "/y" },
    },
    at + 1000,
  );
}

interface GapWorld {
  dataDir: string;
  transcriptPath: string;
}

function buildWholeRecording(): GapWorld {
  const start = openRecording("flightpath-gap-", "sess-gap");
  const { root, dataDir, storage, transcriptPath, base } = start;
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_2",
      tool_input: { command: "ls" },
    },
    T0 + 3000,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      prompt_id: "p-1",
      tool_name: "Agent",
      tool_use_id: "toolu_agent",
      tool_input: { subagent_type: "explore" },
    },
    T0 + 3200,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "SubagentStart",
      agent_id: "a1",
      agent_type: "explore",
    },
    T0 + 3300,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      agent_id: "a1",
      tool_name: "Read",
      tool_use_id: "toolu_sub",
      tool_input: { file_path: "/z" },
    },
    T0 + 3400,
  );
  recordSecondPrompt(start, T0 + 4000, "toolu_3");
  const db = new DatabaseSync(storage.dbPath);
  insertRequests(db, "sess-gap", [
    ["req-0", 2000],
    ["req-sub", 3400],
    ["req-1", 5000],
  ]);
  db.close();
  storage.close();

  writeFileSync(
    transcriptPath,
    [
      userLine(T0 + 1000, "p-1"),
      // One response written as three entries sharing a
      // request id, as a real response is: text first, then
      // one tool call per entry.
      assistantLine(T0 + 2000, "req-0", [{ type: "text", text: "working" }]),
      assistantLine(T0 + 2100, "req-0", [toolUse("toolu_1")]),
      assistantLine(T0 + 2200, "req-0", [toolUse("toolu_2")]),
      assistantLine(T0 + 2300, "req-0", [toolUse("toolu_agent")]),
      JSON.stringify({
        type: "user",
        timestamp: iso(T0 + 3500),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          ],
        },
      }),
      // Neither of these is a prompt.
      JSON.stringify({
        type: "user",
        timestamp: iso(T0 + 3600),
        message: { role: "user", content: "[Request interrupted by user]" },
      }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        timestamp: iso(T0 + 3700),
        message: { role: "user", content: "housekeeping" },
      }),
      userLine(T0 + 4000, "p-2"),
      assistantLine(T0 + 5000, "req-1", [toolUse("toolu_3")]),
    ].join("\n") + "\n",
  );
  // The subagent's own transcript, beside the session's: its
  // steps and requests count, its prompt does not.
  const subagentsDir = join(root, "sess-gap", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(
    join(subagentsDir, "agent-a1.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: iso(T0 + 3350),
        message: { role: "user", content: "explore the repo" },
      }),
      assistantLine(T0 + 3400, "req-sub", [toolUse("toolu_sub")]),
    ].join("\n") + "\n",
  );
  return { dataDir, transcriptPath };
}

interface CommandWorld extends GapWorld {
  turnCount: number;
  loadCount: number;
}

function buildCommandRecording(): CommandWorld {
  const start = openRecording("flightpath-gap-cmd-", "sess-cmd");
  const { dataDir, storage, transcriptPath, base } = start;
  // Three of the plugin's own commands between the prompts:
  // each arrives as a submit followed by its expansion.
  const commands: [string, string][] = [
    ["flightpath:status", "p-c1"],
    ["flightpath:stop", "p-c2"],
    ["flightpath:start", "p-c3"],
  ];
  commands.forEach(([name, promptId], index) => {
    const at = T0 + 3000 + index * 100;
    recordHookEvent(
      storage,
      {
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt_id: promptId,
        prompt: `/${name}`,
      },
      at,
    );
    recordHookEvent(
      storage,
      {
        ...base,
        hook_event_name: "UserPromptExpansion",
        prompt_id: promptId,
        command_name: name,
        command_args: "",
        command_source: "plugin",
      },
      at + 10,
    );
  });
  recordSecondPrompt(start, T0 + 4000, "toolu_2");
  // A real prompt that merely starts with the namespace is
  // not a command, and stays a turn.
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt_id: "p-3",
      prompt: "flightpath: why is this session slow?",
    },
    T0 + 6000,
  );
  recordHookEvent(
    storage,
    {
      ...base,
      hook_event_name: "PreToolUse",
      prompt_id: "p-3",
      tool_name: "Read",
      tool_use_id: "toolu_3",
      tool_input: { file_path: "/z" },
    },
    T0 + 7000,
  );
  const db = new DatabaseSync(storage.dbPath);
  insertRequests(db, "sess-cmd", [
    ["req-0", 2000],
    ["req-1", 5000],
    ["req-2", 7000],
  ]);
  // Exactly three turns — and the plugin's own commands
  // record no load.
  const turns = db
    .prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'sess-cmd'")
    .get() as { n: number };
  const loads = db
    .prepare(
      "SELECT COUNT(*) AS n FROM loads WHERE session_id = 'sess-cmd' AND trigger = 'user_slash'",
    )
    .get() as { n: number };
  db.close();
  storage.close();

  writeFileSync(
    transcriptPath,
    [
      userLine(T0 + 1000, "p-1"),
      assistantLine(T0 + 2000, "req-0", [toolUse("toolu_1")]),
      userLine(T0 + 4000, "p-2"),
      assistantLine(T0 + 5000, "req-1", [toolUse("toolu_2")]),
      userLine(T0 + 6000, "p-3"),
      assistantLine(T0 + 7000, "req-2", [toolUse("toolu_3")]),
    ].join("\n") + "\n",
  );
  return { dataDir, transcriptPath, turnCount: turns.n, loadCount: loads.n };
}

function buildRealRecording(): GapWorld {
  const start = openRecording("flightpath-gap-real-", "sess-real");
  const { dataDir, storage, transcriptPath } = start;
  recordSecondPrompt(start, T0 + 9000, "toolu_2");
  const db = new DatabaseSync(storage.dbPath);
  insertRequests(db, "sess-real", [
    ["req-0", 2000],
    ["req-meta", 5500],
    ["req-1", 10000],
  ]);
  // The recorder counts the turn the subagent's result opens,
  // and a pause the middle prompt fell inside.
  db.prepare(
    "INSERT INTO turns (session_id, prompt_id, sequence, started_at, prompt_text, flightpath_command) VALUES ('sess-real', NULL, 90, ?, NULL, 0)",
  ).run(T0 + 5000);
  db.prepare(
    "INSERT INTO pauses (session_id, paused_at, resumed_at) VALUES ('sess-real', ?, ?)",
  ).run(T0 + 6000, T0 + 8000);
  db.close();
  storage.close();

  const user = (
    at: number,
    extra: Record<string, unknown>,
    content: unknown,
  ): string =>
    JSON.stringify({
      type: "user",
      timestamp: iso(at),
      ...extra,
      message: { role: "user", content },
    });
  writeFileSync(
    transcriptPath,
    [
      user(T0 + 1000, { promptId: "p-1" }, "one"),
      assistantLine(T0 + 2000, "req-0", [toolUse("toolu_1")]),
      // A compaction summary and the /compact command's own
      // entries are not prompts.
      user(
        T0 + 3000,
        { isCompactSummary: true },
        "This session is being continued from a previous conversation.",
      ),
      user(
        T0 + 3100,
        {},
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
      ),
      user(
        T0 + 3200,
        {},
        "<local-command-stdout>Compacted.</local-command-stdout>",
      ),
      // A subagent's result comes back as a housekeeping
      // entry — and starts the request that follows it.
      user(T0 + 5000, { isMeta: true }, "the subagent's findings"),
      assistantLine(T0 + 5500, "req-meta", [{ type: "text", text: "noted" }]),
      // This prompt was typed while recording was paused.
      user(T0 + 7000, { promptId: "p-paused" }, "while you were off"),
      user(T0 + 9000, { promptId: "p-2" }, "two"),
      assistantLine(T0 + 10000, "req-1", [toolUse("toolu_2")]),
    ].join("\n") + "\n",
  );
  return { dataDir, transcriptPath };
}

describe("gap check", () => {
  it("reports no differences on a whole recording", () => {
    const { dataDir } = buildWholeRecording();
    // No transcript argument: the path comes from the stored
    // hook events.
    const whole = runGapCheck(dataDir, "sess-gap");
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain("turns: recorded 2 · transcript 2");
    expect(whole.stdout).toContain("steps: recorded 5 · transcript 5");
    expect(whole.stdout).toContain("requests: recorded 3 · transcript 3");
    expect(whole.stdout).toContain("gap check: no differences");
  });

  it("names a missing request in a whole recording", () => {
    const { dataDir, transcriptPath } = buildWholeRecording();
    const reopened = openStorage({ dataDir });
    const db2 = new DatabaseSync(reopened.dbPath);
    db2.prepare("DELETE FROM requests WHERE request_id = 'req-1'").run();
    db2.close();
    reopened.close();
    const gapped = runGapCheck(dataDir, "sess-gap", transcriptPath);
    expect(gapped.status).toBe(1);
    expect(gapped.stdout).toContain(
      "requests: recorded 2 · transcript 3  <-- difference",
    );
    expect(gapped.stdout).toContain("gap check: 1 difference(s) found");
  });

  it("counts no turn for Flightpath's own commands between prompts", () => {
    const recording = buildCommandRecording();
    expect(recording.turnCount).toBe(3);
    expect(recording.loadCount).toBe(0);
  });

  it("keeps a prompt that only starts with the namespace as a turn", () => {
    const { dataDir } = buildCommandRecording();
    const whole = runGapCheck(dataDir, "sess-cmd");
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain("turns: recorded 3 · transcript 3");
    expect(whole.stdout).toContain("gap check: no differences");
  });

  it("counts turns around a compaction, a local command, a pause and a subagent result", () => {
    const { dataDir } = buildRealRecording();
    const whole = runGapCheck(dataDir, "sess-real");
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain("turns: recorded 3 · transcript 3");
  });

  it("counts steps and requests around a compaction, a local command, a pause and a subagent result", () => {
    const { dataDir } = buildRealRecording();
    const whole = runGapCheck(dataDir, "sess-real");
    expect(whole.stdout).toContain("steps: recorded 2 · transcript 2");
    expect(whole.stdout).toContain("requests: recorded 3 · transcript 3");
  });

  it("reports no differences around a compaction, a local command, a pause and a subagent result", () => {
    const { dataDir } = buildRealRecording();
    const whole = runGapCheck(dataDir, "sess-real");
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain("gap check: no differences");
  });
});
