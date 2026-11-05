import { readFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

import { readDaemonAddress, writeFileAtomically } from "../util/fs.js";
import type { SettingSpec, Settings } from "./types.js";

export type { SettingSpec, Settings } from "./types.js";

// The plugin's settings (ADR-0022): one file in the data folder,
// read by the hook, the daemon and the commands through this one
// module. Every setting has a safe default, so the file can be
// missing; a value that fails validation is ignored, never fatal.
// The table below is the whole contract — adding a setting is one
// row here plus its use. This module imports nothing beyond
// node builtins (through util/fs, which is likewise builtins
// only) so the hook script loads it cheaply.

export const SETTING_SPECS: SettingSpec[] = [
  {
    name: "port",
    type: "port",
    default: 4747,
    description: "The port the daemon listens on, on this machine only.",
    note: "Saving a new port restarts the daemon on it; this page reloads at the new address.",
  },
  {
    name: "autostart",
    type: "boolean",
    default: true,
    description:
      "Record new sessions automatically. When off, a session records only after /flightpath:start is run in it.",
  },
  {
    name: "startupNotice",
    type: "boolean",
    default: true,
    description: "Print a one-line notice when a session starts recording.",
  },
  {
    name: "telemetry",
    type: "boolean",
    default: false,
    description:
      "Also record Claude Code's own telemetry — timings, token counts and tool outcomes, nothing you typed. It stays on this machine.",
    note: "Applies from the next session.",
  },
  {
    name: "excludedFolders",
    type: "folders",
    default: [],
    description:
      "Folders that are never recorded. Sessions working in them are dropped, as if paused. One folder per line.",
  },
  {
    name: "storePromptText",
    type: "boolean",
    default: true,
    description:
      "Keep the text of your prompts. Only the first 2,000 characters of each prompt are kept, with its full length and line count. When off, only the length of each prompt is kept.",
  },
  {
    name: "retentionDays",
    type: "days",
    default: 15,
    values: [7, 15, 30, 60, 90],
    description:
      "How many days of recordings to keep. Older recordings are deleted automatically, and the space is given back. A session still in progress is never deleted.",
  },
  {
    name: "idleShutdownMinutes",
    type: "minutes",
    default: 30,
    description:
      "How long the daemon waits with no events before it exits. The next event starts it again.",
  },
];

const SPEC_BY_NAME = new Map(SETTING_SPECS.map((spec) => [spec.name, spec]));

export function defaultSettings(): Settings {
  // Filled key by key from the table below; every spec writes
  // its key before the record is read as a whole Settings.
  const out = {} as Record<keyof Settings, unknown>;
  for (const spec of SETTING_SPECS) {
    out[spec.name] = Array.isArray(spec.default)
      ? [...spec.default]
      : spec.default;
  }
  return out as Settings;
}

function validateValue(
  spec: SettingSpec,
  value: unknown,
):
  | { ok: true; value: number | boolean | string[] }
  | { ok: false; error: string } {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: "must be on or off" };
    case "port":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 65535
        ? { ok: true, value }
        : { ok: false, error: "must be a whole number between 1 and 65535" };
    case "minutes":
      return typeof value === "number" && Number.isInteger(value) && value >= 5
        ? { ok: true, value }
        : { ok: false, error: "must be a whole number of 5 or more" };
    case "days":
      return typeof value === "number" &&
        spec.values !== undefined &&
        spec.values.includes(value)
        ? { ok: true, value }
        : {
            ok: false,
            error: `must be one of ${(spec.values ?? []).join(", ")}`,
          };
    case "folders":
      return Array.isArray(value) &&
        value.every((v) => typeof v === "string" && v.trim().length > 0)
        ? { ok: true, value: value.map((v) => v.trim()) }
        : { ok: false, error: "must be a list of folder paths" };
  }
}

export function loadSettings(
  dataDir: string,
  warn?: (message: string) => void,
): Settings {
  const settings = defaultSettings();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
  } catch {
    return settings; // No file yet, or unreadable: defaults throughout.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn?.("settings file is not an object; using defaults");
    return settings;
  }
  for (const [key, value] of Object.entries(parsed)) {
    const spec = SPEC_BY_NAME.get(key as keyof Settings);
    if (spec === undefined) continue; // A setting from a newer version.
    const result = validateValue(spec, value);
    if (result.ok) {
      // The value passed the spec's own check; the record write
      // is how a key the table names lands on the typed object.
      (settings as Record<keyof Settings, unknown>)[spec.name] = result.value;
    } else {
      warn?.(`setting ${spec.name} ignored (${result.error})`);
    }
  }
  return settings;
}

/** Writes are atomic: a reader never sees a half-written file. */
export function saveSettings(dataDir: string, settings: Settings): void {
  writeFileAtomically(
    join(dataDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

/**
 * Validate a settings change, as the settings endpoint receives
 * it: known keys only, each value checked. Returns the accepted
 * values, or an error message per field that failed.
 */
export function validateSettingsInput(
  input: unknown,
):
  | { ok: true; values: Partial<Settings> }
  | { ok: false; errors: Record<string, string> } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: { settings: "must be an object" } };
  }
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const spec = SPEC_BY_NAME.get(key as keyof Settings);
    if (spec === undefined) {
      errors[key] = "unknown setting";
      continue;
    }
    const result = validateValue(spec, value);
    if (result.ok) {
      values[spec.name] = result.value;
    } else {
      errors[spec.name] = result.error;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values: values as Partial<Settings> };
}

/** True when a path is written the Windows way: a drive letter or a UNC share. */
function isWindowsStyle(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");
}

/**
 * A path in the one form comparisons use: resolved, with `/`
 * separators. A Windows-style path folds case on every host —
 * the folder a session runs in doesn't change spelling because
 * the check runs somewhere else — and so does every path on
 * Windows itself, whose file system is case-insensitive.
 */
function comparablePath(path: string): string {
  const windowsStyle = isWindowsStyle(path);
  const resolved = windowsStyle ? win32.resolve(path) : resolve(path);
  const unified = resolved.replaceAll("\\", "/");
  return windowsStyle || process.platform === "win32"
    ? unified.toLowerCase()
    : unified;
}

/** True when `cwd` is one of the folders, or inside one of them. */
export function isExcludedFolder(cwd: string, folders: string[]): boolean {
  const target = comparablePath(cwd);
  for (const folder of folders) {
    const base = comparablePath(folder);
    if (target === base || target.startsWith(`${base}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The view's Settings screen address for this install, token
 * in the fragment so it never reaches a request log — or null
 * when the daemon has not run yet and there is nothing to
 * point at.
 */
export function settingsScreenUrl(dataDir: string): string | null {
  const address = readDaemonAddress(dataDir);
  if (address === null) return null;
  return `http://127.0.0.1:${address.port}/#settings&token=${address.token}`;
}
