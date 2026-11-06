import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pauseFileName } from "../src/data-dir.js";
import { runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  distPath,
  envForDataRoot,
  freePort,
  type StartedDaemon,
} from "./support/daemon.js";
import { stopEvent } from "./support/events.js";
import { LINE_WORLD, startLineDaemon } from "./support/line-world.js";
import {
  runDistAsync,
  scratchHome,
  type DistResult,
} from "./support/process.js";
import { writeSettings } from "./support/settings.js";
import {
  startClosingServer,
  startRecordingServer,
  startSlowServer,
  writeDaemonFiles,
  type Received,
  type StubServer,
} from "./support/stub-daemon.js";

// Integration tests for the end-of-turn hook (dist/line.js), run as a
// child process the way Claude Code runs it. The answer that matters
// comes from a real daemon over a seeded store; stub servers stand in
// only for the failure shapes and to count the requests the hook makes.

const distLine = distPath("line.js");

afterEach(async () => {
  await runCleanups();
});

const { mixed, several, outsideTurn } = LINE_WORLD;

function runLine(
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown>,
): Promise<DistResult> {
  return runDistAsync(distLine, JSON.stringify(event), env);
}

function expectSilent(result: DistResult): void {
  expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
}

describe("the end-of-turn hook against a daemon", () => {
  async function stopAt(
    daemon: StartedDaemon,
    sessionId: string,
    promptId: string,
  ): Promise<DistResult> {
    return runLine(envForDataRoot(daemon.root), stopEvent(sessionId, promptId));
  }

  it("prints the line for a turn with a finding worth fixing, and nothing else", async () => {
    const daemon = await startLineDaemon();
    const result = await stopAt(daemon, mixed.id, mixed.fixPrompt);
    const line =
      "● flightpath has 1 suggestion worth fixing from this turn · /flightpath:open to see it";
    expect(result).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ systemMessage: line })}\n`,
      stderr: "",
    });
  });

  it("prints the line for a turn with a finding worth a look, and for several", async () => {
    const daemon = await startLineDaemon();
    const look = await stopAt(daemon, mixed.id, mixed.lookPrompt);
    expect(look.stdout).toContain("1 suggestion worth a look from this turn");
    const many = await stopAt(daemon, several.id, several.prompt);
    expect(many.stdout).toContain(
      "2 suggestions from this turn, 1 worth fixing",
    );
  });

  it("prints a systemMessage and no other field", async () => {
    const daemon = await startLineDaemon();
    const result = await stopAt(daemon, mixed.id, mixed.fixPrompt);
    expect(Object.keys(JSON.parse(result.stdout) as object)).toEqual([
      "systemMessage",
    ]);
  });

  it("points to /flightpath:open and carries no address, port or token", async () => {
    const daemon = await startLineDaemon();
    const { stdout } = await stopAt(daemon, mixed.id, mixed.fixPrompt);
    expect(stdout).toContain("/flightpath:open");
    for (const forbidden of [
      "http",
      "127.0.0.1",
      "localhost",
      daemon.token,
      String(daemon.port),
    ]) {
      expect(stdout).not.toContain(forbidden);
    }
  });

  it.each([
    [
      "a turn with no finding, in a session with findings elsewhere",
      mixed.id,
      mixed.cleanPrompt,
    ],
    ["a prompt the session has no turn for", mixed.id, "prompt-unknown"],
    [
      "a finding on a request outside any turn",
      outsideTurn.id,
      outsideTurn.prompt,
    ],
    ["a session the daemon does not know", "sess-nope", mixed.fixPrompt],
  ])("prints nothing for %s", async (_name, sessionId, promptId) => {
    const daemon = await startLineDaemon();
    expectSilent(await stopAt(daemon, sessionId, promptId));
  });

  it("prints nothing once the finding is dismissed", async () => {
    const daemon = await startLineDaemon();
    expect((await stopAt(daemon, mixed.id, mixed.fixPrompt)).stdout).not.toBe(
      "",
    );
    const dismissed = await callDaemon(daemon.port, {
      method: "POST",
      path: `/api/sessions/${mixed.id}/findings/${mixed.fixFinding}/dismiss`,
      token: daemon.token,
    });
    expect(dismissed.status).toBe(200);
    expectSilent(await stopAt(daemon, mixed.id, mixed.fixPrompt));
  });
});

describe("the end-of-turn hook when the session is not to be told", () => {
  const LINE = '{"line":"a line"}';

  async function arrange(): Promise<{
    env: NodeJS.ProcessEnv;
    dataDir: string;
    daemon: StubServer & { received: Received[] };
  }> {
    const daemon = await startRecordingServer(200, LINE);
    const { env, dataDir } = scratchHome("flightpath-line-");
    writeDaemonFiles(dataDir, daemon.port);
    return { env, dataDir, daemon };
  }

  const stop = stopEvent("sess-1", "prompt-1");

  it("asks the daemon for the ended turn and prints what it answers", async () => {
    const { env, daemon } = await arrange();
    const result = await runLine(env, stop);
    expect(result.stdout).toBe(
      `${JSON.stringify({ systemMessage: "a line" })}\n`,
    );
    expect(daemon.received).toEqual([
      {
        method: "GET",
        url: "/api/sessions/sess-1/terminal-line?prompt=prompt-1",
        token: "test-token",
        body: "",
      },
    ]);
  });

  const blocks: [string, (dataDir: string) => void, Record<string, unknown>][] =
    [
      [
        "the off flag",
        (dataDir) => writeFileSync(join(dataDir, "off"), ""),
        stop,
      ],
      [
        "a paused session",
        (dataDir) => {
          mkdirSync(join(dataDir, "pause"), { recursive: true });
          writeFileSync(join(dataDir, "pause", pauseFileName("sess-1")), "");
        },
        stop,
      ],
      [
        "the setting turned off",
        (dataDir) => writeSettings(dataDir, { terminalLine: false }),
        stop,
      ],
      [
        "an excluded folder",
        (dataDir) =>
          writeSettings(dataDir, { excludedFolders: ["/work/never"] }),
        { ...stop, cwd: "/work/never/app" },
      ],
      [
        "an excluded Windows folder, in another case and with a trailing separator",
        (dataDir) =>
          writeSettings(dataDir, { excludedFolders: ["C:\\work\\harbor"] }),
        { ...stop, cwd: "c:\\WORK\\Harbor\\sub\\" },
      ],
    ];

  it.each(blocks)(
    "prints nothing and asks nothing for %s",
    async (_name, arrangeBlock, event) => {
      const { env, dataDir, daemon } = await arrange();
      arrangeBlock(dataDir);
      expectSilent(await runLine(env, event));
      expect(daemon.received).toEqual([]);
    },
  );

  it("asks about a folder that only shares an excluded folder's prefix", async () => {
    const { env, dataDir, daemon } = await arrange();
    writeSettings(dataDir, { excludedFolders: ["C:\\work\\harbor"] });
    await runLine(env, { ...stop, cwd: "C:\\work\\harbor2" });
    expect(daemon.received).toHaveLength(1);
  });

  const unusable: [string, Record<string, unknown>][] = [
    [
      "an event that is not a Stop",
      { ...stop, hook_event_name: "SubagentStop" },
    ],
    ["a Stop with no prompt id", { ...stop, prompt_id: undefined }],
    ["a Stop with an empty prompt id", { ...stop, prompt_id: "" }],
    ["a Stop with no session id", { ...stop, session_id: undefined }],
  ];

  it.each(unusable)(
    "prints nothing and asks nothing for %s",
    async (_name, event) => {
      const { env, daemon } = await arrange();
      expectSilent(await runLine(env, event));
      expect(daemon.received).toEqual([]);
    },
  );

  it.each([
    ["nothing", ""],
    ["text that is not JSON", "not json"],
    ["a JSON list", "[]"],
  ])(
    "prints nothing and asks nothing when stdin holds %s",
    async (_name, input) => {
      const { env, daemon } = await arrange();
      expectSilent(await runDistAsync(distLine, input, env));
      expect(daemon.received).toEqual([]);
    },
  );

  it("never sends, prints or logs Claude's last message", async () => {
    const { env, dataDir, daemon } = await arrange();
    const marker = "MARKER-LAST-MESSAGE-5d1c";
    const result = await runLine(env, {
      ...stop,
      last_assistant_message: marker,
    });
    expect(JSON.stringify(daemon.received)).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(() =>
      readFileSync(join(dataDir, "logs", "hook-errors.log")),
    ).toThrow();
  });
});

describe("the end-of-turn hook when the daemon cannot answer", () => {
  const LINE = '{"line":"a line"}';

  async function runAgainst(server: StubServer): Promise<DistResult> {
    const { env, dataDir } = scratchHome("flightpath-line-");
    writeDaemonFiles(dataDir, server.port);
    return runLine(env, stopEvent("sess-1", "prompt-1"));
  }

  const answers: [string, number, string][] = [
    ["a 401", 401, LINE],
    ["a 404", 404, LINE],
    ["a 500", 500, LINE],
    ["an empty body", 200, ""],
    ["a body that is not JSON", 200, "not json"],
    ["a line that is not text", 200, '{"line":5}'],
    ["a null line", 200, '{"line":null}'],
  ];

  it.each(answers)("prints nothing for %s", async (_name, status, body) => {
    expectSilent(await runAgainst(await startRecordingServer(status, body)));
  });

  it("prints nothing when the daemon closes the connection", async () => {
    expectSilent(await runAgainst(await startClosingServer()));
  });

  it("prints nothing when no daemon listens on the port file's port", async () => {
    expectSilent(await runAgainst({ port: await freePort(), close: () => {} }));
  });

  it("prints nothing when there is no port file", async () => {
    const { env } = scratchHome("flightpath-line-");
    expectSilent(await runLine(env, stopEvent("sess-1", "prompt-1")));
  });

  it("prints the line of a daemon that answers a little late, inside the wait", async () => {
    const server = await startSlowServer(200, LINE, 60);
    expect((await runAgainst(server)).stdout).toBe(
      `${JSON.stringify({ systemMessage: "a line" })}\n`,
    );
  });

  it("stops waiting for a daemon that is slow to answer", async () => {
    const server = await startSlowServer(200, LINE, 5_000);
    const started = performance.now();
    expectSilent(await runAgainst(server));
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});

describe("the end-of-turn hook's bundle", () => {
  it("holds no database, no HTTP stack and no redaction", () => {
    const bundle = readFileSync(distLine, "utf8");
    expect(bundle).not.toMatch(/node:sqlite|node:http["']|redact/i);
  });
});
