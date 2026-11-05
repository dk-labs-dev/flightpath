import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultSettings, type Settings } from "../../src/settings/index.js";
import { setupPaths, type SetupPaths } from "../../src/setup/index.js";
import { openStorage, type Storage } from "../../src/storage/index.js";
import {
  createTranscriptFollower,
  encodeProjectPath,
  type TranscriptFollower,
} from "../../src/transcripts/index.js";
import { makeTempRoot, registerCleanup } from "./cleanup.js";
import { recordHookEvent } from "./events.js";

export interface TelemetryWorld {
  root: string;
  dataDir: string;
  storage: Storage;
  releaseStorageCleanup: () => void;
}

export function makeTelemetryWorld(): TelemetryWorld {
  const root = makeTempRoot("flightpath-telemetry-");
  const dataDir = join(root, "data");
  const storage = openStorage({ dataDir });
  const releaseStorageCleanup = registerCleanup(() => storage.close());
  return { root, dataDir, storage, releaseStorageCleanup };
}

export interface TranscriptWorld {
  root: string;
  dataDir: string;
  configDir: string;
  storage: Storage;
  follower: TranscriptFollower;
}

export function makeTranscriptWorld(
  settings: Partial<Settings> = {},
): TranscriptWorld {
  const root = makeTempRoot("flightpath-transcripts-");
  const dataDir = join(root, "data");
  const configDir = join(root, "claude");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const storage = openStorage({ dataDir });
  registerCleanup(() => storage.close());
  const current: Settings = { ...defaultSettings(), ...settings };
  const follower = createTranscriptFollower(storage, {
    dataDir,
    configDir,
    settings: () => current,
  });
  return { root, dataDir, configDir, storage, follower };
}

/** Write lines to the live session's transcript and follow them. */
export async function followLines(
  world: TranscriptWorld,
  lines: string[],
): Promise<void> {
  const path = join(world.root, "sess-live.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  await world.follower.follow("sess-live", path);
}

/** The install moment the import tests pin, as the follower reads it. */
export const IMPORT_INSTALL = Date.parse("2026-10-24T09:00:00.000Z");

/**
 * A transcript world with an install stamp and one recorded
 * session, so proj-a is a known project the import may read.
 */
export function seedImportWorld(
  settings: Partial<Settings> = {},
): TranscriptWorld {
  const world = makeTranscriptWorld(settings);
  // The install stamp pins "first installed" for the test.
  writeFileSync(join(world.dataDir, "installed-at"), String(IMPORT_INSTALL));
  // One recorded session makes proj-a a known project.
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-known",
      source: "startup",
      cwd: "/home/user/proj-a",
    },
    IMPORT_INSTALL + 3_600_000,
  );
  return world;
}

/**
 * Place the lines as a session's transcript in the known
 * project and import it, as a session hooks never captured.
 */
export async function importTranscriptLines(
  sessionId: string,
  lines: string[],
): Promise<TranscriptWorld> {
  const world = seedImportWorld();
  const dir = join(
    world.configDir,
    "projects",
    encodeProjectPath("/home/user/proj-a"),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  const when = new Date(IMPORT_INSTALL + 60_000);
  utimesSync(path, when, when);
  await world.follower.importAll();
  return world;
}

export interface TelemetrySetupWorld {
  root: string;
  dataDir: string;
  configDir: string;
  managedDir: string;
  paths: SetupPaths;
}

export function makeTelemetrySetupWorld(): TelemetrySetupWorld {
  const root = makeTempRoot("flightpath-setup-");
  const dataDir = join(root, "data");
  const configDir = join(root, "claude");
  const managedDir = join(root, "managed");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(managedDir, { recursive: true });
  return {
    root,
    dataDir,
    configDir,
    managedDir,
    paths: setupPaths({ dataDir, configDir, managedDir }),
  };
}
