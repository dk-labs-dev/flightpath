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
    total: 30_673,
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
        bytes: 6_474,
        tokens: 2_233,
      },
    ],
    startup: [
      {
        loadId: loadIds.skill,
        kind: "skill-listing",
        name: null,
        count: 49,
        chars: 24_851,
        tokens: 8_570,
        fromContext: false,
      },
      {
        loadId: loadIds.deferred,
        kind: "deferred-tool-names",
        name: null,
        count: 132,
        chars: 4_160,
        tokens: 1_435,
        fromContext: false,
      },
      {
        loadId: loadIds.mcp,
        kind: "mcp-instructions",
        name: null,
        count: 2,
        chars: 3_715,
        tokens: 1_282,
        fromContext: false,
      },
      {
        loadId: loadIds.agent,
        kind: "agent-listing",
        name: null,
        count: null,
        chars: 2_527,
        tokens: 872,
        fromContext: false,
      },
      {
        loadId: loadIds.hook,
        kind: "hook-output",
        name: "SessionStart:startup",
        count: null,
        chars: 1_207,
        tokens: 417,
        fromContext: false,
      },
    ],
  };
}
