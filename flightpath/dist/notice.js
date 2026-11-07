if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\.js$/.test(process.argv[1])) process.stdout.write(`{"systemMessage":"● flightpath needs Node 24 or later; this is Node ${process.versions.node} · see Install in the README"}\n`); process.exit(0); }

// src/notice.ts
import { existsSync, readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";

// src/buffer.ts
import { readdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/util/fs.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function readDaemonPid(dataDir) {
  try {
    const pid = Number(
      readFileSync(join(dataDir, "daemon.lock"), "utf8").trim()
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// src/buffer.ts
function bufferStats(dataDir) {
  let names;
  try {
    names = readdirSync(join2(dataDir, "buffer"));
  } catch {
    return { count: 0, oldestAt: null };
  }
  let oldestAt = null;
  for (const name of names) {
    const at = Number.parseInt(name, 10);
    if (Number.isFinite(at) && (oldestAt === null || at < oldestAt)) {
      oldestAt = at;
    }
  }
  return { count: names.length, oldestAt };
}

// src/data-dir.ts
import { homedir } from "node:os";
import { isAbsolute, join as join3 } from "node:path";
function resolveDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") {
    return join3(
      env.LOCALAPPDATA ?? join3(home, "AppData", "Local"),
      "Flightpath"
    );
  }
  if (platform === "darwin") {
    return join3(home, "Library", "Application Support", "Flightpath");
  }
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join3(home, ".local", "share");
  return join3(xdg, "flightpath");
}
function pauseFileName(sessionId) {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

// src/daemon/lock.ts
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function daemonLive(dataDir) {
  const pid = readDaemonPid(dataDir);
  return pid !== null && pidAlive(pid);
}

// src/settings/index.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4, resolve, win32 } from "node:path";
var SETTING_SPECS = [
  {
    name: "port",
    type: "port",
    default: 4747,
    description: "The port the daemon listens on, on this machine only.",
    note: "Saving a new port restarts the daemon on it; this page reloads at the new address."
  },
  {
    name: "autostart",
    type: "boolean",
    default: true,
    description: "Record new sessions automatically. When off, a session records only after /flightpath:start is run in it."
  },
  {
    name: "startupNotice",
    type: "boolean",
    default: true,
    description: "Print a one-line notice when a session starts recording."
  },
  {
    name: "terminalLine",
    type: "boolean",
    default: true,
    description: "Print a one-line note after Claude's reply when a turn has a suggestion worth a look."
  },
  {
    name: "telemetry",
    type: "boolean",
    default: false,
    description: "Also record Claude Code's own telemetry \u2014 timings, token counts and tool outcomes, nothing you typed. It stays on this machine.",
    note: "Applies from the next session."
  },
  {
    name: "excludedFolders",
    type: "folders",
    default: [],
    description: "Folders that are never recorded. Sessions working in them are dropped, as if paused. One folder per line."
  },
  {
    name: "storePromptText",
    type: "boolean",
    default: true,
    description: "Keep the text of your prompts. Only the first 2,000 characters of each prompt are kept, with its full length and line count. When off, only the length of each prompt is kept."
  },
  {
    name: "retentionDays",
    type: "days",
    default: 15,
    values: [7, 15, 30, 60, 90],
    description: "How many days of recordings to keep. Older recordings are deleted automatically, and the space is given back. A session still in progress is never deleted."
  },
  {
    name: "idleShutdownMinutes",
    type: "minutes",
    default: 30,
    description: "How long the daemon waits with no events before it exits. The next event starts it again."
  }
];
var SPEC_BY_NAME = new Map(SETTING_SPECS.map((spec) => [spec.name, spec]));
function defaultSettings() {
  const out = {};
  for (const spec of SETTING_SPECS) {
    out[spec.name] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return out;
}
function validateValue(spec, value) {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "must be on or off" };
    case "port":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? { ok: true, value } : { ok: false, error: "must be a whole number between 1 and 65535" };
    case "minutes":
      return typeof value === "number" && Number.isInteger(value) && value >= 5 ? { ok: true, value } : { ok: false, error: "must be a whole number of 5 or more" };
    case "days":
      return typeof value === "number" && spec.values !== void 0 && spec.values.includes(value) ? { ok: true, value } : {
        ok: false,
        error: `must be one of ${(spec.values ?? []).join(", ")}`
      };
    case "folders":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0) ? { ok: true, value: value.map((v) => v.trim()) } : { ok: false, error: "must be a list of folder paths" };
  }
}
function loadSettings(dataDir, warn) {
  const settings = defaultSettings();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(join4(dataDir, "settings.json"), "utf8"));
  } catch {
    return settings;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn?.("settings file is not an object; using defaults");
    return settings;
  }
  for (const [key, value] of Object.entries(parsed)) {
    const spec = SPEC_BY_NAME.get(key);
    if (spec === void 0) continue;
    const result = validateValue(spec, value);
    if (result.ok) {
      settings[spec.name] = result.value;
    } else {
      warn?.(`setting ${spec.name} ignored (${result.error})`);
    }
  }
  return settings;
}
function isWindowsStyle(path) {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");
}
function comparablePath(path) {
  const windowsStyle = isWindowsStyle(path);
  const resolved = windowsStyle ? win32.resolve(path) : resolve(path);
  const unified = resolved.replaceAll("\\", "/");
  return windowsStyle || process.platform === "win32" ? unified.toLowerCase() : unified;
}
function isExcludedFolder(cwd, folders) {
  const target = comparablePath(cwd);
  for (const folder of folders) {
    const base = comparablePath(folder);
    if (target === base || target.startsWith(`${base}/`)) {
      return true;
    }
  }
  return false;
}

// src/notice.ts
var RECORDING = "\u25CF flightpath is recording \xB7 /flightpath:status for settings";
var EXCLUDED = "\u25CF flightpath isn't recording this folder \xB7 it's in Folders never recorded in Settings";
var PAUSED = "\u25CF flightpath is paused \xB7 /flightpath:start to record";
var OFF = "\u25CF flightpath is off \xB7 /flightpath:start to turn it on";
var WARNING = "\u25CF flightpath can't start its recorder \xB7 /flightpath:status for details";
var BUFFER_STALE_MS = 12e4;
function main() {
  let raw;
  try {
    raw = readFileSync4(0, "utf8");
  } catch {
    return;
  }
  if (raw.trim().length === 0) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const event = payload;
  if (event.hook_event_name !== "SessionStart") return;
  if (event.source !== "startup" && event.source !== "clear" && event.source !== "fork") {
    return;
  }
  const dataDir = resolveDataDir();
  const off = existsSync(join5(dataDir, "off"));
  const stats = bufferStats(dataDir);
  if (!off && stats.oldestAt !== null && Date.now() - stats.oldestAt >= BUFFER_STALE_MS && !daemonLive(dataDir)) {
    process.stdout.write(`${JSON.stringify({ systemMessage: WARNING })}
`);
    return;
  }
  const settings = loadSettings(dataDir);
  if (!settings.startupNotice) return;
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  const cwd = typeof event.cwd === "string" ? event.cwd : "";
  const excluded = cwd.length > 0 && isExcludedFolder(cwd, settings.excludedFolders);
  const paused = !settings.autostart || sessionId.length > 0 && existsSync(join5(dataDir, "pause", pauseFileName(sessionId)));
  let line = RECORDING;
  if (off) {
    line = OFF;
  } else if (excluded) {
    line = EXCLUDED;
  } else if (paused) {
    line = PAUSED;
  }
  process.stdout.write(`${JSON.stringify({ systemMessage: line })}
`);
}
try {
  main();
} catch {
}
