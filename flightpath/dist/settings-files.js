// Claude Code's settings files: where they are and how they are
// read. Callers take only the keys they need out of them, so no
// other setting is kept (ADR-0004).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeConfigDir } from "./transcripts/follower.js";
import { isPlainObject } from "./util/json.js";
/** The user's and the project's settings files. */
export function userAndProjectSettingsFiles(cwd) {
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
export function managedSettingsFiles(paths) {
    const files = existsSync(paths.managedSettingsPath)
        ? [paths.managedSettingsPath]
        : [];
    try {
        for (const name of readdirSync(paths.managedDropInDir).sort()) {
            if (name.endsWith(".json")) {
                files.push(join(paths.managedDropInDir, name));
            }
        }
    }
    catch {
        // No drop-in folder: the common case.
    }
    return files;
}
function isMissing(error) {
    return error.code === "ENOENT";
}
/** The settings objects in the files; a file that is not there
 * is skipped, one that cannot be read is reported. */
export function readSettingsFiles(files) {
    const read = { settings: [], unreadable: false };
    for (const file of files) {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            if (isPlainObject(parsed))
                read.settings.push(parsed);
            else
                read.unreadable = true;
        }
        catch (error) {
            if (!isMissing(error))
                read.unreadable = true;
        }
    }
    return read;
}
function denyRulesOf(settings) {
    const permissions = settings.permissions;
    if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
        return [];
    }
    return permissions.deny.filter((rule) => typeof rule === "string");
}
/** Every `permissions.deny` rule from the user, project, local
 * and managed settings, read now. Undefined when a file could
 * not be read, because the rules it held are unknown. */
export function readDenyRules(cwd, managed) {
    const { settings, unreadable } = readSettingsFiles([
        ...userAndProjectSettingsFiles(cwd),
        ...managedSettingsFiles(managed),
    ]);
    return unreadable ? undefined : settings.flatMap(denyRulesOf);
}
