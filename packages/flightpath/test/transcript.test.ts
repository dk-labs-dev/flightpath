import { describe, expect, it } from "vitest";

import { redactTranscriptEntry } from "../src/redact/index.js";

describe("redactTranscriptEntry", () => {
  it("keeps ids, model and usage; reduces message content to sizes", () => {
    const out = redactTranscriptEntry({
      type: "assistant",
      uuid: "entry-1",
      parentUuid: "entry-0",
      sessionId: "sess-1",
      timestamp: "2026-10-23T14:00:00.000Z",
      requestId: "req-1",
      message: {
        role: "assistant",
        model: "claude-sonnet",
        usage: { input_tokens: 1200, output_tokens: 300 },
        content: [
          { type: "text", text: "Here is the explanation you asked for." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/home/user/project/src/a.ts" },
          },
        ],
      },
    });
    expect(out.type).toBe("assistant");
    expect(out.sessionId).toBe("sess-1");
    expect(out.requestId).toBe("req-1");
    const message = out.message as {
      model: string;
      usage: { input_tokens: number };
      content: Record<string, unknown>[];
    };
    expect(message.model).toBe("claude-sonnet");
    expect(message.usage.input_tokens).toBe(1200);
    expect(message.content[0]?.text).toEqual({ chars: 38 });
    expect(message.content[1]?.name).toBe("Read");
    expect(message.content[1]?.id).toBe("toolu_1");
    const input = message.content[1]?.input as Record<string, unknown>;
    expect(input.file_path).toEqual({ chars: 27 });
    expect(JSON.stringify(out)).not.toContain("explanation");
    expect(out.redaction_version).toBe(1);
  });

  it("reduces user message text and tool results", () => {
    const out = redactTranscriptEntry({
      type: "user",
      uuid: "entry-2",
      sessionId: "sess-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "the file's actual contents, line by line",
          },
        ],
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("actual contents");
    const message = out.message as { content: Record<string, unknown>[] };
    expect(message.content[0]?.content).toEqual({ chars: 40 });
  });

  it("reduces tool inputs and results however they are keyed", () => {
    const out = redactTranscriptEntry({
      type: "assistant",
      uuid: "entry-3",
      sessionId: "sess-1",
      message: {
        role: "assistant",
        model: "claude-sonnet",
        content: [
          {
            type: "tool_use",
            id: "toolu_9",
            name: "mcp__crm__lookup",
            input: { name: "Jamie Example, 1 Test Street", id: "cust-1" },
          },
        ],
      },
      toolUseResult: {
        name: "Jamie Example",
        stdout: "the full lookup output",
      },
    });
    const message = out.message as { content: Record<string, unknown>[] };
    const input = message.content[0]?.input as Record<string, unknown>;
    expect(input.name).toEqual({ chars: 28 });
    expect(input.id).toEqual({ chars: 6 });
    expect(message.content[0]?.name).toBe("mcp__crm__lookup");
    const result = out.toolUseResult as Record<string, unknown>;
    expect(result.name).toEqual({ chars: 13 });
    expect(result.stdout).toEqual({ chars: 22 });
    expect(JSON.stringify(out)).not.toContain("Jamie");
  });

  it("never modifies the input", () => {
    const entry = {
      type: "user",
      sessionId: "sess-1",
      message: { role: "user", content: "hello there" },
    };
    const snapshot = JSON.stringify(entry);
    redactTranscriptEntry(entry);
    expect(JSON.stringify(entry)).toBe(snapshot);
  });
});
