// Claude Code's settings files: where they are and how they are
// read. Callers take only the keys they need out of them, so no
// other setting is kept (ADR-0004).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ManagedPaths } from "./setup/index.js";
import { resolveClaudeConfigDir } from "./transcripts/follower.js";
import { isPlainObject } from "./util/json.js";

export interface SettingsRead {
  settings: Record<string, unknown>[];
  /** A file was there but could not be read as a settings object,
   * so something it holds may be missing from `settings`. */
  unreadable: boolean;
}

/** The user's and the project's settings files. */
export function userAndProjectSettingsFiles(cwd: string): string[] {
  const configDir = resolveClaudeConfigDir();
  return [
    join(configDir, "settings.json"),
    join(configDir, "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
}

/** The managed settings file and the drop-in files beside it
 * that exist. */
export function managedSettingsFiles(paths: ManagedPaths): string[] {
  const files = existsSync(paths.managedSettingsPath)
    ? [paths.managedSettingsPath]
    : [];
  try {
    for (const name of readdirSync(paths.managedDropInDir).sort()) {
      if (name.endsWith(".json")) {
        files.push(join(paths.managedDropInDir, name));
      }
    }
  } catch {
    // No drop-in folder: the common case.
  }
  return files;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** The settings objects in the files; a file that is not there
 * is skipped, one that cannot be read is reported. */
export function readSettingsFiles(files: string[]): SettingsRead {
  const read: SettingsRead = { settings: [], unreadable: false };
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isPlainObject(parsed)) read.settings.push(parsed);
      else read.unreadable = true;
    } catch (error) {
      if (!isMissing(error)) read.unreadable = true;
    }
  }
  return read;
}

function denyRulesOf(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions;
  if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
    return [];
  }
  return permissions.deny.filter(
    (rule): rule is string => typeof rule === "string",
  );
}

/** Every `permissions.deny` rule from the user, project, local
 * and managed settings, read now. Undefined when a file could
 * not be read, because the rules it held are unknown. */
export function readDenyRules(
  cwd: string,
  managed: ManagedPaths,
): string[] | undefined {
  const { settings, unreadable } = readSettingsFiles([
    ...userAndProjectSettingsFiles(cwd),
    ...managedSettingsFiles(managed),
  ]);
  return unreadable ? undefined : settings.flatMap(denyRulesOf);
}
