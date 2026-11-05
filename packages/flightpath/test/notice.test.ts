import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { distPath } from "./support/daemon.js";
import { sessionStartEvent } from "./support/events.js";
import { scratchHome } from "./support/process.js";
import { writeSettings } from "./support/settings.js";

// Integration tests for the startup notice hook
// (dist/notice.js), run as a child process the way Claude Code
// runs it. The notice is one line, decided from the settings
// and the pause and off flags alone (ADR-0024).

const distNotice = distPath("notice.js");

afterEach(async () => {
  await runCleanups();
});

function runNotice(
  env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
): string {
  const result = spawnSync(process.execPath, [distNotice], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

function noticeLineFor(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  settings: Record<string, unknown>,
  cwd: string,
): string {
  writeSettings(dataDir, settings);
  const parsed = JSON.parse(
    runNotice(env, sessionStartEvent("startup", "s1", { cwd })),
  ) as { systemMessage: string };
  return parsed.systemMessage;
}

const EXCLUDED_LINE =
  "● flightpath isn't recording this folder · it's in Folders never recorded in Settings";

describe("the startup notice hook", () => {
  it("prints the recording line on a fresh start, with no link and no token", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    // Even with a daemon's port and token files present, neither
    // appears in the line.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "port"), "4799");
    writeFileSync(join(dataDir, "token"), "test-token");
    const stdout = runNotice(env, sessionStartEvent("startup"));
    const parsed = JSON.parse(stdout) as { systemMessage: string };
    expect(parsed.systemMessage).toBe(
      "● flightpath is recording · /flightpath:status for settings",
    );
    expect(stdout).not.toContain("test-token");
    expect(stdout).not.toContain("4799");
    // The notice starts nothing: no daemon lock, no database.
    expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "flightpath.db"))).toBe(false);
  });

  it("prints it on clear and fork starts too", () => {
    const { env } = scratchHome("flightpath-notice-");
    for (const source of ["clear", "fork"]) {
      const parsed = JSON.parse(runNotice(env, sessionStartEvent(source))) as {
        systemMessage: string;
      };
      expect(parsed.systemMessage).toContain("flightpath is recording");
    }
  });

  it("never prints on resume or compact segments", () => {
    const { env } = scratchHome("flightpath-notice-");
    expect(runNotice(env, sessionStartEvent("resume"))).toBe("");
    expect(runNotice(env, sessionStartEvent("compact"))).toBe("");
  });

  it("prints the paused line when autostart is off", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    writeSettings(dataDir, { autostart: false });
    const parsed = JSON.parse(runNotice(env, sessionStartEvent("startup"))) as {
      systemMessage: string;
    };
    expect(parsed.systemMessage).toBe(
      "● flightpath is paused · /flightpath:start to record",
    );
  });

  it("prints the off line when flightpath is off", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "off"), "");
    const parsed = JSON.parse(runNotice(env, sessionStartEvent("startup"))) as {
      systemMessage: string;
    };
    expect(parsed.systemMessage).toBe(
      "● flightpath is off · /flightpath:start to turn it on",
    );
  });

  it("prints the paused line when the session is paused", () => {
    const second = scratchHome("flightpath-notice-");
    mkdirSync(join(second.dataDir, "pause"), { recursive: true });
    writeFileSync(join(second.dataDir, "pause", "s1"), "");
    const pausedLine = JSON.parse(
      runNotice(second.env, sessionStartEvent("startup")),
    ) as { systemMessage: string };
    expect(pausedLine.systemMessage).toContain("flightpath is paused");
  });

  it("stays silent when the notice setting is off", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    writeSettings(dataDir, { startupNotice: false });
    expect(runNotice(env, sessionStartEvent("startup"))).toBe("");
  });

  it("prints the excluded line in an excluded folder and inside it", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    const settings = { excludedFolders: ["/work/never"] };
    for (const cwd of ["/work/never", "/work/never/app"]) {
      expect(noticeLineFor(env, dataDir, settings, cwd)).toBe(EXCLUDED_LINE);
    }
  });

  it("prints the excluded line for a Windows-style path in any letter case, with a trailing separator", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    const line = noticeLineFor(
      env,
      dataDir,
      { excludedFolders: ["C:\\work\\harbor\\"] },
      "c:\\WORK\\Harbor",
    );
    expect(line).toBe(EXCLUDED_LINE);
  });

  it("prints the excluded line inside a Windows-style excluded folder", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    const line = noticeLineFor(
      env,
      dataDir,
      { excludedFolders: ["C:\\work\\harbor"] },
      "C:\\work\\harbor\\sub",
    );
    expect(line).toBe(EXCLUDED_LINE);
  });

  it("prints the recording line in a sibling folder with the same prefix", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    const line = noticeLineFor(
      env,
      dataDir,
      { excludedFolders: ["C:\\work\\harbor"] },
      "C:\\work\\harbor2",
    );
    expect(line).toBe(
      "● flightpath is recording · /flightpath:status for settings",
    );
  });

  it("prints the excluded line over the paused line", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    const line = noticeLineFor(
      env,
      dataDir,
      { autostart: false, excludedFolders: ["/work/never"] },
      "/work/never",
    );
    expect(line).toBe(EXCLUDED_LINE);
  });

  it("prints the off line over the excluded line", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "off"), "");
    const line = noticeLineFor(
      env,
      dataDir,
      { excludedFolders: ["/work/never"] },
      "/work/never",
    );
    expect(line).toBe("● flightpath is off · /flightpath:start to turn it on");
  });

  it("stays silent in an excluded folder when the notice setting is off", () => {
    const { env, dataDir } = scratchHome("flightpath-notice-");
    writeSettings(dataDir, {
      startupNotice: false,
      excludedFolders: ["/work/never"],
    });
    expect(
      runNotice(
        env,
        sessionStartEvent("startup", "s1", { cwd: "/work/never" }),
      ),
    ).toBe("");
  });
});
