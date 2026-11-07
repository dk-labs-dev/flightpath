if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\.js$/.test(process.argv[1])) process.stdout.write(`{"systemMessage":"● flightpath needs Node 24 or later; this is Node ${process.versions.node} · see Install in the README"}\n`); process.exit(0); }

// src/data-dir.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
function resolveDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "Flightpath"
    );
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Flightpath");
  }
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(xdg, "flightpath");
}
function pauseFileName(sessionId) {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}
function isRecordingOff(dataDir, event) {
  if (existsSync(join(dataDir, "off"))) {
    return true;
  }
  const sessionId = event.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 && existsSync(join(dataDir, "pause", pauseFileName(sessionId)));
}

// src/settings/index.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3, resolve, win32 } from "node:path";

// src/util/fs.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
function readDaemonAddress(dataDir) {
  try {
    const port = Number(readFileSync(join2(dataDir, "port"), "utf8").trim());
    const token = readFileSync(join2(dataDir, "token"), "utf8").trim();
    if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
      return null;
    }
    return { port, token };
  } catch {
    return null;
  }
}

// src/settings/index.ts
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
    parsed = JSON.parse(readFileSync2(join3(dataDir, "settings.json"), "utf8"));
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

// src/util/json.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textOf(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

// src/util/loopback.ts
import { connect } from "node:net";
var REPLY = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/;
function requestText(address, { method, path, body }) {
  const head = `${method} ${path} HTTP/1.0\r
Host: 127.0.0.1:${address.port}\r
x-flightpath-token: ${address.token}\r
`;
  if (body === void 0) return `${head}\r
`;
  return `${head}Content-Type: application/json\r
Content-Length: ${Buffer.byteLength(body)}\r
\r
${body}`;
}
function parseReply(raw) {
  const head = REPLY.exec(raw);
  if (head === null) return null;
  return { status: Number(head[1]), body: raw.slice(head[0].length) };
}
function loopbackRequest(address, request, timeoutMs) {
  return new Promise((resolvePromise) => {
    const socket = connect(address.port, "127.0.0.1");
    const timer = setTimeout(
      () => socket.destroy(new Error("timeout")),
      timeoutMs
    );
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(requestText(address, request)));
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", () => {
    });
    socket.on("close", (failed) => {
      clearTimeout(timer);
      resolvePromise(failed ? null : parseReply(raw));
    });
  });
}

// src/util/stdin-event.ts
import { readFileSync as readFileSync3 } from "node:fs";
function readStdinEvent() {
  let raw;
  try {
    raw = readFileSync3(0, "utf8");
  } catch {
    return null;
  }
  if (raw.trim().length === 0) {
    return null;
  }
  try {
    const payload = JSON.parse(raw);
    return isPlainObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

// src/line.ts
var LINE_WAIT_MS = 150;
function lineFrom(reply) {
  if (reply === null || reply.status !== 200) return null;
  try {
    const answer = JSON.parse(reply.body);
    return isPlainObject(answer) && typeof answer.line === "string" ? answer.line : null;
  } catch {
    return null;
  }
}
async function main() {
  const event = readStdinEvent();
  if (event === null || event.hook_event_name !== "Stop") return;
  const dataDir = resolveDataDir();
  if (isRecordingOff(dataDir, event)) return;
  const settings = loadSettings(dataDir);
  if (!settings.terminalLine) return;
  if (typeof event.cwd === "string" && isExcludedFolder(event.cwd, settings.excludedFolders)) {
    return;
  }
  const sessionId = textOf(event.session_id);
  const promptId = textOf(event.prompt_id);
  const address = readDaemonAddress(dataDir);
  if (sessionId === void 0 || promptId === void 0 || address === null) {
    return;
  }
  const reply = await loopbackRequest(
    address,
    {
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/terminal-line?prompt=${encodeURIComponent(promptId)}`
    },
    LINE_WAIT_MS
  );
  const line = lineFrom(reply);
  if (line !== null) {
    process.stdout.write(`${JSON.stringify({ systemMessage: line })}
`);
  }
}
try {
  await main();
} catch {
}
