import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { distDir } from "./support/daemon.js";
import { onHostedRunner } from "./support/time.js";

import {
  findHostProcess,
  isClaudeCommand,
  parseProcStat,
  parseWindowsProcessTable,
  parseWindowsStartTimes,
  processExists,
  readProcessLinux,
  sameProcessStart,
  WINDOWS_STARTED_AT_PROPERTY,
  type ProcessInfo,
} from "../src/util/host-process.js";

afterEach(async () => {
  await runCleanups();
});

// Finding the Claude Code process above a hook: the command
// match, the ancestor walk past the short-lived shell, and
// the /proc start-time parse the reuse check rests on.

describe("isClaudeCommand", () => {
  it("matches the native binary and node running the entry point", () => {
    expect(isClaudeCommand(["/usr/local/bin/claude"])).toBe(true);
    expect(isClaudeCommand(["C:\\Users\\x\\claude.exe"])).toBe(true);
    expect(
      isClaudeCommand([
        "node",
        "/home/x/.npm/@anthropic-ai/claude-code/cli.js",
      ]),
    ).toBe(true);
  });

  it("does not match a shell running a hook, or another program", () => {
    expect(
      isClaudeCommand([
        "/bin/sh",
        "-c",
        "node /home/x/.claude/plugins/flightpath/dist/hook.js",
      ]),
    ).toBe(false);
    expect(isClaudeCommand(["node", "/home/x/project/server.js"])).toBe(false);
    expect(isClaudeCommand(["cmd.exe", "/c", "node hook.js"])).toBe(false);
    expect(isClaudeCommand([])).toBe(false);
  });
});

describe("findHostProcess", () => {
  const table = new Map<number, ProcessInfo>([
    [
      300,
      { pid: 300, parentPid: 200, startedAt: 30, argv: ["node", "hook.js"] },
    ],
    [200, { pid: 200, parentPid: 100, startedAt: 20, argv: ["/bin/sh", "-c"] }],
    [
      100,
      {
        pid: 100,
        parentPid: 1,
        startedAt: 10,
        argv: ["node", "/opt/@anthropic-ai/claude-code/cli.js"],
      },
    ],
  ]);
  const read = (pid: number): ProcessInfo | null => table.get(pid) ?? null;

  it("walks past the shell to the Claude Code process", () => {
    expect(findHostProcess(read, 300)).toEqual({ pid: 100, startedAt: 10 });
  });

  it("finds nothing when no ancestor is Claude Code", () => {
    const shells = new Map<number, ProcessInfo>([
      [200, { pid: 200, parentPid: 1, startedAt: 20, argv: ["/bin/sh"] }],
      [1, { pid: 1, parentPid: 0, startedAt: 1, argv: ["init"] }],
    ]);
    expect(findHostProcess((pid) => shells.get(pid) ?? null, 200)).toBeNull();
  });

  it("stops when a process in the chain is already gone", () => {
    expect(findHostProcess(read, 999)).toBeNull();
  });
});

describe("parseWindowsProcessTable", () => {
  const row = (
    pid: number,
    parentPid: number,
    name: string,
    commandLine: string,
  ) => ({
    ProcessId: pid,
    ParentProcessId: parentPid,
    StartedAt: pid * 10,
    Name: name,
    CommandLine: commandLine,
  });

  it("reads the table the one Windows query emits", () => {
    const text = JSON.stringify([
      row(300, 200, "node.exe", "node hook.js"),
      row(200, 100, "sh.exe", "sh -c node hook.js"),
      row(100, 1, "node.exe", "node C:\\x\\@anthropic-ai\\claude-code\\cli.js"),
      { ProcessId: "junk", ParentProcessId: 1, StartedAt: 5 },
    ]);
    const table = parseWindowsProcessTable(text);
    expect(table.size).toBe(3);
    expect(table.get(300)).toEqual({
      pid: 300,
      parentPid: 200,
      startedAt: 3000,
      argv: ["node.exe", "hook.js"],
    });
  });

  it("takes the entry point out of a quoted command line", () => {
    const text = JSON.stringify([
      row(
        100,
        1,
        "node.exe",
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\@anthropic-ai\\claude-code\\cli.js"',
      ),
    ]);
    const info = parseWindowsProcessTable(text).get(100);
    expect(info?.argv).toEqual([
      "node.exe",
      "C:\\x\\@anthropic-ai\\claude-code\\cli.js",
    ]);
    expect(info !== undefined && isClaudeCommand(info.argv)).toBe(true);
  });

  it("does not match claude-code named only in a later argument", () => {
    const text = JSON.stringify([
      row(
        100,
        1,
        "node.exe",
        "node C:\\tools\\runner.js --root C:\\x\\claude-code\\config",
      ),
    ]);
    const info = parseWindowsProcessTable(text).get(100);
    expect(info?.argv[1]).toBe("C:\\tools\\runner.js");
    expect(info !== undefined && isClaudeCommand(info.argv)).toBe(false);
  });

  it("walks the parsed table in memory to the Claude Code process", () => {
    const text = JSON.stringify([
      row(300, 200, "node.exe", "node hook.js"),
      row(200, 100, "sh.exe", "sh -c node hook.js"),
      row(100, 1, "node.exe", "node C:\\x\\@anthropic-ai\\claude-code\\cli.js"),
    ]);
    const table = parseWindowsProcessTable(text);
    expect(findHostProcess((pid) => table.get(pid) ?? null, 300)).toEqual({
      pid: 100,
      startedAt: 1000,
    });
  });

  it("accepts a single row not wrapped in an array, and no rows at all", () => {
    const single = parseWindowsProcessTable(
      JSON.stringify(row(7, 1, "claude.exe", "claude.exe")),
    );
    expect(single.get(7)?.argv[0]).toBe("claude.exe");
    expect(parseWindowsProcessTable("").size).toBe(0);
    expect(parseWindowsProcessTable("not json").size).toBe(0);
  });
});

describe("parseWindowsStartTimes", () => {
  it("reads the batch query's rows, skipping junk", () => {
    const text = JSON.stringify([
      { ProcessId: 4321, StartedAt: 111 },
      { ProcessId: 5555, StartedAt: 222 },
      { ProcessId: "junk", StartedAt: 333 },
    ]);
    expect(parseWindowsStartTimes(text)).toEqual(
      new Map([
        [4321, 111],
        [5555, 222],
      ]),
    );
    expect(
      parseWindowsStartTimes(JSON.stringify({ ProcessId: 1, StartedAt: 9 })),
    ).toEqual(new Map([[1, 9]]));
    expect(parseWindowsStartTimes("").size).toBe(0);
  });
});

describe("sameProcessStart", () => {
  it("holds within the boot time's noise and breaks past it", () => {
    expect(sameProcessStart(1_000_000, 1_000_000)).toBe(true);
    expect(sameProcessStart(1_000_000, 1_001_000)).toBe(true);
    expect(sameProcessStart(1_000_000, 1_002_000)).toBe(true);
    expect(sameProcessStart(1_000_000, 1_030_000)).toBe(false);
    expect(sameProcessStart(1_030_000, 1_000_000)).toBe(false);
  });
});

describe("the Windows start-time expression", () => {
  it("calls the method: read as a property it yields null", () => {
    expect(WINDOWS_STARTED_AT_PROPERTY).toContain(").ToUnixTimeMilliseconds()");
    expect(WINDOWS_STARTED_AT_PROPERTY).not.toContain("ExpandProperty");
  });

  const pwsh = spawnSync("pwsh", ["--version"], { encoding: "utf8" });
  it.skipIf(pwsh.status !== 0)(
    "run through pwsh, gives the parser a real start time",
    () => {
      // A stand-in row in the shape Win32_Process returns,
      // carried through the shipped expression itself, so the
      // parser's input is what PowerShell really emits.
      const script =
        `$row = [pscustomobject]@{ ProcessId = 4242; ParentProcessId = 1;` +
        ` CreationDate = [DateTime]::new(2024, 5, 6, 7, 8, 9, [DateTimeKind]::Utc);` +
        ` Name = 'claude.exe'; CommandLine = 'claude.exe' };` +
        ` $row | Select-Object ProcessId,ParentProcessId,${WINDOWS_STARTED_AT_PROPERTY},Name,CommandLine` +
        ` | ConvertTo-Json -Compress`;
      const run = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(run.status).toBe(0);
      const table = parseWindowsProcessTable(run.stdout);
      expect(table.get(4242)?.startedAt).toBe(Date.UTC(2024, 4, 6, 7, 8, 9));
    },
    // Starting PowerShell on a hosted runner can outlast the default 5 s.
    onHostedRunner ? 20_000 : 5_000,
  );
});

describe("parseProcStat", () => {
  it("reads the parent id and the start time in ticks", () => {
    // Fields after the parenthesised name: state, then the
    // parent id, then seventeen more fields before the start
    // time — a name holding spaces and a parenthesis included,
    // as a real command name can.
    const middle = Array.from({ length: 17 }, () => "0").join(" ");
    const text = `4321 (claude (worker)) S 100 ${middle} 123450 0 0 0`;
    // Boot at 1_000 s, 123450 ticks at 100 ticks a second.
    expect(parseProcStat(text, 1000)).toEqual({
      parentPid: 100,
      startedAt: 1000 * 1000 + 1234_500,
    });
  });

  it("rejects a line with no closing parenthesis", () => {
    expect(parseProcStat("4321 claude S 100", 1000)).toBeNull();
  });
});

describe("the running process, read live", () => {
  it.skipIf(process.platform !== "linux")(
    "reads this process and its parent from /proc",
    () => {
      const info = readProcessLinux(process.pid);
      expect(info?.pid).toBe(process.pid);
      expect(info?.parentPid).toBe(process.ppid);
      expect(info?.startedAt).toBeGreaterThan(0);
      expect(readProcessLinux(0)).toBeNull();
    },
  );

  it("knows this process exists and a nonsense id does not", () => {
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(99_999_999)).toBe(false);
  });
});

describe("the ancestor walk over real processes", () => {
  /** Run a real chain — a node named `topName` runs a shell
   * that runs the probe — and return the probe's walk result
   * and the top process's id. The probe is plain script
   * importing the built reader, as the hook runs it. */
  function runChain(topName: string): {
    host: { pid: number; startedAt: number } | null;
    topPid: number;
  } {
    const root = makeTempRoot("flightpath-walk-");
    symlinkSync(process.execPath, join(root, topName));
    const probe = join(root, "probe.mjs");
    const reader = pathToFileURL(join(distDir, "util/host-process.js")).href;
    writeFileSync(
      probe,
      `import { findHostProcess, readProcessLinux } from "${reader}";\n` +
        `console.log(JSON.stringify(findHostProcess(readProcessLinux, process.ppid)));\n`,
    );
    const top = join(root, "top.mjs");
    writeFileSync(
      top,
      `import { spawnSync } from "node:child_process";\n` +
        `console.log(JSON.stringify({ topPid: process.pid }));\n` +
        `spawnSync("sh", ["-c", "node \\"$1\\"", "walk", process.argv[2]], { stdio: "inherit" });\n`,
    );
    const run = spawnSync(join(root, topName), [top, probe], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n");
    const head = JSON.parse(lines[0] ?? "{}") as { topPid?: number };
    const host = JSON.parse(lines[lines.length - 1] ?? "null") as {
      pid: number;
      startedAt: number;
    } | null;
    if (head.topPid === undefined) {
      throw new Error("the chain's top process did not report its id");
    }
    return { host, topPid: head.topPid };
  }

  it.skipIf(process.platform !== "linux")(
    "finds the claude process above the shell above the probe",
    () => {
      const { host, topPid } = runChain("claude");
      expect(host?.pid).toBe(topPid);
      expect(Math.abs((host?.startedAt ?? 0) - Date.now())).toBeLessThan(
        60_000,
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "finds nothing when no ancestor is claude",
    () => {
      expect(runChain("plainnode").host).toBeNull();
    },
  );
});
