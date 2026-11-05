import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedPaths } from "../src/setup/index.js";
import {
  managedSettingsFiles,
  readDenyRules,
  readSettingsFiles,
} from "../src/settings-files.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await runCleanups();
});

function writeSettings(path: string, contents: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

type SettingsWorld = ReturnType<typeof settingsWorld>;

const deny = (...rules: string[]) => ({ permissions: { deny: rules } });

/** A user config folder, a project and a managed folder, all empty. */
function settingsWorld() {
  const config = makeTempRoot("flightpath-config-");
  const project = makeTempRoot("flightpath-project-");
  const managed = managedPaths("linux", makeTempRoot("flightpath-managed-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  return { config, project, managed };
}

describe("the managed settings files", () => {
  it("lists the managed file and the drop-in files in name order", () => {
    const { managed } = settingsWorld();
    writeSettings(join(managed.managedDropInDir, "20-b.json"), {});
    writeSettings(join(managed.managedDropInDir, "10-a.json"), {});
    writeSettings(join(managed.managedDropInDir, "notes.txt"), "not settings");
    writeSettings(managed.managedSettingsPath, {});
    expect(managedSettingsFiles(managed)).toEqual([
      managed.managedSettingsPath,
      join(managed.managedDropInDir, "10-a.json"),
      join(managed.managedDropInDir, "20-b.json"),
    ]);
  });

  it("lists nothing when the machine has no managed settings", () => {
    const { managed } = settingsWorld();
    expect(managedSettingsFiles(managed)).toEqual([]);
  });
});

describe("reading settings files", () => {
  it("skips a file that is not there without calling it unreadable", () => {
    const { config } = settingsWorld();
    expect(readSettingsFiles([join(config, "settings.json")])).toEqual({
      settings: [],
      unreadable: false,
    });
  });

  it.each([
    ["text that is not JSON", "{ nope"],
    ["JSON that is not an object", "[]"],
  ])("reports %s as unreadable", (_name, contents) => {
    const { config } = settingsWorld();
    const file = join(config, "settings.json");
    writeSettings(file, contents);
    expect(readSettingsFiles([file])).toEqual({
      settings: [],
      unreadable: true,
    });
  });
});

describe("the deny rules", () => {
  it.each([
    ["user settings", (w: SettingsWorld) => join(w.config, "settings.json")],
    [
      "user local settings",
      (w: SettingsWorld) => join(w.config, "settings.local.json"),
    ],
    [
      "project settings",
      (w: SettingsWorld) => join(w.project, ".claude", "settings.json"),
    ],
    [
      "project local settings",
      (w: SettingsWorld) => join(w.project, ".claude", "settings.local.json"),
    ],
    ["managed settings", (w: SettingsWorld) => w.managed.managedSettingsPath],
    [
      "a managed drop-in file",
      (w: SettingsWorld) => join(w.managed.managedDropInDir, "10-deny.json"),
    ],
  ])("come from the %s", (_name, fileOf) => {
    const world = settingsWorld();
    writeSettings(fileOf(world), deny("Read(**/dist/**)"));
    expect(readDenyRules(world.project, world.managed)).toEqual([
      "Read(**/dist/**)",
    ]);
  });

  it("are gathered from every file together", () => {
    const { config, project, managed } = settingsWorld();
    writeSettings(join(config, "settings.json"), deny("Read(**/dist/**)"));
    writeSettings(
      join(project, ".claude", "settings.json"),
      deny("Read(**/coverage/**)"),
    );
    expect(readDenyRules(project, managed)).toEqual([
      "Read(**/dist/**)",
      "Read(**/coverage/**)",
    ]);
  });

  it("are empty when no file sets any", () => {
    const { config, project, managed } = settingsWorld();
    writeSettings(join(config, "settings.json"), {
      permissions: { allow: [] },
    });
    expect(readDenyRules(project, managed)).toEqual([]);
  });

  it("leave out anything in the list that is not a rule", () => {
    const { config, project, managed } = settingsWorld();
    writeSettings(join(config, "settings.json"), {
      permissions: { deny: ["Read(**/dist/**)", 7, null] },
    });
    expect(readDenyRules(project, managed)).toEqual(["Read(**/dist/**)"]);
  });

  it("are unknown when any settings file cannot be read", () => {
    const { config, project, managed } = settingsWorld();
    writeSettings(join(config, "settings.json"), deny("Read(**/dist/**)"));
    writeSettings(join(project, ".claude", "settings.json"), "{ nope");
    expect(readDenyRules(project, managed)).toBeUndefined();
  });
});
