import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { distPath } from "./support/daemon.js";

// Hooks are registered in exec form so that no shell parses them: a
// shell command works on bash and not on the PowerShell Claude Code
// falls back to on Windows. The banner esbuild puts on every bundled
// entry covers a Node that is too old. Both are checked on what
// ships: the registered hooks and the built files.

interface Hook {
  command: string;
  args?: string[];
}

const hooksConfig = JSON.parse(
  readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
) as { hooks: Record<string, { hooks: Hook[] }[]> };

const hooks = Object.values(hooksConfig.hooks)
  .flat()
  .flatMap((entry) => entry.hooks);

const ENTRY_PATH = /^\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/([\w-]+\.js)$/;

function entryOf(hook: Hook): string | undefined {
  return ENTRY_PATH.exec(hook.args?.[0] ?? "")?.[1];
}

describe("the hooks in hooks.json", () => {
  it("run node directly, with the entry as its one argument", () => {
    expect(hooks.length).toBeGreaterThan(1);
    for (const hook of hooks) {
      expect(hook.command, JSON.stringify(hook)).toBe("node");
      expect(hook.args, JSON.stringify(hook)).toHaveLength(1);
    }
  });

  it("name an entry that is built", () => {
    for (const hook of hooks) {
      const entry = entryOf(hook);
      expect(entry, JSON.stringify(hook)).toBeDefined();
      expect(existsSync(distPath(entry ?? "")), JSON.stringify(hook)).toBe(
        true,
      );
    }
  });

  it("register each of the four entries", () => {
    expect(new Set(hooks.map(entryOf))).toEqual(
      new Set(["hook.js", "notice.js", "submit-command.js", "command.js"]),
    );
  });
});

describe("the version gate on the built entries", () => {
  const entries = [
    "hook.js",
    "daemon.js",
    "command.js",
    "notice.js",
    "submit-command.js",
    "command-handler.js",
  ];

  // The daemon keeps its shebang on the first line, as a shebang must be.
  function gateOf(entry: string): string {
    const lines = readFileSync(distPath(entry), "utf8").split("\n");
    return (lines[0]?.startsWith("#!") ? lines[1] : lines[0]) ?? "";
  }

  class Exited extends Error {}

  function runGate(
    entry: string,
    node: string,
  ): { written: string[]; exitCodes: number[] } {
    const written: string[] = [];
    const exitCodes: number[] = [];
    const stubProcess = {
      versions: { node },
      argv: ["node", distPath(entry)],
      stdout: { write: (text: string) => written.push(text) },
      exit: (code: number) => {
        exitCodes.push(code);
        throw new Exited();
      },
    };
    try {
      runInNewContext(gateOf(entry), { process: stubProcess });
    } catch (error) {
      if (!(error instanceof Exited)) throw error;
    }
    return { written, exitCodes };
  }

  it("is the first line of every bundled entry, after a shebang", () => {
    const gate = gateOf("hook.js");
    expect(gate).toContain("process.versions.node");
    for (const entry of entries) {
      expect(gateOf(entry), entry).toBe(gate);
    }
  });

  it("makes the notice name the Node it found, then exit 0", () => {
    expect(runGate("notice.js", "20.11.0")).toEqual({
      written: [
        '{"systemMessage":"● flightpath needs Node 24 or later; this is Node 20.11.0 · see Install in the README"}\n',
      ],
      exitCodes: [0],
    });
  });

  it("makes every other entry exit 0 without writing", () => {
    for (const entry of entries.filter((name) => name !== "notice.js")) {
      expect(runGate(entry, "20.11.0"), entry).toEqual({
        written: [],
        exitCodes: [0],
      });
    }
  });

  it("lets Node 24 and later through", () => {
    for (const node of ["24.0.0", "26.1.0"]) {
      expect(runGate("notice.js", node), node).toEqual({
        written: [],
        exitCodes: [],
      });
    }
  });
});
