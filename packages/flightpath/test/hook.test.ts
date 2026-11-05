import { describe, expect, it } from "vitest";

import { REDACTION_VERSION, redactHookEvent } from "../src/redact/index.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

const base = {
  session_id: "sess-1",
  transcript_path: "/home/user/.claude/projects/x/sess-1.jsonl",
  cwd: "/home/user/project",
  permission_mode: "default",
};

describe("redactHookEvent", () => {
  it("stamps the redaction version", () => {
    const out = redactHookEvent({ ...base, hook_event_name: "Stop" });
    expect(out.redaction_version).toBe(REDACTION_VERSION);
  });

  it("keeps the common fields as text", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "toolu_1",
      agent_id: "agent-1",
      agent_type: "research-agent",
      prompt_id: "prompt-1",
    });
    expect(out.session_id).toBe("sess-1");
    expect(out.tool_name).toBe("Read");
    expect(out.tool_use_id).toBe("toolu_1");
    expect(out.agent_type).toBe("research-agent");
    expect(out.prompt_id).toBe("prompt-1");
  });

  it("reduces a 1 MB tool_response to a size and stays under 2 KB", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat big.log" },
      tool_response: "x".repeat(1_000_000),
    });
    expect(out.tool_response).toEqual({ chars: 1_000_000 });
    expect(JSON.stringify(out).length).toBeLessThan(2048);
  });

  it("keeps a prompt as text and scrubs the secrets in it", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "deploy with AKIAIOSFODNN7EXAMPLE please",
    });
    expect(out.prompt).toBe("deploy with [redacted:aws-access-key] please");
  });

  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
    "keeps the path and reduces the content for %s",
    (tool) => {
      const out = redactHookEvent({
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: {
          file_path: "/home/user/project/src/a.ts",
          notebook_path: "/home/user/project/n.ipynb",
          content: "the whole file",
          new_string: "replacement text",
          old_string: "original text",
          edits: [{ old_string: "a", new_string: "b" }],
        },
      });
      const input = out.tool_input as Record<string, unknown>;
      expect(input.file_path).toBe("/home/user/project/src/a.ts");
      expect(input.content).toEqual({ chars: 14 });
      expect(input.new_string).toEqual({ chars: 16 });
      expect(input.old_string).toEqual({ chars: 13 });
      expect(JSON.stringify(out)).not.toContain("the whole file");
    },
  );

  it("keeps command and description for Bash, sizes for the rest", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "pnpm test",
        description: "Run tests",
        timeout: 5000,
      },
    });
    const input = out.tool_input as Record<string, unknown>;
    expect(input.command).toBe("pnpm test");
    expect(input.description).toBe("Run tests");
    expect(input.timeout).toBe(5000);
  });

  it("reduces an Agent prompt but keeps its description and subagent type", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Review the module",
        prompt: "read everything and report back in detail",
        subagent_type: "research-agent",
      },
    });
    const input = out.tool_input as Record<string, unknown>;
    expect(input.description).toBe("Review the module");
    expect(input.subagent_type).toBe("research-agent");
    expect(input.prompt).toEqual({ chars: 41 });
  });

  it("keeps only keys and sizes for an unknown MCP tool", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "mcp__docs__search",
      tool_input: { query: "secret query text", path: "/etc/passwd" },
    });
    const input = out.tool_input as Record<string, unknown>;
    expect(input.query).toEqual({ chars: 17 });
    expect(input.path).toEqual({ chars: 11 });
  });

  it("keeps only common fields for an unknown event", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "SomeFutureEvent",
      surprise_field: "you should not see this",
    });
    expect(out.surprise_field).toEqual({ chars: 23 });
    expect(out.session_id).toBe("sess-1");
  });

  it("keeps SessionStart source and model, and the numeric cache fields", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "SessionStart",
      source: "resume",
      model: "claude-sonnet",
      context_tokens: 12345,
      prompt_cache_likely_expired: false,
      seconds_since_last_response: 300,
    });
    expect(out.source).toBe("resume");
    expect(out.model).toBe("claude-sonnet");
    expect(out.context_tokens).toBe(12345);
    expect(out.prompt_cache_likely_expired).toBe(false);
    expect(out.seconds_since_last_response).toBe(300);
  });

  it("keeps the Notification type but reduces its message", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to run a command",
    });
    expect(out.notification_type).toBe("permission_prompt");
    expect(out.message).toEqual({ chars: 45 });
  });

  it("reduces compact summaries and last assistant messages", () => {
    const compact = redactHookEvent({
      ...base,
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "a long summary of everything so far",
    });
    expect(compact.trigger).toBe("auto");
    expect(compact.compact_summary).toEqual({ chars: 35 });

    const stop = redactHookEvent({
      ...base,
      hook_event_name: "SubagentStop",
      last_assistant_message: "here is my full report",
    });
    expect(stop.last_assistant_message).toEqual({ chars: 22 });
  });

  it("keeps AskUserQuestion questions, labels and answers", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which layout should the summary use?",
            header: "Layout",
            options: [
              {
                label: "Table",
                description: "Rows and columns, evenly spaced",
              },
              {
                label: "List",
                description: "One item per line, in order",
              },
            ],
          },
        ],
      },
      tool_response: {
        answers: { "Which layout should the summary use?": "Table" },
      },
    });
    const input = out.tool_input as {
      questions: {
        question: string;
        options: { label: string; description: unknown }[];
      }[];
    };
    expect(input.questions[0]?.question).toBe(
      "Which layout should the summary use?",
    );
    expect(input.questions[0]?.options[0]?.label).toBe("Table");
    expect(input.questions[0]?.options[0]?.description).toEqual({ chars: 31 });
    const response = out.tool_response as { answers: Record<string, string> };
    expect(response.answers["Which layout should the summary use?"]).toBe(
      "Table",
    );
  });

  it("keeps InstructionsLoaded path and memory type", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "InstructionsLoaded",
      file_path: "/home/user/project/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    expect(out.file_path).toBe("/home/user/project/CLAUDE.md");
    expect(out.memory_type).toBe("Project");
    expect(out.load_reason).toEqual({ chars: 13 });
  });

  it("keeps the ids and names a PostToolBatch names, sizes for their content", () => {
    const out = redactHookEvent({
      ...base,
      hook_event_name: "PostToolBatch",
      tool_calls: [
        {
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          tool_input: { command: "ls" },
          tool_response: "x",
        },
      ],
    });
    const calls = out.tool_calls as Record<string, unknown>[];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool_use_id).toBe("toolu_1");
    expect(calls[0]?.tool_name).toBe("Bash");
    expect(calls[0]?.tool_input).toEqual({ command: { chars: 2 } });
    expect(calls[0]?.tool_response).toEqual({ chars: 1 });
  });

  it("never modifies the input", () => {
    const payload = deepFreeze({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/x/a.ts", content: "body" },
      tool_response: { nested: ["a", "b"] },
    });
    const out = redactHookEvent(payload);
    expect(out).not.toBe(payload);
    expect(JSON.stringify(payload)).toContain("body");
  });
});

describe("property: planted markers never survive", () => {
  // A deterministic pseudo-random payload generator: every string leaf
  // carries a marker, planted at random depths under random keys. After
  // redaction, no marker may appear anywhere in the output, whatever
  // the shape — outside the fields the allow-list keeps, which the
  // generator deliberately never uses as keys.
  let state = 42;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const keys = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const randomValue = (depth: number): unknown => {
    const roll = next();
    if (depth > 3 || roll < 0.4) {
      return `MARKER_${Math.floor(next() * 1e9)}_secret text`;
    }
    if (roll < 0.7) {
      return Array.from({ length: Math.floor(next() * 3) }, () =>
        randomValue(depth + 1),
      );
    }
    const obj: Record<string, unknown> = {};
    for (const key of keys) {
      if (next() < 0.5) {
        obj[key] = randomValue(depth + 1);
      }
    }
    return obj;
  };

  it("holds for 200 random payloads", () => {
    for (let i = 0; i < 200; i++) {
      const payload: Record<string, unknown> = {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__unknown__thing",
        tool_input: randomValue(0),
        tool_response: randomValue(0),
        extra: randomValue(0),
      };
      const out = JSON.stringify(redactHookEvent(payload));
      expect(out).not.toContain("MARKER_");
      expect(out).not.toContain("secret text");
    }
  });
});
