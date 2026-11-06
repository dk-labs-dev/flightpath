import type { FixedLoad } from "../../src/api/payloads.js";

/**
 * A split fixed load of the shape both the seeded read
 * and the followed replay build: a system prompt and two
 * tools, one instruction file, and the five startup
 * additions at their sizes. The load ids and the file's
 * path are each world's own, so they are the caller's to
 * name.
 */
export function startupSplit(loadIds: {
  instructions: number;
  skill: number;
  deferred: number;
  mcp: number;
  agent: number;
  hook: number;
  instructionsName: string;
}): FixedLoad {
  return {
    kind: "split",
    requestId: 1,
    total: 28_522,
    system: { chars: 40_000, tokens: 13_794, fromContext: false },
    tools: [
      { name: "Read", chars: 4_000, tokens: 1_380 },
      { name: "Bash", chars: 2_000, tokens: 690 },
    ],
    toolsReported: null,
    mcp: [],
    instructions: [
      {
        loadId: loadIds.instructions,
        name: loadIds.instructionsName,
        bytes: 6_000,
        tokens: 2_069,
      },
    ],
    startup: [
      {
        loadId: loadIds.skill,
        kind: "skill-listing",
        name: null,
        count: 40,
        chars: 20_000,
        tokens: 6_897,
        fromContext: false,
      },
      {
        loadId: loadIds.deferred,
        kind: "deferred-tool-names",
        name: null,
        count: 100,
        chars: 4_000,
        tokens: 1_380,
        fromContext: false,
      },
      {
        loadId: loadIds.mcp,
        kind: "mcp-instructions",
        name: null,
        count: 2,
        chars: 3_000,
        tokens: 1_035,
        fromContext: false,
      },
      {
        loadId: loadIds.agent,
        kind: "agent-listing",
        name: null,
        count: null,
        chars: 2_500,
        tokens: 863,
        fromContext: false,
      },
      {
        loadId: loadIds.hook,
        kind: "hook-output",
        name: "SessionStart:startup",
        count: null,
        chars: 1_200,
        tokens: 414,
        fromContext: false,
      },
    ],
  };
}
