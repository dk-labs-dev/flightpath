import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { distDir, distPath } from "./support/daemon.js";

// The shell guard in hooks.json covers a machine with no node; the
// banner esbuild puts on every bundled entry covers one with an old
// node. Both are checked on what ships: the registered commands and
// the built files.

interface HookCommand {
  command: string;
}

const hooksConfig = JSON.parse(
  readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
) as { hooks: Record<string, { hooks: HookCommand[] }[]> };

const commands = Object.values(hooksConfig.hooks)
  .flat()
  .flatMap((entry) => entry.hooks.map((hook) => hook.command));

const SILENT_GUARD = "command -v node >/dev/null 2>&1 || exit 0; ";
const NO_NODE_LINE =
  '{"systemMessage":"● flightpath needs Node 24 or later, and none was found · see Install in the README"}';
const PRINTING_GUARD = `command -v node >/dev/null 2>&1 || { printf '%s\\n' '${NO_NODE_LINE}'; exit 0; }; `;
const RUN_ENTRY = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/([\w-]+\.js)"$/;

const noticeCommand = commands.filter((command) => command.includes("notice"));
const recordingCommand = commands.find((command) =>
  command.endsWith('/dist/hook.js"'),
);

afterEach(runCleanups);

describe("the guard in hooks.json", () => {
  it("opens every command except the startup notice with the silent exit", () => {
    const others = commands.filter((command) => !command.includes("notice"));
    expect(others.length).toBeGreaterThan(1);
    for (const command of others) {
      expect(command.startsWith(SILENT_GUARD), command).toBe(true);
    }
  });

  it("opens the startup notice's command with the form that prints the no-Node line", () => {
    expect(noticeCommand).toHaveLength(1);
    expect(noticeCommand[0]?.startsWith(PRINTING_GUARD)).toBe(true);
  });

  it("ends every command by running a built entry", () => {
    for (const command of commands) {
      const entry = RUN_ENTRY.exec(command)?.[1];
      expect(entry, command).toBeDefined();
      expect(existsSync(distPath(entry ?? "")), command).toBe(true);
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "a command with no node on the PATH",
  // Windows runs hook commands through a shell this test can't
  // stand in for with a symlink to sh.
  () => {
    function runWithoutNode(command: string): {
      status: number | null;
      stdout: string;
    } {
      const bin = makeTempRoot("no-node-");
      symlinkSync("/bin/sh", join(bin, "sh"));
      const result = spawnSync(join(bin, "sh"), ["-c", command], {
        env: { PATH: bin, CLAUDE_PLUGIN_ROOT: dirname(distDir) },
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout };
    }

    it("makes the startup notice print the no-Node line and exit 0", () => {
      const result = runWithoutNode(noticeCommand[0] ?? "");
      expect(result).toEqual({ status: 0, stdout: `${NO_NODE_LINE}\n` });
    });

    it("makes a recording command print nothing and exit 0", () => {
      const result = runWithoutNode(recordingCommand ?? "");
      expect(result).toEqual({ status: 0, stdout: "" });
    });
  },
);

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
