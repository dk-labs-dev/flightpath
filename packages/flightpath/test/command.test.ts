import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import {
  distPath,
  fakeDaemon,
  readPort,
  stopSleeper,
} from "./support/daemon.js";
import {
  expandedCommandPrompt,
  expansion,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";
import { fakeOpener, platformOpenerCall } from "./support/opener.js";
import { runDist, runDistJson, scratchHome } from "./support/process.js";
import { firstRow, requiredValue } from "./support/rows.js";
import { seedRequest, seedSession, seedTurn } from "./support/seed.js";
import { writeSettings } from "./support/settings.js";
import { queryRows } from "./support/storage.js";

import { ingestEnvelope, type Envelope } from "../src/daemon/ingest.js";
import { loadSettings, saveSettings } from "../src/settings/index.js";
import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";

// Integration tests for the command hook (dist/command.js), run
// as a child process the way Claude Code runs it, plus the
// recording hook's session-start behaviour. The startup notice
// has its own entry and its own test file (notice.test.ts).

const distCommand = distPath("command.js");
const distSubmitCommand = distPath("submit-command.js");
const distHook = distPath("hook.js");

// The body of every command file (commands/*.md): the test
// below pins all six files to this text, word for word.
const COMMAND_FALLBACK_TEXT =
  "Flightpath commands are handled locally, before expansion, and never reach the model. If this text is in front of you, the local handler did not run.";

describe("the command files", () => {
  it("each carries the one fallback text", () => {
    for (const action of ["status", "stop", "start", "off", "forget", "open"]) {
      const file = readFileSync(
        new URL(`../commands/${action}.md`, import.meta.url),
        "utf8",
      );
      const body = file.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      expect(body).toBe(COMMAND_FALLBACK_TEXT);
    }
  });
});

afterEach(async () => {
  await runCleanups();
});

function runCommand(
  env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
): { status: number | null; stdout: string } {
  // Each event reaches the entry hooks.json registers for it.
  const entry =
    payload.hook_event_name === "UserPromptSubmit"
      ? distSubmitCommand
      : distCommand;
  const result = spawnSync(process.execPath, [entry], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

function blockedReason(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    decision: string;
    reason: string;
  };
  expect(parsed.decision).toBe("block");
  return parsed.reason;
}

/** Run flightpath:start; the session must record again. */
function expectStartResumes(env: NodeJS.ProcessEnv, dataDir: string): void {
  const started = runCommand(env, expansion("s1", "flightpath:start"));
  expect(blockedReason(started.stdout)).toContain("recording on");
  expect(existsSync(join(dataDir, "pause", "s1"))).toBe(false);
}

describe("the command hook", () => {
  it("does nothing at all for any other command", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { status, stdout } = runCommand(env, expansion("s1", "commit"));
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does nothing for the bare command name", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { status, stdout } = runCommand(env, expansion("s1", "flightpath"));
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("answers /flightpath:status and blocks the expansion", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { status, stdout } = runCommand(
      env,
      expansion("s1", "flightpath:status"),
    );
    expect(status).toBe(0);
    const reason = blockedReason(stdout);
    expect(reason).toContain("flightpath is recording");
    expect(reason).toContain("daemon: not running");
    expect(reason).toContain(`data folder: ${dataDir}`);
    expect(reason).toContain("overhead in this session: 0 tokens");
    expect(reason).toContain(
      "settings: run /flightpath:start to open the settings screen",
    );
    expect(reason).toContain(
      "live view: /flightpath:open opens it in the browser",
    );
  });

  it("reports only the marked turn's requests as the overhead", () => {
    const { env, dataDir } = scratchHome("flightpath-command-");
    const storage = openStorage({ dataDir });
    const db = new DatabaseSync(storage.dbPath);
    try {
      const at = 1_700_000_000_000;
      seedSession(db, {
        id: "s1",
        projectPath: "/work/app",
        firstSeenAt: at,
        lastSeenAt: at + 600_000,
      });
      // A turn marked as Flightpath's own: its requests are
      // the overhead.
      seedTurn(db, {
        id: 1,
        sessionId: "s1",
        sequence: 1,
        startedAt: at,
        endedAt: at + 60_000,
        promptText: "/flightpath:status",
        flightpathCommand: true,
      });
      seedTurn(db, {
        id: 2,
        sessionId: "s1",
        sequence: 2,
        startedAt: at + 120_000,
        endedAt: at + 300_000,
        promptText: "Fix the bug",
      });
      // The marked turn's requests: 5,500 + 250 = 5,750. The
      // normal turn's 77,777 is the user's work, not overhead.
      seedRequest(db, {
        id: 1,
        sessionId: "s1",
        turnId: 1,
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 5_000,
        cacheWrite5mTokens: 100,
        cacheWrite1hTokens: 60,
        startedAt: at + 1_000,
      });
      seedRequest(db, {
        id: 2,
        sessionId: "s1",
        turnId: 1,
        inputTokens: 200,
        outputTokens: 50,
        startedAt: at + 2_000,
      });
      seedRequest(db, {
        id: 3,
        sessionId: "s1",
        turnId: 2,
        inputTokens: 7_000,
        outputTokens: 777,
        cacheReadTokens: 70_000,
        startedAt: at + 130_000,
      });
    } finally {
      db.close();
      storage.close();
    }
    const { status, stdout } = runCommand(
      env,
      expansion("s1", "flightpath:status"),
    );
    expect(status).toBe(0);
    expect(blockedReason(stdout)).toContain(
      "overhead in this session: 5750 tokens",
    );
  });

  it("reports the retention period and the database size in the status", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const storage = openStorage({ dataDir });
    storage.close();
    saveSettings(dataDir, { ...loadSettings(dataDir), retentionDays: 30 });
    const { stdout } = runCommand(env, expansion("s1", "flightpath:status"));
    const reason = blockedReason(stdout);
    expect(reason).toContain("recordings kept for: 30 days");
    expect(reason).toMatch(/database size: [1-9]\d* KB/);
  });

  it("takes the action from the command name and ignores arguments", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { stdout } = runCommand(
      env,
      expansion("s1", "flightpath:status", "dance"),
    );
    expect(blockedReason(stdout)).toContain("flightpath is recording");
    const stopped = runCommand(
      env,
      expansion("s1", "flightpath:stop", "right now please"),
    );
    expect(blockedReason(stopped.stdout)).toContain("paused");
    expect(existsSync(join(dataDir, "pause", "s1"))).toBe(true);
  });

  it("shows the settings link in the status while the daemon is running", async () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    // A live daemon, as the off test models it: a real process
    // whose pid the lock names. Port and token files alone are a
    // daemon that ran once and stopped, and its link is dead.
    const sleeper = fakeDaemon(dataDir);
    const { stdout } = runCommand(env, expansion("s1", "flightpath:status"));
    expect(blockedReason(stdout)).toContain(
      "settings: http://127.0.0.1:4799/#settings&token=test-token",
    );
    await stopSleeper(sleeper);
  });

  it("points at /flightpath:start in the status when the daemon is down", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    mkdirSync(dataDir, { recursive: true });
    // The daemon ran once — its port and token files remain —
    // but nothing holds the lock, so the link would not open.
    writeFileSync(join(dataDir, "port"), "4799");
    writeFileSync(join(dataDir, "token"), "test-token");
    const { stdout } = runCommand(env, expansion("s1", "flightpath:status"));
    const reason = blockedReason(stdout);
    expect(reason).toContain(
      "settings: run /flightpath:start to open the settings screen",
    );
    expect(reason).not.toContain("127.0.0.1:4799");
  });

  it("records a pause on stop and closes it on start", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const stopped = runCommand(env, expansion("s1", "flightpath:stop"));
    expect(blockedReason(stopped.stdout)).toContain("paused");
    expect(existsSync(join(dataDir, "pause", "s1"))).toBe(true);

    expectStartResumes(env, dataDir);

    const pause = firstRow(
      queryRows(join(dataDir, "flightpath.db"), "SELECT * FROM pauses"),
      "the pause",
    ) as { paused_at: number; resumed_at: number | null };
    expect(pause.resumed_at).not.toBeNull();
    expect(
      requiredValue(pause.resumed_at, "the pause's resumed_at"),
    ).toBeGreaterThanOrEqual(pause.paused_at);
  });

  it("drops the events between stop and start", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      // This test walks pause and resume, not idling: its
      // daemon must not idle out between hooks, or the third
      // event buffers behind the start lock and never lands.
      idleMs: "600000",
      stopDaemon: true,
    });
    const promptEvent = (prompt: string): Record<string, unknown> => ({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/work/app",
      prompt,
    });
    const storedPrompts = (): string[] => {
      const dbPath = join(dataDir, "flightpath.db");
      if (!existsSync(dbPath)) return [];
      try {
        const rows = queryRows(
          dbPath,
          "SELECT body FROM raw_events ORDER BY received_at",
        ) as { body: string }[];
        return rows.map(
          (row) =>
            (JSON.parse(row.body) as { event: { prompt: string } }).event
              .prompt,
        );
      } catch (err) {
        // The file exists before the daemon has created its
        // tables: that is "no rows yet", and the deadline loop
        // below keeps waiting for them.
        if (err instanceof Error && err.message.includes("no such table")) {
          return [];
        }
        throw err;
      }
    };
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const waitForPrompts = (expected: string[]): void => {
      // A give-up time, not a bound: the loop is synchronous and fails on content first.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const found = storedPrompts();
        if (JSON.stringify(found) === JSON.stringify(expected)) return;
        Atomics.wait(nap, 0, 0, 50);
      }
      expect(storedPrompts()).toEqual(expected);
    };

    expect(runDistJson(distHook, promptEvent("first"), env).status).toBe(0);
    waitForPrompts(["first"]);

    runCommand(env, expansion("s1", "flightpath:stop"));
    expect(runDistJson(distHook, promptEvent("second"), env).status).toBe(0);
    // The paused event is dropped by the hook itself, synchronously:
    // nothing is stored and nothing is waiting in the buffer.
    expect(storedPrompts()).toEqual(["first"]);

    runCommand(env, expansion("s1", "flightpath:start"));
    expect(runDistJson(distHook, promptEvent("third"), env).status).toBe(0);
    waitForPrompts(["first", "third"]);
  }, 120_000);

  it("off stops the daemon; status only reports it; start turns recording back on", async () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const sleeper = fakeDaemon(dataDir);

    const off = runCommand(env, expansion("s1", "flightpath:off"));
    expect(blockedReason(off.stdout)).toContain("off in all sessions");
    expect(existsSync(join(dataDir, "off"))).toBe(true);
    await expect(
      new Promise((resolvePromise) =>
        sleeper.once("exit", () => resolvePromise("exited")),
      ),
    ).resolves.toBe("exited");

    // Status reports the off state and changes nothing.
    const status = runCommand(env, expansion("s1", "flightpath:status"));
    expect(blockedReason(status.stdout)).toContain("off in all sessions");
    expect(existsSync(join(dataDir, "off"))).toBe(true);

    const on = runCommand(env, expansion("s1", "flightpath:start"));
    expect(blockedReason(on.stdout)).toContain("recording on");
    expect(existsSync(join(dataDir, "off"))).toBe(false);
  });

  it("forget deletes the session's recording and pauses it", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const storage = openStorage({ dataDir });
    const envelope: Envelope = {
      id: "command-test-1",
      received_at: Date.now(),
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "SessionStart",
        session_id: "s1",
        source: "startup",
        cwd: "/work/app",
      },
    };
    expect(ingestEnvelope(storage, envelope)).toBe("stored");
    expect(storage.countRawEvents()).toBe(1);
    storage.close();

    const forgotten = runCommand(env, expansion("s1", "flightpath:forget"));
    expect(blockedReason(forgotten.stdout)).toContain("deleted");

    const after = openStorage({ dataDir });
    expect(after.countRawEvents()).toBe(0);
    expect(after.isForgotten("s1")).toBe(true);
    after.close();
    expect(existsSync(join(dataDir, "pause", "s1"))).toBe(true);
  });

  // The second is how a command typed while Claude is working
  // arrives: already expanded, with no expansion after it.
  it.each([
    [
      "an expansion",
      expansion("s1", "flightpath:open", "please open the pod bay doors"),
    ],
    [
      "an already expanded prompt",
      userPromptEvent("s1", expandedCommandPrompt("flightpath:open")),
    ],
  ])(
    "opens the live view with the platform opener for %s, and nothing from the prompt reaches it",
    async (_route, payload) => {
      const { env, dataDir } = scratchHome("flightpath-command-", {
        idleMs: "1200",
        stopDaemon: true,
      });
      const sleeper = fakeDaemon(dataDir);
      const { openEnv, calls } = fakeOpener(env);
      openEnv.DISPLAY = ":0";
      const { status, stdout } = runCommand(openEnv, payload);
      expect(status).toBe(0);
      const url = "http://127.0.0.1:4799/#session/s1&token=test-token";
      expect(blockedReason(stdout)).toBe(
        `flightpath: opened the live view · ${url}`,
      );
      // The opener received the address alone: the command's
      // arguments are nowhere in what it was given.
      expect(calls()).toEqual([platformOpenerCall(url)]);
      await stopSleeper(sleeper);
    },
  );

  it("does not load the command handler for a prompt that is not a command", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    // The entry alone, with no handler beside it: a plain prompt
    // never reaches for one, and a command that needs it fails.
    const alone = join(makeTempRoot("flightpath-submit-entry-"), "entry.mjs");
    copyFileSync(distSubmitCommand, alone);
    const plain = runDist(
      alone,
      JSON.stringify(userPromptEvent("s1", "please open the live view")),
      env,
    );
    expect(plain).toMatchObject({ status: 0, stdout: "", stderr: "" });
    const command = runDist(
      alone,
      JSON.stringify(
        userPromptEvent("s1", expandedCommandPrompt("flightpath:status")),
      ),
      env,
    );
    expect(command.status).not.toBe(0);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("leaves the plain /flightpath:open prompt to the expansion that follows it", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { status, stdout } = runCommand(
      env,
      userPromptEvent("s1", "/flightpath:open"),
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("leaves an expanded command that is not Flightpath's alone", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { stdout } = runCommand(
      env,
      userPromptEvent("s1", expandedCommandPrompt("review")),
    );
    expect(stdout).toBe("");
    expect(existsSync(dataDir)).toBe(false);
  });

  // Only Linux can lack a display; the other platforms always have one.
  it.skipIf(process.platform !== "linux")(
    "prints the link for /flightpath:open when there is no display",
    async () => {
      const { env, dataDir } = scratchHome("flightpath-command-", {
        idleMs: "1200",
        stopDaemon: true,
      });
      const sleeper = fakeDaemon(dataDir);
      const { openEnv, calls } = fakeOpener(env);
      delete openEnv.DISPLAY;
      delete openEnv.WAYLAND_DISPLAY;
      const { stdout } = runCommand(
        openEnv,
        expansion("s1", "flightpath:open"),
      );
      expect(blockedReason(stdout)).toBe(
        "flightpath: open this link to see the live view · " +
          "http://127.0.0.1:4799/#session/s1&token=test-token",
      );
      expect(calls()).toEqual([]);
      await stopSleeper(sleeper);
    },
  );

  it("prints the link for /flightpath:open when the opener is missing", async () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const sleeper = fakeDaemon(dataDir);
    const { openEnv } = fakeOpener(env, { missing: true });
    openEnv.DISPLAY = ":0";
    const { stdout } = runCommand(openEnv, expansion("s1", "flightpath:open"));
    expect(blockedReason(stdout)).toBe(
      "flightpath: open this link to see the live view · " +
        "http://127.0.0.1:4799/#session/s1&token=test-token",
    );
    await stopSleeper(sleeper);
  });

  it("returns at once while the opener is still running", async () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const sleeper = fakeDaemon(dataDir);
    const { openEnv } = fakeOpener(env, { runsMs: 5000 });
    openEnv.DISPLAY = ":0";
    const startedAt = Date.now();
    const { stdout } = runCommand(openEnv, expansion("s1", "flightpath:open"));
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(blockedReason(stdout)).toContain("opened the live view");
    await stopSleeper(sleeper);
  });

  it("starts the daemon and opens the view within three seconds when none is running", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { openEnv, calls } = fakeOpener(env);
    openEnv.DISPLAY = ":0";
    const startedAt = Date.now();
    const { status, stdout } = runCommand(
      openEnv,
      expansion("s1", "flightpath:open"),
    );
    expect(status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    const matched = requiredValue(
      /^flightpath: opened the live view · (http:\/\/127\.0\.0\.1:(\d+)\/#session\/s1&token=[0-9a-f]+)$/.exec(
        blockedReason(stdout),
      ),
      "the opened address line",
    );
    const url = requiredValue(matched[1], "the opened address");
    // The address names the port the daemon published, and the
    // opener was spawned with that address alone.
    expect(readPort(dataDir)).toBe(Number(matched[2]));
    expect(calls()).toEqual([platformOpenerCall(url)]);
  });
});

describe("the recording hook at session start", () => {
  function autostartOff(dataDir: string): void {
    writeSettings(dataDir, { autostart: false });
  }

  it("prints nothing: the notice hook shows the notice", () => {
    const { env } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const startup = runDistJson(distHook, sessionStartEvent("startup"), env);
    expect(startup.status).toBe(0);
    expect(startup.stdout).toBe("");
    const clear = runDistJson(distHook, sessionStartEvent("clear"), env);
    expect(clear.status).toBe(0);
    expect(clear.stdout).toBe("");
  });

  it("starts the session paused, silently, when autostart is off", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    autostartOff(dataDir);
    const hookResult = runDistJson(distHook, sessionStartEvent("startup"), env);
    expect(hookResult.status).toBe(0);
    expect(hookResult.stdout).toBe("");
    expect(existsSync(join(dataDir, "pause", "s1"))).toBe(true);
    expect(existsSync(join(dataDir, "pause", "s1.auto"))).toBe(true);
    // The start itself was not recorded: nothing was buffered.
    expect(existsSync(join(dataDir, "buffer"))).toBe(false);
  });

  it("status reports an autostart pause without lifting it; start lifts it", () => {
    const { env, dataDir } = scratchHome("flightpath-command-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    autostartOff(dataDir);
    expect(
      runDistJson(distHook, sessionStartEvent("startup"), env).status,
    ).toBe(0);
    const status = runCommand(env, expansion("s1", "flightpath:status"));
    expect(blockedReason(status.stdout)).toContain(
      "flightpath is paused for this session",
    );
    expect(existsSync(join(dataDir, "pause", "s1"))).toBe(true);
    expect(existsSync(join(dataDir, "pause", "s1.auto"))).toBe(true);

    expectStartResumes(env, dataDir);
    expect(existsSync(join(dataDir, "pause", "s1.auto"))).toBe(false);
  });
});

describe("the hooks.json matchers", () => {
  // Claude Code's documented rule (the hooks reference,
  // "Matcher patterns"): a matcher made only of letters,
  // digits, "_", "-", spaces, "," and "|" is an exact string —
  // or an exact list when it contains "|" — and any other
  // character makes it an unanchored regular expression. A
  // plain "flightpath" matcher is therefore exact, and never
  // fires for "flightpath:status": the registration has to
  // carry the anchored pattern itself. Every other test here
  // calls the handler directly, so this is the only check of
  // the registration the handler depends on.
  const hooksConfig = JSON.parse(
    readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
  ) as {
    hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]>;
  };

  function matcherFires(matcher: string, name: string): boolean {
    if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
      return matcher.split("|").includes(name);
    }
    return new RegExp(matcher).test(name);
  }

  function matcherFor(event: string, script: string): string {
    const entry = (hooksConfig.hooks[event] ?? []).find((candidate) =>
      candidate.hooks.some((hook) => hook.command.includes(script)),
    );
    expect(entry, `${event} -> ${script}`).toBeDefined();
    return requiredValue(entry, `${event} -> ${script}`).matcher;
  }

  it("the command matcher fires for the six commands, and nothing else", () => {
    const matcher = matcherFor("UserPromptExpansion", "command.js");
    for (const name of ["status", "stop", "start", "off", "forget", "open"]) {
      expect(matcherFires(matcher, `flightpath:${name}`), name).toBe(true);
      expect(matcherFires(matcher, `/flightpath:${name}`), name).toBe(true);
    }
    for (const name of [
      "flightpath",
      "flightpath:flightpath",
      "x:status",
      "flightpath:statusx",
      "other:flightpath:status",
    ]) {
      expect(matcherFires(matcher, name), name).toBe(false);
    }
  });

  it("registers the command entries for the submitted prompt and the expansion", () => {
    expect(matcherFor("UserPromptExpansion", "dist/command.js")).toBeTruthy();
    expect(
      matcherFor("UserPromptSubmit", "dist/submit-command.js"),
    ).toBeTruthy();
  });

  it("the startup notice matcher is the exact list it reads as", () => {
    const matcher = matcherFor("SessionStart", "notice.js");
    for (const source of ["startup", "clear", "fork"]) {
      expect(matcherFires(matcher, source), source).toBe(true);
    }
    for (const source of ["resume", "compact", "startupx"]) {
      expect(matcherFires(matcher, source), source).toBe(false);
    }
  });

  it("keeps the six commands out of the model's hands", () => {
    for (const name of ["status", "stop", "start", "off", "forget", "open"]) {
      const text = readFileSync(
        new URL(`../commands/${name}.md`, import.meta.url),
        "utf8",
      );
      expect(text, name).toContain("disable-model-invocation: true");
    }
  });
});
