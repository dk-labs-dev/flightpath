import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningDaemon } from "../src/daemon/server.js";
import {
  applyTelemetrySetup,
  detectTelemetrySetup,
  setupPaths,
  syncTelemetryEndpoint,
  telemetryEnvValues,
  TELEMETRY_ENV_KEYS,
  undoTelemetrySetup,
  type SetupPaths,
} from "../src/setup/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import { callDaemon, callDaemonJson } from "./support/daemon.js";
import { startTelemetryDaemon } from "./support/telemetry.js";
import {
  makeTelemetrySetupWorld,
  type TelemetrySetupWorld,
} from "./support/worlds.js";

// Telemetry setup (ADR-0023): detection across the environment,
// user settings and managed settings; a careful apply with a
// backup and a record; an exact undo. All files are temporary;
// the managed-settings paths are the ones the Claude Code
// settings docs name (see the setup module's header).

const daemons: RunningDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.shutdown("signal");
  await runCleanups();
});

function options(
  world: TelemetrySetupWorld,
  env: NodeJS.ProcessEnv = {},
): { paths: SetupPaths; env: NodeJS.ProcessEnv; port: number; token: string } {
  return { paths: world.paths, env, port: 4747, token: "test-token" };
}

function writeUserSettings(world: TelemetrySetupWorld, value: unknown): void {
  writeFileSync(
    world.paths.userSettingsPath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readUserSettings(world: TelemetrySetupWorld): Record<string, unknown> {
  return JSON.parse(
    readFileSync(world.paths.userSettingsPath, "utf8"),
  ) as Record<string, unknown>;
}

describe("setupPaths", () => {
  it("names the managed settings file the docs name, per platform", () => {
    const base = { dataDir: "/data", configDir: "/home/u/.claude" };
    expect(
      setupPaths({ ...base, platform: "darwin" }).managedSettingsPath,
    ).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(setupPaths({ ...base, platform: "linux" }).managedSettingsPath).toBe(
      "/etc/claude-code/managed-settings.json",
    );
    expect(setupPaths({ ...base, platform: "win32" }).managedSettingsPath).toBe(
      "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    );
  });
});

describe("detectTelemetrySetup", () => {
  it("is off when nothing is configured anywhere", () => {
    const world = makeTelemetrySetupWorld();
    expect(detectTelemetrySetup(options(world))).toEqual({ state: "off" });
  });

  it("finds configuration in the environment, user settings and managed settings", () => {
    const byEnv = makeTelemetrySetupWorld();
    expect(
      detectTelemetrySetup(
        options(byEnv, {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
        }),
      ),
    ).toMatchObject({ state: "elsewhere", where: "the environment" });

    const byUser = makeTelemetrySetupWorld();
    writeUserSettings(byUser, {
      env: {
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318",
      },
    });
    expect(detectTelemetrySetup(options(byUser))).toMatchObject({
      state: "elsewhere",
      where: "your Claude Code settings",
    });

    const byManaged = makeTelemetrySetupWorld();
    writeFileSync(
      byManaged.paths.managedSettingsPath,
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } }),
    );
    expect(detectTelemetrySetup(options(byManaged))).toMatchObject({
      state: "elsewhere",
      where: "managed settings",
    });

    const byDropIn = makeTelemetrySetupWorld();
    const dropIn = join(byDropIn.managedDir, "managed-settings.d");
    mkdirSync(dropIn, { recursive: true });
    writeFileSync(
      join(dropIn, "10-telemetry.json"),
      JSON.stringify({ env: { OTEL_LOGS_EXPORTER: "otlp" } }),
    );
    expect(detectTelemetrySetup(options(byDropIn))).toMatchObject({
      state: "elsewhere",
      where: "managed settings",
    });
  });

  it("does not mistake setup's own endpoint, reflected in the environment, for a foreign one", () => {
    const world = makeTelemetrySetupWorld();
    applyTelemetrySetup(options(world));
    const reflected: NodeJS.ProcessEnv = {
      ...telemetryEnvValues(4747, "test-token"),
    };
    expect(detectTelemetrySetup(options(world, reflected))).toMatchObject({
      state: "on",
    });
  });

  it("reads setup's own keys in the settings file as on, even when the daemon's environment carries telemetry keys too", () => {
    const world = makeTelemetrySetupWorld();
    writeUserSettings(world, {
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
        CLAUDE_EFFORT: "high",
      },
    });
    expect(applyTelemetrySetup(options(world)).ok).toBe(true);
    // The daemon's environment carries telemetry keys
    // inherited from the session that started it. Setup's
    // endpoint is not among them, so the environment alone
    // would read them as a foreign configuration; the
    // settings file is checked first and wins.
    const carried: NodeJS.ProcessEnv = {
      ...telemetryEnvValues(4747, "test-token"),
    };
    delete carried.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(detectTelemetrySetup(options(world, carried))).toMatchObject({
      state: "on",
      endpoint: "http://127.0.0.1:4747",
    });
    const undone = undoTelemetrySetup({ paths: world.paths });
    expect(undone.ok).toBe(true);
    expect([...undone.removed].sort()).toEqual([...TELEMETRY_ENV_KEYS].sort());
    expect(readUserSettings(world).env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
      CLAUDE_EFFORT: "high",
    });
  });

  it("checks the environment when the settings file holds none of setup's keys", () => {
    const world = makeTelemetrySetupWorld();
    expect(
      detectTelemetrySetup(
        options(world, {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
        }),
      ),
    ).toMatchObject({ state: "elsewhere", where: "the environment" });
  });

  it("reports a malformed user settings file instead of touching it", () => {
    const world = makeTelemetrySetupWorld();
    writeFileSync(world.paths.userSettingsPath, "{ not json");
    const state = detectTelemetrySetup(options(world));
    expect(state.state).toBe("error");
    expect(applyTelemetrySetup(options(world)).ok).toBe(false);
    expect(readFileSync(world.paths.userSettingsPath, "utf8")).toBe(
      "{ not json",
    );
  });
});

describe("apply and undo", () => {
  const ORIGINAL = {
    model: "opus",
    permissions: { allow: ["Bash(pnpm *)"] },
    env: { MY_FLAG: "keep-me", OTEL_LOG_ASSISTANT_RESPONSES: "1" },
    statusLine: { type: "command", command: "echo hi" },
  };

  it("writes through a symlinked settings file and keeps the link", () => {
    const world = makeTelemetrySetupWorld();
    // The real file lives elsewhere, as in a dotfiles repo,
    // and the settings path is a link to it.
    const realPath = join(world.root, "dotfiles", "settings.json");
    mkdirSync(dirname(realPath), { recursive: true });
    writeFileSync(realPath, `${JSON.stringify(ORIGINAL, null, 2)}\n`);
    const originalBytes = readFileSync(realPath, "utf8");
    symlinkSync(realPath, world.paths.userSettingsPath);

    const applied = applyTelemetrySetup(options(world));
    expect(applied.ok).toBe(true);
    expect(lstatSync(world.paths.userSettingsPath).isSymbolicLink()).toBe(true);
    const env = readUserSettings(world).env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");

    const undone = undoTelemetrySetup({ paths: world.paths });
    expect(undone.ok).toBe(true);
    expect(lstatSync(world.paths.userSettingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realPath, "utf8")).toBe(originalBytes);
  });

  it("writes exactly the setup keys, backs up, and undoes byte-identically", () => {
    const world = makeTelemetrySetupWorld();
    writeUserSettings(world, ORIGINAL);
    const originalBytes = readFileSync(world.paths.userSettingsPath, "utf8");

    const applied = applyTelemetrySetup(options(world));
    expect(applied.ok).toBe(true);
    const written = readUserSettings(world);
    expect(Object.keys(written)).toEqual(Object.keys(ORIGINAL));
    const env = written.env as Record<string, string>;
    expect(env.MY_FLAG).toBe("keep-me");
    for (const [key, value] of Object.entries(
      telemetryEnvValues(4747, "test-token"),
    )) {
      expect(env[key]).toBe(value);
    }
    expect(Object.keys(env).sort()).toEqual(
      [...TELEMETRY_ENV_KEYS, "MY_FLAG"].sort(),
    );
    // Prompt and tool-detail logging are never enabled.
    expect(readFileSync(world.paths.userSettingsPath, "utf8")).not.toContain(
      "OTEL_LOG_USER_PROMPTS",
    );
    expect(
      readFileSync(
        join(world.dataDir, "telemetry-settings-backup.json"),
        "utf8",
      ),
    ).toBe(originalBytes);
    expect(detectTelemetrySetup(options(world))).toMatchObject({
      state: "on",
      endpoint: "http://127.0.0.1:4747",
    });

    const undone = undoTelemetrySetup({ paths: world.paths });
    expect(undone.ok).toBe(true);
    expect(undone.left).toEqual([]);
    expect(readFileSync(world.paths.userSettingsPath, "utf8")).toBe(
      originalBytes,
    );
    expect(detectTelemetrySetup(options(world))).toEqual({ state: "off" });
  });

  it("changes nothing when telemetry is configured elsewhere", () => {
    const world = makeTelemetrySetupWorld();
    writeUserSettings(world, {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
    });
    const before = readFileSync(world.paths.userSettingsPath, "utf8");
    const applied = applyTelemetrySetup(options(world));
    expect(applied.ok).toBe(false);
    expect(applied.message).toContain("already configured");
    expect(readFileSync(world.paths.userSettingsPath, "utf8")).toBe(before);
    expect(existsSync(join(world.dataDir, "telemetry-setup.json"))).toBe(false);
  });

  it("leaves a user-edited key in place on undo, and reports it", () => {
    const world = makeTelemetrySetupWorld();
    writeUserSettings(world, { model: "opus" });
    applyTelemetrySetup(options(world));
    const edited = readUserSettings(world);
    (edited.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://127.0.0.1:9999";
    writeFileSync(
      world.paths.userSettingsPath,
      `${JSON.stringify(edited, null, 2)}\n`,
    );
    const undone = undoTelemetrySetup({ paths: world.paths });
    expect(undone.ok).toBe(true);
    expect(undone.left).toEqual(["OTEL_EXPORTER_OTLP_ENDPOINT"]);
    const after = readUserSettings(world);
    const env = after.env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:9999");
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    // What remains is the user's own configuration now.
    expect(detectTelemetrySetup(options(world))).toMatchObject({
      state: "elsewhere",
    });
  });

  it("removes a settings file setup created, when undo leaves it empty", () => {
    const world = makeTelemetrySetupWorld();
    expect(existsSync(world.paths.userSettingsPath)).toBe(false);
    applyTelemetrySetup(options(world));
    expect(existsSync(world.paths.userSettingsPath)).toBe(true);
    const undone = undoTelemetrySetup({ paths: world.paths });
    expect(undone.ok).toBe(true);
    expect(existsSync(world.paths.userSettingsPath)).toBe(false);
  });

  it("creates the config folder when it does not exist yet, and leaves it on undo", () => {
    const world = makeTelemetrySetupWorld();
    const configDir = join(world.root, "not-created", "claude");
    const paths = setupPaths({
      dataDir: world.dataDir,
      configDir,
      managedDir: world.managedDir,
    });
    expect(existsSync(configDir)).toBe(false);

    const applied = applyTelemetrySetup({
      paths,
      env: {},
      port: 4747,
      token: "test-token",
    });
    expect(applied.ok).toBe(true);
    expect(existsSync(paths.userSettingsPath)).toBe(true);

    const undone = undoTelemetrySetup({ paths });
    expect(undone.ok).toBe(true);
    expect(existsSync(paths.userSettingsPath)).toBe(false);
    // The folder stays: undo removes what setup wrote, and
    // the folder is Claude Code's own.
    expect(existsSync(configDir)).toBe(true);
  });

  it("moves the written endpoint when the port changes", () => {
    const world = makeTelemetrySetupWorld();
    writeUserSettings(world, { model: "opus" });
    applyTelemetrySetup(options(world));
    expect(
      syncTelemetryEndpoint({
        paths: world.paths,
        port: 5555,
        token: "test-token",
      }),
    ).toBe(true);
    const env = readUserSettings(world).env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:5555");
    expect(
      detectTelemetrySetup({ ...options(world), port: 5555 }),
    ).toMatchObject({ state: "on", endpoint: "http://127.0.0.1:5555" });
    expect(
      syncTelemetryEndpoint({
        paths: world.paths,
        port: 5555,
        token: "test-token",
      }),
    ).toBe(false);
  });
});

describe("the /api/telemetry-setup endpoints", () => {
  async function startSetupDaemon(createConfigDir = true) {
    const root = makeTempRoot("flightpath-setup-daemon-");
    const dataDir = join(root, "data");
    const configDir = join(root, "claude");
    if (createConfigDir) mkdirSync(configDir, { recursive: true });
    // Detection reads the daemon's environment — this process,
    // for an in-process daemon — so clear every routing key
    // for the test and put them all back afterwards.
    const savedConfig = process.env.CLAUDE_CONFIG_DIR;
    const routingKeys = [
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_LOGS_EXPORTER",
      "OTEL_METRICS_EXPORTER",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
    ];
    const savedRouting = new Map(
      routingKeys.map((key) => [key, process.env[key]]),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    for (const key of routingKeys) delete process.env[key];
    registerCleanup(() => {
      if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedConfig;
      for (const [key, value] of savedRouting) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { daemon, token } = await startTelemetryDaemon(dataDir);
    daemons.push(daemon);
    return {
      daemon,
      token,
      dataDir,
      configDir,
      settingsPath: join(configDir, "settings.json"),
    };
  }

  async function postSetupAction(
    daemon: RunningDaemon,
    token: string,
    action: "on" | "off",
  ) {
    return callDaemonJson(
      daemon.port,
      "POST",
      "/api/telemetry-setup",
      token,
      JSON.stringify({ action }),
    );
  }

  async function expectFailureLoggedAndServing(
    daemon: RunningDaemon,
    token: string,
    dataDir: string,
    failureLine: string,
  ) {
    const log = readFileSync(join(dataDir, "logs", "daemon.log"), "utf8");
    expect(log).toContain(failureLine);
    expect(log).toContain("answered 500");
    const health = await callDaemon(daemon.port, {
      method: "GET",
      path: "/health",
      token,
    });
    expect(health.status).toBe(200);
  }

  it("rejects telemetry-setup requests without the token", async () => {
    const { daemon } = await startSetupDaemon();
    const noToken = await callDaemonJson(
      daemon.port,
      "GET",
      "/api/telemetry-setup",
      null,
    );
    expect(noToken.status).toBe(401);
  });

  it("turns telemetry on through the daemon and writes the settings", async () => {
    const { daemon, token, settingsPath } = await startSetupDaemon();
    const before = await callDaemonJson(
      daemon.port,
      "GET",
      "/api/telemetry-setup",
      token,
    );
    expect(before.json.state).toBe("off");
    const turnedOn = await postSetupAction(daemon, token, "on");
    expect(turnedOn.status).toBe(200);
    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      env: Record<string, string>;
    };
    expect(written.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      `http://127.0.0.1:${(before.json.configuredPort as number) ?? 4747}`,
    );
    expect(written.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
      `x-flightpath-token=${token}`,
    );
    const on = await callDaemonJson(
      daemon.port,
      "GET",
      "/api/telemetry-setup",
      token,
    );
    expect(on.json.state).toBe("on");
  });

  it("turns telemetry off through the daemon and removes the settings", async () => {
    const { daemon, token, configDir, settingsPath } = await startSetupDaemon();
    const turnedOn = await postSetupAction(daemon, token, "on");
    expect(turnedOn.status).toBe(200);
    const turnedOff = await postSetupAction(daemon, token, "off");
    expect(turnedOff.status).toBe(200);
    expect(existsSync(settingsPath)).toBe(false);
    const after = await callDaemonJson(
      daemon.port,
      "GET",
      "/api/telemetry-setup",
      token,
    );
    expect(after.json.state).toBe("off");
    expect(dirname(settingsPath)).toBe(configDir);
  });

  it("turns telemetry on when the config folder does not exist yet", async () => {
    const { daemon, token, configDir, settingsPath } =
      await startSetupDaemon(false);
    expect(existsSync(configDir)).toBe(false);
    const turnedOn = await postSetupAction(daemon, token, "on");
    expect(turnedOn.status).toBe(200);
    expect(turnedOn.json.ok).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const turnedOff = await postSetupAction(daemon, token, "off");
    expect(turnedOff.status).toBe(200);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(configDir)).toBe(true);
  });

  it("answers 500, logs the failure, and keeps serving when the settings write throws", async () => {
    const { daemon, token, dataDir, configDir } = await startSetupDaemon();
    // A config folder path blocked by a plain file: the
    // settings read finds nothing there, and the write throws.
    const blocked = join(dirname(configDir), "blocked");
    writeFileSync(blocked, "not a folder\n");
    process.env.CLAUDE_CONFIG_DIR = blocked;
    const failed = await postSetupAction(daemon, token, "on");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    expect(failed.status).toBe(500);
    expect(existsSync(join(blocked, "settings.json"))).toBe(false);
    await expectFailureLoggedAndServing(
      daemon,
      token,
      dataDir,
      "POST /api/telemetry-setup failed",
    );
  });

  it("answers 500, logs the failure, and keeps serving when a GET handler throws", async () => {
    const { daemon, token, dataDir } = await startSetupDaemon();
    // Storage damage behind the running daemon's back: the
    // table the settings payload counts is gone, so the read
    // throws inside the handler.
    const db = new DatabaseSync(join(dataDir, "flightpath.db"));
    db.exec("DROP TABLE sessions");
    db.close();
    const failed = await callDaemonJson(
      daemon.port,
      "GET",
      "/api/settings",
      token,
    );
    expect(failed.status).toBe(500);
    await expectFailureLoggedAndServing(
      daemon,
      token,
      dataDir,
      "GET /api/settings failed",
    );
  });
});
