import type { DatabaseSync } from "../../src/storage/sqlite.js";
import {
  seedConditions,
  seedLoad,
  seedMoment,
  seedRequestExact,
  seedSample,
  seedSession,
  seedStep,
  seedTurn,
} from "./seed.js";

export const SKILL_COST_SESSION = "sess-skill-cost";

/**
 * A session in which a skill loads with three files attached and
 * a test run's output is saved to a file and read back: the rise
 * between the first two requests holds the skill, and the last
 * step reads the saved output of the one before it.
 */
export function seedSkillCostSession(db: DatabaseSync, start: number): void {
  const id = SKILL_COST_SESSION;
  seedSession(db, {
    id,
    projectPath: "/home/user/app",
    firstSeenAt: start,
    lastSeenAt: start + 60_000,
  });
  seedConditions(db, id, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 1,
    sessionId: id,
    sequence: 1,
    startedAt: start,
    endedAt: start + 60_000,
    promptChars: 30,
    promptText: "Tidy the code and run the tests",
  });
  seedMoment(db, {
    sessionId: id,
    turnId: 1,
    kind: "prompt",
    occurredAt: start,
    detail: "Tidy the code and run the tests",
  });
  const requests = [
    { at: 1_000, input: 20_000, cacheRead: 0 },
    { at: 6_000, input: 2_000, cacheRead: 53_000 },
    { at: 10_000, input: 3_000, cacheRead: 70_000 },
    { at: 14_000, input: 2_000, cacheRead: 78_000 },
  ];
  requests.forEach((request, index) => {
    seedRequestExact(db, {
      id: index + 1,
      sessionId: id,
      turnId: 1,
      startedAt: start + request.at,
      input: request.input,
      cacheRead: request.cacheRead,
      output: 300,
    });
    seedSample(db, {
      sessionId: id,
      requestId: index + 1,
      sampledAt: start + request.at,
      contextTokens: request.input + request.cacheRead,
    });
  });
  seedSkillLoads(db, start);
  seedSavedOutputSteps(db, start);
}

function seedSkillLoads(db: DatabaseSync, start: number): void {
  const at = start + 3_000;
  seedLoad(db, {
    id: 1,
    sessionId: SKILL_COST_SESSION,
    kind: "skill",
    name: "code-style",
    occurredAt: at,
    sizeBytes: 9_280,
  });
  [
    [2, "docs/style-guide.md", 29_000, 600],
    [3, "docs/naming.md", 14_500, 300],
    [4, "docs/examples/formatting-and-layout-rules.md", 8_700, 150],
  ].forEach(([loadId, path, bytes, lines]) => {
    seedLoad(db, {
      id: Number(loadId),
      sessionId: SKILL_COST_SESSION,
      kind: "skill-file",
      filePath: String(path),
      parentLoadId: 1,
      lineCount: Number(lines),
      occurredAt: at,
      sizeBytes: Number(bytes),
    });
  });
}

function seedSavedOutputSteps(db: DatabaseSync, start: number): void {
  seedStep(db, {
    id: 1,
    sessionId: SKILL_COST_SESSION,
    turnId: 1,
    toolName: "Bash",
    input: { command: "npm test" },
    toolUseId: "toolu_made_up",
    savedOutputBytes: 31_000,
    startedAt: start + 7_000,
    endedAt: start + 8_000,
    resultRequestId: 3,
    contextChars: 180,
  });
  seedStep(db, {
    id: 2,
    sessionId: SKILL_COST_SESSION,
    turnId: 1,
    toolName: "Read",
    input: {
      file_path:
        "/home/user/.claude/projects/app/sess-skill-cost/tool-results/toolu_made_up.txt",
    },
    toolUseId: "toolu_read",
    startedAt: start + 11_000,
    endedAt: start + 12_000,
    resultRequestId: 4,
    contextChars: 24_000,
  });
}
