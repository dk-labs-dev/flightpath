import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startLockPath } from "../src/daemon/lock.js";
import {
  defaultSettings,
  isExcludedFolder,
  loadSettings,
  saveSettings,
  settingsScreenUrl,
  validateSettingsInput,
} from "../src/settings/index.js";
import { runCleanups } from "./support/cleanup.js";
import {
  DAEMON_SUITE,
  callDaemon,
  callDaemonJson,
  dataDirFor,
  distPath,
  envForDataRoot,
  freePort,
  listenOnFreePort,
  makeRoot,
  readPort,
  startTestDaemon,
  waitFor,
} from "./support/daemon.js";
import {
  expandedCommandPrompt,
  sequencedHookEnvelope,
  userPromptEvent,
} from "./support/events.js";
import { runDist } from "./support/process.js";
import { firstRow } from "./support/rows.js";
import { writeSettings } from "./support/settings.js";

// Settings: the module on its own, then the built daemon's
// endpoints and page, then the hook's two uses of them.
const distHook = distPath("hook.js");

afterEach(async () => {
  await runCleanups();
});

describe("settings module", () => {
  it("reads every default when there is no file", () => {
    const { dataDir } = makeRoot("flightpath-settings-test-");
    expect(loadSettings(dataDir)).toEqual(defaultSettings());
    expect(defaultSettings().port).toBe(4747);
    expect(defaultSettings().idleShutdownMinutes).toBe(30);
  });

  it("keeps the valid values when one value is invalid, and warns", () => {
    const { dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, {
      port: "soon",
      autostart: false,
      idleShutdownMinutes: 45,
    });
    const warnings: string[] = [];
    const settings = loadSettings(dataDir, (m) => warnings.push(m));
    expect(settings.port).toBe(4747);
    expect(settings.autostart).toBe(false);
    expect(settings.idleShutdownMinutes).toBe(45);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("port");
  });

  it("writes atomically and reads its own file back", () => {
    const { dataDir } = makeRoot("flightpath-settings-test-");
    mkdirSync(dataDir, { recursive: true });
    const settings = { ...defaultSettings(), port: 4901, telemetry: true };
    saveSettings(dataDir, settings);
    expect(loadSettings(dataDir)).toEqual(settings);
    expect(readdirSync(dataDir)).toEqual(["settings.json"]);
  });

  it("validates a change field by field", () => {
    expect(validateSettingsInput({ port: 8080 })).toEqual({
      ok: true,
      values: { port: 8080 },
    });
    const bad = validateSettingsInput({
      port: 70000,
      idleShutdownMinutes: 3,
      nope: true,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual([
        "idleShutdownMinutes",
        "nope",
        "port",
      ]);
    }
  });

  it("turns the note after a turn on by default and accepts only on or off", () => {
    expect(defaultSettings().terminalLine).toBe(true);
    expect(validateSettingsInput({ terminalLine: false })).toEqual({
      ok: true,
      values: { terminalLine: false },
    });
    const bad = validateSettingsInput({ terminalLine: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors["terminalLine"]).toBe("must be on or off");
  });

  it("accepts only the five retention periods", () => {
    expect(defaultSettings().retentionDays).toBe(15);
    for (const days of [7, 15, 30, 60, 90]) {
      const ok = validateSettingsInput({ retentionDays: days });
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.values.retentionDays).toBe(days);
    }
    for (const days of [0, 14, 16, 45, -7, 15.5, "15"]) {
      const bad = validateSettingsInput({ retentionDays: days });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors["retentionDays"]).toContain("one of");
    }
    // An invalid stored value falls back to the default.
    const { dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { retentionDays: 12 });
    expect(loadSettings(dataDir).retentionDays).toBe(15);
  });

  it("matches excluded folders by path, not by prefix", () => {
    const base = join(tmpdir(), "fp-excluded");
    expect(isExcludedFolder(base, [base])).toBe(true);
    expect(isExcludedFolder(join(base, "sub"), [base])).toBe(true);
    expect(isExcludedFolder(`${base}x`, [base])).toBe(false);
    expect(isExcludedFolder(join(tmpdir(), "other"), [base])).toBe(false);
    expect(isExcludedFolder(base, [])).toBe(false);
  });

  it("matches Windows-style excluded folders in any letter case, on any host", () => {
    const base = "C:\\work\\harbor";
    expect(isExcludedFolder("c:\\WORK\\Harbor", [base])).toBe(true);
    expect(isExcludedFolder("C:\\work\\harbor\\sub", [base])).toBe(true);
    expect(isExcludedFolder(base, [`${base}\\`])).toBe(true);
    expect(isExcludedFolder("C:\\work\\harbor2", [base])).toBe(false);
  });

  it("builds the settings screen address from the port and token files", () => {
    const { dataDir } = makeRoot("flightpath-settings-test-");
    expect(settingsScreenUrl(dataDir)).toBeNull();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "port"), "4747");
    writeFileSync(join(dataDir, "token"), "abc123");
    expect(settingsScreenUrl(dataDir)).toBe(
      "http://127.0.0.1:4747/#settings&token=abc123",
    );
  });
});

/** A root whose stored settings name port 4799, for the tests
 *  of the settings endpoints. */
function makeSettingsRoot(): { root: string; dataDir: string } {
  const made = makeRoot("flightpath-settings-test-");
  writeSettings(made.dataDir, { port: 4799 });
  return made;
}

/** The settings answer at a port the daemon moved to, with
 *  the port it stored. */
async function expectSettingsAt(
  port: number,
  headers: Record<string, string>,
  wantedPort: number,
): Promise<void> {
  const moved = await callDaemon(port, {
    method: "GET",
    path: "/api/settings",
    headers,
  });
  expect(moved.status).toBe(200);
  expect(JSON.parse(moved.body).settings.port).toBe(wantedPort);
}

/** Wait until a listener stops taking connections: a restart
 *  is under way once connects are refused. */
async function waitForListenerToClose(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const probeSocket = connect(port, "127.0.0.1", () => {
          probeSocket.destroy();
          resolvePromise();
        });
        probeSocket.on("error", reject);
      });
      return false;
    } catch {
      return true;
    }
  }, 5_000);
}

describe("settings endpoints", DAEMON_SUITE, () => {
  it("sends the old page address to the view and serves the settings only with the header", async () => {
    const { port, token } = await startTestDaemon(makeSettingsRoot().root);

    const page = await callDaemon(port, { method: "GET", path: "/settings" });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");

    const noToken = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
    });
    expect(noToken.status).toBe(401);
    const queryToken = await callDaemon(port, {
      method: "GET",
      path: `/api/settings?token=${token}`,
    });
    expect(queryToken.status).toBe(401);
    const cookieToken = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      headers: { cookie: `token=${token}` },
    });
    expect(cookieToken.status).toBe(401);

    const ok = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      headers: { "x-flightpath-token": token },
    });
    expect(ok.status).toBe(200);
    const data = JSON.parse(ok.body) as {
      settings: { port: number };
      boundPort: number;
      fields: unknown[];
    };
    expect(data.settings.port).toBe(4799);
    expect(data.boundPort).toBe(port);
    expect(data.fields).toHaveLength(9);
  });

  it("tells the screen the data folder, the kept count and who is recording", async () => {
    const { dataDir, port, token } = await startTestDaemon(
      makeSettingsRoot().root,
    );
    const headers = { "x-flightpath-token": token };

    const posted = await callDaemon(port, {
      method: "POST",
      path: "/events/hook",
      headers,
      body: sequencedHookEnvelope(
        "env-settings",
        userPromptEvent("settings-live-1", "Build a tip calculator", {
          cwd: "/work/tip-calc",
        }),
      ),
    });
    expect(posted.status).toBe(204);

    const ok = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      headers,
    });
    expect(ok.status).toBe(200);
    const data = JSON.parse(ok.body) as {
      dataDir: string;
      liveSessions: { id: string; title: string }[];
      retention: { sessionCount: number };
    };
    expect(data.dataDir).toBe(dataDir);
    expect(data.liveSessions).toEqual([
      { id: "settings-live-1", title: "Build a tip calculator" },
    ]);
    expect(data.retention.sessionCount).toBe(1);
  });

  it("rejects a bad change field by field and changes nothing", async () => {
    const { port, token } = await startTestDaemon(makeSettingsRoot().root);

    const bad = await callDaemonJson(
      port,
      "PUT",
      "/api/settings",
      token,
      JSON.stringify({ port: "soon" }),
    );
    expect(bad.status).toBe(400);
    expect((bad.json.errors as Record<string, unknown>).port).toBeTruthy();

    const after = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      token,
    });
    expect(JSON.parse(after.body).settings.port).toBe(4799);
  });

  it("saves a change and answers with the stored result", async () => {
    const { root, dataDir } = makeSettingsRoot();
    const { port, token } = await startTestDaemon(root);

    const saved = await callDaemonJson(
      port,
      "PUT",
      "/api/settings",
      token,
      JSON.stringify({ idleShutdownMinutes: 45, startupNotice: false }),
    );
    expect(saved.status).toBe(200);
    const data = saved.json as {
      settings: { idleShutdownMinutes: number; startupNotice: boolean };
    };
    expect(data.settings.idleShutdownMinutes).toBe(45);
    expect(data.settings.startupNotice).toBe(false);
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, "settings.json"), "utf8"),
    ) as { idleShutdownMinutes: number };
    expect(onDisk.idleShutdownMinutes).toBe(45);
  });

  it("moves to the new port when the port changes", async () => {
    // Both ports come from the OS: a second suite's daemons claim the shared defaults too, which would void the old-port refusal below.
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { port: await freePort() });
    const { port, token } = await startTestDaemon(root);
    const headers = { "x-flightpath-token": token };
    const target = await freePort();

    const saved = await callDaemonJson(
      port,
      "PUT",
      "/api/settings",
      token,
      JSON.stringify({ port: target }),
    );
    expect(saved.status).toBe(200);

    // The daemon restarts in place: the port file moves, and the
    // settings endpoint answers there with the new setting stored.
    await waitFor(() => {
      try {
        return readPort(dataDir) !== port;
      } catch {
        return false;
      }
    });
    const newPort = readPort(dataDir);
    await expectSettingsAt(newPort, headers, target);
    await expect(
      callDaemon(port, { method: "GET", path: "/settings" }),
    ).rejects.toThrow();
  });

  it("moves to the new port while a stream arrives mid-restart", async () => {
    const { root, dataDir } = makeSettingsRoot();
    const { port, token } = await startTestDaemon(root);
    const headers = { "x-flightpath-token": token };

    const probe = createServer();
    const newPort = await listenOnFreePort(probe);
    await new Promise<void>((resolvePromise) =>
      probe.close(() => resolvePromise()),
    );

    // One kept-alive socket, held busy by a request whose
    // body is still arriving — a page's pooled socket while
    // the daemon restarts around it. The listener's close
    // sweeps past it because it is busy, not idle.
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise<void>((resolvePromise) =>
      socket.once("connect", resolvePromise),
    );
    socket.write(
      "PUT /api/settings HTTP/1.1\r\n" +
        `host: 127.0.0.1:${port}\r\n` +
        `x-flightpath-token: ${token}\r\n` +
        "content-type: application/json\r\n" +
        "content-length: 2\r\n" +
        "\r\n" +
        "x",
    );
    // Give the daemon the request before the move starts.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const saved = await callDaemonJson(
      port,
      "PUT",
      "/api/settings",
      token,
      JSON.stringify({ port: newPort }),
    );
    expect(saved.status).toBe(200);

    // Wait for the restart to be under way while the held
    // socket is still busy with its unfinished request.
    await waitForListenerToClose(port);

    // The held body lands (not JSON; it changes nothing),
    // and pipelined behind it a stream request, the way a
    // page's reconnect rides the socket it already holds.
    // A stream taken on now would never go idle: the move
    // must not be held open by it.
    socket.write(
      "x" +
        "GET /api/stream HTTP/1.1\r\n" +
        `host: 127.0.0.1:${port}\r\n` +
        `x-flightpath-token: ${token}\r\n` +
        "\r\n",
    );

    // The new port answers within the bound, with the new
    // setting stored.
    await waitFor(() => readPort(dataDir) === newPort, 5_000);
    await expectSettingsAt(newPort, headers, newPort);
    socket.destroy();
  });

  it("never shows an empty or partial port file across restarts", async () => {
    // Both bounce ports come from the OS: a second suite's daemons claim the shared defaults, and one holding a bounce target makes this daemon fall forward to a third port.
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    const first = await freePort();
    let second = await freePort();
    while (second === first) second = await freePort();
    writeSettings(dataDir, { port: first });
    const { token } = await startTestDaemon(root);
    // Hammer the reader while the port bounces: every read
    // must land on one whole port number or the other, never
    // on an empty or partial file.
    const seen = new Set<string>();
    let stop = false;
    const reader = async (): Promise<void> => {
      let spins = 0;
      while (!stop) {
        const raw = readFileSync(join(dataDir, "port"), "utf8");
        expect([String(first), String(second)]).toContain(raw);
        seen.add(raw);
        spins += 1;
        if (spins % 200 === 0) {
          await new Promise((resolvePromise) => setImmediate(resolvePromise));
        }
      }
    };
    const hammer = Promise.all([reader(), reader(), reader()]);
    let current = readPort(dataDir);
    for (const next of [
      second,
      first,
      second,
      first,
      second,
      first,
      second,
      first,
    ]) {
      const saved = await callDaemonJson(
        current,
        "PUT",
        "/api/settings",
        token,
        JSON.stringify({ port: next }),
      );
      expect(saved.status).toBe(200);
      await waitFor(() => readPort(dataDir) === next);
      current = next;
    }
    stop = true;
    await hammer;
    expect(seen).toEqual(new Set([String(first), String(second)]));
  });
});

describe("hook settings", () => {
  function runHook(
    root: string,
    event: Record<string, unknown>,
  ): { status: number | null } {
    const dataDir = dataDirFor(root);
    // A fresh daemon-start lock means the hook will not spawn a
    // daemon, so anything it buffers stays buffered to be read.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(startLockPath(dataDir), "");
    const result = runDist(
      distHook,
      JSON.stringify(event),
      envForDataRoot(root),
      {
        timeout: 20_000,
      },
    );
    return { status: result.status };
  }

  function bufferedEvents(dataDir: string): Record<string, unknown>[] {
    const buffer = join(dataDir, "buffer");
    if (!existsSync(buffer)) return [];
    return readdirSync(buffer)
      .sort()
      .map(
        (name) =>
          JSON.parse(readFileSync(join(buffer, name), "utf8")) as Record<
            string,
            unknown
          >,
      );
  }

  function onlyBufferedEvent(dataDir: string): {
    event: Record<string, unknown>;
  } {
    const buffered = bufferedEvents(dataDir);
    expect(buffered).toHaveLength(1);
    return firstRow(buffered, "a buffered event") as {
      event: Record<string, unknown>;
    };
  }

  /** Run one prompt submit through the hook; the envelope it buffered. */
  function promptEnvelope(
    root: string,
    dataDir: string,
    sessionId: string,
    prompt: string,
  ): { event: Record<string, unknown> } {
    runHook(root, {
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt,
    });
    return onlyBufferedEvent(dataDir);
  }

  it("never sends or buffers an event from an excluded folder", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    const work = join(root, "work");
    writeSettings(dataDir, { excludedFolders: [work] });
    const result = runHook(root, {
      session_id: "s-excluded",
      hook_event_name: "PreToolUse",
      cwd: join(work, "sub"),
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "x" },
    });
    expect(result.status).toBe(0);
    expect(bufferedEvents(dataDir)).toEqual([]);
  });

  it("keeps only the length of a prompt when prompt storage is off", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { storePromptText: false });
    runHook(root, {
      session_id: "s-prompt",
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "a secret plan",
    });
    const envelope = onlyBufferedEvent(dataDir);
    expect(envelope.event.prompt).toEqual({ chars: 13 });
    expect(JSON.stringify(envelope)).not.toContain("a secret plan");
  });

  it("counts the prompt's true length, before any scrubbing", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { storePromptText: false });
    // The key-shaped word is scrubbed out of stored text, which
    // changes its length; the kept number must be the length of
    // what the user actually typed.
    const prompt = "deploy with AKIA1234567890ABCDEF today";
    runHook(root, {
      session_id: "s-prompt-scrubbed",
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt,
    });
    const envelope = onlyBufferedEvent(dataDir);
    expect(envelope.event.prompt).toEqual({ chars: prompt.length });
    expect(JSON.stringify(envelope)).not.toContain("AKIA");
  });

  it("keeps the prompt text when prompt storage is on", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    runHook(root, {
      session_id: "s-prompt-on",
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "a secret plan",
    });
    const envelope = onlyBufferedEvent(dataDir);
    expect(envelope.event.prompt).toBe("a secret plan");
  });

  it("sends a typed prompt's kind and length, not its text, when prompt storage is off", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { storePromptText: false });
    const envelope = promptEnvelope(
      root,
      dataDir,
      "s-prompt-typed",
      "fix the parser today",
    );
    expect(envelope.event.prompt_kind).toBe("typed");
    expect(envelope.event.prompt_chars).toBe(20);
    expect(envelope.event.prompt_lines).toBe(1);
    expect(envelope.event.prompt).toEqual({ chars: 20 });
    expect(JSON.stringify(envelope)).not.toContain("fix the parser today");
  });

  it("sends the kind and length with the text when prompt storage is on", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    const envelope = promptEnvelope(
      root,
      dataDir,
      "s-prompt-kind-on",
      "fix the parser today",
    );
    expect(envelope.event).toMatchObject({
      prompt_kind: "typed",
      prompt_chars: 20,
      prompt_lines: 1,
      prompt: "fix the parser today",
    });
  });

  it("names a hand-back's kind when prompt storage is off, and sends none of its text", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { storePromptText: false });
    const prompt =
      '<agent-message from="a000000000000001">\n[Subagent hand-back] the files it read, reported back.';
    const envelope = promptEnvelope(root, dataDir, "s-prompt-handback", prompt);
    expect(envelope.event.prompt_kind).toBe("agent-message");
    expect(envelope.event.prompt).toEqual({ chars: prompt.length });
    expect(JSON.stringify(envelope)).not.toContain("reported back");
  });

  it("names a command in its expanded form as a Flightpath command", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    const envelope = promptEnvelope(
      root,
      dataDir,
      "s-prompt-expanded",
      expandedCommandPrompt("flightpath:open"),
    );
    expect(envelope.event.prompt_kind).toBe("flightpath-command");
  });

  it("names a task notification's kind when prompt storage is off", () => {
    const { root, dataDir } = makeRoot("flightpath-settings-test-");
    writeSettings(dataDir, { storePromptText: false });
    const envelope = promptEnvelope(
      root,
      dataDir,
      "s-prompt-notification",
      "<task-notification>\n<task-id>t1</task-id>\n</task-notification>",
    );
    expect(envelope.event.prompt_kind).toBe("task-notification");
    expect(envelope.event.prompt_lines).toBe(3);
    expect(JSON.stringify(envelope)).not.toContain("task-id");
  });
});
