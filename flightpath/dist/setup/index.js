// Telemetry setup (ADR-0023): turning Claude Code's telemetry
// on for Flightpath, from the settings screen, with consent — and
// turning it off again cleanly.
//
// Setup edits one file it does not own: the `env` block of the
// user's Claude Code settings. So the edit is careful: detect
// first and change nothing when telemetry is already configured
// somewhere (managed settings, the environment, the user's own
// settings); back the file up before writing; write atomically,
// preserving every other key and the existing key order; record
// exactly what was written, including any value of ours that
// replaced one of the user's; and on undo, remove only the
// recorded keys whose values are still the ones setup wrote.
//
// Detection of managed settings uses the file locations in the
// Claude Code settings docs (Deploy managed settings,
// code.claude.com): managed-settings.json under
// /Library/Application Support/ClaudeCode/ on macOS,
// /etc/claude-code/ on Linux, C:\Program Files\ClaudeCode\ on
// Windows.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { managedSettingsFiles } from "../settings-files.js";
import { errorMessage } from "../util/errors.js";
import { writeFileAtomically } from "../util/fs.js";
import { isPlainObject } from "../util/json.js";
/** The env keys setup writes, in the order it writes them. */
export const TELEMETRY_ENV_KEYS = [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_LOGS_EXPORT_INTERVAL",
    "OTEL_LOG_ASSISTANT_RESPONSES",
];
/** The exact values setup writes for a daemon port and token. */
export function telemetryEnvValues(port, token) {
    return {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_HEADERS: `x-flightpath-token=${token}`,
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
    };
}
/**
 * Keys whose presence in a source means telemetry routing is
 * configured there. Logging toggles and intervals are not
 * routing, so they are not detection keys.
 */
const DETECTION_KEYS = [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
];
/** The platform's managed settings folder (the docs cited above). */
function managedSettingsDir(platform) {
    if (platform === "darwin")
        return "/Library/Application Support/ClaudeCode";
    if (platform === "win32")
        return "C:\\Program Files\\ClaudeCode";
    return "/etc/claude-code";
}
/** Where the managed settings live, per platform (the docs cited above). */
export function managedPaths(platform, managedDir = managedSettingsDir(platform)) {
    // The managed folder is named for the target platform, so its
    // separators come from that platform's rules, not the host's.
    const joinFor = platform === "win32" ? win32.join : posix.join;
    return {
        managedSettingsPath: joinFor(managedDir, "managed-settings.json"),
        managedDropInDir: joinFor(managedDir, "managed-settings.d"),
    };
}
/** Where things live, per platform (the docs cited above). */
export function setupPaths(options) {
    return {
        dataDir: options.dataDir,
        userSettingsPath: join(options.configDir, "settings.json"),
        ...managedPaths(options.platform ?? process.platform, options.managedDir),
    };
}
const RECORD_FILE = "telemetry-setup.json";
const BACKUP_FILE = "telemetry-settings-backup.json";
/** The string-valued entries of a record read back from disk. */
function stringEntries(record) {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string")
            out[key] = value;
    }
    return out;
}
function readRecord(dataDir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dataDir, RECORD_FILE), "utf8"));
        if (isPlainObject(parsed) &&
            parsed.version === 1 &&
            typeof parsed.settingsPath === "string" &&
            isPlainObject(parsed.keys)) {
            return {
                version: 1,
                writtenAt: typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0,
                settingsPath: parsed.settingsPath,
                createdFile: parsed.createdFile === true,
                envExisted: parsed.envExisted === true,
                keys: stringEntries(parsed.keys),
                previous: isPlainObject(parsed.previous)
                    ? stringEntries(parsed.previous)
                    : {},
                backup: typeof parsed.backup === "string" ? parsed.backup : null,
            };
        }
    }
    catch {
        // No record, or an unreadable one: treated as no record.
    }
    return null;
}
function writeRecord(dataDir, record) {
    writeFileAtomically(join(dataDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}
function deleteRecord(dataDir) {
    rmSync(join(dataDir, RECORD_FILE), { force: true });
}
function readUserSettings(path) {
    if (!existsSync(path))
        return { ok: true, exists: false, parsed: {} };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        return {
            ok: false,
            message: `your Claude Code settings file (${path}) is not valid JSON (${errorMessage(error)}); nothing was changed`,
        };
    }
    if (!isPlainObject(parsed)) {
        return {
            ok: false,
            message: `your Claude Code settings file (${path}) does not hold a settings object; nothing was changed`,
        };
    }
    return { ok: true, exists: true, parsed };
}
function envBlock(parsed) {
    return isPlainObject(parsed.env) ? parsed.env : {};
}
function hasDetectionKey(env) {
    for (const key of DETECTION_KEYS) {
        const value = env[key];
        if (typeof value === "string" && value.length > 0)
            return key;
    }
    return null;
}
/** The managed settings' env block, when the file can be read. */
function managedConfig(paths) {
    const files = managedSettingsFiles(paths);
    let unreadable = false;
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            unreadable = true;
            continue;
        }
        if (isPlainObject(parsed) && hasDetectionKey(envBlock(parsed)) !== null) {
            return { found: true, unreadable };
        }
    }
    return { found: false, unreadable };
}
/**
 * Whether the daemon's environment routes telemetry somewhere
 * other than this daemon. The environment is whichever session
 * started the daemon, so this is best-effort — and an
 * environment that points at this daemon is setup's own doing
 * reflected back, not a foreign configuration.
 */
function envPointsElsewhere(env, ourEndpoint) {
    // An endpoint, when one is set, decides where telemetry
    // goes; setup's own endpoint reflected back is not foreign.
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (endpoint !== undefined && endpoint.length > 0) {
        return endpoint !== ourEndpoint;
    }
    const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    if (logsEndpoint !== undefined && logsEndpoint.length > 0) {
        return logsEndpoint !== ourEndpoint;
    }
    // Enabled, or an exporter chosen, with no endpoint naming
    // this daemon: an existing configuration we must not disturb.
    return DETECTION_KEYS.some((key) => {
        if (key === "OTEL_EXPORTER_OTLP_ENDPOINT")
            return false;
        if (key === "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
            return false;
        const value = env[key];
        return typeof value === "string" && value.length > 0;
    });
}
/**
 * What setup's record and the settings file's env block
 * decide on their own: the keys intact read as on, and keys
 * the user changed read as their own configuration. A
 * record whose keys are gone is stale — it decides nothing
 * until the environment has had its say.
 */
function settingsFileReading(paths, env) {
    const record = readRecord(paths.dataDir);
    if (record === null || record.settingsPath !== paths.userSettingsPath) {
        return { kind: "none" };
    }
    const intact = Object.entries(record.keys).every(([key, value]) => env[key] === value);
    if (intact) {
        return {
            kind: "state",
            state: {
                state: "on",
                endpoint: record.keys.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
            },
        };
    }
    if (hasDetectionKey(env) !== null) {
        return {
            kind: "state",
            state: {
                state: "elsewhere",
                where: "your Claude Code settings",
                detail: "The telemetry settings Flightpath wrote were changed in your Claude Code settings, so they count as your own configuration now. Flightpath will not change them.",
            },
        };
    }
    return { kind: "stale" };
}
/** The telemetry setup state, changing nothing. */
export function detectTelemetrySetup(options) {
    const { paths } = options;
    const ours = telemetryEnvValues(options.port, options.token);
    const managed = managedConfig(paths);
    if (managed.found || managed.unreadable) {
        return {
            state: "elsewhere",
            where: "managed settings",
            detail: managed.found
                ? `Telemetry is configured in ${paths.managedSettingsPath}, which overrides user settings. Flightpath will not change it.`
                : `A managed settings file exists at ${paths.managedSettingsPath} but could not be read, so Flightpath will not change anything.`,
        };
    }
    // The settings file is checked before the environment:
    // setup's own keys there, still holding setup's values,
    // read as on even when the daemon's environment carries
    // telemetry keys but no endpoint naming this daemon,
    // which the environment check alone reads as foreign.
    const read = readUserSettings(paths.userSettingsPath);
    if (!read.ok) {
        return { state: "error", message: read.message };
    }
    const env = envBlock(read.parsed);
    const reading = settingsFileReading(paths, env);
    if (reading.kind === "state") {
        return reading.state;
    }
    if (envPointsElsewhere(options.env, ours.OTEL_EXPORTER_OTLP_ENDPOINT)) {
        return {
            state: "elsewhere",
            where: "the environment",
            detail: "Telemetry is configured in the environment of the session that started the daemon (detection there is best-effort). Flightpath will not change it.",
        };
    }
    if (reading.kind === "stale") {
        // The record is stale (its keys were removed by hand): off.
        return { state: "off" };
    }
    if (hasDetectionKey(env) !== null) {
        return {
            state: "elsewhere",
            where: "your Claude Code settings",
            detail: `Telemetry is already configured in ${paths.userSettingsPath}. Flightpath will not change it.`,
        };
    }
    return { state: "off" };
}
function writeSettingsAtomic(path, parsed) {
    writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
/**
 * The file a write must land on. A settings file is often a
 * symlink into a dotfiles repository; renaming over the link
 * would replace the link itself and silently detach the file
 * from the repo, so writes go to the real file behind it.
 */
function settingsTarget(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/** Turn telemetry on for Flightpath. Only runs from `off`. */
export function applyTelemetrySetup(options) {
    const { paths } = options;
    const state = detectTelemetrySetup(options);
    if (state.state === "error") {
        return { ok: false, message: state.message };
    }
    if (state.state !== "off") {
        return {
            ok: false,
            message: state.state === "on"
                ? "Telemetry is already on for Flightpath."
                : state.detail,
        };
    }
    const read = readUserSettings(paths.userSettingsPath);
    if (!read.ok)
        return { ok: false, message: read.message };
    const parsed = read.parsed;
    const envExisted = isPlainObject(parsed.env);
    const env = { ...envBlock(parsed) };
    const values = telemetryEnvValues(options.port, options.token);
    const previous = {};
    for (const key of TELEMETRY_ENV_KEYS) {
        const existing = env[key];
        if (typeof existing === "string" && existing !== values[key]) {
            previous[key] = existing;
        }
        env[key] = values[key];
    }
    let backup = null;
    const target = settingsTarget(paths.userSettingsPath);
    // Before Claude Code's first run its config folder does not
    // exist yet; create it the way Claude Code itself would, so
    // the write below has somewhere to land.
    const folder = dirname(target);
    if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
    }
    if (read.exists) {
        copyFileSync(target, join(paths.dataDir, BACKUP_FILE));
        backup = BACKUP_FILE;
    }
    parsed.env = env;
    writeSettingsAtomic(target, parsed);
    writeRecord(paths.dataDir, {
        version: 1,
        writtenAt: Date.now(),
        settingsPath: paths.userSettingsPath,
        createdFile: !read.exists,
        envExisted,
        keys: values,
        previous,
        backup,
    });
    return {
        ok: true,
        message: "Telemetry is on for Flightpath from the next session. Your previous settings were backed up in Flightpath's data folder.",
        endpoint: values.OTEL_EXPORTER_OTLP_ENDPOINT,
    };
}
/**
 * Turn telemetry off: remove exactly the recorded keys whose
 * values are still the ones setup wrote, restoring any user
 * value setup had replaced. Keys the user edited stay, and are
 * reported.
 */
export function undoTelemetrySetup(options) {
    const { paths } = options;
    const record = readRecord(paths.dataDir);
    if (record === null) {
        return {
            ok: false,
            message: "Flightpath has no record of turning telemetry on.",
            removed: [],
            left: [],
        };
    }
    const read = readUserSettings(paths.userSettingsPath);
    if (!read.ok) {
        return { ok: false, message: read.message, removed: [], left: [] };
    }
    const parsed = read.parsed;
    const env = { ...envBlock(parsed) };
    const removed = [];
    const left = [];
    for (const [key, value] of Object.entries(record.keys)) {
        if (env[key] === value) {
            if (record.previous[key] !== undefined) {
                env[key] = record.previous[key];
            }
            else {
                delete env[key];
            }
            removed.push(key);
        }
        else if (key in env) {
            left.push(key);
        }
    }
    if (Object.keys(env).length === 0 && !record.envExisted) {
        delete parsed.env;
    }
    else {
        parsed.env = env;
    }
    if (record.createdFile && Object.keys(parsed).length === 0) {
        // Setup created the file and nothing of the user's is in
        // it: removing it restores the original absence.
        rmSync(paths.userSettingsPath, { force: true });
    }
    else {
        writeSettingsAtomic(settingsTarget(paths.userSettingsPath), parsed);
    }
    deleteRecord(paths.dataDir);
    return {
        ok: true,
        message: left.length === 0
            ? "Telemetry is off for Flightpath from the next session."
            : `Telemetry is off for Flightpath from the next session. These settings were left because you changed them: ${left.join(", ")}.`,
        removed,
        left,
    };
}
/**
 * A port change moves the endpoint setup wrote. Only the
 * recorded value is updated, and only while the settings still
 * hold it; an edited endpoint is the user's, not setup's.
 * Returns true when the endpoint moved.
 */
export function syncTelemetryEndpoint(options) {
    const { paths } = options;
    const record = readRecord(paths.dataDir);
    if (record === null)
        return false;
    const recorded = record.keys.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (recorded === undefined)
        return false;
    const values = telemetryEnvValues(options.port, options.token);
    if (recorded === values.OTEL_EXPORTER_OTLP_ENDPOINT)
        return false;
    const read = readUserSettings(paths.userSettingsPath);
    if (!read.ok)
        return false;
    const parsed = read.parsed;
    const env = { ...envBlock(parsed) };
    if (env.OTEL_EXPORTER_OTLP_ENDPOINT !== recorded)
        return false;
    env.OTEL_EXPORTER_OTLP_ENDPOINT = values.OTEL_EXPORTER_OTLP_ENDPOINT;
    parsed.env = env;
    writeSettingsAtomic(settingsTarget(paths.userSettingsPath), parsed);
    record.keys = {
        ...record.keys,
        OTEL_EXPORTER_OTLP_ENDPOINT: values.OTEL_EXPORTER_OTLP_ENDPOINT,
    };
    writeRecord(paths.dataDir, record);
    return true;
}
