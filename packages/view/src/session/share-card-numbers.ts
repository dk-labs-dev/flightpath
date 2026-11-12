// The share card's numbers: a pure read over what the view
// already holds for the open session — the summary, the
// context at the latest step and the token history. No new
// read and no new estimate; a field with no value stays
// off the card, except the overhead, which is a real 0.

import {
  itemTokens,
  type ContextAtStep,
  type Rise,
  type SnapshotSummary,
  type StepSummary,
  type TokenHistory,
} from "@flightpath/flightpath/api/payloads";

/** What the card can show, each field absent when the view
 * has no value for it. Unformatted; the render module
 * words them. */
export interface CardNumbers {
  promptsTokens: number | null;
  contextTokens: number | null;
  biggestRise: { tokens: number; kind: string | null } | null;
  durationMs: number | null;
  steps: number | null;
  overheadTokens: number | null;
}

export interface ShareCardInput {
  summary: SnapshotSummary | null;
  /** The context at the session's latest step. */
  context: ContextAtStep | null;
  history: TokenHistory | null;
  steps: ReadonlyMap<number, StepSummary>;
  nowMs: number;
}

/** A step's tool, in the card's plain words: never a name,
 * only the kind of thing the step's result was. One table,
 * so the words live in one place. */
export const RISE_KIND_BY_TOOL: Readonly<Record<string, string>> = {
  Read: "one file read",
  Bash: "a command's output",
  Agent: "a subagent's result",
  Task: "a subagent's result",
  WebFetch: "a web page",
  WebSearch: "a web page",
};

/** The kind phrase for one tool: an MCP tool names its
 * server, which never goes on the card, so every MCP tool
 * shares one phrase; any other tool is a tool's output. */
export function riseKindPhrase(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    return "an MCP tool's output";
  }
  return RISE_KIND_BY_TOOL[toolName] ?? "a tool's output";
}

/** The prompts' size at the latest step: the sum of the
 * prompt items the snapshot lens groups as "Your prompts".
 * When no prompt's size is known, the field is absent —
 * the lens names it unknown rather than zero. */
function promptsTokensOf(context: ContextAtStep | null): number | null {
  if (context === null) {
    return null;
  }
  let total = 0;
  let known = false;
  for (const item of context.items) {
    if (item.kind !== "prompt") {
      continue;
    }
    const tokens = itemTokens(item);
    if (tokens !== null) {
      total += tokens;
      known = true;
    }
  }
  return known ? total : null;
}

/** The largest rise's size and the kind of its first
 * linked step, in the items' ranked order; a branch return
 * is a subagent's result by what it is. A rise that links
 * no step keeps its size and carries no kind. */
function biggestRiseOf(
  history: TokenHistory | null,
  steps: ReadonlyMap<number, StepSummary>,
): CardNumbers["biggestRise"] {
  const rise: Rise | undefined = history?.rises[0];
  if (rise === undefined) {
    return null;
  }
  for (const item of rise.items) {
    if (item.kind === "branch-return") {
      return { tokens: rise.delta, kind: "a subagent's result" };
    }
    if (item.kind === "step") {
      const step = steps.get(item.stepId);
      if (step !== undefined) {
        return { tokens: rise.delta, kind: riseKindPhrase(step.toolName) };
      }
    }
  }
  return { tokens: rise.delta, kind: null };
}

/** The summary's own elapsed time: to now while the
 * session is live, else to its end or its last activity. */
function durationOf(summary: SnapshotSummary, nowMs: number): number {
  const end =
    summary.status === "live"
      ? nowMs
      : (summary.endedAt ?? summary.lastActivityAt);
  return Math.max(0, end - summary.startedAt);
}

export function shareCardNumbers(input: ShareCardInput): CardNumbers {
  const { summary, context, history, steps, nowMs } = input;
  return {
    promptsTokens: promptsTokensOf(context),
    contextTokens: summary?.contextNow ?? null,
    biggestRise: biggestRiseOf(history, steps),
    durationMs: summary === null ? null : durationOf(summary, nowMs),
    steps: summary?.counts.steps ?? null,
    overheadTokens: summary?.overheadTokens ?? null,
  };
}
