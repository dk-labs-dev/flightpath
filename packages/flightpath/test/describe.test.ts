import { describe, expect, it } from "vitest";

import {
  describeBranch,
  describeHuman,
  describePause,
  describeRequest,
  describeSegment,
  describeStep,
} from "../src/describe/index.js";
import type { HumanRow, RequestRow, StepRow } from "../src/storage/index.js";

// The describer, per kind, on hand-written fixtures shaped the
// way the recorder really stores them: text keys the redaction
// allow-list keeps, sizes as { chars: N } for everything else.
const AT = new Date(2026, 0, 1, 15, 5, 0).getTime();

function step(partial: Partial<StepRow>): StepRow {
  return {
    id: 1,
    turnId: 1,
    branchId: null,
    toolName: "Bash",
    inputSummary: null,
    outcome: "succeeded",
    startedAt: AT,
    endedAt: AT + 30_000,
    durationMs: 30_000,
    resultSize: null,
    resultRequestId: null,
    contextChars: null,
    contextImages: null,
    asyncLaunch: null,
    toolUseId: null,
    savedOutputBytes: null,
    ...partial,
  };
}

function human(partial: Partial<HumanRow>): HumanRow {
  return {
    id: 1,
    turnId: 1,
    stepId: null,
    kind: "prompt",
    occurredAt: AT,
    decision: null,
    decisionSource: null,
    detail: null,
    ...partial,
  };
}

describe("describeStep", () => {
  it("uses Claude's own description for a command, else the command", () => {
    const described = describeStep(
      step({
        inputSummary: JSON.stringify({
          command: "npm test",
          description: "Run the test suite",
        }),
        resultSize: 14_602,
      }),
    );
    expect(described.sentence).toBe("Run the test suite");
    expect(described.facts).toContainEqual({
      label: "Output",
      value: "printed 14,602 characters, not stored",
    });
    const bare = describeStep(
      step({ inputSummary: JSON.stringify({ command: "npm test" }) }),
    );
    expect(bare.sentence).toBe("Ran `npm test`");
    const running = describeStep(
      step({
        inputSummary: JSON.stringify({ command: "npm test" }),
        outcome: "open",
      }),
    );
    expect(running.sentence).toBe("Running `npm test`");
    expect(describeStep(step({})).sentence).toBe("Ran a command");
  });

  it("says what was read, with the line range and size when known", () => {
    const described = describeStep(
      step({
        toolName: "Read",
        inputSummary: JSON.stringify({
          file_path: "src/tip.js",
          offset: 10,
          limit: 20,
        }),
        resultSize: 2_048,
      }),
    );
    expect(described.sentence).toBe("Read src/tip.js");
    expect(described.facts).toContainEqual({
      label: "Lines",
      value: "lines 10 to 29 of the file",
    });
    expect(described.facts).toContainEqual({
      label: "Size read",
      value: "2,048 characters",
    });
  });

  describe("reading a saved tool output back", () => {
    const readOf = (file_path: string, outcome = "succeeded"): StepRow =>
      step({
        toolName: "Read",
        outcome,
        inputSummary: JSON.stringify({ file_path }),
      });
    const saved =
      "/home/u/.claude/projects/p/s1/tool-results/toolu_made_up.txt";
    const inSession = { sessionId: "s1" };

    it("names the step that printed it", () => {
      expect(
        describeStep(readOf(saved), {
          ...inSession,
          savedOutputOf: "Ran `npm test`",
        }).sentence,
      ).toBe('Read the saved output of the step "Ran `npm test`"');
      expect(
        describeStep(readOf(saved, "open"), {
          ...inSession,
          savedOutputOf: "Ran `npm test`",
        }).sentence,
      ).toBe('Reading the saved output of the step "Ran `npm test`"');
    });

    it("says a saved tool output when the step that printed it is not recorded", () => {
      expect(describeStep(readOf(saved), inSession).sentence).toBe(
        "Read a saved tool output",
      );
      expect(
        describeStep(
          readOf("C:\\Users\\u\\s1\\tool-results\\toolu_made_up.txt", "open"),
          inSession,
        ).sentence,
      ).toBe("Reading a saved tool output");
    });

    it("reads a project's own tool-results folder as a file", () => {
      const own = "docs/tool-results/notes.txt";
      expect(describeStep(readOf(own), inSession).sentence).toBe(
        "Read docs/tool-results/notes.txt",
      );
    });

    it("reads another session's saved output as a file", () => {
      expect(describeStep(readOf(saved), { sessionId: "s2" }).sentence).toBe(
        `Read ${saved}`,
      );
    });

    it("reads any other text file as a file", () => {
      expect(
        describeStep(readOf("/home/u/notes/toolu_made_up.txt")).sentence,
      ).toBe("Read /home/u/notes/toolu_made_up.txt");
    });

    it("marks a step whose own output was saved to a file", () => {
      const described = describeStep(
        step({ savedOutputBytes: 31_000, resultSize: 31_000 }),
      );
      expect(described.facts).toContainEqual({
        label: "Saved output",
        value:
          "Output saved to a file (31.0 KB); only a short notice entered the context",
      });
    });
  });

  it("counts an edit's characters from the stored sizes, never the text", () => {
    const described = describeStep(
      step({
        toolName: "Edit",
        inputSummary: JSON.stringify({
          file_path: "bin/tip.js",
          old_string: { chars: 10 },
          new_string: { chars: 25 },
        }),
      }),
    );
    expect(described.sentence).toBe("Edited bin/tip.js");
    expect(described.facts).toContainEqual({
      label: "Places changed",
      value: "1 place",
    });
    expect(described.facts).toContainEqual({
      label: "Characters",
      value: "replaced 10 characters with 25 characters",
    });
    const all = describeStep(
      step({
        toolName: "Edit",
        inputSummary: JSON.stringify({
          file_path: "bin/tip.js",
          old_string: { chars: 4 },
          new_string: { chars: 4 },
          replace_all: true,
        }),
      }),
    );
    expect(all.facts).toContainEqual({
      label: "Places changed",
      value: "all occurrences",
    });
  });

  it("says a file was written, with its size, without claiming created or rewrote", () => {
    const described = describeStep(
      step({
        toolName: "Write",
        inputSummary: JSON.stringify({
          file_path: "README.md",
          content: { chars: 1_234 },
        }),
      }),
    );
    expect(described.sentence).toBe("Wrote README.md");
    expect(described.facts).toContainEqual({
      label: "Size written",
      value: "1,234 characters",
    });
  });

  it("names the pattern and scope of a search", () => {
    const grep = describeStep(
      step({
        toolName: "Grep",
        inputSummary: JSON.stringify({ pattern: "round(", path: "src/" }),
        resultSize: 512,
      }),
    );
    expect(grep.sentence).toBe("Searched for `round(` in src/");
    const glob = describeStep(
      step({
        toolName: "Glob",
        inputSummary: JSON.stringify({ pattern: "src/**/*.ts" }),
      }),
    );
    expect(glob.sentence).toBe("Looked for files matching `src/**/*.ts`");
  });

  it("starts a subagent with its task and its own totals", () => {
    const described = describeStep(
      step({
        toolName: "Agent",
        inputSummary: JSON.stringify({
          subagent_type: "module-reviewer",
          description: "Review the module",
        }),
      }),
      {
        branchTotals: {
          steps: 4,
          requests: 2,
          durationMs: 65_000,
          coldStartTokens: 4_000,
        },
      },
    );
    expect(described.sentence).toBe("Started a subagent: module-reviewer");
    expect(described.facts).toContainEqual({
      label: "Task",
      value: "Review the module",
    });
    expect(described.facts).toContainEqual({
      label: "Its work",
      value: "4 steps, 2 requests, 1m 5s",
    });
    expect(described.facts).toContainEqual({
      label: "Cold start",
      value: "4,000 tokens written to cache",
    });
  });

  it("loads a skill, fetches a page, and names an MCP tool's server and tool", () => {
    expect(
      describeStep(
        step({
          toolName: "Skill",
          inputSummary: JSON.stringify({ skill: "add-unit" }),
        }),
      ).sentence,
    ).toBe("Loaded the add-unit skill");
    const fetched = describeStep(
      step({
        toolName: "WebFetch",
        inputSummary: JSON.stringify({
          url: "https://code.claude.com/docs/en/overview",
        }),
        resultSize: 900,
      }),
    );
    expect(fetched.sentence).toBe("Fetched code.claude.com/docs/en/overview");
    const mcp = describeStep(
      step({
        toolName: "mcp__github__create_issue",
        inputSummary: JSON.stringify({
          title: { chars: 12 },
          labels: ["bug"],
        }),
      }),
    );
    expect(mcp.sentence).toBe("Used github: create_issue");
    expect(mcp.facts).toContainEqual({
      label: "Inputs",
      value: "title (12 characters), labels (a list or object)",
    });
  });

  it("asks a question in words, and falls back to naming an unknown tool", () => {
    const asked = describeStep(
      step({
        toolName: "AskUserQuestion",
        inputSummary: JSON.stringify({
          questions: [{ question: "How big?", options: [] }],
        }),
      }),
    );
    expect(asked.sentence).toBe("Asked you a question");
    expect(asked.facts).toContainEqual({
      label: "The question",
      value: "How big?",
    });
    expect(describeStep(step({ toolName: "NotebookRead" })).sentence).toBe(
      "Ran NotebookRead",
    );
  });

  it("turns unrecorded times and outcomes into words, never empty fields", () => {
    const described = describeStep(
      step({ startedAt: null, durationMs: null, outcome: null }),
    );
    expect(described.facts).toContainEqual({
      label: "When",
      value: "unknown",
    });
    expect(described.facts).toContainEqual({
      label: "Duration",
      value: "unknown",
    });
    expect(described.facts).toContainEqual({
      label: "Outcome",
      value: "Not recorded",
    });
  });

  it("never blames telemetry for a step's hook facts", () => {
    // When and Duration come from the tool hooks, so a
    // missing one reads "unknown" even when the session has
    // no telemetry; the telemetry wording belongs to the
    // facts only telemetry supplies (a request's, below).
    const described = describeStep(
      step({ startedAt: null, durationMs: null }),
      { telemetrySeen: false },
    );
    expect(described.facts).toContainEqual({
      label: "When",
      value: "unknown",
    });
    expect(described.facts).toContainEqual({
      label: "Duration",
      value: "unknown",
    });
  });

  it("words a step whose target was not recorded, for every tool kind", () => {
    expect(
      describeStep(step({ toolName: "Grep", inputSummary: "{}" })).sentence,
    ).toBe("Searched in the project");
    expect(
      describeStep(
        step({ toolName: "Grep", inputSummary: "{}", outcome: "open" }),
      ).sentence,
    ).toBe("Searching in the project");
    expect(
      describeStep(step({ toolName: "Glob", inputSummary: "{}" })).sentence,
    ).toBe("Looked for files");
    expect(
      describeStep(step({ toolName: "Skill", inputSummary: "{}" })).sentence,
    ).toBe("Loaded a skill");
    expect(
      describeStep(step({ toolName: "WebFetch", inputSummary: "{}" })).sentence,
    ).toBe("Fetched a page");
    expect(
      describeStep(step({ toolName: "Agent", inputSummary: "{}" })).sentence,
    ).toBe("Started a subagent");
    const mcp = describeStep(
      step({ toolName: "mcp__github__create_issue", inputSummary: "{}" }),
    );
    expect(mcp.sentence).toBe("Used github: create_issue");
    expect(mcp.facts.some((fact) => fact.label === "Inputs")).toBe(false);
  });

  it("adds the approval, context, turn and branch facts when they are known", () => {
    const described = describeStep(step({ branchId: 7 }), {
      turnSequence: 3,
      branchName: "Subagent agent-1",
      approvedBy: "you",
      contextBefore: 48_000,
      contextAfter: 50_500,
    });
    expect(described.facts).toContainEqual({
      label: "Approved by",
      value: "you",
    });
    expect(described.facts).toContainEqual({
      label: "Context",
      value:
        "48.0K tokens before, 50.5K tokens after (+2.5K tokens from this step)",
    });
    expect(described.facts).toContainEqual({ label: "Turn", value: "Turn 3" });
    expect(described.facts).toContainEqual({
      label: "Branch",
      value: "Subagent agent-1",
    });
  });

  it("gives the context before a step alone when nothing was sampled after it", () => {
    const described = describeStep(step({ branchId: 7 }), {
      contextBefore: 37_800,
    });
    expect(described.facts).toContainEqual({
      label: "Context",
      value: "37.8K tokens before",
    });
  });

  it("says a subagent handed its report back, rather than naming the tool", () => {
    const sentence = (outcome: string): string =>
      describeStep(step({ toolName: "SubagentHandback", outcome })).sentence;
    expect(sentence("succeeded")).toBe("Handed its report back");
    expect(sentence("open")).toBe("Handing its report back");
  });

  describe("a file path against the project's folder", () => {
    const sentenceFor = (
      toolName: string,
      file_path: string,
      projectPath: string,
    ): string =>
      describeStep(
        step({ toolName, inputSummary: JSON.stringify({ file_path }) }),
        { projectPath },
      ).sentence;

    it("words a file inside the project relative to it", () => {
      expect(sentenceFor("Read", "/work/app/data/sales.csv", "/work/app")).toBe(
        "Read data/sales.csv",
      );
      expect(sentenceFor("Edit", "/work/app/src/a.ts", "/work/app/")).toBe(
        "Edited src/a.ts",
      );
      expect(sentenceFor("Write", "/work/app/b.md", "/work/app")).toBe(
        "Wrote b.md",
      );
    });

    it("keeps the backslashes and ignores the case of a Windows project", () => {
      expect(
        sentenceFor("Read", "C:\\Work\\App\\data\\sales.csv", "c:\\work\\app"),
      ).toBe("Read data\\sales.csv");
    });

    it("keeps the full path of a file outside the project", () => {
      expect(sentenceFor("Read", "/work/notes/a.txt", "/work/app")).toBe(
        "Read /work/notes/a.txt",
      );
    });

    it("keeps the full path of a folder that only shares the project's name", () => {
      expect(sentenceFor("Read", "/work/app-two/a.txt", "/work/app")).toBe(
        "Read /work/app-two/a.txt",
      );
    });

    it("keeps the full path of a file on a different drive", () => {
      expect(
        sentenceFor("Read", "D:\\Work\\App\\data\\sales.csv", "C:\\Work\\App"),
      ).toBe("Read D:\\Work\\App\\data\\sales.csv");
    });

    it("words the path in full when it is told no project", () => {
      const read = step({
        toolName: "Read",
        inputSummary: JSON.stringify({ file_path: "/work/app/a.txt" }),
      });
      expect(describeStep(read).sentence).toBe("Read /work/app/a.txt");
    });
  });
});

describe("describeHuman", () => {
  it("quotes a kept prompt, and counts an unkept one", () => {
    const kept = describeHuman(human({ kind: "prompt" }), {
      promptText: "add rounding rules\nwith tests",
    });
    expect(kept.sentence).toBe("You asked: add rounding rules");
    const counted = describeHuman(
      human({
        kind: "prompt",
        detail: JSON.stringify({ prompt_length: 42 }),
      }),
      { promptText: null },
    );
    expect(counted.sentence).toBe(
      "You asked a question (42 characters, wording not kept)",
    );
    const unknown = describeHuman(human({ kind: "prompt" }), {
      promptText: null,
    });
    expect(unknown.sentence).toBe("You asked a question (wording not kept)");
  });

  it("counts an unkept prompt from the length its turn kept", () => {
    const counted = describeHuman(human({ kind: "prompt" }), {
      promptText: null,
      promptLength: 20,
    });
    expect(counted.sentence).toBe(
      "You asked a question (20 characters, wording not kept)",
    );
  });

  it("says who was asked, what was asked, and the answer's reach", () => {
    const editStep = step({
      toolName: "Edit",
      inputSummary: JSON.stringify({ file_path: "README.md" }),
    });
    const asked = describeHuman(human({ kind: "permission_request" }), {
      step: editStep,
    });
    expect(asked.sentence).toBe("Claude asked to use Edit on README.md");
    const approved = describeHuman(
      human({ kind: "permission_decision", decision: "accept" }),
      { step: editStep },
    );
    expect(approved.sentence).toBe("You approved Edit README.md");
    expect(approved.facts).toContainEqual({
      label: "The answer",
      value: "approved, once",
    });
    const always = describeHuman(
      human({ kind: "permission_decision", decision: "accept_permanent" }),
      { step: editStep },
    );
    expect(always.facts).toContainEqual({
      label: "The answer",
      value: "approved, always",
    });
    const rejected = describeHuman(
      human({ kind: "permission_decision", decision: "reject" }),
      { step: editStep },
    );
    expect(rejected.sentence).toBe("You rejected Edit README.md");
    const plainRejection = describeHuman(human({ kind: "rejection" }), {
      step: editStep,
    });
    expect(plainRejection.sentence).toBe("You rejected Edit README.md");
    const unrecorded = describeHuman(
      human({ kind: "permission_decision", decision: null }),
      { step: editStep },
    );
    expect(unrecorded.sentence).toBe(
      "The answer for Edit README.md was not recorded",
    );
    expect(unrecorded.facts).toContainEqual({
      label: "The answer",
      value: "not recorded",
    });
  });

  it("names what an interrupt stopped and how long it had run", () => {
    const running = step({
      inputSummary: JSON.stringify({ command: "npm test --watch" }),
      durationMs: 41_000,
    });
    const described = describeHuman(human({ kind: "interrupt" }), {
      step: running,
    });
    expect(described.sentence).toBe("You stopped `npm test --watch` after 41s");
  });

  it("reads the chosen label out of the stored answers map", () => {
    const described = describeHuman(
      human({
        kind: "question_answered",
        detail: JSON.stringify({ "How big?": "Short ton" }),
      }),
      { options: ["Short ton", "Long ton"] },
    );
    expect(described.sentence).toBe("You answered: Short ton");
    expect(described.facts).toContainEqual({
      label: "The options",
      value: "Short ton, Long ton",
    });
    expect(described.facts).toContainEqual({
      label: "Your choice",
      value: "Short ton",
    });
  });

  it("marks a waiting moment in words", () => {
    expect(describeHuman(human({ kind: "waiting" })).sentence).toBe(
      "Claude is waiting for you",
    );
  });

  it("names the command the person ran", () => {
    const ran = describeHuman(
      human({ kind: "command", detail: '{"name":"/context"}' }),
    );
    expect(ran.sentence).toBe("You ran `/context`");
  });

  it("says who reported back and what it cost, as an estimate", () => {
    const sentence = (detail: string): string =>
      describeHuman(human({ kind: "handback", detail })).sentence;
    expect(sentence('{"agent_type":"Explore","chars":7619}')).toBe(
      "Explore reported back · about 2.6K tokens est.",
    );
    expect(sentence('{"agent_type":null,"chars":497}')).toBe(
      "A subagent reported back · about 172 tokens est.",
    );
  });

  it("gives a notice's size in characters, one and many", () => {
    const sentence = (chars: number): string =>
      describeHuman(human({ kind: "notice", detail: `{"chars":${chars}}` }))
        .sentence;
    expect(sentence(1)).toBe("Claude Code added a notice · 1 character");
    expect(sentence(866)).toBe("Claude Code added a notice · 866 characters");
    expect(sentence(1234)).toBe(
      "Claude Code added a notice · 1,234 characters",
    );
  });
});

describe("describeSegment and describePause", () => {
  it("compacts without claiming manual or automatic, and shows the context change", () => {
    const described = describeSegment(
      { id: 1, kind: "compact", startedAt: AT, contextTokens: 30_000 },
      { contextBefore: 96_000 },
    );
    expect(described.sentence).toBe("Compacted the conversation");
    expect(described.facts).toContainEqual({
      label: "Context",
      value: "96.0K tokens before, 30.0K tokens after",
    });
    expect(
      describeSegment({
        id: 2,
        kind: "resume",
        startedAt: AT,
        contextTokens: null,
      }).sentence,
    ).toBe("Session resumed");
    expect(
      describeSegment({
        id: 3,
        kind: "startup",
        startedAt: AT,
        contextTokens: null,
      }).sentence,
    ).toBe("Session started");
  });

  it("says how long a finished pause lasted, and that an open one is open", () => {
    const done = describePause({ id: 1, pausedAt: AT, resumedAt: AT + 60_000 });
    expect(done.sentence).toBe("Recording paused, then resumed");
    expect(done.facts).toContainEqual({ label: "For", value: "1m" });
    expect(
      describePause({ id: 2, pausedAt: AT, resumedAt: null }).sentence,
    ).toBe("Recording paused");
  });

  it("names a branch by type, then id, then not at all", () => {
    expect(describeBranch("Explore", null)).toBe("Subagent Explore");
    expect(describeBranch(null, "agent-9")).toBe("Subagent agent-9");
    expect(describeBranch(null, null)).toBe("A subagent");
  });
});

describe("describeRequest", () => {
  it("says only what a request was part of: the table carries its numbers", () => {
    const request: RequestRow = {
      id: 1,
      turnId: 1,
      branchId: null,
      model: "claude-sonnet-4-5",
      querySource: "main",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 40_000,
      cacheWrite5mTokens: 1_000,
      cacheWrite1hTokens: null,
      tokenSource: "telemetry",
      startedAt: AT,
      durationMs: 20_000,
      effort: null,
      shapeHash: null,
      cacheLifetimes: null,
    };
    const facts = describeRequest(request);
    expect(facts).toEqual([
      { label: "Part of", value: "the main conversation" },
    ]);
  });

  it("says not recorded when a request's source was never captured", () => {
    const request: RequestRow = {
      id: 2,
      turnId: null,
      branchId: null,
      model: null,
      querySource: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      tokenSource: null,
      startedAt: null,
      durationMs: null,
      effort: null,
      shapeHash: null,
      cacheLifetimes: null,
    };
    const facts = describeRequest(request);
    expect(facts).toEqual([{ label: "Part of", value: "unknown" }]);
    const noTelemetry = describeRequest(request, { telemetrySeen: false });
    expect(noTelemetry).toEqual([
      { label: "Part of", value: "not recorded (telemetry off)" },
    ]);
  });
});
