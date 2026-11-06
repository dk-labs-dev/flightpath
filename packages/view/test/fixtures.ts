import type {
  SessionSnapshot,
  TokenPoint,
} from "@flightpath/flightpath/api/payloads";

/** One main point of a token history, in the payload's shape. */
export function tokenPoint(
  requestId: number,
  at: number,
  tokens: number,
  cacheLifetime: TokenPoint["cacheLifetime"] = "5m",
): TokenPoint {
  return { requestId, at, tokens, turnId: null, cacheLifetime };
}

/** A stand-in for the fetch Response: the history reader
 * reads only the status, the ok flag and the json body. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// One small recorded session in the read API's shape, shared by
// the view tests: two turns, a branch, a failure, a moment the
// person stepped in, a question answered, and a compaction.
export function fixtureSnapshot(): SessionSnapshot {
  return {
    summary: {
      id: "s1",
      title: "tip-calc at proj",
      project: "proj",
      status: "ended",
      startedAt: 1000,
      endedAt: 9000,
      lastActivityAt: 9000,
      model: "claude-sonnet-4-5",
      permissionModes: ["default"],
      sources: ["hook", "telemetry"],
      endSeen: true,
      note: "",
      counts: { turns: 2, steps: 6, requests: 5, branches: 1, humanMoments: 3 },
      failures: 1,
      steppedIn: 2,
      tokensProcessed: 42000,
      contextNow: 20000,
      window: { tokens: 200000, source: "model-list", reportedAt: null },
      overheadTokens: 1200,
      waitingSince: null,
      lastStepAt: 9000,
      cache: null,
    },
    turns: [
      {
        id: 11,
        sequence: 1,
        startedAt: 1000,
        endedAt: 4000,
        failures: 1,
        steppedIn: 1,
        images: 0,
        files: 0,
        steps: [
          {
            id: 101,
            toolName: "Bash",
            outcome: "succeeded",
            startedAt: 1100,
            endedAt: 1500,
            durationMs: 400,
            branchId: null,
            resultRequestId: null,
            sentence: "Ran npm test",
          },
          {
            id: 102,
            toolName: "Edit",
            outcome: "failed",
            startedAt: 1600,
            endedAt: 2000,
            durationMs: 400,
            branchId: null,
            resultRequestId: null,
            sentence: "Edited src/app.ts",
          },
        ],
        humanMoments: [
          {
            id: 21,
            kind: "prompt",
            occurredAt: 1050,
            sentence: "You asked: add tests",
          },
          {
            id: 22,
            kind: "permission_decision",
            occurredAt: 1550,
            sentence: "You approved this step",
          },
        ],
      },
      {
        id: 12,
        sequence: 2,
        startedAt: 5000,
        endedAt: 9000,
        failures: 0,
        steppedIn: 1,
        images: 0,
        files: 0,
        steps: [
          {
            id: 103,
            toolName: "Agent",
            outcome: "succeeded",
            startedAt: 5100,
            endedAt: 7000,
            durationMs: 1900,
            branchId: null,
            resultRequestId: null,
            sentence: "Ran a subagent: review",
          },
          {
            id: 105,
            toolName: "Grep",
            outcome: "succeeded",
            startedAt: 5300,
            endedAt: 5400,
            durationMs: 100,
            branchId: 31,
            resultRequestId: null,
            sentence: "Searched for tip",
          },
          {
            id: 106,
            toolName: "Read",
            outcome: "succeeded",
            startedAt: 6000,
            endedAt: 6100,
            durationMs: 100,
            branchId: 31,
            resultRequestId: null,
            sentence: "Read src/tip.ts",
          },
          {
            id: 104,
            toolName: "Read",
            outcome: "succeeded",
            startedAt: 8000,
            endedAt: 8100,
            durationMs: 100,
            branchId: null,
            resultRequestId: null,
            sentence: "Read docs/guide.md",
          },
        ],
        humanMoments: [
          {
            id: 23,
            kind: "question_answered",
            occurredAt: 7500,
            sentence: "You answered a question",
          },
        ],
      },
    ],
    branches: [
      {
        id: 31,
        agentId: "agent-1",
        agentType: "Explore",
        kind: "user",
        spawningStepId: 103,
        startedAt: 5200,
        endedAt: 6900,
        totalTokens: 5400,
        steps: 2,
        requests: 1,
        sentence: "Explore · 2 steps",
      },
    ],
    sessionEvents: [
      {
        kind: "segment",
        id: 41,
        at: 4500,
        segmentKind: "compact",
        sentence: "Context was compacted",
      },
    ],
    contextSamples: [
      { at: 1000, contextTokens: 9000 },
      { at: 3000, contextTokens: 20000 },
      { at: 5000, contextTokens: 9100 },
      { at: 8000, contextTokens: 20000 },
    ],
  };
}
