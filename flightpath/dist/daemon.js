#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\.js$/.test(process.argv[1])) process.stdout.write(`{"systemMessage":"● flightpath needs Node 24 or later; this is Node ${process.versions.node} · see Install in the README"}\n`); process.exit(0); }

// src/daemon.ts
import { homedir as homedir3 } from "node:os";

// src/data-dir.ts
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

// src/daemon/last-error.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/util/errors.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/util/fs.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
function writeFileAtomically(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}
function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch {
  }
}

// src/daemon/last-error.ts
var LAST_ERROR_FILE = "last-error";
var MESSAGE_CAP = 300;
var UNEXPECTED = "unexpected error (details in daemon.log)";
function errorCode(error) {
  if (typeof error !== "object" || error === null) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}
function nameable(error, code) {
  if (code === "EADDRINUSE" || code === "EACCES") return true;
  if (code !== null && code.startsWith("ERR_SQLITE")) return true;
  if (typeof error !== "object" || error === null) return false;
  if (typeof error.errcode === "number") {
    return true;
  }
  return error.databaseOpen === true;
}
function writeLastError(dataDir, error) {
  const code = errorCode(error);
  let message = UNEXPECTED;
  if (nameable(error, code)) {
    const raw = errorMessage(error);
    message = raw.split(/\r?\n/, 1)[0]?.slice(0, MESSAGE_CAP) ?? "";
  }
  const entry = {
    at: Date.now(),
    message,
    ...code !== null ? { code } : {}
  };
  writeFileSync2(join2(dataDir, LAST_ERROR_FILE), `${JSON.stringify(entry)}
`);
}
function readLastError(dataDir) {
  try {
    const parsed = JSON.parse(
      readFileSync2(join2(dataDir, LAST_ERROR_FILE), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed;
    if (typeof entry.at !== "number" || typeof entry.message !== "string") {
      return null;
    }
    return {
      at: entry.at,
      message: entry.message,
      ...typeof entry.code === "string" ? { code: entry.code } : {}
    };
  } catch {
    return null;
  }
}
function clearLastError(dataDir) {
  unlinkIfPresent(join2(dataDir, LAST_ERROR_FILE));
}
function startProblem(lastError, dataDir) {
  const { message, code } = lastError;
  if (code === "EADDRINUSE" || code === "EACCES" || /EADDRINUSE|address already in use/.test(message)) {
    const port = /:(\d+)$/.exec(message.trim())?.[1];
    const reason = code === "EACCES" || /EACCES/.test(message) ? "not-allowed" : "in-use";
    return {
      kind: "port",
      port: port === void 0 ? null : Number(port),
      reason
    };
  }
  if (/database|sqlite|malformed/i.test(message)) {
    return { kind: "database", path: join2(dataDir, "flightpath.db") };
  }
  return { kind: "other" };
}

// src/daemon/log.ts
import { appendFileSync, mkdirSync, renameSync as renameSync2, statSync } from "node:fs";
import { join as join3 } from "node:path";
var MAX_LOG_BYTES = 256 * 1024;
function daemonLog(dataDir, message) {
  try {
    const dir = join3(dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    const path = join3(dir, "daemon.log");
    try {
      if (statSync(path).size >= MAX_LOG_BYTES) {
        renameSync2(path, `${path}.1`);
      }
    } catch {
    }
    appendFileSync(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
  } catch {
  }
}

// src/daemon/server.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync11,
  readdirSync as readdirSync4,
  renameSync as renameSync3,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync6
} from "node:fs";
import { createServer } from "node:http";
import { join as join12 } from "node:path";

// src/buffer.ts
import { readdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
var DROPPED_FILE = "buffer-dropped";
function bufferStats(dataDir) {
  let names;
  try {
    names = readdirSync(join4(dataDir, "buffer"));
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
function droppedCount(dataDir) {
  try {
    const value = Number.parseInt(
      readFileSync3(join4(dataDir, DROPPED_FILE), "utf8").trim(),
      10
    );
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
function resetDropped(dataDir) {
  unlinkIfPresent(join4(dataDir, DROPPED_FILE));
}

// src/settings/index.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join5, resolve, win32 } from "node:path";
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
    parsed = JSON.parse(readFileSync4(join5(dataDir, "settings.json"), "utf8"));
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
function saveSettings(dataDir, settings) {
  writeFileAtomically(
    join5(dataDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}
`
  );
}
function validateSettingsInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: { settings: "must be an object" } };
  }
  const values = {};
  const errors = {};
  for (const [key, value] of Object.entries(input)) {
    const spec = SPEC_BY_NAME.get(key);
    if (spec === void 0) {
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
  return { ok: true, values };
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

// src/storage/index.ts
import { mkdirSync as mkdirSync2, statSync as statSync3 } from "node:fs";
import { join as join8 } from "node:path";

// src/commands.ts
var COMMAND_ACTIONS = [
  "status",
  "stop",
  "start",
  "off",
  "forget",
  "open"
];
var EXPANDED_FORM = /^<command-message>[^<]*<\/command-message>\s*<command-name>([^<\s]+)<\/command-name>/;
function expandedCommandName(prompt) {
  return EXPANDED_FORM.exec(prompt)?.[1] ?? null;
}
function isFlightpathCommand(text) {
  const name = (expandedCommandName(text) ?? text).replace(/^\//, "");
  for (const action of COMMAND_ACTIONS) {
    const command = `flightpath:${action}`;
    if (name === command) return true;
    if (name.startsWith(command) && /\s/.test(name.charAt(command.length))) {
      return true;
    }
  }
  return false;
}

// src/effort.ts
var EFFORT_LEVELS = /* @__PURE__ */ new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
function effortLevel(value) {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  return EFFORT_LEVELS.has(level) ? level : null;
}

// src/prompt-kind.ts
var AGENT_MESSAGE_OPENING = "<agent-message";
var TASK_NOTIFICATION_OPENING = "<task-notification>";
function isAgentMessage(prompt) {
  return prompt.trimStart().startsWith(`${AGENT_MESSAGE_OPENING} from="`);
}

// src/settings-files.ts
import { existsSync as existsSync2, readFileSync as readFileSync6, readdirSync as readdirSync3 } from "node:fs";
import { join as join7 } from "node:path";

// src/transcripts/follower.ts
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync as readFileSync5,
  readSync,
  readdirSync as readdirSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname, isAbsolute as isAbsolute2, join as join6, relative, sep } from "node:path";

// src/redact/allowlist.ts
var COMMON_TEXT_KEYS = /* @__PURE__ */ new Set([
  "session_id",
  "prompt_id",
  "transcript_path",
  "cwd",
  "permission_mode",
  "hook_event_name",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_use_id"
]);
var EVENT_TEXT_KEYS = {
  UserPromptSubmit: ["prompt", "prompt_kind"],
  UserPromptExpansion: ["command_name", "command_args", "command_source"],
  SessionStart: ["source", "model"],
  Notification: ["notification_type"],
  PreCompact: ["trigger"],
  PostCompact: ["trigger"],
  InstructionsLoaded: ["file_path", "memory_type"]
};
var EVENT_PROMPT_KEY = {
  UserPromptSubmit: "prompt",
  UserPromptExpansion: "command_args"
};
var EVENT_ARRAY_ITEM_TEXT_KEYS = {
  PostToolBatch: { tool_calls: ["tool_use_id", "tool_name"] }
};
var TOOL_INPUT_TEXT_KEYS = /* @__PURE__ */ new Set([
  "file_path",
  "notebook_path",
  "path",
  "command",
  "description",
  "pattern",
  "glob",
  "url",
  "skill",
  "subagent_type"
]);
var KNOWN_TOOLS = /* @__PURE__ */ new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Skill",
  "TodoWrite",
  "AskUserQuestion"
]);
var ASK_USER_QUESTION_TEXT_KEYS = /* @__PURE__ */ new Set([
  "question",
  "header",
  "label",
  "answers",
  "answer"
]);
var HOOK_EFFORT_TEXT = /* @__PURE__ */ new Set(["level"]);
var TELEMETRY_TEXT_KEYS = /* @__PURE__ */ new Set([
  "event.name",
  "tool_name",
  "model",
  "query_source",
  "effort",
  "agent_type",
  "decision",
  "source",
  "classifier_verdict",
  "permission_mode",
  "session.id",
  "prompt.id",
  "request_id",
  "tool_use_id",
  "skill.name",
  "hook_name",
  "hook_event"
]);
var TELEMETRY_NUMERIC_KEYS = /* @__PURE__ */ new Set([
  "duration_ms",
  "total_duration_ms",
  "num_hooks",
  "prompt_length",
  "pre_tokens",
  "post_tokens"
]);
var TELEMETRY_BOOLEAN_KEYS = /* @__PURE__ */ new Set(["success"]);
var TELEMETRY_IDENTITY_KEY = /email|account|organi[sz]ation|org_?id|user_?id|user\.id/i;
var TELEMETRY_COST_KEY = /cost/i;
var TRANSCRIPT_ENTRY_TEXT = /* @__PURE__ */ new Set([
  "type",
  "sessionId",
  "uuid",
  "parentUuid",
  "timestamp",
  "requestId"
]);
var TRANSCRIPT_MESSAGE_TEXT = /* @__PURE__ */ new Set([
  "role",
  "model",
  "id"
]);

// src/redact/secrets.ts
var MYSQL_CLIENT = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/;
var PATTERNS = [
  // Private key blocks span lines; match the whole block first so the
  // base64 body can't trip other patterns on its own.
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[redacted:private-key]"
  },
  {
    kind: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "[redacted:aws-access-key]"
  },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: "[redacted:github-token]"
  },
  {
    kind: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
    replace: "[redacted:anthropic-key]"
  },
  {
    kind: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: "[redacted:openai-key]"
  },
  {
    kind: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "[redacted:slack-token]"
  },
  {
    kind: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: "[redacted:google-api-key]"
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: "[redacted:jwt]"
  },
  // Credentials embedded in a URL: scheme://user:password@host — keep
  // the user and the host, replace only the password.
  {
    kind: "url-password",
    pattern: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/g,
    replace: "$1[redacted:url-password]$2"
  },
  // Authorization headers and bearer tokens. The header form runs
  // first so "Authorization: Bearer x" is one replacement, not two.
  {
    kind: "authorization",
    pattern: /\b(Authorization\s*:\s*)(?:(?:Bearer|Basic|Token)\s+)?\S+/gi,
    replace: "$1[redacted:authorization]"
  },
  {
    kind: "bearer",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    replace: "$1[redacted:bearer]"
  },
  // Password and token flags: --password value, --token=value. The word
  // boundary plus the flag name keeps unrelated flags alone.
  {
    kind: "flag-value",
    pattern: /(--(?:password|passwd|token|api-key|apikey|secret|auth))(=|\s+)\S+/gi,
    replace: "$1$2[redacted:flag-value]"
  },
  // MySQL-family clients take the password as -p with the value
  // attached (mysql -psecret) or following it (mysql -p secret; the
  // spaced form requires a non-numeric value, so a port is left
  // alone). Both forms apply only to those clients (see MYSQL_CLIENT).
  {
    kind: "flag-value",
    pattern: /(^|\s)(-p)([^\s-]\S*)/g,
    replace: "$1$2[redacted:flag-value]",
    mysqlOnly: true
  },
  {
    kind: "flag-value",
    pattern: /(^|\s)(-p\s+)(?!\d+\b)\S+/g,
    replace: "$1$2[redacted:flag-value]",
    mysqlOnly: true
  },
  // Assignments whose name marks the value as a secret: API_KEY=...,
  // session_token: "...", DB_PASSWORD=hunter2. Runs last so a value
  // that is itself a known token shape has already been replaced by
  // kind.
  {
    kind: "env-secret",
    pattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: "$1[redacted:env-secret]"
  },
  // The bare names, PASSWORD=... and TOKEN=...: the pattern above
  // needs a character before the suffix, so these need their own.
  // Assignment form only, so prose like "password: required" is safe,
  // and the lookbehind keeps it out of --token=..., which the flag
  // pattern above already handles.
  {
    kind: "env-secret",
    pattern: /(?<![\w-])((?:PASSWORD|TOKEN)\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: "$1[redacted:env-secret]"
  }
];
function scrubSecrets(text) {
  const mysql = MYSQL_CLIENT.test(text);
  let out = text;
  for (const { pattern, replace, mysqlOnly } of PATTERNS) {
    if (mysqlOnly && !mysql) {
      continue;
    }
    out = out.replace(pattern, replace);
  }
  return out;
}

// src/storage/prompt-text.ts
var PROMPT_TEXT_LIMIT = 2e3;
function cutPromptText(text) {
  if (text.length <= PROMPT_TEXT_LIMIT) {
    return text;
  }
  const stored = text.slice(0, PROMPT_TEXT_LIMIT);
  const last = stored.charCodeAt(stored.length - 1);
  return last >= 55296 && last <= 56319 ? stored.slice(0, -1) : stored;
}
function promptTextColumns(text) {
  if (text === null) {
    return { text: null, chars: null, lines: null };
  }
  return {
    text: cutPromptText(text),
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split("\n").length
  };
}
var UPDATE_TURN_PROMPT = "UPDATE turns SET prompt_text = ?, prompt_chars = ?, prompt_lines = ? WHERE id = ?";
var UPDATE_TURN_PROMPT_IF_UNSET = `${UPDATE_TURN_PROMPT} AND prompt_text IS NULL`;
var FILL_TURN_PROMPT_FIGURES = "UPDATE turns SET prompt_chars = ?, prompt_lines = ? WHERE id = ? AND prompt_chars IS NULL";
function preparePromptTextStatements(db) {
  return {
    setTurnPrompt: db.prepare(UPDATE_TURN_PROMPT),
    fillTurnPrompt: db.prepare(UPDATE_TURN_PROMPT_IF_UNSET),
    fillTurnFigures: db.prepare(FILL_TURN_PROMPT_FIGURES)
  };
}
function setTurnPromptColumns(st, turnId, columns) {
  st.setTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}
function fillTurnPromptText(st, turnId, text) {
  const columns = promptTextColumns(text);
  st.fillTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}
function fillTurnPromptFigures(st, turnId, chars, lines) {
  st.fillTurnFigures.run(chars, lines, turnId);
}

// src/util/json.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRecord(text) {
  if (text === null) {
    return {};
  }
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}
function bool(record, key) {
  return record[key] === true;
}
function charsOf(record, key) {
  const value = record[key];
  if (!isPlainObject(value)) {
    return void 0;
  }
  return typeof value.chars === "number" ? value.chars : void 0;
}
function textOf(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function countOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function str(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function num(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function obj(record, key) {
  const value = record[key];
  return isPlainObject(value) ? value : void 0;
}
function asText(value) {
  return typeof value === "string" ? value : null;
}
function numberValue(value) {
  return typeof value === "number" ? value : null;
}
function parseStringArray(text) {
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "string");
  } catch {
    return [];
  }
}
function textAttr(attrs, key) {
  const value = attrs.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}
function numAttr(attrs, key) {
  const value = attrs.get(key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function boolAttr(attrs, key) {
  const value = attrs.get(key);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

// src/redact/index.ts
var REDACTION_VERSION = 1;
var NO_TEXT = /* @__PURE__ */ new Set();
function sizeOf(text) {
  return { chars: text.length };
}
function walkValue(value, keepText) {
  if (typeof value === "string") {
    return keepText ? scrubSecrets(value) : sizeOf(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkValue(item, false));
  }
  if (isPlainObject(value)) {
    return walkObject(value, NO_TEXT);
  }
  return value;
}
function walkObject(obj2, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj2)) {
    out[scrubSecrets(key)] = walkValue(value, textKeys.has(key));
  }
  return out;
}
function walkDeepObject(obj2, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj2)) {
    out[scrubSecrets(key)] = (key === "answers" || key === "answer") && isPlainObject(value) ? redactAnswersMap(value, textKeys) : walkDeepValue(value, textKeys.has(key), textKeys);
  }
  return out;
}
function redactAnswersMap(obj2, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj2)) {
    if (typeof value === "string") {
      out[scrubSecrets(key)] = scrubSecrets(value);
    } else if (Array.isArray(value)) {
      out[scrubSecrets(key)] = value.map(
        (item) => typeof item === "string" ? scrubSecrets(item) : walkDeepValue(item, false, textKeys)
      );
    } else {
      out[scrubSecrets(key)] = walkDeepValue(value, false, textKeys);
    }
  }
  return out;
}
function walkDeepValue(value, keepText, textKeys) {
  if (typeof value === "string") {
    return keepText ? scrubSecrets(value) : sizeOf(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkDeepValue(item, false, textKeys));
  }
  if (isPlainObject(value)) {
    return walkDeepObject(value, textKeys);
  }
  return value;
}
function redactToolInput(toolName, value) {
  if (!isPlainObject(value)) {
    return walkValue(value, false);
  }
  if (toolName === "AskUserQuestion") {
    return walkDeepObject(value, ASK_USER_QUESTION_TEXT_KEYS);
  }
  if (!KNOWN_TOOLS.has(toolName)) {
    return walkObject(value, NO_TEXT);
  }
  return walkObject(value, TOOL_INPUT_TEXT_KEYS);
}
function redactToolResponse(toolName, value) {
  if (toolName === "AskUserQuestion" && isPlainObject(value)) {
    return walkDeepObject(value, ASK_USER_QUESTION_TEXT_KEYS);
  }
  return walkValue(value, false);
}
function redactHookEvent(payload) {
  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const textKeys = /* @__PURE__ */ new Set([
    ...COMMON_TEXT_KEYS,
    ...EVENT_TEXT_KEYS[eventName] ?? []
  ]);
  const arrayItemKeys = EVENT_ARRAY_ITEM_TEXT_KEYS[eventName] ?? {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "tool_input") {
      out[scrubSecrets(key)] = redactToolInput(toolName, value);
    } else if (key === "effort" && isPlainObject(value)) {
      out[scrubSecrets(key)] = walkObject(value, HOOK_EFFORT_TEXT);
    } else if (key === "tool_response") {
      out[scrubSecrets(key)] = redactToolResponse(toolName, value);
    } else if (arrayItemKeys[key] !== void 0 && Array.isArray(value)) {
      const itemKeys = new Set(arrayItemKeys[key]);
      out[scrubSecrets(key)] = value.map(
        (item) => isPlainObject(item) ? walkObject(item, itemKeys) : walkValue(item, false)
      );
    } else {
      const kept = walkValue(value, textKeys.has(key));
      out[scrubSecrets(key)] = typeof kept === "string" && EVENT_PROMPT_KEY[eventName] === key ? cutPromptText(kept) : kept;
    }
  }
  out.redaction_version = REDACTION_VERSION;
  return out;
}
function isAttributeEntry(value) {
  return isPlainObject(value) && typeof value.key === "string" && "value" in value && Object.keys(value).length === 2;
}
function redactAttributeEntry(entry) {
  const key = scrubSecrets(entry.key);
  const value = entry.value;
  if (isPlainObject(value) && ("intValue" in value || "doubleValue" in value || "boolValue" in value)) {
    return { key, value };
  }
  if (isPlainObject(value) && typeof value.stringValue === "string") {
    if (TELEMETRY_TEXT_KEYS.has(entry.key)) {
      return {
        key,
        value: { stringValue: scrubSecrets(value.stringValue) }
      };
    }
    if (TELEMETRY_NUMERIC_KEYS.has(entry.key) && value.stringValue.trim().length > 0 && Number.isFinite(Number(value.stringValue))) {
      return { key, value: { stringValue: value.stringValue } };
    }
    if (TELEMETRY_BOOLEAN_KEYS.has(entry.key) && (value.stringValue === "true" || value.stringValue === "false")) {
      return { key, value: { stringValue: value.stringValue } };
    }
    return { key, value: sizeOf(value.stringValue) };
  }
  return { key, value: redactTelemetryValue(value) };
}
function redactTelemetryValue(value) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isAttributeEntry)) {
      return value.filter(
        (entry) => !TELEMETRY_IDENTITY_KEY.test(entry.key) && !TELEMETRY_COST_KEY.test(entry.key)
      ).map(redactAttributeEntry);
    }
    return value.map(redactTelemetryValue);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (TELEMETRY_IDENTITY_KEY.test(key) || TELEMETRY_COST_KEY.test(key)) {
        continue;
      }
      out[scrubSecrets(key)] = typeof item === "string" && key === "eventName" ? scrubSecrets(item) : redactTelemetryValue(item);
    }
    return out;
  }
  if (typeof value === "string") {
    return sizeOf(value);
  }
  return value;
}
function redactTelemetryRecord(record) {
  const out = redactTelemetryValue(record);
  out.redaction_version = REDACTION_VERSION;
  return out;
}
function redactContentBlock(block) {
  if (!isPlainObject(block)) {
    return walkValue(block, false);
  }
  const type = typeof block.type === "string" ? block.type : "";
  const out = {};
  for (const [key, value] of Object.entries(block)) {
    const keepText = key === "type" || type === "tool_use" && (key === "id" || key === "name") || type === "tool_result" && key === "tool_use_id";
    out[scrubSecrets(key)] = walkValue(value, keepText);
  }
  return out;
}
function redactTranscriptMessage(message) {
  const out = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "content" && Array.isArray(value)) {
      out[key] = value.map(redactContentBlock);
    } else {
      out[scrubSecrets(key)] = walkValue(
        value,
        TRANSCRIPT_MESSAGE_TEXT.has(key)
      );
    }
  }
  return out;
}
function redactTranscriptEntry(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "message" && isPlainObject(value)) {
      out[key] = redactTranscriptMessage(value);
    } else {
      out[scrubSecrets(key)] = walkValue(value, TRANSCRIPT_ENTRY_TEXT.has(key));
    }
  }
  out.redaction_version = REDACTION_VERSION;
  return out;
}

// src/storage/request-tokens.ts
var REQUEST_TOKEN_SUM = "COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_1h_tokens, 0)";
function requestTotalTokens(request) {
  return (request.inputTokens ?? 0) + (request.outputTokens ?? 0) + (request.cacheReadTokens ?? 0) + (request.cacheWrite5mTokens ?? 0) + (request.cacheWrite1hTokens ?? 0);
}
function requestContextTokens(request) {
  return (request.inputTokens ?? 0) + (request.cacheReadTokens ?? 0) + (request.cacheWrite5mTokens ?? 0) + (request.cacheWrite1hTokens ?? 0);
}
function cacheWriteTokens(request) {
  if (request.cacheWrite5mTokens === null && request.cacheWrite1hTokens === null) {
    return null;
  }
  return (request.cacheWrite5mTokens ?? 0) + (request.cacheWrite1hTokens ?? 0);
}
var OVERHEAD_SQL = `SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) AS total
  FROM requests r JOIN turns t ON t.id = r.turn_id
  WHERE r.session_id = ? AND t.flightpath_command = 1`;

// src/util/event-loop.ts
function yieldToEventLoop() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

// src/transcripts/parse.ts
var CLAUDE_OPENINGS = [
  { marker: "<command-name>", command: true },
  { marker: "<local-command-stdout>", command: true },
  { marker: "<local-command-stderr>", command: true },
  { marker: "<local-command-caveat>", command: false },
  { marker: TASK_NOTIFICATION_OPENING, command: false },
  { marker: AGENT_MESSAGE_OPENING, command: false }
];
var NON_PROMPT_OPENINGS = CLAUDE_OPENINGS.map(
  (opening) => opening.marker
);
var COMMAND_OPENINGS = CLAUDE_OPENINGS.filter(
  (opening) => opening.command
).map((opening) => opening.marker);
function isTypedPrompt(parsed) {
  if (parsed.originKind !== null && parsed.originKind !== "human") {
    return false;
  }
  return !parsed.opensWithClaudeOpening;
}
var COMMAND_NAME = /^<command-name>\s*(\S+?)\s*<\/command-name>/;
var CONTEXT_REPORT_OPENING = "## Context Usage";
function commandNameOf(entry, texts) {
  const opening = texts[0]?.trimStart() ?? "";
  if (entry.isMeta === true && opening.startsWith(CONTEXT_REPORT_OPENING)) {
    return "/context";
  }
  return COMMAND_NAME.exec(opening)?.[1] ?? null;
}
function claudeMessageOf(entry, origin, texts, chars) {
  const originKind = origin === void 0 ? void 0 : textOf(origin.kind);
  if (originKind === "peer" && origin?.handback === true) {
    return {
      kind: "handback",
      agentType: textOf(origin.name) ?? null,
      agentId: textOf(origin.from) ?? null,
      chars
    };
  }
  if (originKind === "task-notification") return { kind: "notice", chars };
  if (originKind !== void 0) return null;
  const name = commandNameOf(entry, texts);
  return name === null ? null : { kind: "command", name: scrubSecrets(name) };
}
var INTERRUPT_TEXTS = /* @__PURE__ */ new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]"
]);
function timestampOf(entry) {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
function versionOf(entry) {
  return textOf(entry.version);
}
function readContent(content) {
  const blocks = {
    texts: [],
    toolResultSizes: /* @__PURE__ */ new Map(),
    errorResultIds: [],
    interruptResultIds: [],
    images: []
  };
  if (typeof content === "string") {
    blocks.texts.push(content);
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.texts.push(block.text);
    } else if (block.type === "image") {
      const source = isPlainObject(block.source) ? block.source : void 0;
      blocks.images.push({
        mediaType: source !== void 0 ? textOf(source.media_type) ?? null : null,
        bytes: source !== void 0 && typeof source.data === "string" ? source.data.length : 0
      });
    } else if (block.type === "tool_result") {
      const id = textOf(block.tool_use_id);
      if (id === void 0) continue;
      const texts = toolResultTexts(block.content);
      blocks.toolResultSizes.set(id, {
        chars: texts.reduce((sum, text) => sum + text.length, 0),
        images: toolResultImages(block.content),
        asyncLaunch: false,
        savedBytes: savedOutputBytes(texts)
      });
      if (block.is_error === true) blocks.errorResultIds.push(id);
      if (texts.some((text) => INTERRUPT_TEXTS.has(text.trim()))) {
        blocks.interruptResultIds.push(id);
      }
    }
  }
  return blocks;
}
function toolResultTexts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part) => isPlainObject(part) && part.type === "text" && typeof part.text === "string"
  ).map((part) => part.text);
}
var SAVED_OUTPUT_OPENING = "<persisted-output>";
var SAVED_OUTPUT_SIZE = /Output too large \((\d+(?:\.\d+)?)(KB|MB)\)/;
function savedOutputBytes(texts) {
  const notice = texts.find(
    (text) => text.trimStart().startsWith(SAVED_OUTPUT_OPENING)
  );
  const size = notice === void 0 ? null : SAVED_OUTPUT_SIZE.exec(notice);
  if (size?.[1] === void 0) return null;
  return Math.round(Number(size[1]) * (size[2] === "MB" ? 1e6 : 1e3));
}
function markAsyncLaunch(results, toolUseResult) {
  if (!isPlainObject(toolUseResult) || results.size !== 1) return;
  if (toolUseResult.status !== "async_launched") return;
  for (const size of results.values()) size.asyncLaunch = true;
}
function toolResultImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => isPlainObject(part) && part.type === "image").length;
}
function usageOf(message) {
  const usage = message.usage;
  if (!isPlainObject(usage)) return void 0;
  const inputTokens = countOf(usage.input_tokens);
  const outputTokens = countOf(usage.output_tokens);
  if (inputTokens === void 0 || outputTokens === void 0) {
    return void 0;
  }
  let cacheWrite5mTokens = null;
  let cacheWrite1hTokens = null;
  const split = isPlainObject(usage.cache_creation) ? usage.cache_creation : void 0;
  const split5m = split !== void 0 ? countOf(split.ephemeral_5m_input_tokens) : void 0;
  const split1h = split !== void 0 ? countOf(split.ephemeral_1h_input_tokens) : void 0;
  if (split5m !== void 0 || split1h !== void 0) {
    cacheWrite5mTokens = split5m ?? 0;
    cacheWrite1hTokens = split1h ?? 0;
  } else {
    cacheWrite5mTokens = countOf(usage.cache_creation_input_tokens) ?? null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: countOf(usage.cache_read_input_tokens) ?? null,
    cacheWrite5mTokens,
    cacheWrite1hTokens
  };
}
function toolUsesOf(redacted) {
  const message = isPlainObject(redacted.message) ? redacted.message : void 0;
  const content = message !== void 0 && Array.isArray(message.content) ? message.content : [];
  const uses = [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== "tool_use") continue;
    const id = textOf(block.id);
    if (id === void 0) continue;
    uses.push({
      id,
      name: textOf(block.name) ?? "unknown",
      inputSummary: isPlainObject(block.input) ? JSON.stringify(block.input) : null
    });
  }
  return uses;
}
function parseAssistantEntry(entry, message, timestampMs, version) {
  const usage = usageOf(message);
  if (usage === void 0) {
    return { kind: "unknown", reason: "assistant-without-usage" };
  }
  const redacted = redactTranscriptEntry(entry);
  return {
    kind: "request",
    timestampMs,
    version,
    requestId: textOf(entry.requestId) ?? null,
    requestRef: textOf(entry.requestRef) ?? null,
    model: textOf(message.model) ?? null,
    usage,
    toolUses: toolUsesOf(redacted),
    redacted
  };
}
function attachmentContentBytes(content) {
  const file = attachedFile(content);
  return typeof file?.content === "string" ? Buffer.byteLength(file.content, "utf8") : null;
}
function attachedFile(content) {
  return isPlainObject(content) && isPlainObject(content.file) ? content.file : void 0;
}
function attachmentContentLines(content) {
  const lines = attachedFile(content)?.numLines;
  return typeof lines === "number" ? lines : null;
}
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}
function joinedLength(texts) {
  let total = 0;
  for (const text of texts) total += text.length;
  return total;
}
function parseStartupItem(attachment) {
  switch (textOf(attachment.type)) {
    case "skill_listing":
      return skillListingItem(attachment);
    case "mcp_instructions_delta":
      return deltaItem(attachment, "mcp-instructions", "addedBlocks");
    case "agent_listing_delta": {
      const chars = joinedLength(stringList(attachment.addedLines));
      if (chars === 0) return null;
      return { kind: "agent-listing", name: null, count: null, chars };
    }
    case "deferred_tools_delta":
      return deltaItem(attachment, "deferred-tool-names", "addedLines");
    case "hook_success":
      return hookOutputItem(attachment);
    case "instructions":
      return instructionsItem(attachment);
    default:
      return null;
  }
}
function skillListingItem(attachment) {
  const names = stringList(attachment.names);
  const chars = typeof attachment.content === "string" ? attachment.content.length : 0;
  const count = countOf(attachment.skillCount) ?? (names.length > 0 ? names.length : null);
  if (chars === 0 && (count ?? 0) === 0) return null;
  return {
    kind: "skill-listing",
    name: null,
    count,
    chars,
    names: names.map(scrubSecrets)
  };
}
function deltaItem(attachment, kind, textsKey) {
  const names = stringList(attachment.addedNames).length;
  const chars = joinedLength(stringList(attachment[textsKey]));
  if (chars === 0 && names === 0) return null;
  return { kind, name: null, count: names === 0 ? null : names, chars };
}
function hookOutputItem(attachment) {
  const content = attachment.content;
  if (typeof content !== "string" || content.length === 0) return null;
  const hookName = textOf(attachment.hookName);
  return {
    kind: "hook-output",
    // A hook's name is text from the transcript: it passes
    // the same secret scrubbing as any stored text.
    name: hookName === void 0 ? null : scrubSecrets(hookName),
    count: null,
    chars: content.length
  };
}
function instructionsItem(attachment) {
  const rawFiles = Array.isArray(attachment.files) ? attachment.files : [];
  const files = [];
  for (const raw of rawFiles) {
    if (!isPlainObject(raw)) continue;
    const path = textOf(raw.path);
    if (path === void 0) continue;
    files.push({
      path,
      chars: typeof raw.content === "string" ? raw.content.length : 0
    });
  }
  if (files.length === 0) return null;
  return { kind: "instructions", files };
}
function parseAttachmentEntry(entry, timestampMs, version) {
  const attachment = isPlainObject(entry.attachment) ? entry.attachment : void 0;
  if (attachment === void 0) {
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry)
    };
  }
  if (textOf(attachment.type) === "compact_file_reference") {
    return fileAttachment(entry, attachment, timestampMs, version, true);
  }
  if (textOf(attachment.type) !== "file") {
    const item = parseStartupItem(attachment);
    if (item !== null) {
      return {
        kind: "startup-item",
        timestampMs,
        version,
        item,
        redacted: redactTranscriptEntry(entry)
      };
    }
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry)
    };
  }
  return fileAttachment(entry, attachment, timestampMs, version, false);
}
function fileAttachment(entry, attachment, timestampMs, version, referenceOnly) {
  const displayPath = textOf(attachment.displayPath);
  const filename = textOf(attachment.filename);
  return {
    kind: "attachment",
    timestampMs,
    version,
    attachment: {
      kind: "file",
      // A display path is text from the transcript: it passes
      // the same secret scrubbing as any stored text.
      name: displayPath === void 0 ? null : scrubSecrets(displayPath),
      path: filename === void 0 ? null : scrubSecrets(filename),
      sizeBytes: attachmentContentBytes(attachment.content),
      lineCount: attachmentContentLines(attachment.content),
      referenceOnly
    },
    redacted: redactTranscriptEntry(entry)
  };
}
function contextSize(value, unit) {
  const amount = Number.parseFloat(value);
  const lowerUnit = unit.toLowerCase();
  if (lowerUnit === "m") return Math.round(amount * 1e6);
  if (lowerUnit === "k") return Math.round(amount * 1e3);
  return Math.round(amount);
}
var CATEGORY_ROW = /^\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i;
function categorySizes(lines) {
  const sizes = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const row = line.match(CATEGORY_ROW);
    if (row?.[1] !== void 0 && row[2] !== void 0) {
      sizes.set(row[1], contextSize(row[2], row[3] ?? ""));
    }
  }
  return sizes;
}
function contextReportText(texts) {
  return texts.find(
    (candidate) => candidate.trimStart().startsWith(CONTEXT_REPORT_OPENING)
  );
}
function contextReportOf(text) {
  const lines = text.split("\n");
  const modelLine = lines.find((line) => line.startsWith("**Model:**"));
  const model = modelLine?.match(/^\*\*Model:\*\*\s*(\S+)\s*$/)?.[1];
  const tokensLine = lines.find((line) => line.startsWith("**Tokens:**"));
  const tokens = tokensLine?.match(
    /^\*\*Tokens:\*\*\s*[\d.]+\s*[km]\s*\/\s*([\d.]+)\s*([km])\b/i
  );
  if (model === void 0 || tokens?.[1] === void 0 || tokens[2] === void 0) {
    return null;
  }
  const sizes = categorySizes(lines);
  return {
    model,
    window: contextSize(tokens[1], tokens[2]),
    autocompactBuffer: sizes.get("Autocompact buffer") ?? null,
    systemPrompt: sizes.get("System prompt") ?? null,
    systemTools: sizes.get("System tools") ?? null,
    mcpInstructions: sizes.get("MCP server instructions") ?? null,
    memoryFiles: sizes.get("Memory files") ?? null,
    skills: sizes.get("Skills") ?? null
  };
}
var SKILL_TEXT_OPENING = "Base directory for this skill:";
var SKILL_FOLDER_NAME = /([^\\/]+)[\\/]*$/;
function skillText(entry, texts) {
  const opening = texts[0]?.trimStart() ?? "";
  if (entry.isMeta !== true || !opening.startsWith(SKILL_TEXT_OPENING)) {
    return null;
  }
  const folder = opening.slice(SKILL_TEXT_OPENING.length).split("\n")[0] ?? "";
  const name = SKILL_FOLDER_NAME.exec(folder.trim())?.[1];
  if (name === void 0) return null;
  return {
    name: scrubSecrets(name),
    bytes: texts.reduce(
      (sum, text) => sum + Buffer.byteLength(text, "utf8"),
      0
    )
  };
}
var COMMAND_MESSAGE_NAME = /^<command-message>([^<]+)<\/command-message>/;
function commandMessageName(entry, texts) {
  if (entry.isMeta !== true) return null;
  const name = COMMAND_MESSAGE_NAME.exec(texts[0]?.trimStart() ?? "")?.[1];
  return name === void 0 ? null : scrubSecrets(name);
}
function isInterruptText(texts) {
  return texts.some((text) => INTERRUPT_TEXTS.has(text.trim()));
}
function parseUserEntry(entry, message, timestampMs, version, options) {
  const blocks = readContent(message.content);
  markAsyncLaunch(blocks.toolResultSizes, entry.toolUseResult);
  const isInterrupt = isInterruptText(blocks.texts);
  const isPrompt = blocks.toolResultSizes.size === 0;
  const joined = options.keepPromptText && isPrompt ? scrubSecrets(blocks.texts.join("\n")) : "";
  const promptTextAll = isPrompt ? blocks.texts.join("\n") : "";
  const origin = isPlainObject(entry.origin) ? entry.origin : void 0;
  const firstText = blocks.texts[0]?.trimStart();
  const report = entry.isMeta === true ? contextReportText(blocks.texts) : void 0;
  return {
    kind: "user",
    timestampMs,
    version,
    promptId: textOf(entry.promptId) ?? null,
    isInterrupt,
    isMeta: entry.isMeta === true,
    originKind: origin !== void 0 ? textOf(origin.kind) ?? null : null,
    claudeMessage: claudeMessageOf(
      entry,
      origin,
      blocks.texts,
      promptTextAll.length
    ),
    isCompactSummary: entry.isCompactSummary === true,
    isCommandEntry: firstText !== void 0 && COMMAND_OPENINGS.some((opening) => firstText.startsWith(opening)),
    opensWithClaudeOpening: firstText !== void 0 && NON_PROMPT_OPENINGS.some((opening) => firstText.startsWith(opening)),
    contextReport: report === void 0 ? null : contextReportOf(report),
    commandOutput: report === void 0 ? null : { command: "/context", chars: report.length },
    skillText: skillText(entry, blocks.texts),
    commandMessageName: commandMessageName(entry, blocks.texts),
    toolResultSizes: blocks.toolResultSizes,
    errorResultIds: blocks.errorResultIds,
    interruptResultIds: blocks.interruptResultIds,
    promptText: joined.length > 0 ? joined : null,
    images: blocks.images,
    promptChars: promptTextAll.length,
    promptLines: promptTextAll.length === 0 ? 0 : promptTextAll.split("\n").length,
    promptBytes: Buffer.byteLength(promptTextAll, "utf8"),
    redacted: redactTranscriptEntry(entry)
  };
}
function cacheLifetimesOf(cacheControl) {
  if (!Array.isArray(cacheControl)) return [];
  const lifetimes = [];
  for (const item of cacheControl) {
    if (!isPlainObject(item)) continue;
    const value = isPlainObject(item.value) ? item.value : void 0;
    if (value === void 0) continue;
    const ttl = textOf(value.ttl);
    if (ttl !== void 0) lifetimes.push(ttl);
    else if (value.type === "ephemeral") lifetimes.push("5m");
  }
  return lifetimes;
}
function blockBytes(block) {
  if (isPlainObject(block) && typeof block.text === "string") {
    return Buffer.byteLength(block.text, "utf8");
  }
  return Buffer.byteLength(JSON.stringify(block) ?? "", "utf8");
}
function systemBytesOf(system) {
  if (typeof system === "string") return Buffer.byteLength(system, "utf8");
  if (!Array.isArray(system)) return null;
  let bytes = 0;
  for (const block of system) {
    bytes += blockBytes(block);
  }
  return bytes;
}
function toolsOf(tools) {
  if (!Array.isArray(tools)) return [];
  const shapes = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const name = textOf(tool.name) ?? "unknown";
    shapes.push({
      name,
      bytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
      mcp: name.startsWith("mcp__")
    });
  }
  return shapes;
}
function contextEditsOf(params) {
  const management = params !== void 0 && isPlainObject(params.context_management) ? params.context_management : void 0;
  if (management === void 0 || !Array.isArray(management.edits)) {
    return [];
  }
  const types = [];
  for (const edit of management.edits) {
    if (!isPlainObject(edit)) continue;
    const type = textOf(edit.type);
    if (type !== void 0) types.push(type);
  }
  return types;
}
function parseApiRequestEntry(entry, timestampMs, version) {
  const params = isPlainObject(entry.params) ? entry.params : void 0;
  const outputConfig = params !== void 0 && isPlainObject(params.output_config) ? params.output_config : void 0;
  return {
    kind: "api-request",
    timestampMs,
    version,
    clientId: textOf(entry.id) ?? null,
    shapeHash: textOf(entry.shapeHash) ?? null,
    effort: effortLevel(outputConfig?.effort),
    cacheLifetimes: cacheLifetimesOf(entry.cacheControl),
    contextEdits: contextEditsOf(params),
    redacted: redactTranscriptEntry(entry)
  };
}
function parseApiRequestShapeEntry(entry, timestampMs, version) {
  const shape = isPlainObject(entry.shape) ? entry.shape : void 0;
  const systemBytes = shape === void 0 ? null : systemBytesOf(shape.system);
  const tools = shape === void 0 ? [] : toolsOf(shape.tools);
  return {
    kind: "api-request-shape",
    timestampMs,
    version,
    shapeHash: textOf(entry.shapeHash) ?? null,
    systemBytes,
    tools,
    // The stored copy is the parsed form — sizes, names and
    // the entry's own hash — not the entry's outline: the
    // outline repeats every key of every tool's input schema
    // for data nothing reads.
    redacted: {
      type: "api-request-shape",
      sessionId: textOf(entry.sessionId) ?? null,
      shapeHash: textOf(entry.shapeHash) ?? null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      version: version ?? null,
      systemBytes,
      tools,
      redaction_version: REDACTION_VERSION
    }
  };
}
function blobBlockSize(block) {
  return {
    type: isPlainObject(block) ? textOf(block.type) ?? "unknown" : "unknown",
    bytes: blockBytes(block)
  };
}
function parseApiRequestBlobEntry(entry, timestampMs, version) {
  const message = isPlainObject(entry.message) ? entry.message : void 0;
  const content = message !== void 0 && Array.isArray(message.content) ? message.content : [];
  return {
    kind: "api-request-blob",
    timestampMs,
    version,
    // The blob is a copy of the request's messages: the stored
    // copy is the parsed form — the hash and each block's type
    // and size — never the messages themselves.
    redacted: {
      type: "api-request-blob",
      sessionId: textOf(entry.sessionId) ?? null,
      hash: textOf(entry.hash) ?? null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      version: version ?? null,
      message: {
        role: message !== void 0 ? textOf(message.role) ?? null : null,
        blocks: content.map(blobBlockSize)
      },
      redaction_version: REDACTION_VERSION
    }
  };
}
function notificationId(content, tag) {
  const open = `<${tag}>`;
  const start = content.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = content.indexOf(`</${tag}>`, from);
  if (end === -1) return null;
  const value = content.slice(from, end).trim();
  return value === "" ? null : value;
}
function parseTaskNotification(entry, timestampMs, version) {
  if (textOf(entry.operation) !== "enqueue") return null;
  const content = textOf(entry.content);
  if (content === void 0 || !content.includes("<task-notification>")) {
    return null;
  }
  return {
    kind: "task-notification",
    timestampMs,
    version,
    taskId: notificationId(content, "task-id"),
    toolUseId: notificationId(content, "tool-use-id"),
    redacted: redactTranscriptEntry(entry)
  };
}
function parseTranscriptLine(line, options) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { kind: "unknown", reason: "not-json" };
  }
  if (!isPlainObject(entry)) {
    return { kind: "unknown", reason: "not-an-object" };
  }
  const timestampMs = timestampOf(entry);
  const version = versionOf(entry);
  const entryType = textOf(entry.type);
  if (entryType === "api-request") {
    return parseApiRequestEntry(entry, timestampMs, version);
  }
  if (entryType === "api-request-shape") {
    return parseApiRequestShapeEntry(entry, timestampMs, version);
  }
  if (entryType === "api-request-blob") {
    return parseApiRequestBlobEntry(entry, timestampMs, version);
  }
  if (entryType === "queue-operation") {
    const notification = parseTaskNotification(entry, timestampMs, version);
    if (notification !== null) return notification;
  }
  if (entryType === "attachment") {
    return parseAttachmentEntry(entry, timestampMs, version);
  }
  if (entryType === "system" && textOf(entry.subtype) === "compact_boundary") {
    return {
      kind: "compaction-boundary",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry)
    };
  }
  const message = isPlainObject(entry.message) ? entry.message : void 0;
  if (message === void 0) {
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry)
    };
  }
  const role = textOf(message.role);
  const type = textOf(entry.type);
  if (role === "assistant" || type === "assistant") {
    return parseAssistantEntry(entry, message, timestampMs, version);
  }
  if (role === "user" || type === "user") {
    return parseUserEntry(entry, message, timestampMs, version, options);
  }
  return { kind: "unknown", reason: "unrecognized-message" };
}

// src/transcripts/follower.ts
function resolveClaudeConfigDir(env = process.env, home = homedir2()) {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== void 0 && configured.length > 0 ? configured : join6(home, ".claude");
}
function readAutoCompactWindow(configDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync5(join6(configDir, "settings.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const value = parsed["autoCompactWindow"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function encodeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}
var INSTALL_STAMP = "installed-at";
function readInstalledAt(dataDir, now) {
  const stampPath = join6(dataDir, INSTALL_STAMP);
  if (existsSync(stampPath)) {
    const parsed = Number(readFileSync5(stampPath, "utf8").trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  let installedAt = now;
  try {
    const birth = statSync2(dataDir).birthtimeMs;
    if (Number.isFinite(birth) && birth > 0 && birth <= now) {
      installedAt = Math.floor(birth);
    }
  } catch {
  }
  try {
    writeFileSync4(stampPath, String(installedAt), { flag: "wx" });
  } catch {
  }
  return installedAt;
}
function createTranscriptFollower(storage, options) {
  const ctx = {
    storage,
    options,
    now: options.now ?? Date.now,
    sessions: /* @__PURE__ */ new Map(),
    offsetsPath: join6(options.dataDir, "transcript-offsets.json"),
    persistedOffsets: null,
    chain: Promise.resolve(),
    refollowQueued: null
  };
  return {
    follow: (sessionId, transcriptPath, cwd, sessionEnded = false) => followSession(ctx, sessionId, transcriptPath, cwd, sessionEnded),
    refollowActive: (now = Date.now()) => refollowActive(ctx, now),
    importAll: () => importAll(ctx)
  };
}
function sessionState(ctx, sessionId) {
  let state = ctx.sessions.get(sessionId);
  if (state === void 0) {
    state = {
      files: /* @__PURE__ */ new Map(),
      partialMarked: false,
      versionNoted: void 0,
      lastActivityAt: 0,
      lastPath: null,
      lastCwd: void 0
    };
    ctx.sessions.set(sessionId, state);
  }
  return state;
}
function parseOffsetsInto(parsed, into) {
  if (typeof parsed !== "object" || parsed === null) return;
  for (const [path, value] of Object.entries(parsed)) {
    if (typeof value === "number" && value >= 0) {
      into.set(path, value);
    }
  }
}
function loadOffsets(ctx) {
  if (ctx.persistedOffsets !== null) return ctx.persistedOffsets;
  ctx.persistedOffsets = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(readFileSync5(ctx.offsetsPath, "utf8"));
    parseOffsetsInto(parsed, ctx.persistedOffsets);
  } catch {
  }
  return ctx.persistedOffsets;
}
function saveOffsets(ctx) {
  if (ctx.persistedOffsets === null) return;
  try {
    writeFileAtomically(
      ctx.offsetsPath,
      JSON.stringify(Object.fromEntries(ctx.persistedOffsets))
    );
  } catch {
  }
}
function fileState(ctx, state, path) {
  let file = state.files.get(path);
  if (file === void 0) {
    const offset = loadOffsets(ctx).get(path) ?? 0;
    file = {
      offset,
      partial: Buffer.alloc(0),
      pendingToolUse: [],
      currentTurnId: null,
      compactionAt: null,
      landedResults: /* @__PURE__ */ new Map(),
      toolCalls: /* @__PURE__ */ new Map(),
      lastRequestRowId: null,
      skillText: null,
      pendingApiRequests: /* @__PURE__ */ new Map(),
      metaRead: false,
      openingToRecord: new Set(
        offset === 0 ? ["task-prompt", "preloaded-skills"] : []
      )
    };
    state.files.set(path, file);
  }
  return file;
}
function inPause(pauses, at) {
  if (at === null) return false;
  return pauses.some(
    (pause) => at >= pause.pausedAt && (pause.resumedAt === null || at < pause.resumedAt)
  );
}
var CHUNK_BYTES = 1 * 1024 * 1024;
var CHUNK_LINES = 200;
var MAX_LINE_BYTES = 16 * 1024 * 1024;
var DAY_MS = 24 * 60 * 60 * 1e3;
var TAIL_BYTES = 256 * 1024;
function entryTimestampMs(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.timestamp !== "string") return null;
    const at = Date.parse(parsed.timestamp);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}
function readLastEntryAt(path) {
  let fd;
  let size;
  try {
    fd = openSync(path, "r");
    size = fstatSync(fd).size;
  } catch {
    return null;
  }
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const rawLine = lines[i];
      if (rawLine === void 0) continue;
      const line = rawLine.trim();
      if (line === "") continue;
      const at = entryTimestampMs(line);
      if (at !== null) return at;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
function readChunk(file, path) {
  let size;
  let fd;
  try {
    fd = openSync(path, "r");
    size = fstatSync(fd).size;
  } catch {
    return null;
  }
  try {
    const shrank = size < file.offset;
    const from = shrank ? 0 : file.offset;
    const held = shrank ? Buffer.alloc(0) : file.partial;
    const heldHasNewline = held.includes(10);
    const want = heldHasNewline ? Math.max(0, CHUNK_BYTES - held.length) : CHUNK_BYTES;
    const length = Math.min(size - from, want);
    if (length <= 0 && !heldHasNewline) {
      return null;
    }
    const fresh = Buffer.alloc(Math.max(0, length));
    if (length > 0) readSync(fd, fresh, 0, length, from);
    const data = Buffer.concat([held, fresh]);
    const nextOffset = from + Math.max(0, length);
    const lastNewline = data.lastIndexOf(10);
    if (lastNewline === -1) {
      return chunkWithoutNewline(data, nextOffset, size);
    }
    return splitChunkLines(data, lastNewline, nextOffset, size);
  } finally {
    closeSync(fd);
  }
}
function chunkWithoutNewline(data, nextOffset, size) {
  const end = nextOffset >= size;
  if (!end && data.length < MAX_LINE_BYTES) {
    return {
      lines: [],
      nextOffset,
      nextPartial: Buffer.from(data),
      end: false
    };
  }
  if (!end) {
    return {
      lines: [data.toString("utf8")],
      nextOffset,
      nextPartial: Buffer.alloc(0),
      end: false
    };
  }
  return {
    lines: [],
    nextOffset,
    nextPartial: Buffer.from(data),
    end: true
  };
}
function splitChunkLines(data, lastNewline, nextOffset, size) {
  const lines = [];
  let start = 0;
  let consumed = 0;
  for (let i = 0; i <= lastNewline; i += 1) {
    if (data[i] === 10) {
      lines.push(data.subarray(start, i).toString("utf8"));
      start = i + 1;
      consumed = start;
      if (lines.length >= CHUNK_LINES) break;
    }
  }
  const rest = data.subarray(consumed);
  const end = nextOffset >= size && !rest.includes(10);
  return {
    lines,
    nextOffset,
    nextPartial: Buffer.from(rest),
    end
  };
}
function noteSpan(span, timestampMs) {
  if (span === void 0 || timestampMs === null) return;
  span.first = span.first === null ? timestampMs : Math.min(span.first, timestampMs);
  span.last = span.last === null ? timestampMs : Math.max(span.last, timestampMs);
}
function applyLine(ctx, sessionId, state, file, line, origin, result) {
  if (line.trim().length === 0) return;
  const { storage } = ctx;
  const parsed = parseTranscriptLine(line, {
    keepPromptText: origin.settings.storePromptText
  });
  if (parsed.kind === "unknown") {
    result.skippedUnknown += 1;
    if (!state.partialMarked) {
      storage.markTokensPartial(sessionId);
      state.partialMarked = true;
    }
    return;
  }
  result.entries += 1;
  noteSpan(origin.span, parsed.timestampMs);
  if (parsed.version !== void 0 && parsed.version !== state.versionNoted) {
    storage.noteTranscriptSeen(sessionId, parsed.version, Date.now());
    state.versionNoted = parsed.version;
  }
  if (inPause(origin.pauses, parsed.timestampMs)) {
    return;
  }
  const at = parsed.timestampMs ?? Date.now();
  const uuid = typeof parsed.redacted.uuid === "string" ? parsed.redacted.uuid : null;
  storage.insertRawEvent({
    source: "transcript",
    sessionId,
    ...parsed.timestampMs !== null ? { eventAt: parsed.timestampMs } : {},
    redactionVersion: REDACTION_VERSION,
    body: JSON.stringify(parsed.redacted),
    ...uuid !== null ? { envelopeId: `transcript:${uuid}` } : {}
  });
  applyEntry(ctx, sessionId, file, parsed, at, origin, result);
}
function applyEntry(ctx, sessionId, file, parsed, at, origin, result) {
  if (parsed.redacted.type !== "attachment") file.skillText = null;
  if (origin.branchId !== null) {
    recordSubagentStart(ctx, sessionId, file, parsed, at, origin.branchId);
  }
  if (parsed.kind === "user") {
    applyUserEntry(ctx, sessionId, file, parsed, at, origin);
    recordClaudeMessage(ctx, sessionId, file, parsed, at);
    recordSkillText(ctx, sessionId, file, parsed);
  } else if (parsed.kind === "compaction-boundary") {
    file.compactionAt = at;
  } else if (parsed.kind === "attachment") {
    applyAttachmentEntry(ctx, sessionId, file, parsed);
  } else if (parsed.kind === "startup-item") {
    applyStartupItem(ctx, sessionId, parsed, at, origin.branchId);
  } else if (parsed.kind === "request") {
    file.compactionAt = null;
    applyRequestEntry(ctx, sessionId, file, parsed, origin, result);
  } else if (parsed.kind === "api-request") {
    applyApiRequestEntry(file, parsed);
  } else if (parsed.kind === "api-request-shape") {
    applyShapeEntry(ctx, sessionId, parsed);
  } else if (parsed.kind === "task-notification") {
    applyTaskNotification(ctx, sessionId, parsed);
  }
}
function applyTaskNotification(ctx, sessionId, parsed) {
  if (parsed.taskId === null || parsed.toolUseId === null) return;
  ctx.storage.linkUnlinkedBranchStep(
    sessionId,
    parsed.taskId,
    parsed.toolUseId
  );
}
function applyPromptFacts(ctx, sessionId, turnId, parsed) {
  const { storage } = ctx;
  const attachments = [];
  let imageBytes = 0;
  for (const image of parsed.images) {
    imageBytes += image.bytes;
    attachments.push({
      kind: "image",
      name: image.mediaType,
      sizeBytes: image.bytes,
      lineCount: null
    });
  }
  if (parsed.promptChars > 0) {
    attachments.push({
      kind: "prompt",
      name: null,
      sizeBytes: parsed.promptBytes,
      lineCount: parsed.promptLines
    });
  }
  storage.fillTurnPromptFigures(turnId, parsed.promptChars, parsed.promptLines);
  storage.setTurnImages(turnId, parsed.images.length, imageBytes);
  storage.replacePromptAttachments(sessionId, turnId, attachments);
}
function projectRelativePath(path, projectPath) {
  if (path === null || projectPath === null) return path;
  const inside = relative(projectPath, path);
  const outside = inside === ".." || inside.startsWith(`..${sep}`);
  return inside === "" || outside || isAbsolute2(inside) ? path : inside;
}
function attachmentName(ctx, sessionId, attachment) {
  return attachment.name ?? projectRelativePath(attachment.path, ctx.storage.projectPathOf(sessionId));
}
function recordSkillText(ctx, sessionId, file, parsed) {
  if (parsed.skillText === null || parsed.timestampMs === null) return;
  const loadId = ctx.storage.recordSkillText({
    sessionId,
    name: parsed.skillText.name,
    bytes: parsed.skillText.bytes,
    at: parsed.timestampMs
  });
  file.skillText = { loadId, timestampMs: parsed.timestampMs };
}
function applyAttachmentEntry(ctx, sessionId, file, parsed) {
  if (file.compactionAt !== null) {
    const name = attachmentName(ctx, sessionId, parsed.attachment);
    if (name === null) return;
    ctx.storage.addCompactionFile(sessionId, {
      at: file.compactionAt,
      name,
      sizeBytes: parsed.attachment.sizeBytes,
      reread: !parsed.attachment.referenceOnly
    });
    return;
  }
  if (parsed.attachment.referenceOnly) return;
  const skill = file.skillText;
  if (skill !== null) {
    const name = attachmentName(ctx, sessionId, parsed.attachment);
    if (name !== null) {
      ctx.storage.addSkillFile({
        sessionId,
        skillLoadId: skill.loadId,
        path: name,
        bytes: parsed.attachment.sizeBytes,
        lines: parsed.attachment.lineCount,
        at: skill.timestampMs
      });
      return;
    }
  }
  if (file.currentTurnId === null) return;
  ctx.storage.addPromptAttachment(sessionId, file.currentTurnId, {
    kind: parsed.attachment.kind,
    name: parsed.attachment.name,
    sizeBytes: parsed.attachment.sizeBytes,
    lineCount: null
  });
}
function applyStartupItem(ctx, sessionId, parsed, at, branchId) {
  const { storage } = ctx;
  const item = parsed.item;
  if (item.kind === "instructions") {
    if (branchId !== null) return;
    for (const file of item.files) {
      storage.fillInstructionSize({
        sessionId,
        filePath: file.path,
        chars: file.chars,
        at
      });
    }
    return;
  }
  storage.recordTranscriptLoad({
    sessionId,
    kind: item.kind,
    name: item.name,
    count: item.count,
    names: item.kind === "skill-listing" ? item.names : null,
    chars: item.chars,
    at,
    branchId
  });
}
function recordSubagentStart(ctx, sessionId, file, parsed, at, branchId) {
  const load = { sessionId, count: null, names: null, at, branchId };
  if (parsed.kind === "user" && parsed.toolResultSizes.size === 0) {
    const skill = parsed.commandMessageName;
    if (skill !== null && file.openingToRecord.has("preloaded-skills")) {
      ctx.storage.recordTranscriptLoad({
        ...load,
        kind: "preloaded-skill",
        name: skill,
        chars: parsed.promptChars
      });
    } else if (!parsed.isMeta && file.openingToRecord.has("task-prompt")) {
      file.openingToRecord.delete("task-prompt");
      ctx.storage.recordTranscriptLoad({
        ...load,
        kind: "task-prompt",
        name: null,
        chars: parsed.promptChars
      });
    }
  } else if (parsed.kind === "request") {
    file.openingToRecord.delete("preloaded-skills");
  } else if (parsed.kind === "startup-item") {
    if (parsed.item.kind !== "instructions") return;
    for (const { path, chars } of parsed.item.files) {
      ctx.storage.recordTranscriptLoad({
        ...load,
        kind: "instructions",
        name: null,
        filePath: scrubSecrets(path),
        chars
      });
    }
  }
}
function recordLandedResults(file, parsed, at) {
  for (const [id, size] of parsed.toolResultSizes) {
    if (parsed.interruptResultIds.includes(id)) continue;
    if (!file.landedResults.has(id)) {
      file.landedResults.set(id, {
        size,
        at,
        failed: parsed.errorResultIds.includes(id)
      });
    }
  }
}
function recordClaudeMessage(ctx, sessionId, file, parsed, at) {
  if (parsed.claudeMessage === null || file.currentTurnId === null) return;
  ctx.storage.insertClaudeMessage(
    sessionId,
    file.currentTurnId,
    at,
    parsed.claudeMessage
  );
}
function recordReportEntry(ctx, sessionId, parsed, at) {
  if (parsed.contextReport !== null) {
    ctx.storage.recordContextReport(sessionId, parsed.contextReport, at);
  }
  if (parsed.commandOutput !== null) {
    ctx.storage.recordTranscriptLoad({
      sessionId,
      kind: "command-output",
      name: parsed.commandOutput.command,
      count: null,
      names: null,
      chars: parsed.commandOutput.chars,
      at,
      branchId: null
    });
  }
}
function closePendingInterrupted(ctx, sessionId, file, at) {
  for (const id of file.pendingToolUse) {
    ctx.storage.closeStepInterrupted(sessionId, id, at);
  }
  file.pendingToolUse = [];
}
function applyUserEntry(ctx, sessionId, file, parsed, at, origin) {
  const { storage } = ctx;
  for (const id of parsed.toolResultSizes.keys()) {
    const index = file.pendingToolUse.indexOf(id);
    if (parsed.interruptResultIds.includes(id)) {
      storage.closeStepInterrupted(sessionId, id, at);
      if (index >= 0) file.pendingToolUse.splice(index, 1);
    } else if (!parsed.errorResultIds.includes(id)) {
      if (index >= 0) file.pendingToolUse.splice(index, 1);
    }
  }
  recordLandedResults(file, parsed, at);
  recordReportEntry(ctx, sessionId, parsed, at);
  const isPromptEntry = parsed.toolResultSizes.size === 0 && !parsed.isInterrupt && !parsed.isMeta && isTypedPrompt(parsed);
  if (isPromptEntry) {
    if (parsed.originKind === "human") file.compactionAt = null;
    file.pendingToolUse = [];
    file.landedResults.clear();
    let resolvedTurnId = null;
    if (parsed.promptId !== null) {
      resolvedTurnId = storage.turnIdByPrompt(sessionId, parsed.promptId) ?? (origin.createTurns ? storage.ensureTranscriptTurn(
        sessionId,
        parsed.promptId,
        at,
        parsed.promptText
      ) : null);
      if (resolvedTurnId !== null) file.currentTurnId = resolvedTurnId;
    } else if (origin.createTurns) {
      resolvedTurnId = storage.ensureTranscriptTurn(
        sessionId,
        null,
        at,
        parsed.promptText
      );
      file.currentTurnId = resolvedTurnId;
    }
    if (resolvedTurnId !== null) {
      applyPromptFacts(ctx, sessionId, resolvedTurnId, parsed);
    }
  }
  if (parsed.isInterrupt) {
    closePendingInterrupted(ctx, sessionId, file, at);
  }
}
function settleRequestLinks(ctx, sessionId, file, rowId) {
  const { storage } = ctx;
  file.lastRequestRowId = rowId;
  for (const [id, landed] of file.landedResults) {
    storage.linkStepResult(sessionId, id, rowId, landed.size);
    const call = file.toolCalls.get(id);
    if (call !== void 0) {
      storage.createTranscriptStep({
        sessionId,
        turnId: call.turnId,
        branchId: call.branchId,
        toolUseId: id,
        toolName: call.name,
        inputSummary: call.inputSummary,
        startedAt: call.startedAt,
        endedAt: landed.at,
        failed: landed.failed,
        requestRowId: rowId,
        size: landed.size
      });
    }
    file.toolCalls.delete(id);
  }
  file.landedResults.clear();
}
function applyHeldApiRequest(ctx, file, parsed, rowId) {
  if (parsed.requestRef === null) return;
  const pending = file.pendingApiRequests.get(parsed.requestRef);
  if (pending === void 0) return;
  file.pendingApiRequests.delete(parsed.requestRef);
  applyApiRequest(ctx, pending, rowId);
}
function applyRequestEntry(ctx, sessionId, file, parsed, origin, result) {
  const { storage } = ctx;
  const turnId = file.currentTurnId ?? origin.spawningTurnId ?? storage.latestTurnId(sessionId);
  const rowId = storage.upsertRequest({
    sessionId,
    requestId: parsed.requestId,
    turnId,
    branchId: origin.branchId,
    model: parsed.model,
    querySource: origin.querySource,
    inputTokens: parsed.usage.inputTokens,
    outputTokens: parsed.usage.outputTokens,
    cacheReadTokens: parsed.usage.cacheReadTokens,
    cacheWrite5mTokens: parsed.usage.cacheWrite5mTokens,
    cacheWrite1hTokens: parsed.usage.cacheWrite1hTokens,
    tokenSource: "transcript",
    startedAt: parsed.timestampMs,
    durationMs: null,
    effort: null
  });
  result.requests += 1;
  if (rowId !== file.lastRequestRowId) {
    settleRequestLinks(ctx, sessionId, file, rowId);
  }
  applyHeldApiRequest(ctx, file, parsed, rowId);
  if (parsed.timestampMs !== null) {
    const contextTokens = requestContextTokens(parsed.usage);
    storage.insertContextSample({
      sessionId,
      requestRowId: rowId,
      sampledAt: parsed.timestampMs,
      contextTokens,
      source: "transcript"
    });
  }
  for (const use of parsed.toolUses) {
    if (!file.pendingToolUse.includes(use.id)) {
      file.pendingToolUse.push(use.id);
    }
  }
  recordToolCalls(file, parsed, turnId, origin.branchId);
}
function recordToolCalls(file, parsed, turnId, branchId) {
  for (const use of parsed.toolUses) {
    if (!file.toolCalls.has(use.id)) {
      file.toolCalls.set(use.id, {
        name: use.name,
        inputSummary: use.inputSummary,
        startedAt: parsed.timestampMs,
        turnId,
        branchId
      });
    }
  }
}
function applyApiRequest(ctx, parsed, rowId) {
  const { storage } = ctx;
  if (parsed.effort !== null) {
    storage.setRequestEffort(rowId, parsed.effort);
  }
  storage.setRequestCacheFacts(
    rowId,
    parsed.cacheLifetimes,
    parsed.contextEdits
  );
  if (parsed.shapeHash !== null) {
    storage.setRequestShape(rowId, parsed.shapeHash);
  }
}
function applyApiRequestEntry(file, parsed) {
  if (parsed.clientId !== null) {
    file.pendingApiRequests.set(parsed.clientId, parsed);
  }
}
function applyShapeEntry(ctx, sessionId, parsed) {
  if (parsed.shapeHash !== null) {
    const shape = {
      systemBytes: parsed.systemBytes,
      tools: parsed.tools
    };
    ctx.storage.upsertRequestShape(parsed.shapeHash, shape);
    ctx.storage.noteRequestShape(sessionId, parsed.shapeHash);
  }
}
function snapshotChunkState(state, file) {
  return {
    file: {
      ...file,
      pendingToolUse: [...file.pendingToolUse],
      landedResults: new Map(file.landedResults),
      toolCalls: new Map(file.toolCalls),
      pendingApiRequests: new Map(file.pendingApiRequests),
      openingToRecord: new Set(file.openingToRecord)
    },
    partialMarked: state.partialMarked,
    versionNoted: state.versionNoted
  };
}
function restoreChunkState(state, file, snapshot) {
  Object.assign(file, snapshot.file);
  state.partialMarked = snapshot.partialMarked;
  state.versionNoted = snapshot.versionNoted;
}
async function followFile(ctx, sessionId, state, path, origin, result) {
  const file = fileState(ctx, state, path);
  for (; ; ) {
    const read = readChunk(file, path);
    if (read === null) return;
    if (read.lines.length > 0) {
      const before = snapshotChunkState(state, file);
      try {
        ctx.storage.transaction(() => {
          for (const line of read.lines) {
            applyLine(ctx, sessionId, state, file, line, origin, result);
          }
        });
      } catch (error) {
        restoreChunkState(state, file, before);
        throw error;
      }
    }
    file.offset = read.nextOffset;
    file.partial = read.nextPartial;
    loadOffsets(ctx).set(path, read.nextOffset - read.nextPartial.length);
    saveOffsets(ctx);
    if (read.end) return;
    await yieldToEventLoop();
  }
}
function linkSubagentMeta(ctx, sessionId, agentId, metaPath) {
  let meta;
  try {
    meta = JSON.parse(readFileSync5(metaPath, "utf8"));
  } catch {
    return false;
  }
  if (!isPlainObject(meta)) return true;
  const toolUseId = meta.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId === "") return true;
  if (ctx.storage.branchIdByAgent(sessionId, agentId) === null) return false;
  ctx.storage.linkBranchStep(sessionId, agentId, toolUseId);
  return true;
}
async function followSubagentFiles(ctx, sessionId, state, transcriptPath, base, result) {
  const subagentsDir = join6(
    dirname(transcriptPath),
    basename(transcriptPath, ".jsonl"),
    "subagents"
  );
  let names;
  try {
    names = readdirSync2(subagentsDir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const agentId = name.slice("agent-".length, -".jsonl".length);
    const path = join6(subagentsDir, name);
    const file = fileState(ctx, state, path);
    const branchId = ctx.storage.branchIdByAgent(sessionId, agentId);
    if (branchId === null && !base.createTurns && !base.sessionEnded) continue;
    if (!file.metaRead) {
      file.metaRead = linkSubagentMeta(
        ctx,
        sessionId,
        agentId,
        join6(subagentsDir, `${name.slice(0, -".jsonl".length)}.meta.json`)
      );
    }
    await followFile(
      ctx,
      sessionId,
      state,
      path,
      {
        createTurns: base.createTurns,
        querySource: "subagent",
        branchId,
        spawningTurnId: ctx.storage.spawningTurnId(sessionId, agentId),
        pauses: base.pauses,
        settings: base.settings,
        ...base.span !== void 0 ? { span: base.span } : {}
      },
      result
    );
  }
}
async function followInternal(ctx, sessionId, transcriptPath, createTurns, sessionEnded, span) {
  const result = { entries: 0, requests: 0, skippedUnknown: 0 };
  const state = sessionState(ctx, sessionId);
  const settings = ctx.options.settings();
  const pauses = ctx.storage.pausesFor(sessionId);
  await followFile(
    ctx,
    sessionId,
    state,
    transcriptPath,
    {
      createTurns,
      querySource: "main",
      branchId: null,
      spawningTurnId: null,
      pauses,
      settings,
      ...span !== void 0 ? { span } : {}
    },
    result
  );
  await followSubagentFiles(
    ctx,
    sessionId,
    state,
    transcriptPath,
    {
      createTurns,
      sessionEnded,
      pauses,
      settings,
      ...span !== void 0 ? { span } : {}
    },
    result
  );
  if (result.entries > 0) {
    ctx.storage.touchSession(sessionId, Date.now());
  }
  return result;
}
function enqueue(ctx, task) {
  const run = ctx.chain.then(task, task);
  ctx.chain = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
function dropIfForgotten(ctx, sessionId) {
  if (!ctx.storage.isForgotten(sessionId)) return false;
  ctx.sessions.delete(sessionId);
  return true;
}
function followSession(ctx, sessionId, transcriptPath, cwd, sessionEnded) {
  const empty = { entries: 0, requests: 0, skippedUnknown: 0 };
  if (dropIfForgotten(ctx, sessionId)) return Promise.resolve(empty);
  const settings = ctx.options.settings();
  if (cwd !== void 0 && isExcludedFolder(cwd, settings.excludedFolders)) {
    return Promise.resolve(empty);
  }
  const state = sessionState(ctx, sessionId);
  state.lastActivityAt = Date.now();
  state.lastPath = transcriptPath;
  state.lastCwd = cwd;
  return enqueue(
    ctx,
    () => followInternal(ctx, sessionId, transcriptPath, false, sessionEnded)
  );
}
function refollowActive(ctx, now) {
  if (ctx.refollowQueued !== null) return ctx.refollowQueued;
  ctx.refollowQueued = enqueue(ctx, async () => {
    for (const [sessionId, state] of ctx.sessions) {
      if (dropIfForgotten(ctx, sessionId)) continue;
      if (state.lastPath === null) continue;
      if (now - state.lastActivityAt > 6e4) continue;
      const settings = ctx.options.settings();
      if (state.lastCwd !== void 0 && isExcludedFolder(state.lastCwd, settings.excludedFolders)) {
        continue;
      }
      const result = await followInternal(
        ctx,
        sessionId,
        state.lastPath,
        false,
        false
      );
      if (result.entries > 0) state.lastActivityAt = Date.now();
    }
  }).then(
    () => {
      ctx.refollowQueued = null;
    },
    (error) => {
      ctx.refollowQueued = null;
      throw error;
    }
  );
  return ctx.refollowQueued;
}
async function importOneFile(ctx, sessionId, path, projectPath, settings, installedAt, total) {
  if (ctx.storage.isForgotten(sessionId)) return;
  if (ctx.storage.isPurged(sessionId)) return;
  if (ctx.storage.hasRawEvents(sessionId)) return;
  let mtime;
  try {
    mtime = statSync2(path).mtimeMs;
  } catch {
    return;
  }
  if (mtime < installedAt) return;
  const lastEntryAt = readLastEntryAt(path);
  if (lastEntryAt !== null && lastEntryAt < ctx.now() - settings.retentionDays * DAY_MS) {
    return;
  }
  ctx.storage.ensureImportedSession(sessionId, projectPath, Math.floor(mtime));
  const span = {
    first: null,
    last: null
  };
  const followed = await followInternal(
    ctx,
    sessionId,
    path,
    true,
    false,
    span
  );
  ctx.storage.finishImportedSession(
    sessionId,
    span.first ?? Math.floor(mtime),
    span.last ?? Math.floor(mtime)
  );
  total.importedSessions += 1;
  total.entries += followed.entries;
  total.requests += followed.requests;
}
async function importProjectFolder(ctx, projectsRoot, folder, projectPath, settings, installedAt, total) {
  const dir = join6(projectsRoot, folder);
  let names;
  try {
    names = readdirSync2(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = basename(name, ".jsonl");
    const path = join6(dir, name);
    await enqueue(
      ctx,
      () => importOneFile(
        ctx,
        sessionId,
        path,
        projectPath,
        settings,
        installedAt,
        total
      )
    );
  }
}
async function importAll(ctx) {
  const total = { importedSessions: 0, entries: 0, requests: 0 };
  const settings = ctx.options.settings();
  const installedAt = readInstalledAt(ctx.options.dataDir, ctx.now());
  const recorded = /* @__PURE__ */ new Map();
  for (const projectPath of ctx.storage.recordedProjectPaths()) {
    recorded.set(encodeProjectPath(projectPath), projectPath);
  }
  if (recorded.size === 0) return total;
  const projectsRoot = join6(ctx.options.configDir, "projects");
  let folders;
  try {
    folders = readdirSync2(projectsRoot).sort();
  } catch {
    return total;
  }
  for (const folder of folders) {
    const projectPath = recorded.get(folder);
    if (projectPath === void 0) continue;
    if (isExcludedFolder(projectPath, settings.excludedFolders)) {
      continue;
    }
    await importProjectFolder(
      ctx,
      projectsRoot,
      folder,
      projectPath,
      settings,
      installedAt,
      total
    );
  }
  return total;
}

// src/settings-files.ts
function userAndProjectSettingsFiles(cwd) {
  const configDir = resolveClaudeConfigDir();
  return [
    join7(configDir, "settings.json"),
    join7(configDir, "settings.local.json"),
    join7(cwd, ".claude", "settings.json"),
    join7(cwd, ".claude", "settings.local.json")
  ];
}
function managedSettingsFiles(paths) {
  const files = existsSync2(paths.managedSettingsPath) ? [paths.managedSettingsPath] : [];
  try {
    for (const name of readdirSync3(paths.managedDropInDir).sort()) {
      if (name.endsWith(".json")) {
        files.push(join7(paths.managedDropInDir, name));
      }
    }
  } catch {
  }
  return files;
}
function isMissing(error) {
  return error.code === "ENOENT";
}
function readSettingsFiles(files) {
  const read = { settings: [], unreadable: false };
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync6(file, "utf8"));
      if (isPlainObject(parsed)) read.settings.push(parsed);
      else read.unreadable = true;
    } catch (error) {
      if (!isMissing(error)) read.unreadable = true;
    }
  }
  return read;
}
function denyRulesOf(settings) {
  const permissions = settings.permissions;
  if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
    return [];
  }
  return permissions.deny.filter(
    (rule) => typeof rule === "string"
  );
}
function readDenyRules(cwd, managed) {
  const { settings, unreadable } = readSettingsFiles([
    ...userAndProjectSettingsFiles(cwd),
    ...managedSettingsFiles(managed)
  ]);
  return unreadable ? void 0 : settings.flatMap(denyRulesOf);
}

// src/storage/branch-link.ts
function prepareBranchLinkStatements(db) {
  return {
    setBranchSpawningStep: db.prepare(
      "UPDATE branches SET spawning_step_id = ? WHERE id = ?"
    ),
    restampBranchSteps: db.prepare(
      "UPDATE steps SET turn_id = ? WHERE branch_id = ?"
    )
  };
}
function linkBranchToStep(st, branchId, stepId, stepTurnId2) {
  st.setBranchSpawningStep.run(stepId, branchId);
  if (typeof stepTurnId2 === "number") {
    st.restampBranchSteps.run(stepTurnId2, branchId);
  }
}

// src/storage/conditions.ts
function prepareConditionsStatements(db) {
  return {
    getConditions: db.prepare(
      "SELECT * FROM session_conditions WHERE session_id = ?"
    ),
    insertConditions: db.prepare(
      "INSERT OR IGNORE INTO session_conditions (session_id, sources_seen, updated_at) VALUES (?, '[]', ?)"
    )
  };
}

// src/storage/skill-load.ts
var MATCH_WINDOW_MS = 1e4;
var NEAREST = "ORDER BY ABS(occurred_at - ?), id LIMIT 1";
function prepareSkillLoadStatements(db) {
  const inWindow = "session_id = ? AND kind = 'skill' AND (name = ? OR substr(name, -length(?) - 1) = ':' || ?) AND ABS(occurred_at - ?) <= ?";
  return {
    findUnsizedSkillLoad: db.prepare(
      `SELECT id FROM loads WHERE ${inWindow} AND size_bytes IS NULL ${NEAREST}`
    ),
    findSizedSkillLoad: db.prepare(
      `SELECT id FROM loads WHERE ${inWindow} AND size_bytes IS NOT NULL ${NEAREST}`
    ),
    findUntriggeredSkillLoad: db.prepare(
      `SELECT id FROM loads WHERE ${inWindow} AND source = 'transcript' AND trigger IS NULL ${NEAREST}`
    ),
    setSkillTrigger: db.prepare(
      "UPDATE loads SET trigger = ?, name = ? WHERE id = ?"
    )
  };
}
function findLoadForSkillText(st, sessionId, name, at) {
  const args = [sessionId, name, name, name, at, MATCH_WINDOW_MS, at];
  const row = st.findUnsizedSkillLoad.get(...args) ?? st.findSizedSkillLoad.get(...args);
  return row === void 0 ? null : row.id;
}
function triggerTranscriptSkillLoad(st, sessionId, name, trigger, at) {
  const textName = name.slice(name.lastIndexOf(":") + 1);
  const row = st.findUntriggeredSkillLoad.get(
    sessionId,
    textName,
    textName,
    textName,
    at,
    MATCH_WINDOW_MS,
    at
  );
  if (row === void 0) return false;
  st.setSkillTrigger.run(trigger, name, row.id);
  return true;
}

// src/util/host-process.ts
import { spawn, spawnSync } from "node:child_process";
import { readFileSync as readFileSync7 } from "node:fs";
var TICKS_PER_SECOND = 100;
var START_TIME_TOLERANCE_MS = 2e3;
function sameProcessStart(a, b) {
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
function parseProcStat(text, bootTimeSeconds2) {
  const close = text.lastIndexOf(")");
  if (close === -1) {
    return null;
  }
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(parentPid) || !Number.isFinite(startTicks)) {
    return null;
  }
  return {
    parentPid,
    startedAt: Math.round(
      bootTimeSeconds2 * 1e3 + startTicks / TICKS_PER_SECOND * 1e3
    )
  };
}
function bootTimeSeconds() {
  try {
    const match = /^btime (\d+)$/m.exec(readFileSync7("/proc/stat", "utf8"));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}
function readProcessLinuxAt(pid, boot) {
  if (boot === null) {
    return null;
  }
  let stat;
  let cmdline;
  try {
    stat = readFileSync7(`/proc/${pid}/stat`, "utf8");
    cmdline = readFileSync7(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  const parsed = parseProcStat(stat, boot);
  if (parsed === null) {
    return null;
  }
  return {
    pid,
    parentPid: parsed.parentPid,
    startedAt: parsed.startedAt,
    argv: cmdline.split("\0").filter((part) => part !== "")
  };
}
function linuxProcessReader() {
  const boot = bootTimeSeconds();
  return (pid) => readProcessLinuxAt(pid, boot);
}
function windowsRows(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter(
    (raw) => typeof raw === "object" && raw !== null
  );
}
var WINDOWS_STARTED_AT_PROPERTY = `@{n='StartedAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}`;
var WINDOWS_TABLE_SCRIPT = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,${WINDOWS_STARTED_AT_PROPERTY},Name,CommandLine | ConvertTo-Json -Compress`;
function parseWindowsStartTimes(text) {
  const times = /* @__PURE__ */ new Map();
  for (const row of windowsRows(text)) {
    if (typeof row.ProcessId === "number" && typeof row.StartedAt === "number") {
      times.set(row.ProcessId, row.StartedAt);
    }
  }
  return times;
}
function readProcessStartTimesWindows(pids) {
  if (pids.length === 0) {
    return Promise.resolve(/* @__PURE__ */ new Map());
  }
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | Select-Object ProcessId,${WINDOWS_STARTED_AT_PROPERTY} | ConvertTo-Json -Compress`;
  return new Promise((resolve2) => {
    let settled = false;
    const settle = (text) => {
      if (!settled) {
        settled = true;
        resolve2(parseWindowsStartTimes(text));
      }
    };
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true }
      );
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString("utf8");
      });
      const timer = setTimeout(() => child.kill(), 1e4);
      timer.unref();
      child.on("error", () => settle(""));
      child.on("close", () => settle(out));
    } catch {
      settle("");
    }
  });
}
function readProcessStartTimes(pids) {
  if (process.platform === "win32") {
    return readProcessStartTimesWindows(pids);
  }
  const times = /* @__PURE__ */ new Map();
  if (process.platform === "linux") {
    const read = linuxProcessReader();
    for (const pid of pids) {
      const startedAt = read(pid)?.startedAt ?? null;
      if (startedAt !== null) {
        times.set(pid, startedAt);
      }
    }
  }
  return Promise.resolve(times);
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// src/journey/index.ts
var FILL_REQUEST_EFFORT_SQL = "UPDATE requests SET effort = ? WHERE session_id = ? AND turn_id = ? AND effort IS NULL";
function responseSize(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + responseSize(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const first = entries[0];
    if (entries.length === 1 && first !== void 0 && first[0] === "chars" && typeof first[1] === "number") {
      return first[1];
    }
    return entries.reduce(
      (sum, [, item]) => sum + responseSize(item),
      0
    );
  }
  return 0;
}
function readEnabledPlugins(cwd) {
  const names = /* @__PURE__ */ new Set();
  const { settings } = readSettingsFiles(userAndProjectSettingsFiles(cwd));
  for (const file of settings) {
    const plugins = obj(file, "enabledPlugins");
    if (plugins === void 0) continue;
    for (const [key, enabled] of Object.entries(plugins)) {
      if (!enabled) continue;
      const name = key.split("@")[0];
      if (name !== void 0) names.add(name);
    }
  }
  return [...names].sort();
}
function prepareSessionStatements(db) {
  return {
    ...prepareConditionsStatements(db),
    ...preparePromptTextStatements(db),
    getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    insertSession: db.prepare(
      "INSERT OR IGNORE INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, 'live', ?, ?, ?)"
    ),
    clearJoinedPartway: db.prepare(
      "UPDATE sessions SET joined_partway = 0 WHERE id = ?"
    ),
    touchSession: db.prepare(
      "UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?"
    ),
    setProjectPath: db.prepare(
      "UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL"
    ),
    setModel: db.prepare(
      "UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL"
    ),
    saveConditions: db.prepare(
      "UPDATE session_conditions SET permission_modes = ?, instruction_files = ?, enabled_plugins = ?, claude_code_version = ?, sources_seen = ?, updated_at = ? WHERE session_id = ?"
    ),
    getTurnByPrompt: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND prompt_id = ?"
    ),
    getOpenTurn: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY sequence DESC LIMIT 1"
    ),
    nextSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE session_id = ?"
    ),
    insertTurn: db.prepare(
      "INSERT INTO turns (session_id, prompt_id, sequence, started_at, prompt_text, prompt_chars, prompt_lines, flightpath_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    getTurnById: db.prepare("SELECT * FROM turns WHERE id = ?"),
    endTurn: db.prepare(
      "UPDATE turns SET ended_at = ? WHERE id = ? AND ended_at IS NULL"
    ),
    endTurnConcluded: db.prepare(
      "UPDATE turns SET ended_at = ?, end_source = 'concluded' WHERE id = ? AND ended_at IS NULL"
    ),
    reopenConcludedTurns: db.prepare(
      "UPDATE turns SET ended_at = NULL, end_source = NULL WHERE session_id = ? AND end_source = 'concluded'"
    ),
    getOpenTurns: db.prepare(
      "SELECT * FROM turns WHERE session_id = ? AND ended_at IS NULL"
    )
  };
}
function prepareBranchStatements(db) {
  return {
    getBranch: db.prepare(
      "SELECT * FROM branches WHERE session_id = ? AND agent_id = ?"
    ),
    insertBranch: db.prepare(
      "INSERT INTO branches (session_id, agent_id, spawning_step_id, agent_type, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ),
    endBranch: db.prepare(
      "UPDATE branches SET ended_at = ? WHERE id = ? AND ended_at IS NULL"
    ),
    branchBySpawningStep: db.prepare(
      "SELECT id FROM branches WHERE spawning_step_id = ?"
    ),
    setBranchStartedAt: db.prepare(
      "UPDATE branches SET started_at = ? WHERE id = ?"
    ),
    setBranchType: db.prepare(
      "UPDATE branches SET agent_type = ?, kind = ? WHERE id = ?"
    ),
    spawningTurnByBranch: db.prepare(
      "SELECT steps.turn_id AS turn_id FROM branches JOIN steps ON steps.id = branches.spawning_step_id WHERE branches.id = ?"
    )
  };
}
function prepareStepStatements(db) {
  return {
    ...prepareBranchLinkStatements(db),
    ...prepareSkillLoadStatements(db),
    ...prepareBranchStatements(db),
    getStepByToolUse: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1"
    ),
    insertStep: db.prepare(
      "INSERT INTO steps (session_id, turn_id, branch_id, tool_use_id, tool_name, input_summary, outcome, outcome_source, started_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 'hook', ?)"
    ),
    // A step the transcript built for a call whose hook record
    // had not landed yet: when the record lands, the row
    // stands as the transcript left it — closed, with its
    // outcome, end and sizes — and the record only fills what
    // the transcript could not know (a turn, a branch, an
    // input summary, a start time it left null). It never
    // reopens the step or clears a settled fact.
    fillTranscriptStep: db.prepare(
      "UPDATE steps SET turn_id = COALESCE(turn_id, ?), branch_id = COALESCE(branch_id, ?), input_summary = COALESCE(input_summary, ?), started_at = COALESCE(started_at, ?) WHERE session_id = ? AND tool_use_id = ? AND outcome_source = 'transcript' AND outcome IN ('succeeded', 'failed')"
    ),
    closeStep: db.prepare(
      "UPDATE steps SET outcome = ?, outcome_source = ?, ended_at = ?, duration_ms = ? WHERE id = ?"
    ),
    reopenConcludedSteps: db.prepare(
      "UPDATE steps SET outcome = 'open', outcome_source = NULL, ended_at = NULL, duration_ms = NULL WHERE session_id = ? AND outcome_source = 'concluded'"
    ),
    openSteps: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND outcome = 'open'"
    ),
    insertHumanEvent: db.prepare(
      "INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    insertLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, trigger, memory_type, file_path, occurred_at, source, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 'hook', ?)"
    ),
    fillRequestEffort: db.prepare(FILL_REQUEST_EFFORT_SQL),
    askedAboutStep: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_request' LIMIT 1"
    ),
    decisionForStep: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_decision' LIMIT 1"
    ),
    linkCandidates: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_name IN ('Agent', 'Task') AND started_at >= ? AND started_at <= ? ORDER BY started_at, id"
    ),
    setStepResultSize: db.prepare(
      "UPDATE steps SET result_size = ? WHERE id = ?"
    ),
    getPromptEventByTurn: db.prepare(
      "SELECT id FROM human_events WHERE turn_id = ? AND kind = 'prompt' LIMIT 1"
    )
  };
}
function prepareSegmentStatements(db) {
  return {
    getNearbyCompactSegment: db.prepare(
      "SELECT id FROM segments WHERE session_id = ? AND kind = 'compact' AND ABS(started_at - ?) <= 10000 LIMIT 1"
    ),
    insertSegment: db.prepare(
      "INSERT INTO segments (session_id, kind, started_at, context_tokens, prompt_cache_likely_expired) VALUES (?, ?, ?, ?, ?)"
    ),
    endAllBranches: db.prepare(
      "UPDATE branches SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL"
    ),
    endAllBranchesConcluded: db.prepare(
      "UPDATE branches SET ended_at = ?, end_source = 'concluded' WHERE session_id = ? AND ended_at IS NULL"
    ),
    reopenConcludedBranches: db.prepare(
      "UPDATE branches SET ended_at = NULL, end_source = NULL WHERE session_id = ? AND end_source = 'concluded'"
    ),
    endSession: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 1 WHERE id = ?"
    ),
    endSessionUnseen: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0 WHERE id = ?"
    ),
    endSessionUnseenIfUnchanged: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0 WHERE id = ? AND status = 'live' AND last_seen_at = ? AND host_pid IS ?"
    ),
    reviveSession: db.prepare(
      "UPDATE sessions SET status = 'live' WHERE id = ? AND status = 'ended'"
    ),
    setHostProcess: db.prepare(
      "UPDATE sessions SET host_pid = ?, host_started_at = ? WHERE id = ?"
    ),
    sessionsOnHost: db.prepare(
      "SELECT id, last_seen_at, host_started_at FROM sessions WHERE host_pid = ? AND status = 'live'"
    ),
    insertPause: db.prepare(
      "INSERT INTO pauses (session_id, paused_at) VALUES (?, ?)"
    ),
    pauseSession: db.prepare(
      "UPDATE sessions SET status = 'paused' WHERE id = ? AND status != 'ended'"
    ),
    resumePauses: db.prepare(
      "UPDATE pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL"
    ),
    unpauseSession: db.prepare(
      "UPDATE sessions SET status = 'live' WHERE id = ? AND status = 'paused'"
    )
  };
}
function prepareStatements(db) {
  return {
    ...prepareSessionStatements(db),
    ...prepareStepStatements(db),
    ...prepareSegmentStatements(db)
  };
}
function createJourneyBuilder(db) {
  const statements = prepareStatements(db);
  const applyEvent = (event, at) => applyHookEvent(statements, event, at);
  const apply = (event, at) => {
    applyEvent(event, at);
    endSessionReplacedByStart(statements, event);
  };
  return {
    applyHookEvent: apply,
    recordPause: (sessionId, at) => recordPause(statements, sessionId, at),
    recordResume: (sessionId, at) => recordResume(statements, sessionId, at),
    endSessionUnseen: (sessionId, at) => endSessionUnseen(statements, sessionId, at),
    endSessionUnseenIfUnchanged: (session) => endSessionUnseenIfUnchanged(statements, session)
  };
}
function reopenConclusion(st, sessionId) {
  st.reopenConcludedSteps.run(sessionId);
  st.reopenConcludedTurns.run(sessionId);
  st.reopenConcludedBranches.run(sessionId);
}
function ensureConditions(st, sessionId, at) {
  st.insertConditions.run(sessionId, at);
  return st.getConditions.get(sessionId);
}
function saveConditions(st, sessionId, row, at) {
  st.saveConditions.run(
    asText(row.permission_modes),
    asText(row.instruction_files),
    asText(row.enabled_plugins),
    asText(row.claude_code_version),
    asText(row.sources_seen),
    at,
    sessionId
  );
}
function ensureSession(st, sessionId, event, at) {
  const isStart = event.hook_event_name === "SessionStart";
  st.insertSession.run(sessionId, at, at, isStart ? 0 : 1);
  st.touchSession.run(at, sessionId);
  const cwd = str(event, "cwd");
  if (cwd !== void 0) {
    st.setProjectPath.run(cwd, sessionId);
  }
  const model = str(event, "model");
  if (model !== void 0) {
    st.setModel.run(model, sessionId);
  }
}
function updateConditions(st, sessionId, event, at) {
  const row = ensureConditions(st, sessionId, at);
  let changed = false;
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("hook")) {
    sources.push("hook");
    row.sources_seen = JSON.stringify(sources);
    changed = true;
  }
  const mode = str(event, "permission_mode");
  if (mode !== void 0) {
    const modes = parseStringArray(row.permission_modes);
    if (modes[modes.length - 1] !== mode) {
      modes.push(mode);
      row.permission_modes = JSON.stringify(modes);
      changed = true;
    }
  }
  if (changed) saveConditions(st, sessionId, row, at);
}
function ensurePlugins(st, sessionId, event, at) {
  const row = ensureConditions(st, sessionId, at);
  if (row.enabled_plugins !== null && row.enabled_plugins !== void 0) {
    return;
  }
  const cwd = str(event, "cwd") ?? str(st.getSession.get(sessionId), "project_path");
  row.enabled_plugins = JSON.stringify(
    cwd !== void 0 ? readEnabledPlugins(cwd) : []
  );
  saveConditions(st, sessionId, row, at);
}
function closeStepRow(st, step, outcome, source, at) {
  const started = typeof step.started_at === "number" ? step.started_at : null;
  st.closeStep.run(
    outcome,
    source,
    at,
    started !== null ? at - started : null,
    step.id
  );
}
function closeStepWithoutEvent(st, step, at, source) {
  const asked = st.askedAboutStep.get(step.id);
  closeStepRow(
    st,
    step,
    asked !== void 0 ? "rejected" : "interrupted",
    source,
    at
  );
}
function closeOpenSteps(st, sessionId, turnId, at, source) {
  const steps = st.openSteps.all(sessionId);
  for (const step of steps) {
    if (turnId !== null && step.turn_id !== turnId) continue;
    if (turnId !== null && step.branch_id !== null) continue;
    closeStepWithoutEvent(st, step, at, source);
  }
}
function closeTurn(st, sessionId, turn, at, source) {
  closeOpenSteps(st, sessionId, turn.id, at, source);
  if (source === "concluded") {
    st.endTurnConcluded.run(at, turn.id);
  } else {
    st.endTurn.run(at, turn.id);
  }
}
function hookPromptColumns(event, text) {
  const columns = promptTextColumns(text);
  const chars = num(event, "prompt_chars");
  const lines = num(event, "prompt_lines");
  if (text === null || chars === void 0 || lines === void 0) {
    return columns;
  }
  return { text: columns.text, chars, lines };
}
function ensureTurn(st, sessionId, event, at) {
  const promptId = str(event, "prompt_id");
  if (promptId !== void 0) {
    const existing = st.getTurnByPrompt.get(sessionId, promptId);
    if (existing !== void 0) return existing;
  }
  const open = st.getOpenTurn.get(sessionId);
  const promptText = event.hook_event_name === "UserPromptSubmit" ? str(event, "prompt") ?? null : null;
  if (promptId === void 0 && promptText === null) {
    return open;
  }
  if (open !== void 0) closeTurn(st, sessionId, open, at, "inferred");
  const sequence = st.nextSequence.get(sessionId).n;
  const columns = hookPromptColumns(event, promptText);
  const result = st.insertTurn.run(
    sessionId,
    promptId ?? null,
    sequence,
    at,
    columns.text,
    columns.chars,
    columns.lines,
    0
  );
  return st.getTurnById.get(Number(result.lastInsertRowid));
}
function turnFor(st, sessionId, event, at) {
  const promptId = str(event, "prompt_id");
  if (promptId !== void 0) {
    const turn = st.getTurnByPrompt.get(sessionId, promptId);
    if (turn !== void 0) return turn;
    return ensureTurn(st, sessionId, event, at);
  }
  return st.getOpenTurn.get(sessionId);
}
function permissionDecision(st, step, turnId, at) {
  const asked = st.askedAboutStep.get(step.id);
  if (asked === void 0) return;
  const decided = st.decisionForStep.get(step.id);
  if (decided !== void 0) return;
  st.insertHumanEvent.run(
    step.session_id,
    typeof turnId === "number" ? turnId : null,
    step.id,
    "permission_decision",
    at,
    "accept",
    "inferred",
    null
  );
}
function expiredFlag(value) {
  if (typeof value !== "boolean") return null;
  return value ? 1 : 0;
}
function applySessionStart(st, sessionId, event, at) {
  ensurePlugins(st, sessionId, event, at);
  const hostPid = num(event, "host_pid");
  const hostStartedAt = num(event, "host_started_at");
  if (hostPid !== void 0 && hostStartedAt !== void 0) {
    st.setHostProcess.run(hostPid, hostStartedAt, sessionId);
  } else {
    st.setHostProcess.run(null, null, sessionId);
  }
  const version = str(event, "version");
  if (version !== void 0) {
    const row = ensureConditions(st, sessionId, at);
    if (row.claude_code_version !== version) {
      row.claude_code_version = version;
      saveConditions(st, sessionId, row, at);
    }
  }
  const kind = str(event, "source") ?? "startup";
  if (kind === "startup" || kind === "clear") {
    st.clearJoinedPartway.run(sessionId);
  }
  const nearbyCompact = kind === "compact" ? st.getNearbyCompactSegment.get(sessionId, at) : void 0;
  if (nearbyCompact === void 0) {
    st.insertSegment.run(
      sessionId,
      kind,
      at,
      num(event, "context_tokens") ?? null,
      expiredFlag(event.prompt_cache_likely_expired)
    );
  }
}
function endSessionReplacedByStart(st, event) {
  if (str(event, "hook_event_name") !== "SessionStart") {
    return;
  }
  const sessionId = str(event, "session_id");
  const hostPid = num(event, "host_pid");
  const hostStartedAt = num(event, "host_started_at");
  if (sessionId === void 0 || hostPid === void 0 || hostStartedAt === void 0) {
    return;
  }
  endReplacedSessions(st, sessionId, hostPid, hostStartedAt);
}
function endReplacedSessions(st, sessionId, hostPid, hostStartedAt) {
  const others = st.sessionsOnHost.all(hostPid);
  for (const other of others) {
    if (other.id === sessionId) {
      continue;
    }
    const otherStartedAt = other.host_started_at;
    if (otherStartedAt !== null && sameProcessStart(otherStartedAt, hostStartedAt)) {
      endSessionUnseen(st, other.id, other.last_seen_at);
    }
  }
}
function applyUserPromptSubmit(st, sessionId, event, at) {
  const kind = str(event, "prompt_kind");
  if (kind !== void 0) {
    if (kind !== "typed") return;
  } else {
    const submitted = str(event, "prompt");
    if (submitted !== void 0 && isFlightpathCommand(submitted)) return;
    if (submitted !== void 0 && isAgentMessage(submitted)) return;
  }
  const turn = ensureTurn(st, sessionId, event, at);
  if (turn === void 0) return;
  const text = str(event, "prompt");
  if (text !== void 0 && turn.prompt_text === null) {
    setTurnPromptColumns(st, turn.id, hookPromptColumns(event, text));
  }
  if (text === void 0 && turn.prompt_chars === null) {
    const chars = num(event, "prompt_chars");
    const lines = num(event, "prompt_lines");
    if (chars !== void 0 && lines !== void 0) {
      fillTurnPromptFigures(st, turn.id, chars, lines);
    }
  }
  const seen = st.getPromptEventByTurn.get(turn.id);
  if (seen === void 0) {
    st.insertHumanEvent.run(
      sessionId,
      turn.id,
      null,
      "prompt",
      at,
      null,
      null,
      null
    );
  }
}
function applyUserPromptExpansion(st, sessionId, event, at) {
  const command = str(event, "command_name");
  if (command === void 0 || !isFlightpathCommand(command)) {
    ensureTurn(st, sessionId, event, at);
  }
  if (command !== void 0 && !isFlightpathCommand(command)) {
    recordSkillLoad(st, sessionId, command, "user_slash", at);
  }
}
function recordSkillLoad(st, sessionId, name, trigger, at) {
  if (triggerTranscriptSkillLoad(st, sessionId, name, trigger, at)) return;
  st.insertLoad.run(sessionId, "skill", name, trigger, null, null, at, null);
}
function openStep(st, sessionId, turnId, branchId, event, at) {
  const input = obj(event, "tool_input");
  const inputSummary = input !== void 0 ? JSON.stringify(input) : null;
  const toolUseId = str(event, "tool_use_id");
  if (toolUseId !== void 0) {
    const filled = st.fillTranscriptStep.run(
      turnId,
      branchId,
      inputSummary,
      at,
      sessionId,
      toolUseId
    );
    if (filled.changes > 0) return;
  }
  st.insertStep.run(
    sessionId,
    turnId,
    branchId,
    toolUseId ?? null,
    str(event, "tool_name") ?? "unknown",
    inputSummary,
    at
  );
}
function stepTurnId(st, sessionId, event, at, branch) {
  const turn = turnFor(st, sessionId, event, at);
  if (branch !== void 0) {
    const spawning = st.spawningTurnByBranch.get(branch.id);
    if (spawning !== void 0 && typeof spawning.turn_id === "number") {
      return spawning.turn_id;
    }
  }
  return turn !== void 0 ? turn.id : null;
}
function applyPreToolUse(st, sessionId, event, at) {
  const agentId = str(event, "agent_id");
  const branch = agentId !== void 0 ? st.getBranch.get(sessionId, agentId) : void 0;
  let branchId = branch !== void 0 ? branch.id : null;
  if (agentId !== void 0 && branch === void 0) {
    branchId = insertBranch(
      st,
      sessionId,
      agentId,
      null,
      str(event, "agent_type") ?? "",
      at,
      null
    );
  }
  openStep(
    st,
    sessionId,
    stepTurnId(st, sessionId, event, at, branch),
    branchId,
    event,
    at
  );
  if (str(event, "tool_name") === "Skill") {
    const input = obj(event, "tool_input");
    const skill = input !== void 0 ? str(input, "skill") : void 0;
    if (skill !== void 0) recordSkillLoad(st, sessionId, skill, "agent", at);
  }
}
function closeStepFromEvent(st, sessionId, toolUseId, outcome, source, at) {
  const step = st.getStepByToolUse.get(sessionId, toolUseId);
  if (step !== void 0 && step.outcome === "open") {
    closeStepRow(st, step, outcome, source, at);
  }
  return step;
}
function applyPostToolUse(st, sessionId, event, at, failed) {
  const toolUseId = str(event, "tool_use_id");
  if (toolUseId === void 0) return;
  const step = closeStepFromEvent(
    st,
    sessionId,
    toolUseId,
    failed ? "failed" : "succeeded",
    "hook",
    at
  );
  if (step === void 0) return;
  permissionDecision(st, step, step.turn_id, at);
  if (!failed && str(event, "tool_name") === "AskUserQuestion") {
    const response = obj(event, "tool_response");
    const answers = response !== void 0 ? obj(response, "answers") : void 0;
    st.insertHumanEvent.run(
      sessionId,
      typeof step.turn_id === "number" ? step.turn_id : null,
      step.id,
      "question_answered",
      at,
      null,
      null,
      JSON.stringify(answers ?? response ?? null)
    );
  }
  if (event.tool_response !== void 0 && step.outcome === "open") {
    st.setStepResultSize.run(
      responseSize(event.tool_response),
      step.id
    );
  }
}
function applyPostToolBatch(st, sessionId, event, at) {
  const calls = event.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (!isPlainObject(call)) continue;
    const toolUseId = str(call, "tool_use_id");
    if (toolUseId === void 0) continue;
    closeStepFromEvent(st, sessionId, toolUseId, "succeeded", "batch", at);
  }
}
function applyPermissionRequest(st, sessionId, event, at) {
  const turn = turnFor(st, sessionId, event, at);
  const toolUseId = str(event, "tool_use_id");
  let step = toolUseId !== void 0 ? st.getStepByToolUse.get(sessionId, toolUseId) : void 0;
  if (step === void 0) {
    const toolName = str(event, "tool_name");
    step = st.openSteps.all(sessionId).find(
      (s) => s.tool_name === toolName
    );
  }
  st.insertHumanEvent.run(
    sessionId,
    turn !== void 0 ? turn.id : null,
    step !== void 0 ? step.id : null,
    "permission_request",
    at,
    null,
    null,
    null
  );
}
function applyNotification(st, sessionId, event, at) {
  const promptId = str(event, "prompt_id");
  const turn = promptId !== void 0 ? st.getTurnByPrompt.get(sessionId, promptId) : st.getOpenTurn.get(sessionId);
  const type = str(event, "notification_type");
  st.insertHumanEvent.run(
    sessionId,
    turn !== void 0 ? turn.id : null,
    null,
    "waiting",
    at,
    null,
    null,
    type !== void 0 ? JSON.stringify({ notification_type: type }) : null
  );
}
function applyStop(st, sessionId, at) {
  const open = st.getOpenTurn.get(sessionId);
  if (open !== void 0) closeTurn(st, sessionId, open, at, "inferred");
}
function findSpawningStep(st, sessionId, agentType, at) {
  const candidates = st.linkCandidates.all(sessionId, at - 1e4, at);
  for (const step of candidates) {
    const linked = st.branchBySpawningStep.get(step.id);
    if (linked !== void 0) continue;
    const input = typeof step.input_summary === "string" ? JSON.parse(step.input_summary) : void 0;
    if (input !== void 0 && str(input, "subagent_type") === agentType) {
      return step;
    }
  }
  return void 0;
}
function insertBranch(st, sessionId, agentId, spawningStepId, agentType, startedAt, endedAt) {
  const result = st.insertBranch.run(
    sessionId,
    agentId,
    spawningStepId,
    agentType,
    agentType === "" ? "internal" : "user",
    startedAt,
    endedAt
  );
  return Number(result.lastInsertRowid);
}
function setSpawningStep(st, branch, step) {
  const turnId = step.turn_id;
  linkBranchToStep(
    st,
    branch.id,
    step.id,
    typeof turnId === "number" ? turnId : null
  );
}
function fillBranchFromStart(st, sessionId, branch, agentType, at) {
  const startedAt = branch.started_at;
  if (typeof startedAt !== "number" || at < startedAt) {
    st.setBranchStartedAt.run(at, branch.id);
  }
  if (branch.agent_type === "" && agentType !== "") {
    st.setBranchType.run(agentType, "user", branch.id);
  }
  if (typeof branch.spawning_step_id !== "number") {
    const spawning = findSpawningStep(st, sessionId, agentType, at);
    if (spawning !== void 0) setSpawningStep(st, branch, spawning);
  }
}
function applySubagentStart(st, sessionId, event, at) {
  const agentId = str(event, "agent_id");
  if (agentId === void 0) return;
  const agentType = str(event, "agent_type") ?? "";
  const existing = st.getBranch.get(sessionId, agentId);
  if (existing !== void 0) {
    fillBranchFromStart(st, sessionId, existing, agentType, at);
    return;
  }
  const spawning = findSpawningStep(st, sessionId, agentType, at);
  insertBranch(
    st,
    sessionId,
    agentId,
    spawning !== void 0 ? spawning.id : null,
    agentType,
    at,
    null
  );
}
function applySubagentStop(st, sessionId, event, at) {
  const agentId = str(event, "agent_id");
  if (agentId === void 0) return;
  const branch = st.getBranch.get(sessionId, agentId);
  if (branch !== void 0) {
    st.endBranch.run(at, branch.id);
    for (const step of st.openSteps.all(sessionId)) {
      if (step.branch_id === branch.id) {
        closeStepWithoutEvent(st, step, at, "inferred");
      }
    }
    return;
  }
  const agentType = str(event, "agent_type") ?? "";
  insertBranch(st, sessionId, agentId, null, agentType, null, at);
}
function applyInstructionsLoaded(st, sessionId, event, at) {
  const filePath = str(event, "file_path");
  st.insertLoad.run(
    sessionId,
    "instructions",
    null,
    null,
    str(event, "memory_type") ?? null,
    filePath ?? null,
    at,
    // The daemon statted the file when the event arrived and
    // carried the size on the event, so the stored event is
    // the size's record; a file already gone carries none.
    num(event, "file_size_bytes") ?? null
  );
  if (filePath !== void 0) {
    const row = ensureConditions(st, sessionId, at);
    const files = parseStringArray(row.instruction_files);
    if (!files.includes(filePath)) {
      files.push(filePath);
      row.instruction_files = JSON.stringify(files);
      saveConditions(st, sessionId, row, at);
    }
  }
}
function closeOutSession(st, sessionId, at, source) {
  const turns = st.getOpenTurns.all(sessionId);
  for (const turn of turns) closeTurn(st, sessionId, turn, at, source);
  closeOpenSteps(st, sessionId, null, at, source);
  if (source === "concluded") {
    st.endAllBranchesConcluded.run(at, sessionId);
  } else {
    st.endAllBranches.run(at, sessionId);
  }
}
function applySessionEnd(st, sessionId, at) {
  closeOutSession(st, sessionId, at, "inferred");
  st.endSession.run(sessionId);
}
function endSessionUnseen(st, sessionId, at) {
  closeOutSession(st, sessionId, at, "concluded");
  st.endSessionUnseen.run(sessionId);
}
function endSessionUnseenIfUnchanged(st, session) {
  const result = st.endSessionUnseenIfUnchanged.run(
    session.id,
    session.lastSeenAt,
    session.hostPid
  );
  if (result.changes === 0) {
    return false;
  }
  closeOutSession(st, session.id, session.lastSeenAt, "concluded");
  return true;
}
function fillEffortFromHook(st, sessionId, event) {
  const effort = obj(event, "effort");
  const level = effortLevel(
    effort !== void 0 ? str(effort, "level") : void 0
  );
  if (level === null) return;
  const promptId = str(event, "prompt_id");
  const turn = promptId !== void 0 ? st.getTurnByPrompt.get(sessionId, promptId) : st.getOpenTurn.get(sessionId);
  if (turn !== void 0) {
    st.fillRequestEffort.run(level, sessionId, turn.id);
  }
}
function applyHookEvent(st, event, at) {
  const sessionId = str(event, "session_id");
  if (sessionId === void 0) return;
  ensureSession(st, sessionId, event, at);
  updateConditions(st, sessionId, event, at);
  const name = str(event, "hook_event_name");
  if (name !== "SessionEnd") {
    const row = st.getSession.get(sessionId);
    if (row !== void 0 && row.status === "ended" && row.end_seen === 0) {
      reopenConclusion(st, sessionId);
    }
    st.reviveSession.run(sessionId);
  }
  dispatchHookEvent(st, sessionId, name, event, at);
  fillEffortFromHook(st, sessionId, event);
}
function dispatchHookEvent(st, sessionId, name, event, at) {
  switch (name) {
    case "SessionStart":
      applySessionStart(st, sessionId, event, at);
      break;
    case "UserPromptSubmit":
      applyUserPromptSubmit(st, sessionId, event, at);
      break;
    case "UserPromptExpansion":
      applyUserPromptExpansion(st, sessionId, event, at);
      break;
    case "PreToolUse":
      applyPreToolUse(st, sessionId, event, at);
      break;
    case "PostToolUse":
      applyPostToolUse(st, sessionId, event, at, false);
      break;
    case "PostToolUseFailure":
      applyPostToolUse(st, sessionId, event, at, true);
      break;
    case "PostToolBatch":
      applyPostToolBatch(st, sessionId, event, at);
      break;
    case "PermissionRequest":
      applyPermissionRequest(st, sessionId, event, at);
      break;
    case "Notification":
      applyNotification(st, sessionId, event, at);
      break;
    case "Stop":
      applyStop(st, sessionId, at);
      break;
    case "SubagentStart":
      applySubagentStart(st, sessionId, event, at);
      break;
    case "SubagentStop":
      applySubagentStop(st, sessionId, event, at);
      break;
    case "InstructionsLoaded":
      applyInstructionsLoaded(st, sessionId, event, at);
      break;
    case "SessionEnd":
      applySessionEnd(st, sessionId, at);
      break;
    default:
      break;
  }
}
function recordPause(st, sessionId, at) {
  st.insertSession.run(sessionId, at, at, 1);
  st.insertPause.run(sessionId, at);
  st.pauseSession.run(sessionId);
}
function recordResume(st, sessionId, at) {
  st.insertSession.run(sessionId, at, at, 1);
  st.resumePauses.run(at, sessionId);
  st.unpauseSession.run(sessionId);
}

// src/telemetry/store.ts
function prepareSessionStatements2(db) {
  return {
    ...prepareConditionsStatements(db),
    getSession: db.prepare("SELECT project_path FROM sessions WHERE id = ?"),
    updateSources: db.prepare(
      "UPDATE session_conditions SET sources_seen = ?, updated_at = ? WHERE session_id = ?"
    ),
    updateHookStats: db.prepare(
      "UPDATE session_conditions SET hook_stats = ?, updated_at = ? WHERE session_id = ?"
    )
  };
}
function prepareEventStatements(db) {
  return {
    getStepByToolUse: db.prepare(
      "SELECT * FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1"
    ),
    getDecisionEvent: db.prepare(
      "SELECT id FROM human_events WHERE step_id = ? AND kind = 'permission_decision' LIMIT 1"
    ),
    getRequestEvent: db.prepare(
      "SELECT id, turn_id FROM human_events WHERE step_id = ? AND kind = 'permission_request' LIMIT 1"
    ),
    updateDecision: db.prepare(
      "UPDATE human_events SET decision = ?, decision_source = ?, occurred_at = ? WHERE id = ?"
    ),
    insertHumanEvent: db.prepare(
      "INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at, decision, decision_source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    getPromptEvent: db.prepare(
      "SELECT id FROM human_events WHERE turn_id = ? AND kind = 'prompt' LIMIT 1"
    ),
    closeStep: db.prepare(
      "UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', ended_at = ?, duration_ms = ? WHERE id = ?"
    ),
    correctStep: db.prepare(
      "UPDATE steps SET outcome = 'failed', outcome_source = 'telemetry', duration_ms = COALESCE(?, duration_ms) WHERE id = ?"
    ),
    // Branches of one type overlapping a moment: the window's end
    // carries a small grace, because the completion event and the
    // hook that ended the branch are stamped by different clocks.
    getBranchesByType: db.prepare(
      "SELECT id FROM branches WHERE session_id = ? AND agent_type = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)"
    ),
    // An end telemetry reports replaces a concluded one and
    // clears its mark, like the transcript's closings; a real
    // end already recorded stands.
    updateBranch: db.prepare(
      "UPDATE branches SET total_tokens = COALESCE(?, total_tokens), token_source = 'telemetry', ended_at = CASE WHEN end_source = 'concluded' THEN ? ELSE COALESCE(ended_at, ?) END, end_source = CASE WHEN end_source = 'concluded' THEN NULL ELSE end_source END WHERE id = ?"
    ),
    recentSkillLoad: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND kind = 'skill' AND name = ? AND ABS(occurred_at - ?) <= 5000 LIMIT 1"
    ),
    insertLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, trigger, memory_type, file_path, occurred_at, source) VALUES (?, 'skill', ?, NULL, NULL, NULL, ?, 'telemetry')"
    ),
    getNearbyCompact: db.prepare(
      "SELECT id, context_tokens FROM segments WHERE session_id = ? AND kind = 'compact' AND ABS(started_at - ?) <= 10000 ORDER BY ABS(started_at - ?) LIMIT 1"
    ),
    setSegmentTokens: db.prepare(
      "UPDATE segments SET context_tokens = ? WHERE id = ? AND context_tokens IS NULL"
    ),
    insertSegment: db.prepare(
      "INSERT INTO segments (session_id, kind, started_at, context_tokens, prompt_cache_likely_expired) VALUES (?, 'compact', ?, ?, NULL)"
    )
  };
}
function prepareStatements2(db) {
  return {
    ...prepareSessionStatements2(db),
    ...prepareEventStatements(db)
  };
}
function createTelemetryStore(db) {
  const statements = prepareStatements2(db);
  return {
    noteTelemetrySeen: (sessionId, at) => noteTelemetrySeen(statements, sessionId, at),
    sessionProjectPath: (sessionId) => sessionProjectPath(statements, sessionId),
    correctPermissionDecision: (input) => correctPermissionDecision(statements, input),
    correctStepOutcome: (input) => correctStepOutcome(statements, input),
    setBranchTotals: (input) => setBranchTotals(statements, input),
    branchIdByAgentType: (sessionId, agentType, at) => uniqueBranchByType(statements, sessionId, agentType, at),
    addSkillLoad: (input) => addSkillLoad(statements, input),
    recordPromptEvent: (input) => recordPromptEvent(statements, input),
    recordCompaction: (input) => recordCompaction(statements, input),
    addHookExecution: (input) => addHookExecution(statements, input)
  };
}
function conditionRow(statements, sessionId, at) {
  statements.insertConditions.run(sessionId, at);
  return statements.getConditions.get(sessionId);
}
function noteTelemetrySeen(statements, sessionId, at) {
  const row = conditionRow(statements, sessionId, at);
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("telemetry")) sources.push("telemetry");
  statements.updateSources.run(JSON.stringify(sources), at, sessionId);
}
function sessionProjectPath(statements, sessionId) {
  const row = statements.getSession.get(sessionId);
  if (row === void 0) return void 0;
  return typeof row.project_path === "string" ? row.project_path : null;
}
function correctPermissionDecision(statements, input) {
  const step = statements.getStepByToolUse.get(
    input.sessionId,
    input.toolUseId
  );
  if (step === void 0) return false;
  const stepId = step.id;
  const existing = statements.getDecisionEvent.get(stepId);
  if (existing !== void 0) {
    statements.updateDecision.run(
      input.decision,
      input.source,
      input.at,
      existing.id
    );
    return true;
  }
  const request = statements.getRequestEvent.get(stepId);
  if (request === void 0) return false;
  statements.insertHumanEvent.run(
    input.sessionId,
    request.turn_id ?? (typeof step.turn_id === "number" ? step.turn_id : null),
    stepId,
    "permission_decision",
    input.at,
    input.decision,
    input.source,
    null
  );
  return true;
}
function correctStepOutcome(statements, input) {
  const step = statements.getStepByToolUse.get(
    input.sessionId,
    input.toolUseId
  );
  if (step === void 0) return false;
  if (step.outcome === "open") {
    const started = typeof step.started_at === "number" ? step.started_at : null;
    statements.closeStep.run(
      input.at,
      input.durationMs ?? (started !== null ? input.at - started : null),
      step.id
    );
    return true;
  }
  if (step.outcome_source === "inferred" || step.outcome_source === "concluded") {
    statements.correctStep.run(input.durationMs, step.id);
    return true;
  }
  return false;
}
function uniqueBranchByType(statements, sessionId, agentType, at) {
  const rows = statements.getBranchesByType.all(
    sessionId,
    agentType,
    at,
    at - 5e3
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  return row === void 0 ? null : row.id;
}
function setBranchTotals(statements, input) {
  const branchId = uniqueBranchByType(
    statements,
    input.sessionId,
    input.agentType,
    input.at
  );
  if (branchId === null) return false;
  statements.updateBranch.run(input.totalTokens, input.at, input.at, branchId);
  return true;
}
function addSkillLoad(statements, input) {
  if (statements.recentSkillLoad.get(input.sessionId, input.name, input.at) !== void 0) {
    return;
  }
  statements.insertLoad.run(input.sessionId, input.name, input.at);
}
function recordPromptEvent(statements, input) {
  if (statements.getPromptEvent.get(input.turnId) !== void 0) return;
  statements.insertHumanEvent.run(
    input.sessionId,
    input.turnId,
    null,
    "prompt",
    input.at,
    null,
    null,
    input.promptLength !== null ? JSON.stringify({ prompt_length: input.promptLength }) : null
  );
}
function recordCompaction(statements, input) {
  const nearby = statements.getNearbyCompact.get(
    input.sessionId,
    input.at,
    input.at
  );
  if (nearby !== void 0) {
    if (input.postTokens !== null) {
      statements.setSegmentTokens.run(input.postTokens, nearby.id);
    }
    return;
  }
  statements.insertSegment.run(input.sessionId, input.at, input.postTokens);
}
function addHookExecution(statements, input) {
  const row = conditionRow(statements, input.sessionId, input.at);
  const stats = readHookStats(row.hook_stats);
  stats.executions += 1;
  if (input.durationMs !== null) {
    stats.total_ms += input.durationMs;
    stats.max_ms = Math.max(stats.max_ms, input.durationMs);
  }
  const entry = stats.by_hook[input.name] ?? {
    count: 0,
    total_ms: 0,
    max_ms: 0,
    num_hooks: 0
  };
  entry.count += 1;
  if (input.durationMs !== null) {
    entry.total_ms += input.durationMs;
    entry.max_ms = Math.max(entry.max_ms, input.durationMs);
  }
  if (input.numHooks !== null) entry.num_hooks = input.numHooks;
  stats.by_hook[input.name] = entry;
  statements.updateHookStats.run(
    JSON.stringify(stats),
    input.at,
    input.sessionId
  );
}
function readHookStats(raw) {
  const empty = {
    executions: 0,
    total_ms: 0,
    max_ms: 0,
    by_hook: {}
  };
  if (typeof raw !== "string") return empty;
  try {
    const parsed = JSON.parse(raw);
    return {
      executions: parsed.executions ?? 0,
      total_ms: parsed.total_ms ?? 0,
      max_ms: parsed.max_ms ?? 0,
      by_hook: parsed.by_hook ?? {}
    };
  } catch {
    return empty;
  }
}

// src/telemetry/index.ts
var HOLD_MS = 15e3;
var HOLD_CAP = 500;
function createTelemetryIntake() {
  const held = /* @__PURE__ */ new Map();
  return {
    processExport: (storage, body, options) => processExport(held, storage, body, options),
    flushSession: (storage, sessionId, options) => flushHeld(held, storage, sessionId, options),
    dropStale: (now) => dropStale(held, now)
  };
}
function emptyResult() {
  return { accepted: 0, dropped: 0, unknown: 0, held: 0 };
}
function allLogRecords(body) {
  if (!isPlainObject(body) || !Array.isArray(body.resourceLogs)) {
    return [];
  }
  const records = [];
  for (const resourceLog of body.resourceLogs) {
    if (!isPlainObject(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
      continue;
    }
    collectScopeRecords(resourceLog.scopeLogs, records);
  }
  return records;
}
function collectScopeRecords(scopeLogs, records) {
  for (const scopeLog of scopeLogs) {
    if (!isPlainObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
      continue;
    }
    for (const rawRecord of scopeLog.logRecords) {
      if (isPlainObject(rawRecord)) records.push(rawRecord);
    }
  }
}
function processExport(held, storage, body, options) {
  const result = emptyResult();
  const notedSessions = /* @__PURE__ */ new Set();
  for (const rawRecord of allLogRecords(body)) {
    processRecord(
      held,
      storage,
      rawRecord,
      options,
      notedSessions,
      result,
      true
    );
  }
  return result;
}
function flushHeld(held, storage, sessionId, options) {
  const result = emptyResult();
  const entry = held.get(sessionId);
  if (entry === void 0) return result;
  if (storage.sessionProjectPath(sessionId) === void 0) {
    return result;
  }
  held.delete(sessionId);
  const notedSessions = /* @__PURE__ */ new Set();
  for (const record of entry.records) {
    processRecord(
      held,
      storage,
      record.raw,
      { settings: options.settings, receivedAt: record.receivedAt },
      notedSessions,
      result,
      false
    );
  }
  return result;
}
function dropStale(held, now) {
  let dropped = 0;
  for (const [sessionId, entry] of held) {
    const oldest = entry.records[0];
    if (oldest !== void 0 && now - oldest.receivedAt > HOLD_MS) {
      dropped += entry.records.length;
      held.delete(sessionId);
    }
  }
  return dropped;
}
function processRecord(held, storage, rawRecord, options, notedSessions, result, allowHold) {
  const at = recordTimeMs(rawRecord, options.receivedAt);
  const redacted = redactTelemetryRecord(rawRecord);
  const attrs = readAttrs(redacted);
  const sessionId = textAttr(attrs, "session.id");
  if (sessionId === null || storage.isForgotten(sessionId)) {
    result.dropped += 1;
    return;
  }
  const projectPath = storage.sessionProjectPath(sessionId);
  if (projectPath === void 0) {
    holdRecord(held, rawRecord, options, sessionId, result, allowHold);
    return;
  }
  if (isExcludedOrPaused(storage, projectPath, options, sessionId, at)) {
    result.dropped += 1;
    return;
  }
  if (!notedSessions.has(sessionId)) {
    storage.noteTelemetrySeen(sessionId, at);
    notedSessions.add(sessionId);
  }
  insertRawRecord(storage, attrs, sessionId, at, redacted);
  result.accepted += 1;
  const eventName = textAttr(attrs, "event.name") ?? "";
  const kind = eventName.slice(eventName.lastIndexOf(".") + 1);
  applyRecord(
    storage,
    kind,
    attrs,
    { sessionId, at, promptId: textAttr(attrs, "prompt.id") },
    result
  );
}
function holdRecord(held, rawRecord, options, sessionId, result, allowHold) {
  if (!allowHold) {
    result.dropped += 1;
    return;
  }
  let entry = held.get(sessionId);
  if (entry === void 0) {
    entry = { records: [] };
    held.set(sessionId, entry);
  }
  if (entry.records.length < HOLD_CAP) {
    entry.records.push({ raw: rawRecord, receivedAt: options.receivedAt });
    result.held += 1;
  } else {
    result.dropped += 1;
  }
}
function isExcludedOrPaused(storage, projectPath, options, sessionId, at) {
  if (projectPath !== null && isExcludedFolder(projectPath, options.settings.excludedFolders)) {
    return true;
  }
  return storage.pausesFor(sessionId).some(
    (pause) => at >= pause.pausedAt && (pause.resumedAt === null || at < pause.resumedAt)
  );
}
function insertRawRecord(storage, attrs, sessionId, at, redacted) {
  const sequence = numAttr(attrs, "event.sequence");
  storage.insertRawEvent({
    source: "telemetry",
    sessionId,
    eventAt: at,
    redactionVersion: REDACTION_VERSION,
    body: JSON.stringify(redacted),
    ...sequence !== null ? { envelopeId: `telemetry:${sessionId}:${sequence}:${at}` } : {}
  });
}
function applyRecord(storage, kind, attrs, context, result) {
  const applier = RECORD_APPLIERS[kind];
  if (applier === void 0) {
    result.unknown += 1;
    return;
  }
  applier(storage, attrs, context);
}
function applyApiRequest2(storage, attrs, context) {
  const { sessionId, at, promptId } = context;
  const rawSource = textAttr(attrs, "query_source");
  const background = rawSource !== null && BACKGROUND_SOURCES.has(rawSource);
  let turnId = null;
  if (!background && promptId !== null) {
    turnId = storage.turnIdByPrompt(sessionId, promptId) ?? storage.ensureTranscriptTurn(sessionId, promptId, at, null);
  }
  let branchId = null;
  if (rawSource !== null && rawSource.startsWith("agent:")) {
    const agentType = textAttr(attrs, "agent_type");
    if (agentType !== null) {
      branchId = storage.branchIdByAgentType(sessionId, agentType, at);
    }
  }
  storage.upsertRequest({
    sessionId,
    requestId: textAttr(attrs, "request_id"),
    turnId,
    branchId,
    model: textAttr(attrs, "model"),
    querySource: storedQuerySource(rawSource),
    inputTokens: numAttr(attrs, "input_tokens"),
    outputTokens: numAttr(attrs, "output_tokens"),
    cacheReadTokens: numAttr(attrs, "cache_read_tokens"),
    cacheWrite5mTokens: numAttr(attrs, "cache_creation_5m_tokens") ?? numAttr(attrs, "cache_creation_tokens"),
    cacheWrite1hTokens: numAttr(attrs, "cache_creation_1h_tokens"),
    tokenSource: "telemetry",
    startedAt: at,
    durationMs: numAttr(attrs, "duration_ms"),
    effort: effortLevel(textAttr(attrs, "effort"))
  });
}
function applyUserPrompt(storage, attrs, context) {
  const { sessionId, at, promptId } = context;
  if (promptId === null) return;
  const turnId = storage.turnIdByPrompt(sessionId, promptId) ?? storage.ensureTranscriptTurn(sessionId, promptId, at, null);
  storage.recordPromptEvent({
    sessionId,
    turnId,
    at,
    promptLength: numAttr(attrs, "prompt_length")
  });
}
function applyToolResult(storage, attrs, context) {
  const toolUseId = textAttr(attrs, "tool_use_id");
  if (toolUseId !== null && boolAttr(attrs, "success") === false) {
    storage.correctStepOutcome({
      sessionId: context.sessionId,
      toolUseId,
      at: context.at,
      durationMs: numAttr(attrs, "duration_ms")
    });
  }
}
function applyToolDecision(storage, attrs, context) {
  const toolUseId = textAttr(attrs, "tool_use_id");
  const decision = textAttr(attrs, "decision");
  const source = textAttr(attrs, "source");
  if (toolUseId !== null && decision !== null && source !== null) {
    storage.correctPermissionDecision({
      sessionId: context.sessionId,
      toolUseId,
      decision,
      source,
      at: context.at
    });
  }
}
function applySkillActivated(storage, attrs, context) {
  const name = textAttr(attrs, "skill.name");
  if (name !== null) {
    storage.addSkillLoad({
      sessionId: context.sessionId,
      name,
      at: context.at
    });
  }
}
function applyCompaction(storage, attrs, context) {
  storage.recordCompaction({
    sessionId: context.sessionId,
    at: context.at,
    postTokens: numAttr(attrs, "post_tokens")
  });
}
function applySubagentCompleted(storage, attrs, context) {
  const agentType = textAttr(attrs, "agent_type");
  if (agentType !== null) {
    storage.setBranchTotals({
      sessionId: context.sessionId,
      agentType,
      totalTokens: numAttr(attrs, "total_tokens"),
      at: context.at
    });
  }
}
function applyHookExecution(storage, attrs, context) {
  storage.addHookExecution({
    sessionId: context.sessionId,
    name: textAttr(attrs, "hook_name") ?? "unknown",
    durationMs: numAttr(attrs, "total_duration_ms"),
    numHooks: numAttr(attrs, "num_hooks"),
    at: context.at
  });
}
var RECORD_APPLIERS = {
  api_request: applyApiRequest2,
  user_prompt: applyUserPrompt,
  tool_result: applyToolResult,
  tool_decision: applyToolDecision,
  skill_activated: applySkillActivated,
  compaction: applyCompaction,
  subagent_completed: applySubagentCompleted,
  hook_execution_complete: applyHookExecution
};
function readAttrs(record) {
  const attrs = /* @__PURE__ */ new Map();
  const list = record.attributes;
  if (!Array.isArray(list)) return attrs;
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.key !== "string") continue;
    const value = entry.value;
    if (!isPlainObject(value)) continue;
    if (typeof value.stringValue === "string") {
      attrs.set(entry.key, value.stringValue);
    } else if (typeof value.intValue === "string" || typeof value.intValue === "number") {
      attrs.set(entry.key, Number(value.intValue));
    } else if (typeof value.doubleValue === "number") {
      attrs.set(entry.key, value.doubleValue);
    } else if (typeof value.boolValue === "boolean") {
      attrs.set(entry.key, value.boolValue);
    }
  }
  return attrs;
}
function recordTimeMs(raw, receivedAt) {
  for (const key of ["timeUnixNano", "observedTimeUnixNano"]) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") {
      const ms = Math.floor(Number(value) / 1e6);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return receivedAt;
}
var BACKGROUND_SOURCES = /* @__PURE__ */ new Set([
  "prompt_suggestion",
  "generate_session_title",
  "compact"
]);
function storedQuerySource(raw) {
  if (raw === null) return null;
  if (raw === "repl_main_thread") return "main";
  if (raw.startsWith("agent:")) return "subagent";
  if (raw === "prompt_suggestion") return "suggestion";
  if (raw === "generate_session_title") return "title";
  return raw;
}

// src/transcripts/ingest.ts
function prepareRequestStatements(db) {
  return {
    getRequest: db.prepare(
      "SELECT * FROM requests WHERE session_id = ? AND request_id = ? ORDER BY id LIMIT 1"
    ),
    insertRequest: db.prepare(
      "INSERT INTO requests (session_id, request_id, turn_id, branch_id, model, query_source, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, token_source, started_at, duration_ms, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    updateRequest: db.prepare(
      "UPDATE requests SET turn_id = ?, branch_id = ?, model = ?, query_source = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_5m_tokens = ?, cache_write_1h_tokens = ?, token_source = ?, started_at = ?, duration_ms = ?, effort = ? WHERE id = ?"
    ),
    getSampleByRequest: db.prepare(
      "SELECT id, context_tokens FROM context_samples WHERE request_id = ? AND source = ? LIMIT 1"
    ),
    getSampleByValue: db.prepare(
      "SELECT id FROM context_samples WHERE session_id = ? AND sampled_at = ? AND context_tokens = ? AND source = ? LIMIT 1"
    ),
    insertSample: db.prepare(
      "INSERT INTO context_samples (session_id, request_id, sampled_at, context_tokens, source) VALUES (?, ?, ?, ?, ?)"
    ),
    updateSample: db.prepare(
      "UPDATE context_samples SET sampled_at = ?, context_tokens = ? WHERE id = ?"
    ),
    // A concluded closing is the daemon's guess, not a
    // source's fact: an interrupt the transcript reports
    // replaces it, so the revival never reopens the step.
    closeStep: db.prepare(
      "UPDATE steps SET outcome = 'interrupted', outcome_source = 'transcript', ended_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END WHERE session_id = ? AND tool_use_id = ? AND (outcome = 'open' OR outcome_source = 'concluded')"
    )
  };
}
function prepareSessionStatements3(db) {
  return {
    getPauses: db.prepare(
      "SELECT paused_at, resumed_at FROM pauses WHERE session_id = ? ORDER BY paused_at"
    ),
    countRaw: db.prepare(
      "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?"
    ),
    projectPaths: db.prepare(
      "SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL"
    ),
    getProjectPath: db.prepare(
      "SELECT project_path FROM sessions WHERE id = ?"
    ),
    insertSession: db.prepare(
      "INSERT OR IGNORE INTO sessions (id, project_path, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, ?, 'live', ?, ?, 1)"
    ),
    finishImport: db.prepare(
      "UPDATE sessions SET status = 'ended', end_seen = 0, first_seen_at = ?, last_seen_at = ? WHERE id = ?"
    ),
    fillProjectPath: db.prepare(
      "UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL"
    ),
    touch: db.prepare(
      "UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?"
    ),
    getSessionState: db.prepare(
      "SELECT status, end_seen FROM sessions WHERE id = ?"
    )
  };
}
function prepareTurnStatements(db) {
  return {
    ...preparePromptTextStatements(db),
    ...prepareBranchLinkStatements(db),
    ...prepareSessionStatements3(db),
    getTurnByPrompt: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?"
    ),
    getLatestTurn: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? ORDER BY sequence DESC LIMIT 1"
    ),
    // A concluded end is provisional — the daemon's guess,
    // not a source's fact — so the turn the conclusion ended
    // is still the open one here, and a source's own end is
    // the one that lands (see the endTurn statement below).
    getOpenTurn: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND (ended_at IS NULL OR end_source = 'concluded') ORDER BY sequence DESC LIMIT 1"
    ),
    nextSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE session_id = ?"
    ),
    insertTurn: db.prepare(
      "INSERT INTO turns (session_id, prompt_id, sequence, started_at, ended_at, end_source, prompt_text, prompt_chars, prompt_lines, flightpath_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
    ),
    // The same rule as the step close above: an end a source
    // reports replaces a concluded one and clears its mark.
    endTurn: db.prepare(
      "UPDATE turns SET ended_at = ?, end_source = NULL WHERE id = ? AND (ended_at IS NULL OR end_source = 'concluded')"
    ),
    getBranch: db.prepare(
      "SELECT id, spawning_step_id FROM branches WHERE session_id = ? AND agent_id = ?"
    ),
    getSpawningTurn: db.prepare(
      "SELECT steps.turn_id AS turn_id FROM branches JOIN steps ON steps.id = branches.spawning_step_id WHERE branches.session_id = ? AND branches.agent_id = ?"
    ),
    getStepByToolUse: db.prepare(
      "SELECT id, turn_id FROM steps WHERE session_id = ? AND tool_use_id = ? ORDER BY id DESC LIMIT 1"
    ),
    markPartial: db.prepare(
      "UPDATE sessions SET tokens_partial = 1 WHERE id = ?"
    )
  };
}
function prepareStepResultStatements(db) {
  return {
    linkStepResult: db.prepare(
      "UPDATE steps SET result_request_id = ?, context_chars = ?, context_images = ?, async_launch = ?, saved_output_bytes = ? WHERE session_id = ? AND tool_use_id = ? AND result_request_id IS NULL"
    ),
    // The insert lands only when no step names the call: a
    // step the hooks recorded is the record, and the
    // transcript's version of the call adds nothing to it.
    insertTranscriptStep: db.prepare(
      `INSERT INTO steps (session_id, turn_id, branch_id, tool_use_id, tool_name, input_summary, outcome, outcome_source, started_at, ended_at, duration_ms, result_request_id, context_chars, context_images, async_launch, saved_output_bytes)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM steps WHERE session_id = ? AND tool_use_id = ?)`
    )
  };
}
var DELETE_PROMPT_ATTACHMENTS_SQL = "DELETE FROM prompt_attachments WHERE session_id = ? AND turn_id = ?";
var INSERT_CLAUDE_MESSAGE_SQL = `INSERT INTO human_events (session_id, turn_id, kind, occurred_at, detail)
  SELECT ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM human_events
    WHERE session_id = ? AND occurred_at = ? AND kind = ? AND detail = ?
  )`;
function preparePromptFactStatements(db) {
  return {
    setTurnImages: db.prepare(
      "UPDATE turns SET image_count = ?, image_bytes = ? WHERE id = ?"
    ),
    deleteAttachments: db.prepare(DELETE_PROMPT_ATTACHMENTS_SQL),
    insertAttachment: db.prepare(
      "INSERT INTO prompt_attachments (session_id, turn_id, kind, name, size_bytes, line_count) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    upsertCompactionFile: db.prepare(
      "INSERT INTO compaction_files (session_id, at, name, size_bytes, reread) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, at, name) DO UPDATE SET size_bytes = excluded.size_bytes, reread = excluded.reread"
    ),
    upsertContextReport: db.prepare(
      "INSERT INTO context_reports (session_id, model, window, autocompact_buffer, system_prompt, system_tools, mcp_instructions, memory_files, skills, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, model) DO UPDATE SET window = excluded.window, autocompact_buffer = excluded.autocompact_buffer, system_prompt = excluded.system_prompt, system_tools = excluded.system_tools, mcp_instructions = excluded.mcp_instructions, memory_files = excluded.memory_files, skills = excluded.skills, reported_at = excluded.reported_at"
    )
  };
}
function prepareClaudeMessageStatements(db) {
  return { insertClaudeMessage: db.prepare(INSERT_CLAUDE_MESSAGE_SQL) };
}
function prepareRequestShapeStatements(db) {
  return {
    setRequestEffort: db.prepare("UPDATE requests SET effort = ? WHERE id = ?"),
    insertShape: db.prepare(
      "INSERT OR IGNORE INTO request_shapes (hash, system_bytes, tools) VALUES (?, ?, ?)"
    ),
    noteShape: db.prepare(
      "INSERT OR IGNORE INTO session_shapes (session_id, hash) VALUES (?, ?)"
    ),
    // The named row must exist for the link to land: the
    // foreign key would refuse the hash of a deleted shape,
    // and the request keeps no shape instead.
    setShape: db.prepare(
      "UPDATE requests SET shape_hash = ? WHERE id = ? AND EXISTS (SELECT 1 FROM request_shapes WHERE hash = ?)"
    ),
    setCacheFacts: db.prepare(
      "UPDATE requests SET cache_lifetimes = ?, context_edits = ? WHERE id = ?"
    )
  };
}
function prepareTranscriptLoadStatements(db) {
  return {
    ...prepareSkillLoadStatements(db),
    // `IS ?` is null-safe equality: a repeat is the same
    // session, kind, moment, name and thread from the same
    // source.
    findTranscriptLoad: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND source = 'transcript' AND kind = ? AND occurred_at = ? AND name IS ? AND branch_id IS ? AND file_path IS ? LIMIT 1"
    ),
    insertTranscriptLoad: db.prepare(
      "INSERT INTO loads (session_id, kind, name, file_path, occurred_at, source, size_bytes, item_count, names, branch_id) VALUES (?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?)"
    ),
    fillInstructionSize: db.prepare(
      "UPDATE loads SET size_bytes = ? WHERE id = (SELECT id FROM loads WHERE session_id = ? AND kind = 'instructions' AND file_path = ? AND size_bytes IS NULL AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1)"
    ),
    fillSkillSize: db.prepare(
      "UPDATE loads SET size_bytes = ? WHERE id = ? AND size_bytes IS NULL"
    ),
    findSkillFile: db.prepare(
      "SELECT id FROM loads WHERE session_id = ? AND kind = 'skill-file' AND parent_load_id = ? AND file_path = ? LIMIT 1"
    ),
    insertSkillFile: db.prepare(
      "INSERT INTO loads (session_id, kind, file_path, occurred_at, source, size_bytes, line_count, parent_load_id) VALUES (?, 'skill-file', ?, ?, 'transcript', ?, ?, ?)"
    )
  };
}
function prepareConditionStatements(db) {
  return {
    ...prepareConditionsStatements(db),
    updateConditions: db.prepare(
      "UPDATE session_conditions SET sources_seen = ?, claude_code_version = ?, updated_at = ? WHERE session_id = ?"
    )
  };
}
function prepareIngestStatements(db) {
  return {
    ...prepareRequestStatements(db),
    ...prepareTurnStatements(db),
    ...prepareStepResultStatements(db),
    ...preparePromptFactStatements(db),
    ...prepareClaudeMessageStatements(db),
    ...prepareRequestShapeStatements(db),
    ...prepareTranscriptLoadStatements(db),
    ...prepareConditionStatements(db)
  };
}
function stepResultLinks(st) {
  return {
    linkStepResult: (sessionId, toolUseId, requestRowId, size) => {
      st.linkStepResult.run(
        requestRowId,
        size.chars,
        size.images,
        size.asyncLaunch ? 1 : 0,
        size.savedBytes,
        sessionId,
        toolUseId
      );
    },
    createTranscriptStep: (input) => {
      st.insertTranscriptStep.run(
        input.sessionId,
        input.turnId,
        input.branchId,
        input.toolUseId,
        input.toolName,
        input.inputSummary,
        input.failed ? "failed" : "succeeded",
        input.startedAt,
        input.endedAt,
        input.startedAt !== null ? input.endedAt - input.startedAt : null,
        input.requestRowId,
        input.size.chars,
        input.size.images,
        input.size.asyncLaunch ? 1 : 0,
        input.size.savedBytes,
        input.sessionId,
        input.toolUseId
      );
    }
  };
}
function promptFacts(st) {
  return {
    setTurnImages: (turnId, count, bytes) => {
      st.setTurnImages.run(count, bytes, turnId);
    },
    fillTurnPromptFigures: (turnId, chars, lines) => fillTurnPromptFigures(st, turnId, chars, lines),
    replacePromptAttachments: (sessionId, turnId, attachments) => {
      st.deleteAttachments.run(sessionId, turnId);
      for (const attachment of attachments) {
        st.insertAttachment.run(
          sessionId,
          turnId,
          attachment.kind,
          attachment.name,
          attachment.sizeBytes,
          attachment.lineCount
        );
      }
    },
    addPromptAttachment: (sessionId, turnId, attachment) => {
      st.insertAttachment.run(
        sessionId,
        turnId,
        attachment.kind,
        attachment.name,
        attachment.sizeBytes,
        attachment.lineCount
      );
    },
    addCompactionFile: (sessionId, file) => {
      st.upsertCompactionFile.run(
        sessionId,
        file.at,
        file.name,
        file.sizeBytes,
        file.reread ? 1 : 0
      );
    },
    recordContextReport: (sessionId, report, at) => {
      st.upsertContextReport.run(
        sessionId,
        report.model,
        report.window,
        report.autocompactBuffer,
        report.systemPrompt,
        report.systemTools,
        report.mcpInstructions,
        report.memoryFiles,
        report.skills,
        at
      );
    },
    ...claudeMessages(st)
  };
}
function recordSkillText2(st, input) {
  const loadId = findLoadForSkillText(
    st,
    input.sessionId,
    input.name,
    input.at
  );
  if (loadId !== null) {
    st.fillSkillSize.run(input.bytes, loadId);
    return loadId;
  }
  const inserted = st.insertTranscriptLoad.run(
    input.sessionId,
    "skill",
    input.name,
    null,
    input.at,
    input.bytes,
    null,
    null,
    null
  );
  return Number(inserted.lastInsertRowid);
}
function transcriptLoads(st) {
  return {
    recordTranscriptLoad: (input) => {
      const existing = st.findTranscriptLoad.get(
        input.sessionId,
        input.kind,
        input.at,
        input.name,
        input.branchId,
        input.filePath ?? null
      );
      if (existing !== void 0) return;
      st.insertTranscriptLoad.run(
        input.sessionId,
        input.kind,
        input.name,
        input.filePath ?? null,
        input.at,
        input.chars,
        input.count,
        input.names === null ? null : JSON.stringify(input.names),
        input.branchId
      );
    },
    fillInstructionSize: (input) => {
      st.fillInstructionSize.run(
        input.chars,
        input.sessionId,
        input.filePath,
        input.at
      );
    },
    recordSkillText: (input) => recordSkillText2(st, input),
    addSkillFile: (input) => {
      const existing = st.findSkillFile.get(
        input.sessionId,
        input.skillLoadId,
        input.path
      );
      if (existing !== void 0) return;
      st.insertSkillFile.run(
        input.sessionId,
        input.path,
        input.at,
        input.bytes,
        input.lines,
        input.skillLoadId
      );
    }
  };
}
function claudeMessageDetail(message) {
  switch (message.kind) {
    case "command":
      return JSON.stringify({ name: message.name });
    case "handback":
      return JSON.stringify({
        agent_type: message.agentType,
        agent_id: message.agentId,
        chars: message.chars
      });
    case "notice":
      return JSON.stringify({ chars: message.chars });
  }
}
function claudeMessages(st) {
  return {
    insertClaudeMessage: (sessionId, turnId, at, message) => {
      const detail = claudeMessageDetail(message);
      st.insertClaudeMessage.run(
        sessionId,
        turnId,
        message.kind,
        at,
        detail,
        sessionId,
        at,
        message.kind,
        detail
      );
    }
  };
}
function projectFolders(st) {
  return {
    recordedProjectPaths: () => st.projectPaths.all().map((row) => row.project_path),
    projectPathOf: (sessionId) => {
      const row = st.getProjectPath.get(sessionId);
      return row?.project_path ?? null;
    }
  };
}
function requestShapes(st) {
  return {
    setRequestEffort: (requestRowId, effort) => {
      st.setRequestEffort.run(effort, requestRowId);
    },
    upsertRequestShape: (shapeHash, shape) => {
      st.insertShape.run(
        shapeHash,
        shape.systemBytes,
        JSON.stringify(shape.tools)
      );
    },
    noteRequestShape: (sessionId, shapeHash) => {
      st.noteShape.run(sessionId, shapeHash);
    },
    setRequestShape: (requestRowId, hash) => {
      st.setShape.run(hash, requestRowId, hash);
    },
    setRequestCacheFacts: (requestRowId, cacheLifetimes, contextEdits) => {
      st.setCacheFacts.run(
        JSON.stringify(cacheLifetimes),
        JSON.stringify(contextEdits),
        requestRowId
      );
    }
  };
}
function linkBranch(st, sessionId, agentId, toolUseId, onlyUnlinked) {
  const branch = st.getBranch.get(sessionId, agentId);
  if (branch === void 0) return;
  if (onlyUnlinked && branch.spawning_step_id !== null) return;
  const step = st.getStepByToolUse.get(sessionId, toolUseId);
  if (step === void 0) return;
  linkBranchToStep(st, branch.id, step.id, step.turn_id);
}
function turnAndBranchLinks(st) {
  return {
    turnIdByPrompt: (sessionId, promptId) => {
      const row = st.getTurnByPrompt.get(sessionId, promptId);
      return row?.id ?? null;
    },
    latestTurnId: (sessionId) => {
      const row = st.getLatestTurn.get(sessionId);
      return row?.id ?? null;
    },
    ensureTranscriptTurn: (sessionId, promptId, at, promptText) => ensureTranscriptTurn(st, sessionId, promptId, at, promptText),
    branchIdByAgent: (sessionId, agentId) => {
      const row = st.getBranch.get(sessionId, agentId);
      return row?.id ?? null;
    },
    spawningTurnId: (sessionId, agentId) => {
      const row = st.getSpawningTurn.get(sessionId, agentId);
      return row?.turn_id ?? null;
    },
    linkBranchStep: (sessionId, agentId, toolUseId) => linkBranch(st, sessionId, agentId, toolUseId, false),
    linkUnlinkedBranchStep: (sessionId, agentId, toolUseId) => linkBranch(st, sessionId, agentId, toolUseId, true)
  };
}
function createTranscriptIngest(db) {
  const st = prepareIngestStatements(db);
  return {
    upsertRequest: (input) => upsertRequest(st, input),
    insertContextSample: (input) => insertContextSample(st, input),
    closeStepInterrupted: (sessionId, toolUseId, at) => {
      const result = st.closeStep.run(at, at, sessionId, toolUseId);
      return result.changes > 0;
    },
    ...stepResultLinks(st),
    ...promptFacts(st),
    ...transcriptLoads(st),
    ...requestShapes(st),
    ...projectFolders(st),
    pausesFor: (sessionId) => st.getPauses.all(sessionId).map((row) => ({
      pausedAt: row.paused_at,
      resumedAt: row.resumed_at ?? null
    })),
    hasRawEvents: (sessionId) => st.countRaw.get(sessionId).n > 0,
    ensureImportedSession: (sessionId, projectPath, at) => {
      st.insertSession.run(sessionId, projectPath, at, at);
      st.fillProjectPath.run(projectPath, sessionId);
    },
    finishImportedSession: (sessionId, firstAt, lastAt) => {
      st.finishImport.run(firstAt, lastAt, sessionId);
    },
    ...turnAndBranchLinks(st),
    markTokensPartial: (sessionId) => {
      st.markPartial.run(sessionId);
    },
    noteTranscriptSeen: (sessionId, version, at) => noteTranscriptSeen(st, sessionId, version, at),
    touchSession: (sessionId, at) => {
      st.touch.run(at, sessionId);
    }
  };
}
function pick(incomingWins, incoming, existing) {
  return incomingWins ? incoming ?? existing : existing ?? incoming;
}
function insertRequestRow(st, input) {
  const result = st.insertRequest.run(
    input.sessionId,
    input.requestId,
    input.turnId,
    input.branchId,
    input.model,
    input.querySource,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWrite5mTokens,
    input.cacheWrite1hTokens,
    input.tokenSource,
    input.startedAt,
    input.durationMs,
    input.effort ?? null
  );
  return Number(result.lastInsertRowid);
}
function mergeStartedAt(sameSource, incomingWins, input, existingStarted) {
  if (!sameSource) {
    return pick(incomingWins, input.startedAt, existingStarted);
  }
  if (existingStarted === null) return input.startedAt;
  if (input.startedAt === null) return existingStarted;
  return Math.min(existingStarted, input.startedAt);
}
function mergeCachePair(input, existing, incomingWins) {
  const existing5m = numberValue(existing.cache_write_5m_tokens);
  const existing1h = numberValue(existing.cache_write_1h_tokens);
  let merged5m = pick(incomingWins, input.cacheWrite5mTokens, existing5m);
  let merged1h = pick(incomingWins, input.cacheWrite1hTokens, existing1h);
  if (input.cacheWrite5mTokens !== null && input.cacheWrite1hTokens !== null && existing1h === null && existing5m === input.cacheWrite5mTokens + input.cacheWrite1hTokens) {
    merged5m = input.cacheWrite5mTokens;
    merged1h = input.cacheWrite1hTokens;
  } else if (existing5m !== null && existing1h !== null && input.cacheWrite1hTokens === null && input.cacheWrite5mTokens === existing5m + existing1h) {
    merged5m = existing5m;
    merged1h = existing1h;
  }
  return { cacheWrite5mTokens: merged5m, cacheWrite1hTokens: merged1h };
}
function mergeRequest(input, existing) {
  const sameSource = existing.token_source === input.tokenSource;
  const incomingWins = sameSource || input.tokenSource === "telemetry" && existing.token_source !== "telemetry";
  const cachePair = mergeCachePair(input, existing, incomingWins);
  return {
    turnId: pick(incomingWins, input.turnId, numberValue(existing.turn_id)),
    branchId: pick(
      incomingWins,
      input.branchId,
      numberValue(existing.branch_id)
    ),
    model: pick(incomingWins, input.model, asText(existing.model)),
    querySource: pick(
      incomingWins,
      input.querySource,
      asText(existing.query_source)
    ),
    inputTokens: pick(
      incomingWins,
      input.inputTokens,
      numberValue(existing.input_tokens)
    ),
    outputTokens: pick(
      incomingWins,
      input.outputTokens,
      numberValue(existing.output_tokens)
    ),
    cacheReadTokens: pick(
      incomingWins,
      input.cacheReadTokens,
      numberValue(existing.cache_read_tokens)
    ),
    cacheWrite5mTokens: cachePair.cacheWrite5mTokens,
    cacheWrite1hTokens: cachePair.cacheWrite1hTokens,
    tokenSource: incomingWins && !sameSource ? "telemetry" : asText(existing.token_source),
    startedAt: mergeStartedAt(
      sameSource,
      incomingWins,
      input,
      numberValue(existing.started_at)
    ),
    durationMs: pick(
      incomingWins,
      input.durationMs,
      numberValue(existing.duration_ms)
    ),
    // Effort fills an empty column and is never overwritten by
    // an upsert: the transcript's request entry is the primary
    // source and sets the column directly, so an upsert from
    // either source must not displace a value already recorded.
    effort: asText(existing.effort) ?? input.effort ?? null
  };
}
function upsertRequest(st, input) {
  if (input.requestId === null) {
    return insertRequestRow(st, input);
  }
  const existing = st.getRequest.get(input.sessionId, input.requestId);
  if (existing === void 0) {
    return insertRequestRow(st, input);
  }
  const id = existing.id;
  const merged = mergeRequest(input, existing);
  st.updateRequest.run(
    merged.turnId,
    merged.branchId,
    merged.model,
    merged.querySource,
    merged.inputTokens,
    merged.outputTokens,
    merged.cacheReadTokens,
    merged.cacheWrite5mTokens,
    merged.cacheWrite1hTokens,
    merged.tokenSource,
    merged.startedAt,
    merged.durationMs,
    merged.effort,
    id
  );
  return id;
}
function insertContextSample(st, input) {
  if (input.requestRowId !== null) {
    const existing = st.getSampleByRequest.get(
      input.requestRowId,
      input.source
    );
    if (existing !== void 0) {
      if (existing.context_tokens !== input.contextTokens) {
        st.updateSample.run(
          input.sampledAt,
          input.contextTokens,
          existing.id
        );
      }
      return;
    }
  } else {
    const dupe = st.getSampleByValue.get(
      input.sessionId,
      input.sampledAt,
      input.contextTokens,
      input.source
    );
    if (dupe !== void 0) return;
  }
  st.insertSample.run(
    input.sessionId,
    input.requestRowId,
    input.sampledAt,
    input.contextTokens,
    input.source
  );
}
function ensureTranscriptTurn(st, sessionId, promptId, at, promptText) {
  const columns = promptTextColumns(promptText);
  if (promptId !== null) {
    const existing = st.getTurnByPrompt.get(sessionId, promptId);
    if (existing !== void 0) {
      if (promptText !== null) {
        fillTurnPromptText(st, existing.id, promptText);
      }
      return existing.id;
    }
  }
  const open = st.getOpenTurn.get(sessionId);
  if (open !== void 0) st.endTurn.run(at, open.id);
  const sequence = st.nextSequence.get(sessionId).n;
  const session = st.getSessionState.get(sessionId);
  const concluded = session !== void 0 && session.status === "ended" && session.end_seen === 0;
  const result = st.insertTurn.run(
    sessionId,
    promptId,
    sequence,
    at,
    concluded ? at : null,
    concluded ? "concluded" : null,
    columns.text,
    columns.chars,
    columns.lines
  );
  return Number(result.lastInsertRowid);
}
function noteTranscriptSeen(st, sessionId, version, at) {
  st.insertConditions.run(sessionId, at);
  const row = st.getConditions.get(sessionId);
  const sources = parseStringArray(row.sources_seen);
  if (!sources.includes("transcript")) sources.push("transcript");
  const versionValue = typeof row.claude_code_version === "string" ? row.claude_code_version : version ?? null;
  st.updateConditions.run(JSON.stringify(sources), versionValue, at, sessionId);
}

// src/storage/read.ts
function toSessionListRow(row) {
  const { sourcesSeen, ...rest } = row;
  return {
    ...rest,
    joinedPartway: row.joinedPartway === 1,
    endSeen: row.endSeen === 1,
    tokensPartial: row.tokensPartial === 1,
    sources: parseStringArray(sourcesSeen)
  };
}
var SESSION_AGGREGATES = `
    (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turnCount,
    (SELECT COUNT(*) FROM requests WHERE session_id = s.id) AS requestCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id) AS stepCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id AND outcome = 'open') AS openStepCount,
    (SELECT COUNT(*) FROM pauses WHERE session_id = s.id) AS pauseCount,
    (SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) FROM requests WHERE session_id = s.id) AS tokensProcessed,
    (SELECT cs.context_tokens FROM context_samples cs WHERE cs.session_id = s.id ORDER BY cs.sampled_at DESC, cs.id DESC LIMIT 1) AS contextNow,
    (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText`;
var COUNT_SESSIONS_SQL = "SELECT COUNT(*) AS n FROM sessions";
var SESSION_LIST_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id ORDER BY (s.status = 'live') DESC, s.last_seen_at DESC`;
var SESSION_ROW_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, c.permission_modes AS permissionModes, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id WHERE s.id = ?`;
var LIVE_SESSION_HOSTS_SQL = `SELECT s.id, s.last_seen_at AS lastSeenAt, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt FROM sessions s WHERE s.status = 'live' ORDER BY s.id ASC`;
var LIVE_SESSIONS_SQL = `SELECT s.id, (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText FROM sessions s WHERE s.status = 'live' ORDER BY s.first_seen_at ASC`;
function sessionReadMethods(db) {
  const countSessionRows = db.prepare(COUNT_SESSIONS_SQL);
  const listSessionQuery = db.prepare(SESSION_LIST_SQL);
  const sessionQuery = db.prepare(SESSION_ROW_SQL);
  const liveSessionQuery = db.prepare(LIVE_SESSIONS_SQL);
  const liveHostsQuery = db.prepare(LIVE_SESSION_HOSTS_SQL);
  const overheadQuery = db.prepare(OVERHEAD_SQL);
  return {
    countSessions: () => countSessionRows.get().n,
    liveSessionHosts: () => liveHostsQuery.all(),
    liveSessions: () => liveSessionQuery.all(),
    listSessionRows: () => listSessionQuery.all().map(toSessionListRow),
    sessionRow: (sessionId) => {
      const row = sessionQuery.get(sessionId);
      if (row === void 0) {
        return void 0;
      }
      const { permissionModes, ...rest } = row;
      return {
        ...toSessionListRow(rest),
        permissionModes: parseStringArray(permissionModes)
      };
    },
    flightpathOverheadTokens: (sessionId) => overheadQuery.get(sessionId).total
  };
}
var TURN_ROWS_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? ORDER BY sequence ASC";
var STEP_ROWS_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? ORDER BY started_at ASC, id ASC";
var HUMAN_ROWS_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
var BRANCH_ROWS_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? ORDER BY started_at ASC, id ASC";
var SEGMENT_ROWS_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? ORDER BY started_at ASC, id ASC";
var PAUSE_ROWS_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? ORDER BY paused_at ASC, id ASC";
var REQUEST_COLUMNS = "id, turn_id AS turnId, branch_id AS branchId, model, query_source AS querySource, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_5m_tokens AS cacheWrite5mTokens, cache_write_1h_tokens AS cacheWrite1hTokens, token_source AS tokenSource, started_at AS startedAt, duration_ms AS durationMs, effort, shape_hash AS shapeHash, cache_lifetimes AS cacheLifetimes";
var REQUEST_ROWS_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? ORDER BY started_at ASC, id ASC`;
var LOAD_ROWS_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
var ATTACHMENT_ROWS_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? ORDER BY id ASC";
var SESSION_SHAPES_SQL = "SELECT hash, system_bytes AS systemBytes, tools FROM request_shapes WHERE hash IN (SELECT hash FROM session_shapes WHERE session_id = ?) OR hash IN (SELECT shape_hash FROM requests WHERE session_id = ? AND shape_hash IS NOT NULL) ORDER BY hash ASC";
var SAMPLE_ROWS_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? ORDER BY sampled_at ASC, id ASC";
var CONTEXT_REPORTS_SQL = "SELECT model, window, autocompact_buffer AS autocompactBuffer, system_prompt AS systemPrompt, system_tools AS systemTools, mcp_instructions AS mcpInstructions, memory_files AS memoryFiles, skills, reported_at AS reportedAt FROM context_reports WHERE session_id = ? ORDER BY reported_at ASC";
var COMPACTION_FILES_SQL = "SELECT id, at, name, size_bytes AS sizeBytes, reread FROM compaction_files WHERE session_id = ? ORDER BY at ASC, id ASC";
var DISMISSALS_SQL = "SELECT finding_id AS findingId FROM finding_dismissals WHERE session_id = ?";
var DISMISS_FINDING_SQL = "INSERT INTO finding_dismissals (session_id, finding_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT (session_id, finding_id) DO NOTHING";
var TURN_FOR_PROMPT_SQL = "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?";
var TURN_ROWS_SINCE_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC";
var STEP_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? AND id > ? ORDER BY id ASC";
var HUMAN_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? AND id > ? ORDER BY id ASC";
var BRANCH_ROWS_SINCE_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? AND id > ? ORDER BY id ASC";
var SEGMENT_ROWS_SINCE_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? AND id > ? ORDER BY id ASC";
var PAUSE_ROWS_SINCE_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? AND id > ? ORDER BY id ASC";
var REQUEST_ROWS_SINCE_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND id > ? ORDER BY id ASC`;
var SAMPLE_ROWS_SINCE_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? AND id > ? ORDER BY id ASC";
var REQUEST_ROWS_FOR_BRANCH_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND branch_id = ? ORDER BY started_at ASC, id ASC`;
var LOAD_ROWS_SINCE_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? AND id > ? ORDER BY id ASC";
var ATTACHMENT_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND id > ? ORDER BY id ASC";
var ATTACHMENTS_FOR_TURN_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND turn_id = ? ORDER BY id ASC";
var ROW_CHANGES_SINCE_SQL = "SELECT seq, table_name AS tableName, row_id AS rowId FROM row_changes WHERE session_id = ? AND seq > ? ORDER BY seq ASC";
var CHANGE_MAX_SEQ_SQL = "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM row_changes WHERE session_id = ?";
var CLEAR_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ? AND seq <= ?";
var CLEAR_SESSION_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ?";
var CLEAR_ALL_ROW_CHANGES_SQL = "DELETE FROM row_changes";
var CHANGE_SESSIONS_SQL = "SELECT DISTINCT session_id AS sessionId FROM row_changes";
var REQUEST_BY_ID_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`;
var STEP_BY_ID_SQL = "SELECT id, session_id AS sessionId, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE id = ?";
var TURN_BY_ID_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE id = ?";
var BRANCH_BY_ID_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE id = ?";
var PAUSE_BY_ID_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE id = ?";
var SAMPLE_BY_ID_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE id = ?";
var LOAD_BY_ID_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE id = ?";
var SESSION_SCAN_SQL = "SELECT id, status, last_seen_at AS lastSeenAt FROM sessions ORDER BY id ASC";
var STREAM_PROBE_SQL = `SELECT
  (SELECT COALESCE(MAX(id), 0) FROM turns WHERE session_id = ?) AS turnMax,
  (SELECT COALESCE(MAX(id), 0) FROM steps WHERE session_id = ?) AS stepMax,
  (SELECT COALESCE(MAX(id), 0) FROM human_events WHERE session_id = ?) AS humanMax,
  (SELECT COALESCE(MAX(id), 0) FROM branches WHERE session_id = ?) AS branchMax,
  (SELECT COALESCE(MAX(id), 0) FROM segments WHERE session_id = ?) AS segmentMax,
  (SELECT COALESCE(MAX(id), 0) FROM pauses WHERE session_id = ?) AS pauseMax,
  (SELECT COALESCE(MAX(id), 0) FROM context_samples WHERE session_id = ?) AS sampleMax,
  (SELECT COALESCE(MAX(id), 0) FROM loads WHERE session_id = ?) AS loadMax,
  (SELECT COALESCE(MAX(id), 0) FROM prompt_attachments WHERE session_id = ?) AS attachmentMax`;
function toRequestRow(row) {
  return {
    ...row,
    cacheLifetimes: row.cacheLifetimes === null ? null : parseStringArray(row.cacheLifetimes)
  };
}
function toLoadRow(row) {
  return {
    ...row,
    names: row.names === null ? null : parseStringArray(row.names)
  };
}
function toLoadRowIfAny(row) {
  return row === void 0 ? void 0 : toLoadRow(row);
}
function toRequestShapeRow(row) {
  return {
    hash: row.hash,
    systemBytes: row.systemBytes,
    tools: shapeTools(row.tools)
  };
}
function shapeTools(text) {
  if (text === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tools = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const name = str(item, "name");
    const bytes = num(item, "bytes");
    if (name === void 0 || bytes === void 0) continue;
    tools.push({ name, bytes, mcp: bool(item, "mcp") });
  }
  return tools;
}
function sessionDetailMethods(db) {
  const turnQuery = db.prepare(TURN_ROWS_SQL);
  const stepQuery = db.prepare(STEP_ROWS_SQL);
  const humanQuery = db.prepare(HUMAN_ROWS_SQL);
  const branchQuery = db.prepare(BRANCH_ROWS_SQL);
  const segmentQuery = db.prepare(SEGMENT_ROWS_SQL);
  const pauseQuery = db.prepare(PAUSE_ROWS_SQL);
  const requestQuery = db.prepare(REQUEST_ROWS_SQL);
  const sampleQuery = db.prepare(SAMPLE_ROWS_SQL);
  const contextReportQuery = db.prepare(CONTEXT_REPORTS_SQL);
  const compactionFileQuery = db.prepare(COMPACTION_FILES_SQL);
  const loadQuery = db.prepare(LOAD_ROWS_SQL);
  const attachmentQuery = db.prepare(ATTACHMENT_ROWS_SQL);
  const shapeQuery = db.prepare(SESSION_SHAPES_SQL);
  const stepByIdQuery = db.prepare(STEP_BY_ID_SQL);
  return {
    turnRows: (sessionId) => turnQuery.all(sessionId).map((row) => ({
      ...row,
      flightpathCommand: row.flightpathCommand === 1
    })),
    stepRows: (sessionId) => stepQuery.all(sessionId),
    humanRows: (sessionId) => humanQuery.all(sessionId),
    branchRows: (sessionId) => branchQuery.all(sessionId),
    segmentRows: (sessionId) => segmentQuery.all(sessionId),
    pauseRows: (sessionId) => pauseQuery.all(sessionId),
    requestRows: (sessionId) => requestQuery.all(sessionId).map(toRequestRow),
    contextSampleRows: (sessionId) => sampleQuery.all(sessionId),
    contextReportsFor: (sessionId) => contextReportQuery.all(sessionId),
    compactionFileRows: (sessionId) => compactionFileQuery.all(sessionId).map((row) => ({ ...row, reread: row.reread === 1 })),
    loadRows: (sessionId) => loadQuery.all(sessionId).map(toLoadRow),
    promptAttachmentRows: (sessionId) => attachmentQuery.all(sessionId),
    requestShapeRows: (sessionId) => shapeQuery.all(sessionId, sessionId).map(
      toRequestShapeRow
    ),
    stepRowById: (stepId) => stepByIdQuery.get(stepId)
  };
}
function sessionWatchMethods(db) {
  const turnByIdQuery = db.prepare(TURN_BY_ID_SQL);
  const branchByIdQuery = db.prepare(BRANCH_BY_ID_SQL);
  const pauseByIdQuery = db.prepare(PAUSE_BY_ID_SQL);
  const sampleByIdQuery = db.prepare(SAMPLE_BY_ID_SQL);
  const loadByIdQuery = db.prepare(LOAD_BY_ID_SQL);
  const sessionScanQuery = db.prepare(SESSION_SCAN_SQL);
  const turnSinceQuery = db.prepare(TURN_ROWS_SINCE_SQL);
  const stepSinceQuery = db.prepare(STEP_ROWS_SINCE_SQL);
  const humanSinceQuery = db.prepare(HUMAN_ROWS_SINCE_SQL);
  const branchSinceQuery = db.prepare(BRANCH_ROWS_SINCE_SQL);
  const segmentSinceQuery = db.prepare(SEGMENT_ROWS_SINCE_SQL);
  const pauseSinceQuery = db.prepare(PAUSE_ROWS_SINCE_SQL);
  const requestSinceQuery = db.prepare(REQUEST_ROWS_SINCE_SQL);
  const sampleSinceQuery = db.prepare(SAMPLE_ROWS_SINCE_SQL);
  return {
    turnRowById: (turnId) => {
      const row = turnByIdQuery.get(turnId);
      return row === void 0 ? void 0 : { ...row, flightpathCommand: row.flightpathCommand === 1 };
    },
    branchRowById: (branchId) => branchByIdQuery.get(branchId),
    pauseRowById: (pauseId) => pauseByIdQuery.get(pauseId),
    contextSampleRowById: (sampleId) => sampleByIdQuery.get(sampleId),
    loadRowById: (loadId) => toLoadRowIfAny(loadByIdQuery.get(loadId)),
    sessionScanRows: () => sessionScanQuery.all(),
    turnRowsSince: (sessionId, afterId) => turnSinceQuery.all(sessionId, afterId).map((row) => ({
      ...row,
      flightpathCommand: row.flightpathCommand === 1
    })),
    stepRowsSince: (sessionId, afterId) => stepSinceQuery.all(sessionId, afterId),
    humanRowsSince: (sessionId, afterId) => humanSinceQuery.all(sessionId, afterId),
    branchRowsSince: (sessionId, afterId) => branchSinceQuery.all(sessionId, afterId),
    segmentRowsSince: (sessionId, afterId) => segmentSinceQuery.all(sessionId, afterId),
    pauseRowsSince: (sessionId, afterId) => pauseSinceQuery.all(sessionId, afterId),
    requestRowsSince: (sessionId, afterId) => requestSinceQuery.all(sessionId, afterId).map(
      toRequestRow
    ),
    sampleRowsSince: (sessionId, afterId) => sampleSinceQuery.all(sessionId, afterId)
  };
}
function sessionLiveRowMethods(db) {
  const requestByIdQuery = db.prepare(REQUEST_BY_ID_SQL);
  const branchRequestQuery = db.prepare(REQUEST_ROWS_FOR_BRANCH_SQL);
  const loadSinceQuery = db.prepare(LOAD_ROWS_SINCE_SQL);
  const attachmentSinceQuery = db.prepare(ATTACHMENT_ROWS_SINCE_SQL);
  const attachmentsForTurnQuery = db.prepare(ATTACHMENTS_FOR_TURN_SQL);
  const changesSinceQuery = db.prepare(ROW_CHANGES_SINCE_SQL);
  const changeMaxSeqQuery = db.prepare(CHANGE_MAX_SEQ_SQL);
  const clearChangesQuery = db.prepare(CLEAR_ROW_CHANGES_SQL);
  const clearSessionChangesQuery = db.prepare(CLEAR_SESSION_ROW_CHANGES_SQL);
  const clearAllChangesQuery = db.prepare(CLEAR_ALL_ROW_CHANGES_SQL);
  const changeSessionsQuery = db.prepare(CHANGE_SESSIONS_SQL);
  return {
    requestRowById: (requestId) => {
      const row = requestByIdQuery.get(requestId);
      return row === void 0 ? void 0 : toRequestRow(row);
    },
    requestRowsForBranch: (sessionId, branchId) => branchRequestQuery.all(sessionId, branchId).map(
      toRequestRow
    ),
    loadRowsSince: (sessionId, afterId) => loadSinceQuery.all(sessionId, afterId).map(toLoadRow),
    attachmentRowsSince: (sessionId, afterId) => attachmentSinceQuery.all(sessionId, afterId),
    promptAttachmentsForTurn: (sessionId, turnId) => attachmentsForTurnQuery.all(sessionId, turnId),
    changedRowsSince: (sessionId, afterSeq) => changesSinceQuery.all(sessionId, afterSeq),
    changeMaxSeq: (sessionId) => changeMaxSeqQuery.get(sessionId).maxSeq,
    clearChangedRows: (sessionId, throughSeq) => {
      clearChangesQuery.run(sessionId, throughSeq);
    },
    clearSessionChanges: (sessionId) => {
      clearSessionChangesQuery.run(sessionId);
    },
    clearAllChanges: () => {
      clearAllChangesQuery.run();
    },
    dropUncapturedChanges: (heldSessionIds) => {
      const held = new Set(heldSessionIds);
      const rows = changeSessionsQuery.all();
      for (const row of rows) {
        if (!held.has(row.sessionId)) {
          clearSessionChangesQuery.run(row.sessionId);
        }
      }
    }
  };
}
function streamProbeMethod(db) {
  const streamProbeQuery = db.prepare(STREAM_PROBE_SQL);
  return {
    streamProbe: (sessionId) => streamProbeQuery.get(
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId
    )
  };
}
function turnForPromptMethod(db) {
  const turnForPromptQuery = db.prepare(TURN_FOR_PROMPT_SQL);
  return {
    turnIdForPrompt: (sessionId, promptId) => turnForPromptQuery.get(sessionId, promptId)?.id
  };
}
function findingDismissalMethods(db) {
  const dismissalQuery = db.prepare(DISMISSALS_SQL);
  const dismissQuery = db.prepare(DISMISS_FINDING_SQL);
  return {
    listDismissals: (sessionId) => dismissalQuery.all(sessionId).map(
      (row) => row.findingId
    ),
    dismissFinding: (sessionId, findingId) => {
      dismissQuery.run(sessionId, findingId, Date.now());
    }
  };
}

// src/storage/schema.ts
var MIGRATION_1 = `
-- One row per recorded session. A session may be joined partway
-- through (its first event is not SessionStart); joined_partway
-- records that, so a missing start is never mistaken for data loss.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'live', -- live | paused | ended
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  joined_partway INTEGER NOT NULL DEFAULT 0
);

-- A stretch of one session between boundaries: startup, resume and
-- compact each open a segment, inside the same session. Resume rows
-- carry the cache state SessionStart reports, for the cache-rebuild
-- detector.
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL, -- startup | resume | compact
  started_at INTEGER NOT NULL,
  context_tokens INTEGER,
  prompt_cache_likely_expired INTEGER
);
CREATE INDEX segments_session ON segments (session_id, started_at);

-- One turn per user prompt. prompt_id is shared by hooks and
-- telemetry, so the two sources join here. prompt_text is the user's
-- own prompt (stored by design; users are told prompts are stored).
CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt_id TEXT,
  sequence INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  prompt_text TEXT,
  from_command INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, sequence)
);
CREATE INDEX turns_prompt ON turns (session_id, prompt_id);

-- Session conditions seen while recording: permission mode(s) (a
-- session can switch), instruction files, enabled plugins, the
-- Claude Code version, and which capture sources actually delivered
-- (hooks, telemetry, transcript) \u2014 recordings reflect the setup that
-- produced them, so the setup is recorded with them.
CREATE TABLE session_conditions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  permission_modes TEXT, -- JSON array of mode names
  instruction_files TEXT, -- JSON array of paths
  enabled_plugins TEXT, -- JSON array of plugin names
  claude_code_version TEXT,
  sources_seen TEXT, -- JSON array: hook | telemetry | transcript
  updated_at INTEGER NOT NULL
);

-- Pauses: /flightpath stop and start. A row with no resumed_at is a
-- pause still in effect.
CREATE TABLE pauses (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  paused_at INTEGER NOT NULL,
  resumed_at INTEGER
);
CREATE INDEX pauses_session ON pauses (session_id, paused_at);

-- Subagent branches off the main line. Hooks give no parent id, so
-- the spawning step is linked by order and agent_type.
CREATE TABLE branches (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT,
  spawning_step_id INTEGER REFERENCES steps(id),
  agent_type TEXT,
  kind TEXT, -- user | internal (internal when agent_type is empty)
  started_at INTEGER,
  ended_at INTEGER,
  total_tokens INTEGER,
  token_source TEXT -- hook | telemetry | transcript
);
CREATE INDEX branches_session ON branches (session_id, agent_id);

-- One tool call. input_summary is JSON of the redacted input: paths,
-- commands and sizes, never file contents. outcome can be reported
-- by more than one source, so outcome_source says which one decided
-- the stored value.
CREATE TABLE steps (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER REFERENCES turns(id),
  branch_id INTEGER REFERENCES branches(id),
  tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT, -- JSON, post-redaction
  outcome TEXT, -- succeeded | failed | rejected | interrupted | open
  outcome_source TEXT, -- hook | telemetry | transcript | inferred | concluded | batch
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  result_size INTEGER
);
CREATE INDEX steps_session ON steps (session_id, tool_use_id);
CREATE INDEX steps_turn ON steps (turn_id);

-- One model request. Cache writes split 5-minute and 1-hour where
-- the source reports the split; token_source records where the
-- numbers came from (ADR-0012: every value records its source).
CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT,
  turn_id INTEGER REFERENCES turns(id),
  branch_id INTEGER REFERENCES branches(id),
  model TEXT,
  query_source TEXT, -- main | subagent | suggestion | title | compact
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  token_source TEXT, -- telemetry | transcript
  started_at INTEGER,
  duration_ms INTEGER
);
CREATE INDEX requests_session ON requests (session_id, request_id);

-- Moments the human acted: prompts, permission requests and their
-- decisions, rejections, interrupts, answers, waiting. A decision's
-- source is telemetry when it exists and inferred otherwise; which
-- one applies is stored, not implied.
CREATE TABLE human_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER REFERENCES turns(id),
  step_id INTEGER REFERENCES steps(id),
  kind TEXT NOT NULL, -- prompt | permission_request | permission_decision | rejection | interrupt | question_answered | waiting | command | handback | notice
  occurred_at INTEGER NOT NULL,
  decision TEXT, -- accept | reject | accept_permanent
  decision_source TEXT, -- telemetry | inferred
  detail TEXT -- JSON summary (e.g. the chosen option label)
);
CREATE INDEX human_events_session ON human_events (session_id, occurred_at);

-- Context size per request, for the Tokens lens.
CREATE TABLE context_samples (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id INTEGER REFERENCES requests(id),
  sampled_at INTEGER NOT NULL,
  context_tokens INTEGER NOT NULL,
  source TEXT NOT NULL -- telemetry | transcript
);
CREATE INDEX context_samples_session ON context_samples (session_id, sampled_at);

-- Things loaded into a session: skills (with what triggered them)
-- and instruction files (with their memory type).
CREATE TABLE loads (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL, -- skill | instructions
  name TEXT,
  trigger TEXT, -- user_slash | agent (skills)
  memory_type TEXT, -- User | Project (instruction files)
  file_path TEXT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL -- hook | telemetry | transcript
);
CREATE INDEX loads_session ON loads (session_id, occurred_at);

-- Coach findings: Flightpath's own text about a session, anchored
-- to the step(s) that evidence it.
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  detector TEXT NOT NULL,
  severity TEXT NOT NULL,
  step_id INTEGER REFERENCES steps(id),
  branch_id INTEGER REFERENCES branches(id),
  explanation TEXT,
  suggested_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | applied | dismissed
  created_at INTEGER NOT NULL
);
CREATE INDEX findings_session ON findings (session_id, status);

-- Every payload after intake redaction, retained so journey
-- processing can be re-run as it improves. session_id carries no
-- foreign key on purpose: intake writes raw events before journey
-- processing creates the session row. forgetSession deletes these
-- explicitly, like every other session table.
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL, -- hook | telemetry | transcript
  session_id TEXT,
  received_at INTEGER NOT NULL,
  event_at INTEGER,
  redaction_version INTEGER NOT NULL,
  body TEXT NOT NULL, -- JSON, post-redaction
  envelope_id TEXT -- the envelope's stable id, for hook payloads only
);
CREATE INDEX raw_events_session ON raw_events (session_id, received_at);
CREATE INDEX raw_events_source ON raw_events (source, received_at);
-- Storing the same envelope twice is stopped by this index
-- instead of a lookup over every stored body \u2014 and two writers
-- racing the same envelope cannot both store it. Rows of other
-- sources keep NULL, which the index treats as distinct.
CREATE UNIQUE INDEX raw_events_envelope ON raw_events (envelope_id);

-- Forgotten sessions: the id and the time only, so a session the
-- user forgot is never re-imported from a transcript or a buffer.
-- Deliberately no foreign key: this row must survive the session's
-- deletion \u2014 it is what the deletion leaves behind.
CREATE TABLE forgotten (
  session_id TEXT PRIMARY KEY,
  forgotten_at INTEGER NOT NULL
);
`;
var MIGRATION_2 = `
-- Token completeness (ADR-0019): set when a source skipped entries
-- that should have carried token usage, so the session's token data
-- is known incomplete rather than silently short.
ALTER TABLE sessions ADD COLUMN tokens_partial INTEGER NOT NULL DEFAULT 0;
`;
var MIGRATION_3 = `
-- Hook execution counts and timings from telemetry, as JSON.
ALTER TABLE session_conditions ADD COLUMN hook_stats TEXT;
`;
var MIGRATION_4 = `
-- Finding a session's open steps (turn end, branch end) is
-- served by this index instead of scanning every step the
-- session has: the cost is the number of open steps, not the
-- session's length.
CREATE INDEX steps_session_outcome ON steps (session_id, outcome);
`;
var MIGRATION_5 = `
-- Sessions the retention purge deleted (ADR-0025): the id and
-- the time only, so the transcript import never brings a purged
-- session back. Deliberately unlike "forgotten": if a purged id
-- is recorded live again, it is a new recording. No foreign
-- key: this row must survive the session's deletion \u2014 it is
-- what the deletion leaves behind.
CREATE TABLE purged (
  session_id TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL
);

-- One-row facts about the database itself, recorded by the
-- code that maintains it (for example, that the one-time
-- switch to incremental auto-vacuum has run).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
var MIGRATION_6 = `
-- A stored prompt's full size: its length and line count,
-- recorded before the stored text is cut to its first 2,000
-- characters. Rows already stored get theirs from the one-time
-- pass in storage/index.ts, which also redacts and caps their
-- text; it finds its rows by prompt_chars still being NULL.
ALTER TABLE turns ADD COLUMN prompt_chars INTEGER;
ALTER TABLE turns ADD COLUMN prompt_lines INTEGER;
`;
var MIGRATION_7 = `
-- How a session's end was learned, and where its Claude Code
-- process can be checked. end_seen is 1 when the session's own
-- end event arrived (or nothing has ended it yet) and 0 when the
-- daemon concluded the end itself, so the view can say "no exit
-- seen" instead of implying a clean exit. host_pid and
-- host_started_at identify the Claude Code process the session
-- runs in \u2014 its id and its start time, in milliseconds \u2014 so a
-- later check can tell "still running" from "gone", and a reused
-- id from the same process.
ALTER TABLE sessions ADD COLUMN end_seen INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN host_pid INTEGER;
ALTER TABLE sessions ADD COLUMN host_started_at INTEGER;
`;
var MIGRATION_8 = `
-- What each request was sent with, as sizes and names only
-- (ADR-0004): the system prompt's size and each tool
-- definition's name and size. A shape row is keyed by the
-- hash the transcript's own shape entries name their shape
-- by, and holds only what a shape entry carries; the cache
-- lifetime per block and any context-management edits are
-- per-request facts, stored on the request row below.
-- Deliberately no session column: a shape is a fact about a
-- request's construction, not about a session. Which
-- sessions named a shape is recorded separately, in
-- session_shapes below: a shape is live from the moment a
-- session's shape entry names it until its last request
-- lands, so forgetting a session deletes only the shapes
-- no remaining request references and no session names any
-- more (deleteSessionRows), MCP server names in tool names
-- included; a request read afterwards that names a deleted
-- shape records no shape.
CREATE TABLE request_shapes (
  hash TEXT PRIMARY KEY,
  system_bytes INTEGER,
  tools TEXT -- JSON array of {name, bytes, mcp}
);

-- The sessions that named each shape, one row per session
-- and shape, written when the session's shape entry is
-- read. A shape row goes only when no row here and no
-- request references it. Deleted with the session in
-- deleteSessionRows, which FORGET_ORDER places before the
-- session row itself, so the reference holds throughout.
CREATE TABLE session_shapes (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  hash TEXT NOT NULL REFERENCES request_shapes(hash),
  PRIMARY KEY (session_id, hash)
);

-- The request that first carried a step's result, read from
-- the transcript's tool-result link: the Tokens lens
-- attributes a context rise to the step whose result the
-- request took in.
ALTER TABLE steps ADD COLUMN result_request_id INTEGER REFERENCES requests(id);

-- An instruction file's size on disk, statted by the daemon
-- when InstructionsLoaded arrives; null when the file was
-- already gone.
ALTER TABLE loads ADD COLUMN size_bytes INTEGER;

-- The images in a turn's prompt: how many, and their total
-- encoded size. Null when no prompt entry was read for the
-- turn, so an unrecorded prompt never reads as imageless.
ALTER TABLE turns ADD COLUMN image_count INTEGER;
ALTER TABLE turns ADD COLUMN image_bytes INTEGER;

-- The effort a request ran at, and the shape it was sent
-- with. Both are facts the transcript's request entries
-- carry; effort also arrives on hook payloads and telemetry.
ALTER TABLE requests ADD COLUMN effort TEXT;
ALTER TABLE requests ADD COLUMN shape_hash TEXT REFERENCES request_shapes(hash);

-- The cache lifetime of each cached block in the request,
-- and the context-management edits it applied, by type:
-- facts of the one request, read from its request entry.
ALTER TABLE requests ADD COLUMN cache_lifetimes TEXT; -- JSON array of lifetimes, one per cached block
ALTER TABLE requests ADD COLUMN context_edits TEXT; -- JSON array of edit types

-- The hook effort fill updates a turn's requests by turn:
-- without this index it reads every request in the session
-- on every hook event.
CREATE INDEX requests_turn ON requests (turn_id);

-- What came with each prompt, as kind, name and size, never
-- contents (ADR-0004): the images (media type as the name),
-- attached files (the display path), and the prompt itself
-- (its byte size and line count). The reference capture
-- marks no paste and records no non-file attachment, so
-- neither is recorded yet.
CREATE TABLE prompt_attachments (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL, -- image | file | prompt
  name TEXT,
  size_bytes INTEGER,
  line_count INTEGER -- prompt only
);
-- Deleted by session (forget, purge) and restated by
-- turn: the index leads with the session, the turn within it.
CREATE INDEX prompt_attachments_turn ON prompt_attachments (session_id, turn_id);
`;
var MIGRATION_9 = `
-- Which closer ended a turn or a branch: 'concluded' when
-- the daemon's conclusion ended it, null for a real closing
-- (a stop, a new prompt, an end event). A revival reopens
-- exactly the rows the conclusion closed, so the mark has
-- to name the closer; steps carry the same distinction in
-- outcome_source.
ALTER TABLE turns ADD COLUMN end_source TEXT;
ALTER TABLE branches ADD COLUMN end_source TEXT;
`;
var MIGRATION_10 = `
-- Rows a writer changed after inserting them, one entry per
-- change: a live capture reads the entries past its mark and
-- re-reads those rows by id, so a late fact reaches the held
-- session without a full reload. Triggers do the recording,
-- so every writer is covered, including updates that name
-- their rows by turn or by tool use rather than by id.
CREATE TABLE row_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL
);
CREATE INDEX row_changes_session ON row_changes (session_id, seq);

CREATE TRIGGER requests_changed AFTER UPDATE ON requests BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'requests', NEW.id);
END;
CREATE TRIGGER turns_changed AFTER UPDATE ON turns BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'turns', NEW.id);
END;
CREATE TRIGGER branches_changed AFTER UPDATE ON branches BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'branches', NEW.id);
END;
CREATE TRIGGER steps_changed AFTER UPDATE ON steps BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'steps', NEW.id);
END;
-- A turn's attachments are replaced as a set (delete, then
-- insert), so both directions record the turn whose whole
-- set the capture must re-read.
CREATE TRIGGER prompt_attachments_inserted AFTER INSERT ON prompt_attachments BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'prompt_attachments', NEW.turn_id);
END;
CREATE TRIGGER prompt_attachments_deleted AFTER DELETE ON prompt_attachments BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (OLD.session_id, 'prompt_attachments', OLD.turn_id);
END;
-- A session naming a shape: the capture re-reads the
-- session's shapes, a handful of rows, when one lands.
CREATE TRIGGER session_shapes_inserted AFTER INSERT ON session_shapes BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'session_shapes', NEW.rowid);
END;
`;
var MIGRATION_11 = `
-- A step result's size as it entered context, beside its
-- raw size: the characters of the result's text as the
-- transcript carried it, and the count of its images
-- (counted, never read). Null until the transcript names
-- them: a result no transcript carried is unknown, never 0.
ALTER TABLE steps ADD COLUMN context_chars INTEGER;
ALTER TABLE steps ADD COLUMN context_images INTEGER;
`;
var MIGRATION_12 = `
-- What /context reported for one model in a session: the
-- window Claude Code says it is using, and its auto-compact
-- buffer when the report named one. One row per model; a
-- later report for the same model replaces the earlier one.
-- Written by the transcript follower only, and deleted with
-- the session (the cascade, and FORGET_ORDER below).
CREATE TABLE context_reports (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  window INTEGER NOT NULL,
  autocompact_buffer INTEGER,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, model)
);
`;
var MIGRATION_13 = `
-- How many of a thing a startup load names, when it counts
-- them: the skills in the listing, the servers that sent
-- instructions, the tool names loaded on demand. Null when
-- the load names no count.
ALTER TABLE loads ADD COLUMN item_count INTEGER;
-- A load's size can be filled in after the row lands \u2014 an
-- instruction file's size arrives with the transcript entry
-- when the hook could not stat the file \u2014 and the change
-- rides the same row-changes feed as the other tables'
-- updates, so a live view sees the filled size.
CREATE TRIGGER loads_changed AFTER UPDATE ON loads BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'loads', NEW.id);
END;
`;
var MIGRATION_14 = `
-- What a /context report gave for the system prompt, the MCP
-- server instructions and the skills listing, in tokens:
-- Claude Code's own count of each. Null where the report
-- listed no such row, and for reports stored before these
-- columns existed.
ALTER TABLE context_reports ADD COLUMN system_prompt INTEGER;
ALTER TABLE context_reports ADD COLUMN mcp_instructions INTEGER;
ALTER TABLE context_reports ADD COLUMN skills INTEGER;
`;
var MIGRATION_15 = `
-- Whether a step's result only announced a subagent started in
-- the background (1), as against carrying the answer (0). Null
-- until the transcript names the result. The subagent's report
-- arrives later, as a hand-back.
ALTER TABLE steps ADD COLUMN async_launch INTEGER;
`;
var MIGRATION_16 = `
-- What a /context report gave for the system tools, in
-- tokens: Claude Code's own count of the tool definitions.
-- Null where the report listed no such row, and for reports
-- stored before this column existed.
ALTER TABLE context_reports ADD COLUMN system_tools INTEGER;
`;
var MIGRATION_17 = `
-- The files Claude Code put back after a compaction: the
-- compaction's moment, the file's display path and size, and
-- whether it was read in full again (1) or only named (0).
-- Kept by time rather than by segment: telemetry, the hooks
-- and the transcript each open the compaction's segment, and
-- a replay deletes and rebuilds segments, so a row pointing at
-- one would be lost with it. A read pairs a file with the
-- segment nearest its moment. Written by the transcript
-- follower only, and deleted with the session (the cascade,
-- and FORGET_ORDER below).
CREATE TABLE compaction_files (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  size_bytes INTEGER,
  reread INTEGER NOT NULL,
  UNIQUE (session_id, at, name)
);
-- A session's files arrive after the compaction opened: the
-- capture re-reads the session's rows, a handful, when one lands.
CREATE TRIGGER compaction_files_inserted AFTER INSERT ON compaction_files BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'compaction_files', NEW.id);
END;
`;
var MIGRATION_18 = `
-- What from_command marked is restated (ADR-0021): it flagged
-- other commands' turns, never Flightpath's, so every stored
-- value is cleared rather than carried into the new meaning \u2014
-- keeping one would bill that command's cost to Flightpath.
ALTER TABLE turns RENAME COLUMN from_command TO flightpath_command;
UPDATE turns SET flightpath_command = 0;
`;
var MIGRATION_19 = `
-- The findings a person dismissed, by the finding's stable id.
-- Findings themselves are computed on every read and never
-- stored, so this is the only trace of them. Deleted with the
-- session (the cascade, and FORGET_ORDER below). The table
-- migration 1 created for stored findings was never written.
DROP INDEX findings_session;
DROP TABLE findings;
CREATE TABLE finding_dismissals (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, finding_id)
);
`;
var MIGRATION_20 = `
-- What a /context report gave for the memory files (the
-- instruction files loaded at session start), in tokens:
-- Claude Code's own count of them. Null where the report
-- listed no such row, and for reports stored before this
-- column existed.
ALTER TABLE context_reports ADD COLUMN memory_files INTEGER;
`;
var MIGRATION_21 = `
-- The names a startup listing carries, as a JSON array: the
-- skills Claude Code listed to the model. Names only (ADR-0004).
-- Null for every other load, and for listings stored before
-- this column existed.
ALTER TABLE loads ADD COLUMN names TEXT;
`;
var MIGRATION_22 = `
-- The subagent a startup listing belongs to: a subagent's
-- transcript re-sends the listings for its own context. Null
-- for the main thread's loads, and for every load stored
-- before this column existed.
ALTER TABLE loads ADD COLUMN branch_id INTEGER REFERENCES branches(id);
`;
var MIGRATION_23 = `
-- A file a skill attached when it loaded is a load of its own
-- (kind skill-file), pointing at the skill's load, with the
-- file's line count: paths and sizes only (ADR-0004). Null for
-- every other load.
ALTER TABLE loads ADD COLUMN parent_load_id INTEGER REFERENCES loads(id);
ALTER TABLE loads ADD COLUMN line_count INTEGER;
-- The size of a tool output Claude Code saved to a file, from
-- the notice that stood in for it. Null for every step whose
-- output was sent whole.
ALTER TABLE steps ADD COLUMN saved_output_bytes INTEGER;
`;
var MIGRATION_24 = `
-- A subagent's definition was never in its transcript: the
-- loads stored as agent-definition were the reminder or a
-- preloaded skill, mislabelled. Subagents' preloaded skills
-- are loads of kind preloaded-skill now.
DELETE FROM loads WHERE kind = 'agent-definition';
`;
var MIGRATIONS = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 },
  { version: 5, sql: MIGRATION_5 },
  { version: 6, sql: MIGRATION_6 },
  { version: 7, sql: MIGRATION_7 },
  { version: 8, sql: MIGRATION_8 },
  { version: 9, sql: MIGRATION_9 },
  { version: 10, sql: MIGRATION_10 },
  { version: 11, sql: MIGRATION_11 },
  { version: 12, sql: MIGRATION_12 },
  { version: 13, sql: MIGRATION_13 },
  { version: 14, sql: MIGRATION_14 },
  { version: 15, sql: MIGRATION_15 },
  { version: 16, sql: MIGRATION_16 },
  { version: 17, sql: MIGRATION_17 },
  { version: 18, sql: MIGRATION_18 },
  { version: 19, sql: MIGRATION_19 },
  { version: 20, sql: MIGRATION_20 },
  { version: 21, sql: MIGRATION_21 },
  { version: 22, sql: MIGRATION_22 },
  { version: 23, sql: MIGRATION_23 },
  { version: 24, sql: MIGRATION_24 }
];
var FORGET_ORDER = [
  "human_events",
  "context_samples",
  "context_reports",
  "compaction_files",
  "finding_dismissals",
  "steps",
  "requests",
  "session_shapes",
  "branches",
  "prompt_attachments",
  "turns",
  "segments",
  "session_conditions",
  "pauses",
  "loads",
  "raw_events",
  "row_changes"
];

// src/storage/warning-filter.ts
function installSqliteWarningFilter() {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning, ...rest) => {
    let message = "";
    if (typeof warning === "string") {
      message = warning;
    } else if (warning instanceof Error) {
      message = warning.message;
    }
    if (/sqlite is an experimental feature/i.test(message)) {
      return;
    }
    original(warning, ...rest);
  });
}

// src/storage/sqlite.ts
installSqliteWarningFilter();
var sqlite = process.getBuiltinModule(
  "node:sqlite"
);
var DatabaseSync = sqlite.DatabaseSync;

// src/storage/index.ts
var MAX_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}
function applyMigrations(db) {
  let current = readUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }
}
function configureDatabase(db) {
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const version = readUserVersion(db);
    if (version > MAX_SCHEMA_VERSION) {
      throw new Error(
        `flightpath.db was created by a newer version of Flightpath (schema ${version}); this build supports up to schema ${MAX_SCHEMA_VERSION}. The database was not modified.`
      );
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    redactStoredPromptTexts(db);
    const vacuumMarker = db.prepare("SELECT value FROM meta WHERE key = 'auto_vacuum'").get();
    if (vacuumMarker === void 0) {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('auto_vacuum', 'incremental')"
      ).run();
    }
  } catch (error) {
    db.close();
    throw error;
  }
}
function redactStoredPromptTexts(db) {
  const rows = db.prepare(
    "SELECT id, prompt_text FROM turns WHERE prompt_text IS NOT NULL AND prompt_chars IS NULL"
  ).all();
  if (rows.length === 0) return;
  const st = preparePromptTextStatements(db);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      setTurnPromptColumns(
        st,
        row.id,
        promptTextColumns(scrubSecrets(row.prompt_text))
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function runTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function deleteSessionRows(db, sessionId) {
  db.prepare(
    "UPDATE branches SET spawning_step_id = NULL WHERE session_id = ?"
  ).run(sessionId);
  for (const table of FORGET_ORDER) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
  }
  db.prepare(
    "DELETE FROM request_shapes WHERE hash NOT IN (SELECT shape_hash FROM requests WHERE shape_hash IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_shapes)"
  ).run();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}
function insertRawEventRow(insertEvent, event) {
  const result = insertEvent.run(
    event.source,
    event.sessionId ?? null,
    event.receivedAt ?? Date.now(),
    event.eventAt ?? null,
    event.redactionVersion,
    event.body,
    event.envelopeId ?? null
  );
  return result.changes > 0;
}
function rawEventMethods(db, journey) {
  const insertEvent = db.prepare(
    "INSERT INTO raw_events (source, session_id, received_at, event_at, redaction_version, body, envelope_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (envelope_id) DO NOTHING"
  );
  const countAll = db.prepare("SELECT COUNT(*) AS n FROM raw_events");
  const countForSession = db.prepare(
    "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?"
  );
  return {
    insertRawEvent: (event) => insertRawEventRow(insertEvent, event),
    insertEnvelopeJourney: (event, journeyEvent) => runTransaction(db, () => {
      const inserted = insertRawEventRow(insertEvent, event);
      if (inserted) {
        journey.applyHookEvent(journeyEvent, event.receivedAt ?? Date.now());
      }
      return inserted;
    }),
    countRawEvents: (sessionId) => {
      const row = sessionId === void 0 ? countAll.get() : countForSession.get(sessionId);
      return row.n;
    }
  };
}
function sessionAdminMethods(db, journey) {
  const forgottenRow = db.prepare(
    "SELECT session_id FROM forgotten WHERE session_id = ?"
  );
  const purgedRow = db.prepare(
    "SELECT session_id FROM purged WHERE session_id = ?"
  );
  const insertForgotten = db.prepare(
    "INSERT OR IGNORE INTO forgotten (session_id, forgotten_at) VALUES (?, ?)"
  );
  const insertPurged = db.prepare(
    "INSERT OR IGNORE INTO purged (session_id, purged_at) VALUES (?, ?)"
  );
  return {
    recordPause: (sessionId, at = Date.now()) => journey.recordPause(sessionId, at),
    recordResume: (sessionId, at = Date.now()) => journey.recordResume(sessionId, at),
    endSessionUnseen: (sessionId, at) => journey.endSessionUnseen(sessionId, at),
    endSessionUnseenIfUnchanged: (session) => journey.endSessionUnseenIfUnchanged(session),
    isForgotten: (sessionId) => forgottenRow.get(sessionId) !== void 0,
    forgetSession: (sessionId, forgottenAt = Date.now()) => {
      runTransaction(db, () => {
        deleteSessionRows(db, sessionId);
        insertForgotten.run(sessionId, forgottenAt);
      });
    },
    deleteSession: (sessionId) => {
      runTransaction(db, () => deleteSessionRows(db, sessionId));
    },
    purgeSession: (sessionId, purgedAt = Date.now()) => {
      runTransaction(db, () => {
        deleteSessionRows(db, sessionId);
        insertPurged.run(sessionId, purgedAt);
      });
    },
    isPurged: (sessionId) => purgedRow.get(sessionId) !== void 0
  };
}
function retentionMethods(db, dbPath) {
  const toPurgeRows = db.prepare(
    "SELECT id, last_seen_at FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ? ORDER BY last_seen_at ASC"
  );
  const oldestNonLiveRow = db.prepare(
    "SELECT id, last_seen_at FROM sessions WHERE status != 'live' OR last_seen_at < ? ORDER BY last_seen_at ASC LIMIT 1"
  );
  const countOlderRow = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE (status != 'live' OR last_seen_at < ?) AND last_seen_at < ?"
  );
  const allIdRows = db.prepare("SELECT id FROM sessions");
  return {
    sessionsToPurge: (cutoffMs, staleBeforeMs) => toPurgeRows.all(staleBeforeMs, cutoffMs).map((row) => ({ id: row.id, lastSeenAt: row.last_seen_at })),
    oldestNonLiveSession: (staleBeforeMs) => {
      const row = oldestNonLiveRow.get(staleBeforeMs);
      if (row === void 0) return null;
      return { id: row.id, lastSeenAt: row.last_seen_at };
    },
    countSessionsOlderThan: (cutoffMs, staleBeforeMs) => countOlderRow.get(staleBeforeMs, cutoffMs).n,
    allSessionIds: () => allIdRows.all().map((row) => row.id),
    databaseBytes: () => {
      let bytes = 0;
      for (const path of [dbPath, `${dbPath}-wal`]) {
        try {
          bytes += statSync3(path).size;
        } catch {
        }
      }
      return bytes;
    },
    checkpointWal: () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    incrementalVacuum: () => {
      db.exec("PRAGMA incremental_vacuum");
    }
  };
}
function openStorage(options) {
  mkdirSync2(options.dataDir, { recursive: true });
  const dbPath = join8(options.dataDir, "flightpath.db");
  const db = new DatabaseSync(dbPath);
  configureDatabase(db);
  const journey = createJourneyBuilder(db);
  return {
    dbPath,
    // The ingest and telemetry stores' methods are the
    // storage's own: spread, so the objects can never drift.
    ...createTranscriptIngest(db),
    ...createTelemetryStore(db),
    userVersion: () => readUserVersion(db),
    transaction: (fn) => runTransaction(db, fn),
    ...rawEventMethods(db, journey),
    ...sessionAdminMethods(db, journey),
    ...sessionReadMethods(db),
    ...retentionMethods(db, dbPath),
    ...sessionDetailMethods(db),
    ...sessionWatchMethods(db),
    ...sessionLiveRowMethods(db),
    ...streamProbeMethod(db),
    ...turnForPromptMethod(db),
    ...findingDismissalMethods(db),
    close: () => db.close()
  };
}

// src/api/cache-lifetime.ts
var CACHE_LIFETIME_MS = {
  "1h": 60 * 6e4,
  "5m": 5 * 6e4
};

// src/describe/format.ts
function notRecorded(telemetrySeen) {
  return telemetrySeen === false ? "not recorded (telemetry off)" : "unknown";
}
function firstLine(text) {
  return text.split("\n")[0] ?? text;
}
function relativeToProject(path, project) {
  const root = project.replace(/[\\/]+$/, "");
  const windows = /^[A-Za-z]:/.test(root);
  const comparable = (text) => windows ? text.replaceAll("\\", "/").toLowerCase() : text;
  return comparable(path).startsWith(`${comparable(root)}/`) ? path.slice(root.length + 1) : path;
}
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

// src/format.ts
function formatCount(count) {
  return count.toLocaleString("en-US");
}
function roundedTokens(count) {
  const thousands = Math.round(count / 100) / 10;
  if (thousands >= 1e3) {
    return { value: Math.round(count / 1e5) / 10, unit: "M" };
  }
  return { value: thousands, unit: "K" };
}
function formatTokens(count, options = {}) {
  if (options.axis) {
    if (count < 1e3) {
      return `${Math.round(count)}`;
    }
    const { value: value2, unit: unit2 } = roundedTokens(count);
    return Number.isInteger(value2) ? `${value2}${unit2}` : `${value2.toFixed(1)}${unit2}`;
  }
  if (options.exact || count < 1e3) {
    return `${count.toLocaleString("en-US")} tokens`;
  }
  const { value, unit } = roundedTokens(count);
  return `${value.toFixed(1)}${unit} tokens`;
}
var CHARS_PER_TOKEN = 2.9;
var ESTIMATE_HINT = `Worked out from the number of characters, at about ${CHARS_PER_TOKEN} per token. Close, not exact.`;
function estimatedTokens(size) {
  return size === null ? null : Math.ceil(size / CHARS_PER_TOKEN);
}
function formatDuration(ms) {
  if (ms < 1e3) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1e3);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
function formatSize(bytes) {
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  if (bytes >= 1e3) {
    return `${(bytes / 1e3).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
function formatClock(thenMs) {
  const date = new Date(thenMs);
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) {
    hours = 12;
  }
  return `${hours}:${minutes} ${suffix}`;
}

// src/describe/events.ts
function describeBranch(agentType, agentId) {
  if (agentType !== null) {
    return `Subagent ${agentType}`;
  }
  if (agentId !== null) {
    return `Subagent ${agentId}`;
  }
  return "A subagent";
}
function describeSegment(segment, ctx = {}) {
  const facts = [
    { label: "When", value: formatClock(segment.startedAt) }
  ];
  if (segment.kind === "compact") {
    if (ctx.contextBefore != null && segment.contextTokens !== null) {
      facts.push({
        label: "Context",
        value: `${formatTokens(ctx.contextBefore)} before, ${formatTokens(segment.contextTokens)} after`
      });
    }
    return { sentence: "Compacted the conversation", facts };
  }
  if (segment.kind === "resume") {
    return { sentence: "Session resumed", facts };
  }
  return { sentence: "Session started", facts };
}
function describePause(pause) {
  const facts = [{ label: "When", value: formatClock(pause.pausedAt) }];
  if (pause.resumedAt !== null) {
    facts.push({
      label: "For",
      value: formatDuration(pause.resumedAt - pause.pausedAt)
    });
    return { sentence: "Recording paused, then resumed", facts };
  }
  return { sentence: "Recording paused", facts };
}

// src/describe/tools.ts
var SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
function outcomeWords(outcome) {
  switch (outcome) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "interrupted":
      return "Interrupted";
    case "open":
      return "Running";
    default:
      return "Not recorded";
  }
}
function baseFacts(step, ctx) {
  const facts = [];
  facts.push({
    label: "When",
    value: step.startedAt !== null ? formatClock(step.startedAt) : "unknown"
  });
  facts.push({
    label: "Duration",
    value: step.durationMs !== null ? formatDuration(step.durationMs) : "unknown"
  });
  facts.push({ label: "Outcome", value: outcomeWords(step.outcome) });
  if (ctx.approvedBy !== void 0) {
    facts.push({ label: "Approved by", value: ctx.approvedBy });
  }
  if (ctx.contextBefore != null && ctx.contextAfter != null) {
    const added = ctx.contextAfter - ctx.contextBefore;
    facts.push({
      label: "Context",
      value: `${formatTokens(ctx.contextBefore)} before, ${formatTokens(ctx.contextAfter)} after (${added >= 0 ? "+" : ""}${formatTokens(added)} from this step)`
    });
  } else if (ctx.contextBefore != null) {
    facts.push({
      label: "Context",
      value: `${formatTokens(ctx.contextBefore)} before`
    });
  }
  if (step.savedOutputBytes !== null) {
    facts.push({
      label: "Saved output",
      value: `Output saved to a file (${formatSize(step.savedOutputBytes)}); only a short notice entered the context`
    });
  }
  if (ctx.turnSequence !== void 0) {
    facts.push({ label: "Turn", value: `Turn ${ctx.turnSequence}` });
  }
  if (ctx.branchName !== void 0) {
    facts.push({ label: "Branch", value: ctx.branchName });
  }
  return facts;
}
function shortTarget(step) {
  const input = parseRecord(step.inputSummary);
  const path = str(input, "file_path");
  switch (step.toolName) {
    case "Bash": {
      const command = str(input, "command");
      return command ? `\`${firstLine(command)}\`` : "a command";
    }
    case "Read":
    case "Edit":
    case "Write":
      return path ?? "a file";
    default:
      return path ?? step.toolName;
  }
}
function describeBash(step, input, facts, running) {
  const description = str(input, "description");
  const command = str(input, "command");
  const sentence = running ? `Running ${command ? `\`${truncate(firstLine(command), 60)}\`` : "a command"}` : description ?? (command ? `Ran \`${truncate(firstLine(command), 60)}\`` : "Ran a command");
  if (command) {
    facts.push({ label: "Command", value: command });
  }
  if (step.resultSize !== null) {
    facts.push({
      label: "Output",
      value: `printed ${formatCount(step.resultSize)} characters, not stored`
    });
  }
  return { sentence, facts };
}
function savedOutputToolUseId(step, sessionId) {
  if (step.toolName !== "Read" || sessionId === void 0) return null;
  const path = str(parseRecord(step.inputSummary), "file_path");
  if (path === void 0) return null;
  const parts = path.split(/[\\/]/);
  const file = parts.pop() ?? "";
  return parts.pop() === "tool-results" && parts.pop() === sessionId && file.endsWith(".txt") ? file.slice(0, -".txt".length) : null;
}
function sentencePath(input, ctx) {
  const path = str(input, "file_path");
  if (path === void 0) return "a file";
  return ctx.projectPath === void 0 ? path : relativeToProject(path, ctx.projectPath);
}
function describeRead(step, input, facts, running, ctx) {
  const path = sentencePath(input, ctx);
  const offset = num(input, "offset");
  const limit = num(input, "limit");
  if (offset !== void 0 && limit !== void 0) {
    facts.push({
      label: "Lines",
      value: `lines ${offset} to ${offset + limit - 1} of the file`
    });
  }
  if (step.resultSize !== null) {
    facts.push({
      label: "Size read",
      value: `${formatCount(step.resultSize)} characters`
    });
  }
  const verb = running ? "Reading" : "Read";
  if (savedOutputToolUseId(step, ctx.sessionId) === null) {
    return { sentence: `${verb} ${path}`, facts };
  }
  const source = ctx.savedOutputOf === void 0 ? "a saved tool output" : `the saved output of the step "${ctx.savedOutputOf}"`;
  return { sentence: `${verb} ${source}`, facts };
}
function describeEdit(step, input, facts, running, ctx) {
  const path = sentencePath(input, ctx);
  const oldChars = charsOf(input, "old_string");
  const newChars = charsOf(input, "new_string");
  if (bool(input, "replace_all")) {
    facts.push({ label: "Places changed", value: "all occurrences" });
  } else if (oldChars !== void 0) {
    facts.push({ label: "Places changed", value: "1 place" });
  }
  if (oldChars !== void 0 && newChars !== void 0) {
    facts.push({
      label: "Characters",
      value: `replaced ${formatCount(oldChars)} characters with ${formatCount(newChars)} characters`
    });
  }
  return { sentence: `${running ? "Editing" : "Edited"} ${path}`, facts };
}
function describeWrite(step, input, facts, running, ctx) {
  const path = sentencePath(input, ctx);
  const written = charsOf(input, "content");
  if (written !== void 0) {
    facts.push({
      label: "Size written",
      value: `${formatCount(written)} characters`
    });
  }
  return { sentence: `${running ? "Writing" : "Wrote"} ${path}`, facts };
}
function describeGrep(step, input, facts, running) {
  const pattern = str(input, "pattern");
  const scope = str(input, "path") ?? "the project";
  if (pattern !== void 0) {
    facts.push({ label: "Pattern", value: pattern });
  }
  facts.push({ label: "Scope", value: scope });
  if (step.resultSize !== null) {
    facts.push({
      label: "Results",
      value: `${formatCount(step.resultSize)} characters of results`
    });
  }
  return {
    sentence: pattern !== void 0 ? `${running ? "Searching" : "Searched"} for \`${truncate(pattern, 40)}\` in ${scope}` : `${running ? "Searching" : "Searched"} in ${scope}`,
    facts
  };
}
function describeGlob(step, input, facts, running) {
  const pattern = str(input, "pattern");
  if (pattern !== void 0) {
    facts.push({ label: "Pattern", value: pattern });
  }
  if (step.resultSize !== null) {
    facts.push({
      label: "Results",
      value: `${formatCount(step.resultSize)} characters of results`
    });
  }
  return {
    sentence: pattern !== void 0 ? `${running ? "Looking" : "Looked"} for files matching \`${truncate(pattern, 40)}\`` : `${running ? "Looking" : "Looked"} for files`,
    facts
  };
}
function describeAgent(step, input, facts, running, ctx) {
  const name = str(input, "subagent_type") ?? str(input, "description");
  const task = str(input, "description");
  if (task) {
    facts.push({ label: "Task", value: task });
  }
  if (ctx.branchTotals) {
    facts.push({
      label: "Its work",
      value: `${ctx.branchTotals.steps} steps, ${ctx.branchTotals.requests} requests${ctx.branchTotals.durationMs !== null ? `, ${formatDuration(ctx.branchTotals.durationMs)}` : ""}`
    });
    if (ctx.branchTotals.coldStartTokens != null) {
      facts.push({
        label: "Cold start",
        value: `${formatCount(ctx.branchTotals.coldStartTokens)} tokens written to cache`
      });
    }
  }
  return {
    sentence: name !== void 0 ? `${running ? "Starting" : "Started"} a subagent: ${truncate(name, 60)}` : `${running ? "Starting" : "Started"} a subagent`,
    facts
  };
}
function readQuestions(input) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((entry) => {
    if (!isPlainObject(entry)) {
      return [];
    }
    const options = Array.isArray(entry.options) ? entry.options : [];
    const labels = options.flatMap((option) => {
      if (!isPlainObject(option)) {
        return [];
      }
      const label = str(option, "label");
      return label === void 0 ? [] : [label];
    });
    return [{ question: str(entry, "question") ?? null, options: labels }];
  });
}
function describeQuestion(input, facts, running) {
  const texts = readQuestions(input).flatMap(
    (asked) => asked.question === null ? [] : [asked.question]
  );
  if (texts.length > 0) {
    facts.push({ label: "The question", value: texts.join(" ") });
  }
  return {
    sentence: running ? "Asking you a question" : "Asked you a question",
    facts
  };
}
function describeSkill(input, facts, running) {
  const skill = str(input, "skill");
  return {
    sentence: skill !== void 0 ? `${running ? "Loading" : "Loaded"} the ${skill} skill` : `${running ? "Loading" : "Loaded"} a skill`,
    facts
  };
}
function describeWebFetch(step, input, facts, running) {
  const url = str(input, "url");
  if (url !== void 0) {
    facts.push({ label: "Address", value: url });
  }
  if (step.resultSize !== null) {
    facts.push({
      label: "Result",
      value: `${formatCount(step.resultSize)} characters`
    });
  }
  return {
    sentence: url !== void 0 ? `${running ? "Fetching" : "Fetched"} ${shownAddress(url)}` : `${running ? "Fetching" : "Fetched"} a page`,
    facts
  };
}
function shownAddress(url) {
  try {
    const parsed = new URL(url);
    return truncate(`${parsed.host}${parsed.pathname}`, 60);
  } catch {
    return truncate(url, 60);
  }
}
function inputSizeWords(input, key) {
  const chars = charsOf(input, key);
  if (chars !== void 0) {
    return `${formatCount(chars)} characters`;
  }
  if (typeof input[key] === "number") {
    return "a number";
  }
  if (typeof input[key] === "boolean") {
    return "a yes/no";
  }
  return "a list or object";
}
function describeOtherTool(step, input, facts, running) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(step.toolName);
  if (!mcp) {
    return {
      sentence: `${running ? "Running" : "Ran"} ${step.toolName}`,
      facts
    };
  }
  const keys = Object.keys(input);
  if (keys.length > 0) {
    facts.push({
      label: "Inputs",
      value: keys.map((key) => `${key} (${inputSizeWords(input, key)})`).join(", ")
    });
  }
  if (step.resultSize !== null) {
    facts.push({
      label: "Result",
      value: `${formatCount(step.resultSize)} characters`
    });
  }
  return {
    sentence: `${running ? "Using" : "Used"} ${mcp[1]}: ${mcp[2]}`,
    facts
  };
}
function describeStep(step, ctx = {}) {
  const input = parseRecord(step.inputSummary);
  const facts = baseFacts(step, ctx);
  const running = step.outcome === "open";
  if (SUBAGENT_TOOLS.has(step.toolName)) {
    return describeAgent(step, input, facts, running, ctx);
  }
  switch (step.toolName) {
    case "Bash":
      return describeBash(step, input, facts, running);
    case "Read":
      return describeRead(step, input, facts, running, ctx);
    case "Edit":
      return describeEdit(step, input, facts, running, ctx);
    case "Write":
      return describeWrite(step, input, facts, running, ctx);
    case "Grep":
      return describeGrep(step, input, facts, running);
    case "Glob":
      return describeGlob(step, input, facts, running);
    case "SubagentHandback":
      return {
        sentence: running ? "Handing its report back" : "Handed its report back",
        facts
      };
    case "AskUserQuestion":
      return describeQuestion(input, facts, running);
    case "Skill":
      return describeSkill(input, facts, running);
    case "WebFetch":
      return describeWebFetch(step, input, facts, running);
    default:
      return describeOtherTool(step, input, facts, running);
  }
}

// src/describe/humans.ts
function describePrompt(event, ctx, facts, detail) {
  if (ctx.sinceLastTurnMs != null) {
    facts.push({
      label: "Since the last turn",
      value: formatDuration(ctx.sinceLastTurnMs)
    });
  }
  if (ctx.promptText != null) {
    return {
      sentence: `You asked: ${truncate(firstLine(ctx.promptText), 80)}`,
      facts
    };
  }
  const length = num(detail, "prompt_length") ?? ctx.promptLength ?? void 0;
  return {
    sentence: length !== void 0 ? `You asked a question (${formatCount(length)} characters, wording not kept)` : "You asked a question (wording not kept)",
    facts
  };
}
function describePermissionRequest(ctx, facts) {
  if (ctx.step === void 0) {
    return { sentence: "Claude asked to run an action", facts };
  }
  return {
    sentence: `Claude asked to use ${ctx.step.toolName} on ${shortTarget(ctx.step)}`,
    facts
  };
}
function decisionWords(decision) {
  if (decision === "accept") {
    return "approved, once";
  }
  if (decision === "accept_permanent") {
    return "approved, always";
  }
  if (decision === "reject") {
    return "rejected";
  }
  return "not recorded";
}
function describePermissionDecision(event, ctx, facts, detail) {
  const asked = ctx.step ? `${ctx.step.toolName} ${shortTarget(ctx.step)}` : "an action";
  facts.push({ label: "What was asked", value: asked });
  facts.push({ label: "The answer", value: decisionWords(event.decision) });
  const rule = str(detail, "suggestedRule");
  if (rule) {
    facts.push({ label: "Rule suggested", value: rule });
  }
  return {
    sentence: decisionSentence(event.decision, asked),
    facts
  };
}
function decisionSentence(decision, asked) {
  if (decision === "reject") {
    return `You rejected ${asked}`;
  }
  if (decision === "accept" || decision === "accept_permanent") {
    return `You approved ${asked}`;
  }
  return `The answer for ${asked} was not recorded`;
}
function describeRejection(ctx, facts) {
  const target = ctx.step ? `${ctx.step.toolName} ${shortTarget(ctx.step)}` : "an action";
  facts.push({ label: "What was asked", value: target });
  return { sentence: `You rejected ${target}`, facts };
}
function describeInterrupt(ctx, facts) {
  const target = ctx.step ? shortTarget(ctx.step) : "the running step";
  facts.push({ label: "What was running", value: target });
  const after = ctx.step?.durationMs != null ? ` after ${formatDuration(ctx.step.durationMs)}` : "";
  return { sentence: `You stopped ${target}${after}`, facts };
}
function answerLabels(detail) {
  const answers = typeof detail.answers === "object" && detail.answers !== null ? detail.answers : detail;
  return Object.values(answers).flatMap((value) => {
    if (typeof value === "string") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === "string");
    }
    return [];
  });
}
function describeQuestionAnswered(ctx, facts, detail) {
  const labels = answerLabels(detail);
  const choice = str(detail, "choice") ?? str(detail, "answer") ?? (labels.length > 0 ? labels.join(", ") : void 0);
  const options = ctx.options ?? [];
  if (options.length > 0) {
    facts.push({ label: "The options", value: options.join(", ") });
  }
  if (choice) {
    facts.push({ label: "Your choice", value: choice });
  }
  return {
    sentence: choice ? `You answered: ${choice}` : "You answered a question",
    facts
  };
}
function describeCommand(facts, detail) {
  const name = str(detail, "name");
  return {
    sentence: name === void 0 ? "You ran a command" : `You ran \`${name}\``,
    facts
  };
}
function handbackName(agentType) {
  return `${agentType ?? "A subagent"} reported back`;
}
function describeHandback(facts, detail) {
  const chars = num(detail, "chars");
  const size = chars === void 0 ? "" : ` \xB7 about ${formatTokens(estimatedTokens(chars))} est.`;
  return {
    sentence: `${handbackName(str(detail, "agent_type"))}${size}`,
    facts
  };
}
function describeNotice(facts, detail) {
  const chars = num(detail, "chars");
  const size = chars === void 0 ? "" : ` \xB7 ${formatCount(chars)} ${chars === 1 ? "character" : "characters"}`;
  return { sentence: `Claude Code added a notice${size}`, facts };
}
function describeHuman(event, ctx = {}) {
  const facts = [
    { label: "When", value: formatClock(event.occurredAt) }
  ];
  const detail = parseRecord(event.detail);
  switch (event.kind) {
    case "prompt":
      return describePrompt(event, ctx, facts, detail);
    case "permission_request":
      return describePermissionRequest(ctx, facts);
    case "permission_decision":
      return describePermissionDecision(event, ctx, facts, detail);
    case "rejection":
      return describeRejection(ctx, facts);
    case "interrupt":
      return describeInterrupt(ctx, facts);
    case "question_answered":
      return describeQuestionAnswered(ctx, facts, detail);
    case "waiting":
      return { sentence: "Claude is waiting for you", facts };
    case "command":
      return describeCommand(facts, detail);
    case "handback":
      return describeHandback(facts, detail);
    case "notice":
      return describeNotice(facts, detail);
    default:
      return { sentence: `A moment was recorded (${event.kind})`, facts };
  }
}

// src/describe/requests.ts
function partOfWords(querySource, telemetrySeen) {
  if (querySource === "subagent") {
    return "a subagent";
  }
  if (querySource === "main") {
    return "the main conversation";
  }
  if (querySource === "compact") {
    return "compaction";
  }
  if (querySource === "suggestion" || querySource === "title") {
    return "the background";
  }
  return notRecorded(telemetrySeen);
}
function describeRequest(request, ctx = {}) {
  return [
    {
      label: "Part of",
      value: partOfWords(request.querySource, ctx.telemetrySeen)
    }
  ];
}

// src/api/context-limit.ts
var MODEL_WINDOWS = /* @__PURE__ */ new Map([
  ["claude-fable-5-2", 1e6],
  ["claude-fable-5-1", 1e6],
  ["claude-opus-5-5", 1e6],
  ["claude-sonnet-5-5", 1e6],
  ["claude-haiku-5-5", 1e6],
  ["claude-opus-5", 1e6],
  ["claude-sonnet-5", 1e6],
  ["claude-opus-4-8", 1e6],
  ["claude-opus-4-7", 1e6],
  ["claude-opus-4-6", 2e5],
  ["claude-sonnet-4-6", 2e5],
  ["claude-haiku-4-5", 2e5]
]);
var KNOWN_WINDOWS = [2e5, 1e6];
function modelKey(model) {
  return model.toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
}
function listedWindowFor(model) {
  if (model.toLowerCase().endsWith("[1m]")) {
    return 1e6;
  }
  return MODEL_WINDOWS.get(modelKey(model)) ?? null;
}
function contextReportFor(reports, model) {
  if (model === null) {
    return null;
  }
  const key = modelKey(model);
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const report = reports[index];
    if (report !== void 0 && modelKey(report.model) === key) {
      return report;
    }
  }
  return null;
}
function samplesForModel(samples, requests, model) {
  if (model === null) {
    return [];
  }
  const key = modelKey(model);
  const onModel = new Set(
    requests.filter(
      (request) => request.model !== null && modelKey(request.model) === key
    ).map((request) => request.id)
  );
  return samples.filter(
    (sample) => sample.requestId !== null && onModel.has(sample.requestId)
  );
}
function contextWindowFor(model, samples, reported) {
  if (model === null) {
    return { tokens: null, source: "unknown", reportedAt: null };
  }
  let base;
  let source;
  if (reported !== null) {
    base = reported.window;
    source = "context-command";
  } else {
    const listed = listedWindowFor(model);
    if (listed === null) {
      return { tokens: null, source: "unknown", reportedAt: null };
    }
    base = listed;
    source = "model-list";
  }
  const reportedAt = source === "context-command" && reported !== null ? reported.reportedAt : null;
  if (!samples.some((sample) => sample.contextTokens > base)) {
    return { tokens: base, source, reportedAt };
  }
  const raised = KNOWN_WINDOWS.find((size) => size > base);
  return raised === void 0 ? { tokens: base, source, reportedAt } : { tokens: raised, source: "inferred", reportedAt: null };
}

// src/api/payloads.ts
function itemTokens(item) {
  const filesTokens = item.files?.tokens;
  if (filesTokens === void 0) return item.tokens;
  return (item.tokens ?? 0) + filesTokens;
}
var RISE_FLOOR = 2e3;

// src/api/session-data.ts
function groupSamplesByBranch(requests, samples) {
  const branchOfRequest = new Map(
    requests.map((request) => [request.id, request.branchId])
  );
  const grouped = /* @__PURE__ */ new Map();
  for (const sample of samples) {
    const branchId = sample.requestId === null ? null : branchOfRequest.get(sample.requestId) ?? null;
    const own = grouped.get(branchId) ?? [];
    own.push(sample);
    grouped.set(branchId, own);
  }
  return grouped;
}
function firstHandbackByAgent(humans) {
  const byAgent = /* @__PURE__ */ new Map();
  for (const event of humans) {
    if (event.kind !== "handback") continue;
    const detail = parseRecord(event.detail);
    const agentId = str(detail, "agent_id");
    const chars = num(detail, "chars");
    if (agentId === void 0 || chars === void 0 || byAgent.has(agentId)) {
      continue;
    }
    byAgent.set(agentId, {
      occurredAt: event.occurredAt,
      agentType: str(detail, "agent_type"),
      chars
    });
  }
  return byAgent;
}
function buildSessionData(session, rows) {
  const { turns, steps, humans, branches } = rows;
  const decisionByStep = /* @__PURE__ */ new Map();
  for (const event of humans) {
    if (event.kind === "permission_decision" && event.stepId !== null && !decisionByStep.has(event.stepId)) {
      decisionByStep.set(event.stepId, event);
    }
  }
  const stepsByResult = /* @__PURE__ */ new Map();
  for (const step of steps) {
    if (step.resultRequestId === null) continue;
    const own = stepsByResult.get(step.resultRequestId) ?? [];
    own.push(step);
    stepsByResult.set(step.resultRequestId, own);
  }
  const skillFilesByLoad = /* @__PURE__ */ new Map();
  for (const load of rows.loads) {
    if (load.kind !== "skill-file" || load.parentLoadId === null) continue;
    const own = skillFilesByLoad.get(load.parentLoadId) ?? [];
    own.push(load);
    skillFilesByLoad.set(load.parentLoadId, own);
  }
  return {
    session,
    ...rows,
    stepsById: new Map(steps.map((step) => [step.id, step])),
    turnsById: new Map(turns.map((turn) => [turn.id, turn])),
    branchesById: new Map(branches.map((branch) => [branch.id, branch])),
    branchBySpawningStep: new Map(
      branches.flatMap(
        (branch) => branch.spawningStepId === null ? [] : [[branch.spawningStepId, branch]]
      )
    ),
    decisionByStep,
    samplesByBranch: groupSamplesByBranch(rows.requests, rows.samples),
    handbackByAgent: firstHandbackByAgent(humans),
    stepsByResult,
    stepsByToolUse: new Map(
      steps.flatMap(
        (step) => step.toolUseId === null ? [] : [[step.toolUseId, step]]
      )
    ),
    skillFilesByLoad
  };
}
function handbackOf(data, branch) {
  return branch.agentId === null ? void 0 : data.handbackByAgent.get(branch.agentId);
}
function launchedInBackground(step) {
  return step.asyncLaunch === 1;
}
function backgroundReports(data, branchId) {
  const reports = [];
  for (const branch of data.branches) {
    const handback = handbackOf(data, branch);
    const spawning = branch.spawningStepId === null ? void 0 : data.stepsById.get(branch.spawningStepId);
    if (handback === void 0 || spawning === void 0) continue;
    if (spawning.branchId !== branchId || !launchedInBackground(spawning)) {
      continue;
    }
    reports.push({ branch, spawning, handback });
  }
  return reports;
}
function loadSessionData(storage, sessionId) {
  const session = storage.sessionRow(sessionId);
  if (session === void 0) {
    return void 0;
  }
  return buildSessionData(session, {
    turns: storage.turnRows(sessionId),
    steps: storage.stepRows(sessionId),
    humans: storage.humanRows(sessionId),
    branches: storage.branchRows(sessionId),
    requests: storage.requestRows(sessionId),
    samples: storage.contextSampleRows(sessionId),
    contextReports: storage.contextReportsFor(sessionId),
    segments: storage.segmentRows(sessionId),
    pauses: storage.pauseRows(sessionId),
    loads: storage.loadRows(sessionId),
    promptAttachments: storage.promptAttachmentRows(sessionId),
    compactionFiles: storage.compactionFileRows(sessionId),
    requestShapes: storage.requestShapeRows(sessionId)
  });
}
function upsertRows(rows, fresh, compare) {
  if (fresh === void 0 || fresh.length === 0) {
    return rows;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of fresh) {
    byId.set(row.id, row);
  }
  return [...byId.values()].sort(compare);
}
function byTimeThenId(a, b) {
  const atA = a.at ?? Number.NEGATIVE_INFINITY;
  const atB = b.at ?? Number.NEGATIVE_INFINITY;
  return atA - atB || a.id - b.id;
}
function sessionOnlyRow(delta) {
  if (delta.session === void 0) return null;
  const tables = [
    delta.turns,
    delta.steps,
    delta.humans,
    delta.branches,
    delta.requests,
    delta.samples,
    delta.segments,
    delta.pauses,
    delta.loads,
    delta.promptAttachments,
    delta.compactionFiles,
    delta.requestShapes,
    delta.contextReports
  ];
  const only = tables.every((rows) => rows === void 0) && delta.replacedAttachmentTurns === void 0;
  return only ? delta.session : null;
}
function mergeAttachments(held, delta) {
  const replaced = new Set(delta.replacedAttachmentTurns ?? []);
  const kept = replaced.size === 0 ? held : held.filter((row) => !replaced.has(row.turnId));
  return upsertRows(kept, delta.promptAttachments, (a, b) => a.id - b.id);
}
function replacedLists(data, delta) {
  return {
    contextReports: delta.contextReports ?? data.contextReports,
    compactionFiles: delta.compactionFiles ?? data.compactionFiles,
    requestShapes: delta.requestShapes ?? data.requestShapes
  };
}
function mergeSessionData(data, delta) {
  const alone = sessionOnlyRow(delta);
  if (alone !== null) {
    return { ...data, session: alone };
  }
  return buildSessionData(delta.session ?? data.session, {
    turns: upsertRows(
      data.turns,
      delta.turns,
      (a, b) => a.sequence === b.sequence ? a.id - b.id : a.sequence - b.sequence
    ),
    steps: upsertRows(
      data.steps,
      delta.steps,
      (a, b) => byTimeThenId(
        { at: a.startedAt, id: a.id },
        { at: b.startedAt, id: b.id }
      )
    ),
    humans: upsertRows(
      data.humans,
      delta.humans,
      (a, b) => a.occurredAt - b.occurredAt || a.id - b.id
    ),
    branches: upsertRows(
      data.branches,
      delta.branches,
      (a, b) => byTimeThenId(
        { at: a.startedAt, id: a.id },
        { at: b.startedAt, id: b.id }
      )
    ),
    requests: upsertRows(
      data.requests,
      delta.requests,
      (a, b) => byTimeThenId(
        { at: a.startedAt, id: a.id },
        { at: b.startedAt, id: b.id }
      )
    ),
    samples: upsertRows(
      data.samples,
      delta.samples,
      (a, b) => a.sampledAt - b.sampledAt || a.id - b.id
    ),
    segments: upsertRows(
      data.segments,
      delta.segments,
      (a, b) => a.startedAt - b.startedAt || a.id - b.id
    ),
    pauses: upsertRows(
      data.pauses,
      delta.pauses,
      (a, b) => a.pausedAt - b.pausedAt || a.id - b.id
    ),
    loads: upsertRows(
      data.loads,
      delta.loads,
      (a, b) => a.occurredAt - b.occurredAt || a.id - b.id
    ),
    promptAttachments: mergeAttachments(data.promptAttachments, delta),
    ...replacedLists(data, delta)
  });
}
function latestMainModel(data) {
  let model = null;
  for (const request of data.requests) {
    if (request.branchId === null && request.querySource === "main" && request.model !== null) {
      model = request.model;
    }
  }
  return model ?? data.session.model;
}
function turnByTime(turns, at) {
  if (turns.length === 0) {
    return void 0;
  }
  if (at === null) {
    return turns[turns.length - 1];
  }
  let chosen;
  for (const turn of turns) {
    if (turn.startedAt !== null && turn.startedAt <= at) {
      chosen = turn;
    }
  }
  return chosen ?? turns[0];
}
function groupByTurn(turnsById, rows, atOf) {
  const byTurn = /* @__PURE__ */ new Map();
  const turns = [...turnsById.values()];
  for (const row of rows) {
    const turn = row.turnId !== null && turnsById.has(row.turnId) ? turnsById.get(row.turnId) : turnByTime(turns, atOf(row));
    if (turn === void 0) {
      continue;
    }
    const list = byTurn.get(turn.id) ?? [];
    list.push(row);
    byTurn.set(turn.id, list);
  }
  return byTurn;
}
function approvedByFor(stepId, decisionByStep) {
  const decision = decisionByStep.get(stepId);
  if (decision === void 0 || decision.decision !== "accept" && decision.decision !== "accept_permanent") {
    return void 0;
  }
  const source = decision.decisionSource;
  if (source === "inferred" || source !== null && source.startsWith("user")) {
    return "you";
  }
  return void 0;
}
function firstSampleAtOrAfter(samples, at) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const sample = samples[mid];
    if (sample === void 0 || sample.sampledAt < at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
function contextAround(samples, step) {
  if (step.startedAt === null) {
    return {};
  }
  const end = step.endedAt ?? step.startedAt;
  const beforeIndex = firstSampleAtOrAfter(samples, step.startedAt + 1) - 1;
  const before = beforeIndex >= 0 ? samples[beforeIndex]?.contextTokens ?? null : null;
  const afterIndex = firstSampleAtOrAfter(samples, end);
  const after = afterIndex < samples.length ? samples[afterIndex]?.contextTokens ?? null : null;
  if (before === null) {
    return {};
  }
  return after === null ? { contextBefore: before } : { contextBefore: before, contextAfter: after };
}
function branchTotalsFor(branch, data) {
  const firstRequest = data.requests.find(
    (request) => request.branchId === branch.id
  );
  return {
    steps: data.steps.filter((step) => step.branchId === branch.id).length,
    requests: data.requests.filter((request) => request.branchId === branch.id).length,
    durationMs: branch.startedAt !== null && branch.endedAt !== null ? branch.endedAt - branch.startedAt : null,
    coldStartTokens: firstRequest === void 0 ? null : cacheWriteTokens(firstRequest)
  };
}
function savedOutputSource(step, data) {
  const toolUseId = savedOutputToolUseId(step, data.session.id);
  return toolUseId === null ? void 0 : data.stepsByToolUse.get(toolUseId);
}
function stepContext(step, turn, data) {
  const branch = step.branchId === null ? void 0 : data.branchesById.get(step.branchId);
  const spawning = data.branchBySpawningStep.get(step.id);
  const name = branch === void 0 ? void 0 : describeBranch(branch.agentType, branch.agentId);
  const approvedBy = approvedByFor(step.id, data.decisionByStep);
  const source = savedOutputSource(step, data);
  return {
    sessionId: data.session.id,
    ...turn === void 0 ? {} : { turnSequence: turn.sequence },
    ...name === void 0 ? {} : { branchName: name },
    ...approvedBy === void 0 ? {} : { approvedBy },
    ...source === void 0 ? {} : { savedOutputOf: describeStep(source).sentence },
    telemetrySeen: data.session.sources.includes("telemetry"),
    ...contextAround(data.samplesByBranch.get(step.branchId) ?? [], step),
    ...spawning === void 0 ? {} : { branchTotals: branchTotalsFor(spawning, data) }
  };
}

// src/api/tokens.ts
function hasContextCount(request) {
  return request.inputTokens !== null || request.cacheReadTokens !== null || request.cacheWrite5mTokens !== null || request.cacheWrite1hTokens !== null;
}
function seriesPoints(requests) {
  const started = [];
  for (const request of requests) {
    if (request.startedAt === null || !hasContextCount(request)) continue;
    started.push({ request, at: request.startedAt });
  }
  started.sort((a, b) => a.at - b.at || a.request.id - b.request.id);
  const points = [];
  let lifetime = null;
  for (const { request, at } of started) {
    if ((request.cacheWrite1hTokens ?? 0) > 0) lifetime = "1h";
    else if ((request.cacheWrite5mTokens ?? 0) > 0) lifetime = "5m";
    points.push({
      requestId: request.id,
      at,
      tokens: requestContextTokens(request),
      turnId: request.turnId,
      cacheLifetime: lifetime
    });
  }
  return points;
}
function requestsByBranch(requests) {
  const byBranch = /* @__PURE__ */ new Map();
  for (const request of requests) {
    if (request.branchId === null) continue;
    const own = byBranch.get(request.branchId) ?? [];
    own.push(request);
    byBranch.set(request.branchId, own);
  }
  return byBranch;
}
function agentTypeName(branch) {
  return branch.agentType ?? "subagent";
}
function parentAgentTypeOf(data, branch) {
  if (branch.spawningStepId === null) return null;
  const starter = data.stepsById.get(branch.spawningStepId);
  if (starter === void 0 || starter.branchId === null) return null;
  const parent = data.branchesById.get(starter.branchId);
  if (parent === void 0 || parent.id === branch.id) return null;
  return agentTypeName(parent);
}
var LISTING_KINDS = [
  "skill-listing",
  "mcp-instructions",
  "agent-listing",
  "deferred-tool-names",
  "hook-output"
];
var START_PARTS = [
  { part: "task", kinds: ["task-prompt"] },
  { part: "skills", kinds: ["preloaded-skill"] },
  { part: "CLAUDE.md", kinds: ["instructions"] },
  { part: "listings", kinds: LISTING_KINDS }
];
function startedWith(loads) {
  const parts = [];
  let tokens = 0;
  for (const { part, kinds } of START_PARTS) {
    const own = loads.filter((load) => kinds.includes(load.kind));
    if (own.length === 0) continue;
    parts.push(part);
    for (const load of own) tokens += estimatedTokens(load.sizeBytes ?? 0);
  }
  return parts.length === 0 ? null : { tokens, parts };
}
function loadsByBranch(loads) {
  const byBranch = /* @__PURE__ */ new Map();
  for (const load of loads) {
    if (load.branchId === null) continue;
    const own = byBranch.get(load.branchId) ?? [];
    own.push(load);
    byBranch.set(load.branchId, own);
  }
  return byBranch;
}
function branchHistories(data) {
  const byBranch = requestsByBranch(data.requests);
  const startsByBranch = loadsByBranch(data.loads);
  const branches = [];
  const background = [];
  const ordered = [...data.branches].sort((a, b) => a.id - b.id);
  for (const branch of ordered) {
    const own = byBranch.get(branch.id) ?? [];
    const processed = own.reduce(
      (sum, request) => sum + requestTotalTokens(request),
      0
    );
    if (branch.kind === "user") {
      branches.push({
        branchId: branch.id,
        agentType: branch.agentType,
        parentAgentType: parentAgentTypeOf(data, branch),
        spawningStepId: branch.spawningStepId,
        points: seriesPoints(own),
        tokensProcessed: processed,
        returnedChars: handbackOf(data, branch)?.chars ?? null,
        startedWith: startedWith(startsByBranch.get(branch.id) ?? [])
      });
    } else {
      background.push({
        branchId: branch.id,
        agentType: branch.agentType,
        tokensProcessed: own.length === 0 ? null : processed
      });
    }
  }
  return { branches, background };
}
function groupMainByTurn(rows) {
  const byTurn = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.turnId === null) continue;
    const own = byTurn.get(row.turnId) ?? [];
    own.push(row);
    byTurn.set(row.turnId, own);
  }
  return byTurn;
}
function turnHistories(data, mainRequests, main2, storePromptText) {
  const requests = groupMainByTurn(mainRequests);
  const points = groupMainByTurn(main2);
  const turns = [];
  const endedChanges = [];
  const ordered = [...data.turns].sort(
    (a, b) => a.sequence - b.sequence || a.id - b.id
  );
  for (const turn of ordered) {
    const own = requests.get(turn.id) ?? [];
    const turnPoints = points.get(turn.id) ?? [];
    const first = turnPoints[0];
    const last = turnPoints[turnPoints.length - 1];
    const contextStart = first === void 0 ? null : first.tokens;
    const contextEnd = last === void 0 ? null : last.tokens;
    const shaped = {
      turnId: turn.id,
      sequence: turn.sequence,
      input: own.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      output: own.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
      cacheRead: own.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0),
      cacheWrite: own.reduce((sum, r) => sum + (cacheWriteTokens(r) ?? 0), 0),
      contextStart,
      contextEnd,
      contextChange: contextStart === null || contextEnd === null ? null : contextEnd - contextStart,
      promptLine: storePromptText && turn.promptText !== null ? firstLine(turn.promptText).trim() : null,
      promptChars: turn.promptChars
    };
    turns.push(shaped);
    if (turn.endedAt !== null && shaped.contextChange !== null && shaped.contextChange > 0) {
      endedChanges.push(shaped.contextChange);
    }
  }
  return { turns, endedChanges };
}
function median(values) {
  if (values.length === 0) return null;
  const sorted2 = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted2.length / 2);
  const upper = sorted2[mid];
  if (upper === void 0) return null;
  if (sorted2.length % 2 === 1) return upper;
  const lower = sorted2[mid - 1];
  return lower === void 0 ? upper : (lower + upper) / 2;
}
function autoCompactPoint(window, reported, autoCompactWindow) {
  if (reported !== null && reported.autocompactBuffer !== null && window.tokens !== null) {
    return {
      tokens: window.tokens - reported.autocompactBuffer,
      source: "context-command"
    };
  }
  if (autoCompactWindow !== null) {
    return { tokens: autoCompactWindow, source: "setting" };
  }
  if (window.tokens === 1e6) {
    return { tokens: 967e3, source: "model-default" };
  }
  return null;
}
function roomLeft(data, autoCompactWindow, main2, endedChanges) {
  const model = latestMainModel(data);
  const reported = contextReportFor(data.contextReports, model);
  const window = contextWindowFor(
    model,
    samplesForModel(data.samples, data.requests, model),
    reported
  );
  const autoCompact = autoCompactPoint(window, reported, autoCompactWindow);
  const latest = main2[main2.length - 1];
  const toLimit = latest === void 0 || window.tokens === null ? null : window.tokens - latest.tokens;
  const toAutoCompact = autoCompact === null || latest === void 0 ? null : autoCompact.tokens - latest.tokens;
  const recent = endedChanges.slice(-5);
  const growth = recent.length >= 3 ? median(recent) : null;
  const turnsLeft = growth === null || toAutoCompact === null ? null : {
    value: toAutoCompact <= 0 ? 0 : Math.floor(toAutoCompact / growth),
    estimated: true
  };
  return { model, window, autoCompact, toLimit, toAutoCompact, turnsLeft };
}
function stepLabel(data, step, projectPath) {
  const turn = step.turnId === null ? void 0 : data.turnsById.get(step.turnId);
  const context = stepContext(step, turn, data);
  return describeStep(
    step,
    projectPath === void 0 ? context : { ...context, projectPath }
  ).sentence;
}
function stepChars(step) {
  return step.contextChars ?? step.resultSize;
}
var CONTEXT_EVENT_KINDS = /* @__PURE__ */ new Set([
  "command",
  "handback",
  "notice",
  "interrupt"
]);
var MEASURED_FLOOR = 10;
function enteredBetween(data, from, to) {
  const inWindow = (at) => at > from && at <= to;
  return data.loads.some(
    (load) => load.branchId === null && inWindow(load.occurredAt)
  ) || data.segments.some((segment) => inWindow(segment.startedAt)) || data.humans.some(
    (event) => CONTEXT_EVENT_KINDS.has(event.kind) && inWindow(event.occurredAt)
  );
}
function switchedModel(previous, request) {
  return previous.model !== null && request.model !== null && previous.model !== request.model;
}
function measuredResult(data, previous, request) {
  const [step, ...others] = data.stepsByResult.get(request.id) ?? [];
  const { startedAt: from, outputTokens: reply } = previous;
  const to = request.startedAt;
  if (step === void 0 || others.length > 0) return null;
  if (from === null || to === null || reply === null) return null;
  if (request.turnId !== previous.turnId) return null;
  if (switchedModel(previous, request)) return null;
  if (isCacheRebuild(previous, request)) return null;
  if (enteredBetween(data, from, to)) return null;
  const tokens = requestContextTokens(request) - requestContextTokens(previous) - reply;
  return tokens < MEASURED_FLOOR ? null : { step, tokens };
}
function loadName(load) {
  return load.kind === "instructions" || load.kind === "skill-file" ? load.filePath ?? load.name ?? load.kind : load.name ?? load.kind;
}
function skillFilesOf(data, load) {
  const rows = data.skillFilesByLoad.get(load.id);
  if (rows === void 0) return null;
  const items = rows.map((row) => ({
    loadId: row.id,
    path: loadName(row),
    bytes: row.sizeBytes,
    lines: row.lineCount,
    tokens: estimatedTokens(row.sizeBytes)
  }));
  return {
    tokens: items.reduce((sum, file) => sum + (file.tokens ?? 0), 0),
    items
  };
}
function isListedLoad(load) {
  return load.branchId === null && (load.kind === "skill" || load.kind === "instructions" || load.kind === "command-output");
}
function isListedAttachment(row) {
  return row.kind === "image" || row.kind === "file";
}
function attachmentTokens(row) {
  return row.kind === "file" ? estimatedTokens(row.sizeBytes) : null;
}
function promptAttachmentsByTurn(rows) {
  const byTurn = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const own = byTurn.get(row.turnId) ?? [];
    own.push(row);
    byTurn.set(row.turnId, own);
  }
  return byTurn;
}
function stepItem(data, step, measured) {
  const label = stepLabel(data, step, data.session.projectPath ?? void 0);
  const chars = stepChars(step);
  const measuredTokens = measured?.step.id === step.id ? measured.tokens : null;
  if (SUBAGENT_TOOLS.has(step.toolName) && !launchedInBackground(step)) {
    const branch = data.branchBySpawningStep.get(step.id);
    return {
      kind: "branch-return",
      stepId: step.id,
      branchId: branch === void 0 ? null : branch.id,
      label,
      chars,
      tokens: estimatedTokens(chars),
      estimated: true
    };
  }
  return {
    kind: "step",
    stepId: step.id,
    label,
    chars,
    rawChars: step.contextChars !== null && step.resultSize !== null && step.contextChars < step.resultSize ? step.resultSize : null,
    tokens: measuredTokens ?? estimatedTokens(chars),
    estimated: measuredTokens === null
  };
}
function reportItems(reports, from, to) {
  return reports.filter(
    ({ handback }) => handback.occurredAt > from.at && handback.occurredAt <= to.at
  ).map(({ branch, spawning, handback }) => ({
    kind: "branch-return",
    stepId: spawning.id,
    branchId: branch.id,
    label: handbackName(handback.agentType),
    chars: handback.chars,
    tokens: estimatedTokens(handback.chars),
    estimated: true
  }));
}
function promptItems(data, turnId, attachments) {
  const items = [];
  const turn = data.turnsById.get(turnId);
  if (turn !== void 0) {
    items.push({
      kind: "prompt",
      turnId,
      chars: turn.promptChars,
      tokens: estimatedTokens(turn.promptChars),
      estimated: true
    });
  }
  for (const row of attachments) {
    if (!isListedAttachment(row)) continue;
    items.push({
      kind: "attachment",
      turnId,
      attachmentKind: row.kind,
      name: row.name,
      bytes: row.sizeBytes,
      tokens: attachmentTokens(row),
      estimated: true
    });
  }
  return items;
}
function loadItem(data, load) {
  if (!isListedLoad(load)) return null;
  return {
    kind: "load",
    loadId: load.id,
    loadKind: load.kind,
    name: loadName(load),
    bytes: load.sizeBytes,
    tokens: estimatedTokens(load.sizeBytes),
    files: skillFilesOf(data, load),
    estimated: true
  };
}
function buildRiseIndex(data) {
  const mainStepsByEnd = [];
  for (const step of data.steps) {
    if (step.branchId === null && step.endedAt !== null) {
      mainStepsByEnd.push({ step, endedAt: step.endedAt });
    }
  }
  mainStepsByEnd.sort((a, b) => a.endedAt - b.endedAt);
  const attachmentsByTurn = promptAttachmentsByTurn(data.promptAttachments);
  return {
    mainStepsByEnd,
    attachmentsByTurn,
    reports: backgroundReports(data, null)
  };
}
function firstEndedAfter(entries, at) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const entry = entries[mid];
    if (entry === void 0 || entry.endedAt <= at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
function riseSteps(data, index, from, to) {
  if (data.stepsByResult.size > 0) {
    const steps2 = data.stepsByResult.get(to.requestId) ?? [];
    return { link: steps2.length === 0 ? "none" : "exact", steps: steps2 };
  }
  const steps = [];
  let i = firstEndedAfter(index.mainStepsByEnd, from.at);
  for (; i < index.mainStepsByEnd.length; i++) {
    const entry = index.mainStepsByEnd[i];
    if (entry === void 0 || entry.endedAt > to.at) {
      break;
    }
    steps.push(entry.step);
  }
  return { link: steps.length === 0 ? "none" : "by_time", steps };
}
function rankItems(items) {
  return [...items].sort((a, b) => {
    const sizeA = itemTokens(a);
    const sizeB = itemTokens(b);
    if (sizeA === null) return sizeB === null ? 0 : 1;
    if (sizeB === null) return -1;
    return sizeB - sizeA;
  });
}
function buildRise(data, index, requestsById, firstOfTurn, loads, from, to, delta) {
  const { link, steps } = riseSteps(data, index, from, to);
  const earlier = requestsById.get(from.requestId);
  const later = requestsById.get(to.requestId);
  const measured = earlier === void 0 || later === void 0 ? null : measuredResult(data, earlier, later);
  const items = steps.map((step) => stepItem(data, step, measured));
  if (to.turnId !== null && firstOfTurn.has(to.requestId)) {
    items.push(
      ...promptItems(
        data,
        to.turnId,
        index.attachmentsByTurn.get(to.turnId) ?? []
      )
    );
  }
  items.push(...reportItems(index.reports, from, to));
  items.push(...loads);
  if (earlier !== void 0 && earlier.outputTokens !== null) {
    items.push({
      kind: "reply",
      requestId: from.requestId,
      tokens: earlier.outputTokens,
      estimated: false
    });
  }
  const known = items.reduce((sum, item) => sum + (itemTokens(item) ?? 0), 0);
  if (delta - known > 0) {
    items.push({ kind: "other", tokens: delta - known, estimated: true });
  }
  return {
    id: `rise-${to.requestId}`,
    fromRequestId: from.requestId,
    toRequestId: to.requestId,
    at: to.at,
    delta,
    link,
    items: rankItems(items)
  };
}
function compactionBetween(data, from, to) {
  return data.segments.find(
    (row) => row.kind === "compact" && row.startedAt > from.at && row.startedAt <= to.at
  );
}
function buildDrop(data, from, to) {
  const segment = compactionBetween(data, from, to);
  return {
    id: `drop-${to.requestId}`,
    fromRequestId: from.requestId,
    toRequestId: to.requestId,
    at: to.at,
    before: from.tokens,
    after: to.tokens,
    cause: segment === void 0 ? "unknown" : "compaction",
    segmentId: segment === void 0 ? null : segment.id
  };
}
function forEachPair(main2, visit) {
  for (let i = 1; i < main2.length; i++) {
    const from = main2[i - 1];
    const to = main2[i];
    if (from === void 0 || to === void 0) continue;
    visit(from, to);
  }
}
function loadsForPairs(data, pairs) {
  const grouped = pairs.map(() => []);
  let cursor = 0;
  pairs.forEach((pair, index) => {
    while (cursor < data.loads.length) {
      const load = data.loads[cursor];
      if (load === void 0 || load.occurredAt > pair.to.at) break;
      cursor += 1;
      if (load.occurredAt <= pair.from.at) continue;
      const item = loadItem(data, load);
      if (item !== null) grouped[index]?.push(item);
    }
  });
  return grouped;
}
function risesAndDrops(data, requestsById, main2) {
  const index = buildRiseIndex(data);
  const firstOfTurn = /* @__PURE__ */ new Set();
  const seenTurns = /* @__PURE__ */ new Set();
  for (const point of main2) {
    if (point.turnId === null || seenTurns.has(point.turnId)) continue;
    seenTurns.add(point.turnId);
    firstOfTurn.add(point.requestId);
  }
  const pairs = [];
  const drops = [];
  forEachPair(main2, (from, to) => {
    const delta = to.tokens - from.tokens;
    if (delta < 0) {
      drops.push(buildDrop(data, from, to));
    } else if (delta >= RISE_FLOOR) {
      pairs.push({ from, to, delta });
    }
  });
  const loads = loadsForPairs(data, pairs);
  const rises = pairs.map(
    (pair, i) => buildRise(
      data,
      index,
      requestsById,
      firstOfTurn,
      loads[i] ?? [],
      pair.from,
      pair.to,
      pair.delta
    )
  );
  rises.sort((a, b) => b.delta - a.delta);
  return { rises, drops };
}
function rebuildCause(data, previous, current, from, to) {
  const segment = compactionBetween(data, from, to);
  if (segment !== void 0) {
    return { kind: "compaction", expected: true, segmentId: segment.id };
  }
  const expired = expiredCause(previous, from, to);
  if (expired !== null) return expired;
  if (previous.model !== null && current.model !== null && previous.model !== current.model) {
    return {
      kind: "model",
      expected: false,
      from: previous.model,
      to: current.model
    };
  }
  if (previous.effort !== null && current.effort !== null && previous.effort !== current.effort) {
    return {
      kind: "effort",
      expected: false,
      from: previous.effort,
      to: current.effort
    };
  }
  if (previous.shapeHash !== null && current.shapeHash !== null && previous.shapeHash !== current.shapeHash) {
    return { kind: "tools", expected: false };
  }
  return null;
}
function expiredCause(previous, from, to) {
  const lifetime = from.cacheLifetime;
  if (lifetime === null) return null;
  const gap = to.at - (from.at + (previous.durationMs ?? 0));
  if (gap <= CACHE_LIFETIME_MS[lifetime]) return null;
  return {
    kind: "expired",
    expected: false,
    gapMinutes: Math.round(gap / 6e4),
    lifetime
  };
}
function isCacheRebuild(previous, current) {
  return (cacheWriteTokens(current) ?? 0) > requestContextTokens(current) / 2 && (previous.cacheReadTokens ?? 0) > 0;
}
var WRITE_FLOOR = 5e3;
function isRebuildWithCause(previous, current, cause) {
  if (isCacheRebuild(previous, current)) return true;
  const changed = cause?.kind === "model" || cause?.kind === "effort" || cause?.kind === "tools";
  return changed && (cacheWriteTokens(current) ?? 0) >= WRITE_FLOOR && (previous.cacheReadTokens ?? 0) > 0;
}
function mainSeries(data) {
  return data.requests.filter(
    (request) => request.branchId === null && request.querySource === "main"
  );
}
function rebuildPairs(data, isRebuild) {
  const requests = mainSeries(data);
  const requestsById = new Map(requests.map((r) => [r.id, r]));
  const pairs = [];
  forEachPair(seriesPoints(requests), (from, to) => {
    const previous = requestsById.get(from.requestId);
    const current = requestsById.get(to.requestId);
    if (previous === void 0 || current === void 0) return;
    const cause = rebuildCause(data, previous, current, from, to);
    if (!isRebuild(previous, current, cause)) return;
    pairs.push({ previous, current, at: to.at, cause });
  });
  return pairs;
}
function cacheRebuilds(data) {
  return rebuildPairs(data, isRebuildWithCause).map(
    ({ current, at, cause }) => ({
      id: `rebuild-${current.id}`,
      requestId: current.id,
      at,
      written: cacheWriteTokens(current) ?? 0,
      context: requestContextTokens(current),
      cause
    })
  );
}
function tokenHistory(data, context) {
  const mainRequests = mainSeries(data);
  const main2 = seriesPoints(mainRequests);
  const requestsById = new Map(mainRequests.map((r) => [r.id, r]));
  const { branches, background } = branchHistories(data);
  const { turns, endedChanges } = turnHistories(
    data,
    mainRequests,
    main2,
    context.storePromptText
  );
  const { rises, drops } = risesAndDrops(data, requestsById, main2);
  return {
    sessionId: data.session.id,
    states: {
      telemetry: data.session.sources.includes("telemetry"),
      tokensPartial: data.session.tokensPartial,
      joinedPartway: data.session.joinedPartway
    },
    base: main2[0] ?? null,
    main: main2,
    branches,
    background,
    turns,
    room: roomLeft(data, context.autoCompactWindow, main2, endedChanges),
    rises,
    drops,
    rebuilds: cacheRebuilds(data)
  };
}
function sessionTokens(storage, sessionId, context) {
  const data = loadSessionData(storage, sessionId);
  return data === void 0 ? void 0 : tokenHistory(data, context);
}

// src/api/cache.ts
function lastMainCache(data) {
  const requests = mainSeries(data);
  const last = seriesPoints(requests).at(-1);
  if (last === void 0 || last.cacheLifetime === null || last.tokens === 0) {
    return null;
  }
  const compactedSince = data.segments.some(
    (segment) => segment.kind === "compact" && segment.startedAt > last.at
  );
  if (compactedSince) return null;
  const duration = requests.find((r) => r.id === last.requestId)?.durationMs;
  return {
    lifetime: last.cacheLifetime,
    endedAt: last.at + (duration ?? 0),
    contextTokens: last.tokens
  };
}

// src/daemon/cache-hold.ts
var EXPIRED_LINE_MS = 2 * 6e4;
var MAX_HOLD_MS = 65 * 6e4;
function cacheHold(storage, lastActivity, previous) {
  const liveIds = storage.liveSessions().map((session) => session.id);
  const readsFrom = `${lastActivity} ${liveIds.join(" ")}`;
  if (previous?.readsFrom === readsFrom) return previous;
  let until = 0;
  for (const id of liveIds) {
    const data = loadSessionData(storage, id);
    const cache = data === void 0 ? null : lastMainCache(data);
    if (cache === null) continue;
    until = Math.max(
      until,
      cache.endedAt + CACHE_LIFETIME_MS[cache.lifetime] + EXPIRED_LINE_MS
    );
  }
  return { readsFrom, until: Math.min(until, lastActivity + MAX_HOLD_MS) };
}

// src/daemon/ingest.ts
import { statSync as statSync4 } from "node:fs";
function isEnvelope(value) {
  if (typeof value !== "object" || value === null) return false;
  const e = value;
  return typeof e.id === "string" && e.id.length > 0 && typeof e.received_at === "number" && typeof e.event === "object" && e.event !== null && !Array.isArray(e.event);
}
function withInstructionSize(event) {
  if (event.hook_event_name !== "InstructionsLoaded") return event;
  const filePath = event.file_path;
  if (typeof filePath !== "string") return event;
  try {
    return { ...event, file_size_bytes: statSync4(filePath).size };
  } catch {
    return event;
  }
}
function ingestEnvelope(storage, envelope) {
  const event = withInstructionSize(envelope.event);
  const sessionId = typeof event.session_id === "string" ? event.session_id : void 0;
  if (sessionId !== void 0 && storage.isForgotten(sessionId)) {
    return "forgotten";
  }
  const stored = { ...envelope, event: redactHookEvent(event) };
  const inserted = storage.insertEnvelopeJourney(
    {
      source: "hook",
      ...sessionId !== void 0 ? { sessionId } : {},
      receivedAt: envelope.received_at,
      redactionVersion: REDACTION_VERSION,
      envelopeId: envelope.id,
      body: JSON.stringify(stored)
    },
    stored.event
  );
  return inserted ? "stored" : "duplicate";
}

// src/daemon/lock.ts
import { readFileSync as readFileSync8, statSync as statSync5, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join9 } from "node:path";
var TAKEOVER_STALE_MS = 5e3;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function startLockPath(dataDir) {
  return join9(dataDir, "daemon-start.lock");
}
function makeLock(path) {
  return {
    release() {
      try {
        if (readFileSync8(path, "utf8").trim() === String(process.pid)) {
          unlinkIfPresent(path);
        }
      } catch {
      }
    }
  };
}
function readLockOwner(path) {
  try {
    return Number.parseInt(readFileSync8(path, "utf8").trim(), 10);
  } catch {
    return Number.NaN;
  }
}
function hasLiveOwner(path) {
  const owner = readLockOwner(path);
  return Number.isFinite(owner) && owner !== process.pid && pidAlive(owner);
}
function claimTakeoverMarker(takeoverPath) {
  try {
    writeFileSync5(takeoverPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
  }
  try {
    if (Date.now() - statSync5(takeoverPath).mtimeMs < TAKEOVER_STALE_MS) {
      return false;
    }
    unlinkIfPresent(takeoverPath);
    writeFileSync5(takeoverPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function acquireDaemonLock(dataDir) {
  const path = join9(dataDir, "daemon.lock");
  const takeoverPath = `${path}.takeover`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync5(path, String(process.pid), { flag: "wx" });
      return makeLock(path);
    } catch {
    }
    if (hasLiveOwner(path)) {
      return null;
    }
    if (!claimTakeoverMarker(takeoverPath)) {
      return null;
    }
    try {
      if (hasLiveOwner(path)) {
        return null;
      }
      unlinkIfPresent(path);
    } finally {
      unlinkIfPresent(takeoverPath);
    }
  }
  return null;
}

// src/daemon/retention.ts
var RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1e3;
var DATABASE_SIZE_CAP_BYTES = 2 * 1024 * 1024 * 1024;
var DAY_MS2 = 24 * 60 * 60 * 1e3;
function staleBefore(nowMs) {
  return nowMs - DAY_MS2;
}
function createRetention(options) {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const cap = options.sizeCapBytes ?? DATABASE_SIZE_CAP_BYTES;
  const shrink = () => {
    storage.incrementalVacuum();
    storage.checkpointWal();
  };
  return {
    runOnce: async () => {
      const at = now();
      const cutoff = at - options.settings().retentionDays * DAY_MS2;
      const staleCutoff = staleBefore(at);
      let aged = 0;
      for (const session of storage.sessionsToPurge(cutoff, staleCutoff)) {
        storage.purgeSession(session.id, at);
        aged += 1;
        await yieldToEventLoop();
      }
      let capped = 0;
      shrink();
      while (storage.databaseBytes() > cap) {
        const oldest = storage.oldestNonLiveSession(staleCutoff);
        if (oldest === null) break;
        storage.purgeSession(oldest.id, at);
        capped += 1;
        shrink();
        await yieldToEventLoop();
      }
      return { aged, capped };
    },
    deleteAllData: async () => {
      const at = now();
      const ids = storage.allSessionIds();
      for (const id of ids) {
        storage.purgeSession(id, at);
        await yieldToEventLoop();
      }
      shrink();
      return ids.length;
    }
  };
}

// src/daemon/session-watch.ts
var SESSION_WATCH_INTERVAL_MS = 60 * 1e3;
var SESSION_QUIET_LIMIT_MS = 10 * 60 * 1e3;
function processIsGone(exists, startTimes, session) {
  const pid = session.hostPid;
  if (pid === null) {
    return false;
  }
  if (!exists(pid)) {
    return true;
  }
  if (session.hostStartedAt === null) {
    return false;
  }
  const current = startTimes.get(pid);
  return current !== void 0 && !sameProcessStart(current, session.hostStartedAt);
}
function createSessionWatch(deps) {
  const exists = deps.exists ?? processExists;
  const startedAts = deps.startedAts ?? readProcessStartTimes;
  let running = false;
  return {
    runOnce: async (now = Date.now()) => {
      if (running) {
        return [];
      }
      running = true;
      try {
        const sessions = deps.storage.liveSessionHosts();
        const notedPids = [
          ...new Set(
            sessions.map((session) => session.hostPid).filter((pid) => pid !== null)
          )
        ].filter((pid) => exists(pid));
        const startTimes = await startedAts(notedPids);
        const ended = [];
        for (const session of sessions) {
          const gone = session.hostPid !== null ? processIsGone(exists, startTimes, session) : now - session.lastSeenAt >= SESSION_QUIET_LIMIT_MS;
          if (gone && deps.storage.endSessionUnseenIfUnchanged(session)) {
            ended.push(session.id);
          }
        }
        return ended;
      } finally {
        running = false;
      }
    }
  };
}

// src/daemon/routes/context.ts
var MAX_BODY_BYTES = 4 * 1024 * 1024;
function readBody(request) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolvePromise(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on(
      "end",
      () => resolvePromise(Buffer.concat(chunks).toString("utf8"))
    );
    request.on("error", () => resolvePromise(null));
  });
}
function guardRequest(ctx, request, response, run) {
  try {
    run();
  } catch (error) {
    daemonLog(
      ctx.dataDir,
      `${request.method ?? ""} ${request.url ?? ""} failed (${errorMessage(error)}); answered 500`
    );
    if (!response.headersSent) {
      response.writeHead(500).end();
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}
function handleJsonBody(ctx, request, response, badJson, handle) {
  void readBody(request).then((body) => {
    if (body === null) {
      response.writeHead(413).end();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      badJson(response);
      return;
    }
    guardRequest(ctx, request, response, () => handle(parsed));
  });
}
function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}
function hostIsLoopback(host) {
  if (host === void 0) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "";
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

// src/daemon/routes/events.ts
function postHookEvent(ctx, request, response) {
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => res.writeHead(400).end(),
    (parsed) => {
      if (!isEnvelope(parsed)) {
        response.writeHead(400).end();
        return;
      }
      try {
        ctx.noteVersion(parsed);
        if (ingestEnvelope(ctx.storage, parsed) !== "forgotten") {
          ctx.followTranscripts(parsed);
        }
      } catch (error) {
        daemonLog(
          ctx.dataDir,
          `ingest failed (${errorMessage(error)}); answered 500`
        );
        response.writeHead(500).end();
        return;
      }
      ctx.touch();
      response.writeHead(204).end();
      const sessionId = typeof parsed.event.session_id === "string" ? parsed.event.session_id : void 0;
      if (sessionId !== void 0) {
        ctx.stream.noteSession(sessionId);
      }
      if (ctx.handoverVersion !== null) {
        setTimeout(() => void ctx.shutdown("handover"), 25);
      }
    }
  );
}

// src/daemon/health.ts
function currentHealth(dataDir, autostart) {
  const stats = bufferStats(dataDir);
  const lastError = readLastError(dataDir);
  return {
    buffered: stats.count,
    oldestAt: stats.oldestAt,
    dropped: droppedCount(dataDir),
    lastError,
    problem: lastError === null ? null : startProblem(lastError, dataDir),
    autostart
  };
}

// src/daemon/routes/health.ts
function getHealth(ctx, _request, response) {
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      version: ctx.version,
      uptime_seconds: Math.floor((Date.now() - ctx.startedAt) / 1e3)
    })
  );
}
function getApiHealth(ctx, _request, response) {
  sendJson(response, 200, {
    state: "running",
    ...currentHealth(ctx.dataDir, ctx.settings.autostart)
  });
}

// src/daemon/view.ts
import { existsSync as existsSync3, readFileSync as readFileSync9 } from "node:fs";
import { dirname as dirname2, join as join10 } from "node:path";
import { fileURLToPath } from "node:url";
function viewDir() {
  const here = dirname2(fileURLToPath(import.meta.url));
  for (const candidate of [
    join10(here, "view"),
    join10(here, "..", "..", "dist", "view")
  ]) {
    if (existsSync3(join10(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};
function readViewFile(dir, name) {
  const parts = name.split("/");
  if (parts.length > 2) {
    return null;
  }
  for (const part of parts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) {
      return null;
    }
  }
  const extension = /\.[a-z0-9]+$/.exec(name)?.[0] ?? "";
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    return null;
  }
  const file = join10(dir, ...parts);
  if (!existsSync3(file)) {
    return null;
  }
  return { content: readFileSync9(file), contentType };
}

// src/daemon/routes/pages.ts
function serveViewPage(_ctx, _request, response) {
  const dir = viewDir();
  const page = dir ? readViewFile(dir, "index.html") : null;
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": page.contentType }).end(page.content);
}
function serveViewAsset(_ctx, _request, response, path) {
  const name = path.slice("/view/".length);
  const dir = viewDir();
  const file = dir && name !== "index.html" ? readViewFile(dir, name) : null;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": file.contentType,
    "cache-control": "public, max-age=31536000, immutable"
  }).end(file.content);
}
function serveSettingsRedirect(_ctx, _request, response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<title>Settings \u2014 flightpath</title>
<script>
  const token = /token=([^&]+)/.exec(location.hash);
  location.replace("/#settings" + (token ? "&token=" + token[1] : ""));
</script>
`);
}

// src/api/sessions.ts
function sessionTitle(firstPromptText, settings) {
  if (!settings.storePromptText || firstPromptText === null) {
    return "Untitled session";
  }
  const line = firstLine(firstPromptText).trim();
  if (line === "") {
    return "Untitled session";
  }
  return line.length > 120 ? `${line.slice(0, 119)}\u2026` : line;
}
function sessionEndNote(row) {
  return row.status === "ended" && !row.endSeen ? `Ended ${formatClock(row.lastSeenAt)} (no exit seen)` : null;
}
function sessionNote(row) {
  const parts = [];
  if (row.joinedPartway) {
    parts.push("Joined partway");
  }
  if (row.sources.length === 1 && row.sources[0] === "transcript") {
    parts.push("Imported from transcript");
  }
  if (row.sources.length > 0 && !row.sources.includes("telemetry")) {
    parts.push("No telemetry");
  }
  if (row.pauseCount === 1) {
    parts.push("Paused once");
  } else if (row.pauseCount === 2) {
    parts.push("Paused twice");
  } else if (row.pauseCount > 2) {
    parts.push(`Paused ${row.pauseCount} times`);
  }
  return parts.join(" \xB7 ");
}
function listNote(row) {
  const endNote = sessionEndNote(row);
  const note = sessionNote(row);
  if (endNote === null) {
    return note;
  }
  return note === "" ? endNote : `${endNote} \xB7 ${note}`;
}
function sessionListItem(row, settings) {
  return {
    id: row.id,
    title: sessionTitle(row.firstPromptText, settings),
    project: row.projectPath,
    status: row.status,
    startedAt: row.firstSeenAt,
    endedAt: row.status === "ended" ? row.lastSeenAt : null,
    lastActivityAt: row.lastSeenAt,
    endSeen: row.endSeen,
    hasOpenStep: row.openStepCount > 0,
    turns: row.turnCount,
    steps: row.stepCount,
    tokensProcessed: row.tokensProcessed,
    contextNow: row.contextNow,
    sources: row.sources,
    note: listNote(row)
  };
}
function isEmptySession(row) {
  return row.turnCount === 0 && row.requestCount === 0 && row.status !== "live";
}
function emptyHiddenCount(storage) {
  return storage.listSessionRows().filter(isEmptySession).length;
}
function listSessions(storage, settings, query) {
  const rows = storage.listSessionRows();
  const visible = rows.filter((row) => !isEmptySession(row));
  const items = visible.map((row) => sessionListItem(row, settings));
  const emptyHidden = rows.length - visible.length;
  if (query === null || query.trim() === "") {
    return { sessions: items, emptyHidden };
  }
  const needle = query.trim().toLowerCase();
  return {
    sessions: items.filter(
      (item) => item.title.toLowerCase().includes(needle) || (item.project ?? "").toLowerCase().includes(needle)
    ),
    emptyHidden
  };
}

// src/api/snapshot.ts
var MAX_SAMPLE_POINTS = 1e3;
var STEPPED_IN_KINDS = /* @__PURE__ */ new Set([
  "permission_decision",
  "rejection",
  "interrupt",
  "question_answered",
  "command"
]);
function questionOptions(step) {
  if (step === void 0 || step.toolName !== "AskUserQuestion") {
    return void 0;
  }
  const labels = readQuestions(parseRecord(step.inputSummary)).flatMap(
    (asked) => asked.options
  );
  return labels.length > 0 ? labels : void 0;
}
function humanSentence(event, data, settings, previousPromptAt) {
  const step = event.stepId === null ? void 0 : data.stepsById.get(event.stepId);
  const turn = event.turnId === null ? void 0 : data.turnsById.get(event.turnId);
  const options = questionOptions(step);
  return describeHuman(event, {
    ...step === void 0 ? {} : { step },
    promptText: settings.storePromptText && turn !== void 0 ? turn.promptText : null,
    promptLength: turn?.promptChars ?? null,
    sinceLastTurnMs: previousPromptAt === null ? null : event.occurredAt - previousPromptAt,
    ...options === void 0 ? {} : { options }
  }).sentence;
}
function stepSummaryOf(step, turn, data) {
  return {
    id: step.id,
    toolName: step.toolName,
    outcome: step.outcome,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    durationMs: step.durationMs,
    branchId: step.branchId,
    resultRequestId: step.resultRequestId,
    sentence: describeStep(step, stepContext(step, turn, data)).sentence
  };
}
function stepTurnIds(data) {
  const grouped = groupByTurn(
    data.turnsById,
    data.steps,
    (step) => step.startedAt
  );
  const turnIds = /* @__PURE__ */ new Map();
  for (const [turnId, steps] of grouped) {
    for (const step of steps) {
      turnIds.set(step.id, turnId);
    }
  }
  return turnIds;
}
function turnCounts(steps, humans) {
  return {
    failures: steps.filter((step) => step.outcome === "failed").length,
    steppedIn: humans.filter((event) => STEPPED_IN_KINDS.has(event.kind)).length
  };
}
function summarizeTurn(turn, steps, humans, attachments, data, settings, previousPromptAt) {
  const counts = turnCounts(steps, humans);
  let promptAt = previousPromptAt;
  const humanMoments = humans.map((event) => {
    const sentence = humanSentence(event, data, settings, promptAt);
    if (event.kind === "prompt") {
      promptAt = event.occurredAt;
    }
    return {
      id: event.id,
      kind: event.kind,
      occurredAt: event.occurredAt,
      sentence
    };
  });
  const summary = {
    id: turn.id,
    sequence: turn.sequence,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    failures: counts.failures,
    steppedIn: counts.steppedIn,
    images: turn.imageCount ?? 0,
    files: attachments.filter((row) => row.kind === "file").length,
    steps: steps.map((step) => stepSummaryOf(step, turn, data)),
    humanMoments
  };
  return { summary, previousPromptAt: promptAt };
}
function turnSummaries(data, settings) {
  return summarizeTurns(data, settings, null);
}
function turnSummariesFor(data, settings, turnIds) {
  return summarizeTurns(data, settings, turnIds);
}
function promptCarry(humans, current) {
  let promptAt = current;
  for (const event of humans) {
    if (event.kind === "prompt") {
      promptAt = event.occurredAt;
    }
  }
  return promptAt;
}
function summarizeTurns(data, settings, only) {
  const stepsByTurn = groupByTurn(
    data.turnsById,
    data.steps,
    (step) => step.startedAt
  );
  const humansByTurn = groupByTurn(
    data.turnsById,
    data.humans,
    (event) => event.occurredAt
  );
  const attachmentsByTurn = promptAttachmentsByTurn(data.promptAttachments);
  const turns = [];
  let failures = 0;
  let steppedIn = 0;
  let previousPromptAt = null;
  for (const turn of data.turns) {
    const steps = stepsByTurn.get(turn.id) ?? [];
    const humans = humansByTurn.get(turn.id) ?? [];
    const counts = turnCounts(steps, humans);
    failures += counts.failures;
    steppedIn += counts.steppedIn;
    if (only !== null && !only.has(turn.id)) {
      previousPromptAt = promptCarry(humans, previousPromptAt);
      continue;
    }
    const result = summarizeTurn(
      turn,
      steps,
      humans,
      attachmentsByTurn.get(turn.id) ?? [],
      data,
      settings,
      previousPromptAt
    );
    turns.push(result.summary);
    previousPromptAt = result.previousPromptAt;
  }
  return { turns, failures, steppedIn };
}
function branchSummaryOf(data, branch) {
  const totals = branchTotalsFor(branch, data);
  const spawning = branch.spawningStepId === null ? void 0 : data.stepsById.get(branch.spawningStepId);
  return {
    id: branch.id,
    agentId: branch.agentId,
    agentType: branch.agentType,
    kind: branch.kind,
    spawningStepId: branch.spawningStepId,
    startedAt: branch.startedAt,
    endedAt: branch.endedAt,
    totalTokens: branch.totalTokens,
    steps: totals.steps,
    requests: totals.requests,
    sentence: spawning !== void 0 ? describeStep(spawning, { branchTotals: totals }).sentence : describeBranch(branch.agentType, branch.agentId)
  };
}
function branchSummaries(data) {
  return data.branches.map((branch) => branchSummaryOf(data, branch));
}
function segmentEvent(segment, previousContext) {
  return {
    kind: "segment",
    id: segment.id,
    at: segment.startedAt,
    sentence: describeSegment(segment, { contextBefore: previousContext }).sentence,
    segmentKind: segment.kind
  };
}
function segmentEventOf(data, segment) {
  let previousContext = null;
  for (const earlier of data.segments) {
    if (earlier.id === segment.id) {
      break;
    }
    if (earlier.contextTokens !== null) {
      previousContext = earlier.contextTokens;
    }
  }
  return segmentEvent(segment, previousContext);
}
function pauseEventOf(pause) {
  return {
    kind: "pause",
    id: pause.id,
    at: pause.pausedAt,
    sentence: describePause(pause).sentence
  };
}
function sessionEvents(data) {
  const events = [];
  let previousContext = null;
  for (const segment of data.segments) {
    events.push(segmentEvent(segment, previousContext));
    if (segment.contextTokens !== null) {
      previousContext = segment.contextTokens;
    }
  }
  for (const pause of data.pauses) {
    events.push(pauseEventOf(pause));
  }
  return events.sort((a, b) => a.at - b.at || a.id - b.id);
}
function downsample(samples) {
  const points = samples.map((sample) => ({
    at: sample.sampledAt,
    contextTokens: sample.contextTokens
  }));
  if (points.length <= MAX_SAMPLE_POINTS) {
    return points;
  }
  const stride = Math.ceil(points.length / MAX_SAMPLE_POINTS);
  const kept = points.filter((_, index) => index % stride === 0);
  const last = points[points.length - 1];
  if (last !== void 0 && kept[kept.length - 1] !== last) {
    kept.push(last);
  }
  return kept;
}
function waitingSince(data) {
  let waiting = null;
  for (const event of data.humans) {
    if (event.kind === "waiting" || event.kind === "permission_request") {
      waiting = event.occurredAt;
    } else {
      waiting = null;
    }
  }
  return waiting;
}
function snapshotSummary(data, storage, settings, totals) {
  const latestSample = data.samples[data.samples.length - 1];
  const model = latestMainModel(data);
  const window = contextWindowFor(
    model,
    samplesForModel(data.samples, data.requests, model),
    contextReportFor(data.contextReports, model)
  );
  const lastStep = [...data.steps].reverse().find((step) => step.startedAt !== null);
  return {
    id: data.session.id,
    title: sessionTitle(data.session.firstPromptText, settings),
    project: data.session.projectPath,
    status: data.session.status,
    startedAt: data.session.firstSeenAt,
    endedAt: data.session.status === "ended" ? data.session.lastSeenAt : null,
    lastActivityAt: data.session.lastSeenAt,
    model,
    permissionModes: data.session.permissionModes,
    sources: data.session.sources,
    endSeen: data.session.endSeen,
    // The summary's own status line carries the end state;
    // the note is the shared phrases only.
    note: sessionNote(data.session),
    counts: {
      turns: data.turns.length,
      steps: data.steps.length,
      requests: data.requests.length,
      branches: data.branches.length,
      humanMoments: data.humans.length
    },
    failures: totals.failures,
    steppedIn: totals.steppedIn,
    tokensProcessed: data.session.tokensProcessed,
    contextNow: latestSample?.contextTokens ?? null,
    window,
    overheadTokens: storage.flightpathOverheadTokens(data.session.id),
    waitingSince: waitingSince(data),
    lastStepAt: lastStep?.startedAt ?? null,
    cache: lastMainCache(data)
  };
}
function sessionSnapshot(storage, settings, sessionId) {
  const data = loadSessionData(storage, sessionId);
  if (data === void 0) {
    return void 0;
  }
  const { turns, failures, steppedIn } = turnSummaries(data, settings);
  return {
    summary: snapshotSummary(data, storage, settings, { failures, steppedIn }),
    turns,
    branches: branchSummaries(data),
    sessionEvents: sessionEvents(data),
    // The strip shows the main conversation only: a subagent's
    // samples are its own thread's, never the strip's.
    contextSamples: downsample(data.samplesByBranch.get(null) ?? [])
  };
}

// src/api/steps.ts
function stepRequest(request, telemetrySeen) {
  return {
    id: request.id,
    model: request.model,
    startedAt: request.startedAt,
    durationMs: request.durationMs,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    cacheReadTokens: request.cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens(request),
    facts: describeRequest(request, { telemetrySeen })
  };
}
function stepDetail(storage, stepId) {
  const step = storage.stepRowById(stepId);
  if (step === void 0) {
    return void 0;
  }
  const data = loadSessionData(storage, step.sessionId);
  if (data === void 0) {
    return void 0;
  }
  const turn = step.turnId === null ? void 0 : data.turnsById.get(step.turnId);
  const described = describeStep(step, stepContext(step, turn, data));
  const producing = [...data.requests].reverse().find(
    (request) => request.turnId === step.turnId && request.branchId === step.branchId && request.startedAt !== null && step.startedAt !== null && request.startedAt <= step.startedAt
  );
  return {
    id: step.id,
    sessionId: step.sessionId,
    toolName: step.toolName,
    outcome: step.outcome,
    sentence: described.sentence,
    facts: described.facts,
    savedOutputStepId: savedOutputSource(step, data)?.id ?? null,
    requests: producing === void 0 ? [] : [stepRequest(producing, data.session.sources.includes("telemetry"))]
  };
}

// src/api/storage.ts
function storageSummary(storage) {
  return {
    sessions: storage.countSessions(),
    databaseBytes: storage.databaseBytes()
  };
}

// src/setup/index.ts
import {
  copyFileSync,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync10,
  realpathSync,
  rmSync
} from "node:fs";
import { dirname as dirname3, join as join11, posix, win32 as win322 } from "node:path";
var TELEMETRY_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_ASSISTANT_RESPONSES"
];
function telemetryEnvValues(port, token) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_HEADERS: `x-flightpath-token=${token}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    OTEL_LOG_ASSISTANT_RESPONSES: "0"
  };
}
var DETECTION_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL"
];
function managedSettingsDir(platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}
function managedPaths(platform, managedDir = managedSettingsDir(platform)) {
  const joinFor = platform === "win32" ? win322.join : posix.join;
  return {
    managedSettingsPath: joinFor(managedDir, "managed-settings.json"),
    managedDropInDir: joinFor(managedDir, "managed-settings.d")
  };
}
function setupPaths(options) {
  return {
    dataDir: options.dataDir,
    userSettingsPath: join11(options.configDir, "settings.json"),
    ...managedPaths(options.platform ?? process.platform, options.managedDir)
  };
}
var RECORD_FILE = "telemetry-setup.json";
var BACKUP_FILE = "telemetry-settings-backup.json";
function stringEntries(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
function readRecord(dataDir) {
  try {
    const parsed = JSON.parse(
      readFileSync10(join11(dataDir, RECORD_FILE), "utf8")
    );
    if (isPlainObject(parsed) && parsed.version === 1 && typeof parsed.settingsPath === "string" && isPlainObject(parsed.keys)) {
      return {
        version: 1,
        writtenAt: typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0,
        settingsPath: parsed.settingsPath,
        createdFile: parsed.createdFile === true,
        envExisted: parsed.envExisted === true,
        keys: stringEntries(parsed.keys),
        previous: isPlainObject(parsed.previous) ? stringEntries(parsed.previous) : {},
        backup: typeof parsed.backup === "string" ? parsed.backup : null
      };
    }
  } catch {
  }
  return null;
}
function writeRecord(dataDir, record) {
  writeFileAtomically(
    join11(dataDir, RECORD_FILE),
    `${JSON.stringify(record, null, 2)}
`
  );
}
function deleteRecord(dataDir) {
  rmSync(join11(dataDir, RECORD_FILE), { force: true });
}
function readUserSettings(path) {
  if (!existsSync4(path)) return { ok: true, exists: false, parsed: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync10(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      message: `your Claude Code settings file (${path}) is not valid JSON (${errorMessage(error)}); nothing was changed`
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      message: `your Claude Code settings file (${path}) does not hold a settings object; nothing was changed`
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
    if (typeof value === "string" && value.length > 0) return key;
  }
  return null;
}
function managedConfig(paths) {
  const files = managedSettingsFiles(paths);
  let unreadable = false;
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync10(file, "utf8"));
    } catch {
      unreadable = true;
      continue;
    }
    if (isPlainObject(parsed) && hasDetectionKey(envBlock(parsed)) !== null) {
      return { found: true, unreadable };
    }
  }
  return { found: false, unreadable };
}
function envPointsElsewhere(env, ourEndpoint) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint !== void 0 && endpoint.length > 0) {
    return endpoint !== ourEndpoint;
  }
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint !== void 0 && logsEndpoint.length > 0) {
    return logsEndpoint !== ourEndpoint;
  }
  return DETECTION_KEYS.some((key) => {
    if (key === "OTEL_EXPORTER_OTLP_ENDPOINT") return false;
    if (key === "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") return false;
    const value = env[key];
    return typeof value === "string" && value.length > 0;
  });
}
function settingsFileReading(paths, env) {
  const record = readRecord(paths.dataDir);
  if (record === null || record.settingsPath !== paths.userSettingsPath) {
    return { kind: "none" };
  }
  const intact = Object.entries(record.keys).every(
    ([key, value]) => env[key] === value
  );
  if (intact) {
    return {
      kind: "state",
      state: {
        state: "on",
        endpoint: record.keys.OTEL_EXPORTER_OTLP_ENDPOINT ?? ""
      }
    };
  }
  if (hasDetectionKey(env) !== null) {
    return {
      kind: "state",
      state: {
        state: "elsewhere",
        where: "your Claude Code settings",
        detail: "The telemetry settings Flightpath wrote were changed in your Claude Code settings, so they count as your own configuration now. Flightpath will not change them."
      }
    };
  }
  return { kind: "stale" };
}
function detectTelemetrySetup(options) {
  const { paths } = options;
  const ours = telemetryEnvValues(options.port, options.token);
  const managed = managedConfig(paths);
  if (managed.found || managed.unreadable) {
    return {
      state: "elsewhere",
      where: "managed settings",
      detail: managed.found ? `Telemetry is configured in ${paths.managedSettingsPath}, which overrides user settings. Flightpath will not change it.` : `A managed settings file exists at ${paths.managedSettingsPath} but could not be read, so Flightpath will not change anything.`
    };
  }
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
      detail: "Telemetry is configured in the environment of the session that started the daemon (detection there is best-effort). Flightpath will not change it."
    };
  }
  if (reading.kind === "stale") {
    return { state: "off" };
  }
  if (hasDetectionKey(env) !== null) {
    return {
      state: "elsewhere",
      where: "your Claude Code settings",
      detail: `Telemetry is already configured in ${paths.userSettingsPath}. Flightpath will not change it.`
    };
  }
  return { state: "off" };
}
function writeSettingsAtomic(path, parsed) {
  writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}
`);
}
function settingsTarget(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function applyTelemetrySetup(options) {
  const { paths } = options;
  const state = detectTelemetrySetup(options);
  if (state.state === "error") {
    return { ok: false, message: state.message };
  }
  if (state.state !== "off") {
    return {
      ok: false,
      message: state.state === "on" ? "Telemetry is already on for Flightpath." : state.detail
    };
  }
  const read = readUserSettings(paths.userSettingsPath);
  if (!read.ok) return { ok: false, message: read.message };
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
  const folder = dirname3(target);
  if (!existsSync4(folder)) {
    mkdirSync3(folder, { recursive: true });
  }
  if (read.exists) {
    copyFileSync(target, join11(paths.dataDir, BACKUP_FILE));
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
    backup
  });
  return {
    ok: true,
    message: "Telemetry is on for Flightpath from the next session. Your previous settings were backed up in Flightpath's data folder.",
    endpoint: values.OTEL_EXPORTER_OTLP_ENDPOINT
  };
}
function undoTelemetrySetup(options) {
  const { paths } = options;
  const record = readRecord(paths.dataDir);
  if (record === null) {
    return {
      ok: false,
      message: "Flightpath has no record of turning telemetry on.",
      removed: [],
      left: []
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
      if (record.previous[key] !== void 0) {
        env[key] = record.previous[key];
      } else {
        delete env[key];
      }
      removed.push(key);
    } else if (key in env) {
      left.push(key);
    }
  }
  if (Object.keys(env).length === 0 && !record.envExisted) {
    delete parsed.env;
  } else {
    parsed.env = env;
  }
  if (record.createdFile && Object.keys(parsed).length === 0) {
    rmSync(paths.userSettingsPath, { force: true });
  } else {
    writeSettingsAtomic(settingsTarget(paths.userSettingsPath), parsed);
  }
  deleteRecord(paths.dataDir);
  return {
    ok: true,
    message: left.length === 0 ? "Telemetry is off for Flightpath from the next session." : `Telemetry is off for Flightpath from the next session. These settings were left because you changed them: ${left.join(", ")}.`,
    removed,
    left
  };
}
function syncTelemetryEndpoint(options) {
  const { paths } = options;
  const record = readRecord(paths.dataDir);
  if (record === null) return false;
  const recorded = record.keys.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (recorded === void 0) return false;
  const values = telemetryEnvValues(options.port, options.token);
  if (recorded === values.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  const read = readUserSettings(paths.userSettingsPath);
  if (!read.ok) return false;
  const parsed = read.parsed;
  const env = { ...envBlock(parsed) };
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT !== recorded) return false;
  env.OTEL_EXPORTER_OTLP_ENDPOINT = values.OTEL_EXPORTER_OTLP_ENDPOINT;
  parsed.env = env;
  writeSettingsAtomic(settingsTarget(paths.userSettingsPath), parsed);
  record.keys = {
    ...record.keys,
    OTEL_EXPORTER_OTLP_ENDPOINT: values.OTEL_EXPORTER_OTLP_ENDPOINT
  };
  writeRecord(paths.dataDir, record);
  return true;
}

// src/api/context-at-step.ts
function threadRequests(data, branchId) {
  return data.requests.filter(
    (request) => branchId === null ? request.branchId === null && request.querySource === "main" : request.branchId === branchId
  );
}
function mainEpoch(data, moment) {
  let latest = null;
  for (const segment of data.segments) {
    if (segment.kind !== "compact" || segment.startedAt > moment) continue;
    if (latest === null || segment.startedAt >= latest.startedAt) {
      latest = segment;
    }
  }
  return latest === null ? { startedAt: data.session.firstSeenAt, afterCompactionSegmentId: null } : { startedAt: latest.startedAt, afterCompactionSegmentId: latest.id };
}
function lastAtOrBefore(requests, moment) {
  let chosen;
  for (const request of requests) {
    if ((request.startedAt ?? 0) > moment) break;
    chosen = request;
  }
  return chosen;
}
function countedRequests(requests) {
  return requests.filter((request) => request.startedAt !== null && hasContextCount(request)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id);
}
function firstMainRequest(data) {
  return countedRequests(threadRequests(data, null))[0];
}
function measuredRequest(counted, step, moment) {
  let chosen;
  if (step.resultRequestId !== null) {
    chosen = counted.find((request) => request.id === step.resultRequestId);
  }
  if (chosen === void 0) {
    chosen = counted.find((request) => (request.startedAt ?? 0) > moment) ?? lastAtOrBefore(counted, moment);
  }
  return chosen;
}
function measuredSummary(data, request) {
  const tokens = requestContextTokens(request);
  const model = request.model ?? data.session.model;
  const window = contextWindowFor(
    model,
    samplesForModel(data.samples, data.requests, model),
    contextReportFor(data.contextReports, model)
  );
  return {
    requestId: request.id,
    tokens,
    window,
    share: window.tokens === null ? null : tokens / window.tokens
  };
}
function readPath(step) {
  return str(parseRecord(step.inputSummary), "file_path") ?? "a file";
}
function stepItem2(data, step, measuredSizes2) {
  const chars = stepChars(step);
  if (SUBAGENT_TOOLS.has(step.toolName) && !launchedInBackground(step)) {
    const branch = data.branchBySpawningStep.get(step.id);
    return {
      kind: "subagent-result",
      stepId: step.id,
      branchId: branch === void 0 ? null : branch.id,
      label: stepLabel(data, step),
      chars,
      tokens: estimatedTokens(chars)
    };
  }
  const measuredTokens = measuredSizes2.get(step.id);
  const sized = {
    chars,
    tokens: measuredTokens ?? estimatedTokens(chars),
    measured: measuredTokens !== void 0
  };
  if (step.toolName === "Read") {
    return {
      kind: "file-read",
      stepId: step.id,
      path: readPath(step),
      ...sized
    };
  }
  return {
    kind: "tool-result",
    stepId: step.id,
    label: stepLabel(data, step),
    ...sized
  };
}
function stepItems(data, branchId, epochStart, moment, measuredSizes2) {
  const timed = [];
  for (const step of data.steps) {
    if (step.branchId !== branchId || step.endedAt === null) continue;
    if (step.endedAt < epochStart || step.endedAt > moment) continue;
    timed.push({
      at: step.endedAt,
      item: stepItem2(data, step, measuredSizes2)
    });
  }
  return timed;
}
function handbackItems(data, branchId, epochStart, moment) {
  return backgroundReports(data, branchId).filter(
    ({ handback }) => handback.occurredAt >= epochStart && handback.occurredAt <= moment
  ).map(({ branch, spawning, handback }) => ({
    at: handback.occurredAt,
    item: {
      kind: "subagent-result",
      stepId: spawning.id,
      branchId: branch.id,
      label: handbackName(handback.agentType),
      chars: handback.chars,
      tokens: estimatedTokens(handback.chars)
    }
  }));
}
function promptItems2(data, epochStart, moment) {
  const attachmentsByTurn = promptAttachmentsByTurn(data.promptAttachments);
  const timed = [];
  for (const turn of data.turns) {
    if (turn.startedAt === null) continue;
    if (turn.startedAt < epochStart || turn.startedAt > moment) continue;
    timed.push({
      at: turn.startedAt,
      item: {
        kind: "prompt",
        turnId: turn.id,
        sequence: turn.sequence,
        chars: turn.promptChars,
        tokens: estimatedTokens(turn.promptChars)
      }
    });
    for (const row of attachmentsByTurn.get(turn.id) ?? []) {
      if (!isListedAttachment(row)) continue;
      timed.push({
        at: turn.startedAt,
        item: {
          kind: row.kind,
          turnId: turn.id,
          name: row.name,
          bytes: row.sizeBytes,
          tokens: attachmentTokens(row)
        }
      });
    }
  }
  return timed;
}
function loadItem2(data, load) {
  if (!isListedLoad(load)) return null;
  return {
    kind: load.kind,
    loadId: load.id,
    name: loadName(load),
    bytes: load.sizeBytes,
    tokens: estimatedTokens(load.sizeBytes),
    files: skillFilesOf(data, load)
  };
}
function loadItems(data, epochStart, moment) {
  const timed = [];
  for (const load of data.loads) {
    if (load.occurredAt < epochStart || load.occurredAt > moment) continue;
    const item = loadItem2(data, load);
    if (item !== null) timed.push({ at: load.occurredAt, item });
  }
  return timed;
}
function replyItems(requests, epochStart, moment) {
  const timed = [];
  for (const request of requests) {
    if (request.outputTokens === null || request.startedAt === null) {
      continue;
    }
    if (request.startedAt < epochStart || request.startedAt > moment) {
      continue;
    }
    timed.push({
      at: request.startedAt,
      item: {
        kind: "reply",
        requestId: request.id,
        tokens: request.outputTokens
      }
    });
  }
  return timed;
}
function measuredSizes(data, counted) {
  const sizes = /* @__PURE__ */ new Map();
  for (const [i, request] of counted.entries()) {
    const previous = counted[i - 1];
    if (previous === void 0) continue;
    const measured = measuredResult(data, previous, request);
    if (measured !== null) sizes.set(measured.step.id, measured.tokens);
  }
  return sizes;
}
function measuredStepSizes(data) {
  const sizes = /* @__PURE__ */ new Map();
  const threads = [null, ...data.branches.map((branch) => branch.id)];
  for (const branchId of threads) {
    const counted = countedRequests(threadRequests(data, branchId));
    for (const [stepId, tokens] of measuredSizes(data, counted)) {
      sizes.set(stepId, tokens);
    }
  }
  return sizes;
}
function epochItems(data, branchId, requests, epochStart, moment) {
  const timed = [];
  if (branchId === null) {
    timed.push(...promptItems2(data, epochStart, moment));
    timed.push(...loadItems(data, epochStart, moment));
  }
  const sizes = measuredSizes(data, countedRequests(requests));
  timed.push(...stepItems(data, branchId, epochStart, moment, sizes));
  timed.push(...handbackItems(data, branchId, epochStart, moment));
  timed.push(...replyItems(requests, epochStart, moment));
  timed.sort((a, b) => a.at - b.at);
  return timed.map((entry) => entry.item);
}
function baseTokens(counted) {
  const first = counted[0];
  return first === void 0 ? null : requestContextTokens(first);
}
function mcpServerOf(name) {
  const prefix = "mcp__";
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const cut = rest.indexOf("__");
  return cut > 0 ? rest.slice(0, cut) : null;
}
function epochInstructions(data, branchId, epochStart, moment) {
  const list = [];
  for (const load of data.loads) {
    if (load.kind !== "instructions" || load.branchId !== branchId) continue;
    if (load.occurredAt < epochStart || load.occurredAt > moment) continue;
    list.push({
      loadId: load.id,
      name: loadName(load),
      bytes: load.sizeBytes,
      tokens: estimatedTokens(load.sizeBytes)
    });
  }
  return list;
}
var STARTUP_LOAD_KINDS = /* @__PURE__ */ new Set([
  ...LISTING_KINDS,
  "preloaded-skill",
  "task-prompt"
]);
function reportedStartupTokens(report, kind) {
  switch (kind) {
    case "skill-listing":
      return report.skills;
    case "mcp-instructions":
      return report.mcpInstructions;
    default:
      return null;
  }
}
function withReportedSizes(list, report) {
  if (report === null) return list;
  return list.map((load) => {
    const reported = reportedStartupTokens(report, load.kind);
    const alone = list.filter((other) => other.kind === load.kind).length === 1;
    return reported !== null && alone ? { ...load, tokens: reported, fromContext: true } : load;
  });
}
function startupLoadName(data, load) {
  const branch = load.branchId === null ? void 0 : data.branchesById.get(load.branchId);
  if (branch === void 0) return load.name;
  if (load.kind === "task-prompt") return parentAgentTypeOf(data, branch);
  return load.name;
}
function epochStartup(data, branchId, epochStart, moment, report) {
  const list = [];
  for (const load of data.loads) {
    if (!STARTUP_LOAD_KINDS.has(load.kind)) continue;
    if (load.branchId !== branchId) continue;
    if (load.occurredAt < epochStart || load.occurredAt > moment) continue;
    const chars = load.sizeBytes ?? 0;
    list.push({
      loadId: load.id,
      kind: load.kind,
      name: startupLoadName(data, load),
      count: load.itemCount,
      chars,
      tokens: estimatedTokens(chars),
      fromContext: false
    });
  }
  return withReportedSizes(
    list.sort((a, b) => b.chars - a.chars),
    report
  );
}
function epochReport(data, request, epochStart) {
  const report = contextReportFor(
    data.contextReports,
    request.model ?? data.session.model
  );
  if (report === null) return null;
  return mainEpoch(data, report.reportedAt).startedAt === epochStart ? report : null;
}
function systemPart(systemBytes, report) {
  const reported = report?.systemPrompt ?? null;
  return {
    chars: systemBytes,
    tokens: reported ?? estimatedTokens(systemBytes),
    fromContext: reported !== null
  };
}
function splitTools(shape) {
  const tools = [];
  const servers = /* @__PURE__ */ new Map();
  for (const tool of shape.tools) {
    const server = tool.mcp || tool.name.startsWith("mcp__") ? mcpServerOf(tool.name) : null;
    if (server === null) {
      tools.push({
        name: tool.name,
        chars: tool.bytes,
        tokens: estimatedTokens(tool.bytes)
      });
      continue;
    }
    const group = servers.get(server) ?? { tools: 0, chars: 0 };
    group.tools += 1;
    group.chars += tool.bytes;
    servers.set(server, group);
  }
  tools.sort((a, b) => b.chars - a.chars);
  const mcp = [...servers.entries()].map(([server, group]) => ({
    server,
    tools: group.tools,
    chars: group.chars,
    tokens: estimatedTokens(group.chars)
  })).sort((a, b) => a.server.localeCompare(b.server));
  return { tools, mcp };
}
function sharedOut(tools, reported) {
  const chars = tools.reduce((sum, tool) => sum + tool.chars, 0);
  const shared = tools.map((tool) => ({
    ...tool,
    tokens: Math.round(reported * tool.chars / chars)
  }));
  const rounding = reported - shared.reduce((sum, t) => sum + t.tokens, 0);
  const largest = shared[0];
  if (largest !== void 0) largest.tokens += rounding;
  return shared;
}
function splitLoad(data, request, shape, systemBytes, branchId, epochStart, moment) {
  const split = splitTools(shape);
  const report = branchId === null ? epochReport(data, request, epochStart) : null;
  const toolsReported = split.tools.length > 0 ? report?.systemTools ?? null : null;
  const tools = toolsReported === null ? split.tools : sharedOut(split.tools, toolsReported);
  const { mcp } = split;
  const system = systemPart(systemBytes, report);
  const instructions = epochInstructions(data, branchId, epochStart, moment);
  const startup = epochStartup(data, branchId, epochStart, moment, report);
  return {
    kind: "split",
    requestId: request.id,
    total: splitTotalOf({ system, tools, mcp, instructions, startup }),
    system,
    tools,
    toolsReported,
    mcp,
    instructions,
    startup
  };
}
function splitTotalOf(parts) {
  let total = parts.system.tokens;
  for (const part of [...parts.tools, ...parts.mcp, ...parts.startup]) {
    total += part.tokens;
  }
  for (const file of parts.instructions) total += file.tokens ?? 0;
  return total;
}
function fixedLoad(data, branchId, counted, measured, epochStart, moment) {
  if (measured !== void 0 && measured.shapeHash !== null) {
    const shape = data.requestShapes.find(
      (row) => row.hash === measured.shapeHash
    );
    if (shape !== void 0 && shape.systemBytes !== null) {
      return splitLoad(
        data,
        measured,
        shape,
        shape.systemBytes,
        branchId,
        epochStart,
        moment
      );
    }
  }
  const base = baseTokens(counted);
  return base === null ? null : { kind: "total", tokens: base };
}
var RESTORED_FILE_LIMIT = 5;
var COMPACTION_PAIR_MS = 1e4;
function recordedFiles(data, segment) {
  const gap = (at, other) => Math.abs(other.startedAt - at);
  const restored = [];
  for (const file of data.compactionFiles) {
    const mine = gap(file.at, segment);
    if (mine > COMPACTION_PAIR_MS) continue;
    const nearer = data.segments.some(
      (other) => other.kind === "compact" && other.id !== segment.id && gap(file.at, other) < mine
    );
    if (nearer) continue;
    restored.push({
      kind: "file",
      ref: file.id,
      name: file.name,
      reread: file.reread,
      tokens: file.reread ? estimatedTokens(file.sizeBytes) : null
    });
  }
  return restored;
}
function recentFileReads(before) {
  const files = [];
  const seenPaths = /* @__PURE__ */ new Set();
  for (let i = before.length - 1; i >= 0; i--) {
    if (files.length >= RESTORED_FILE_LIMIT) break;
    const item = before[i];
    if (item === void 0 || item.kind !== "file-read") continue;
    if (seenPaths.has(item.path)) continue;
    seenPaths.add(item.path);
    files.push({ kind: "file-read", ref: item.stepId, name: item.path });
  }
  return files;
}
function restoredItems(data, segment, before) {
  const recorded = recordedFiles(data, segment);
  const restored = recorded.length > 0 ? recorded : recentFileReads(before);
  const seenSkills = /* @__PURE__ */ new Set();
  for (const item of before) {
    if (item.kind !== "skill" || seenSkills.has(item.loadId)) continue;
    seenSkills.add(item.loadId);
    restored.push({ kind: "skill", ref: item.loadId, name: item.name });
  }
  return restored;
}
function previousEpochStart(data, segment) {
  let latest = null;
  for (const other of data.segments) {
    if (other.kind !== "compact" || other.id === segment.id) continue;
    const before = other.startedAt < segment.startedAt || other.startedAt === segment.startedAt && other.id < segment.id;
    if (!before) continue;
    if (latest === null || other.startedAt >= latest.startedAt) {
      latest = other;
    }
  }
  return latest === null ? data.session.firstSeenAt : latest.startedAt;
}
function compactionView(data, requests, segment) {
  const before = epochItems(
    data,
    null,
    requests,
    previousEpochStart(data, segment),
    segment.startedAt - 1
  );
  return {
    segmentId: segment.id,
    at: segment.startedAt,
    before,
    restored: restoredItems(data, segment, before),
    restoredNote: "restored by Claude Code (per its docs)"
  };
}
function epochSegment(data, epoch) {
  return epoch.afterCompactionSegmentId === null ? void 0 : data.segments.find((row) => row.id === epoch.afterCompactionSegmentId);
}
function fixedShare(fixed) {
  return fixed !== null && fixed.kind === "split" ? fixed.total : 0;
}
function withoutCountedInstructions(items, fixed) {
  if (fixed === null || fixed.kind !== "split") return items;
  return items.map(
    (item) => item.kind === "instructions" ? { ...item, tokens: null } : item
  );
}
function totalsFor(measured, items, fixed) {
  const measuredTokens = measured === null ? null : measured.tokens;
  const itemsTotal = items.reduce(
    (sum, item) => sum + (itemTokens(item) ?? 0),
    0
  );
  const named = itemsTotal + fixedShare(fixed);
  const remainder = measuredTokens === null ? null : measuredTokens - named;
  return {
    measured: measuredTokens,
    items: itemsTotal,
    named: measuredTokens === null ? named : Math.min(named, measuredTokens),
    other: remainder !== null && remainder > 0 ? remainder : null
  };
}
function scopeOf(data, branchId) {
  const branch = branchId === null ? void 0 : data.branchesById.get(branchId);
  return branchId === null ? { kind: "main" } : {
    kind: "branch",
    branchId,
    agentType: branch === void 0 ? null : branch.agentType
  };
}
function epochOf(data, branchId, moment) {
  if (branchId === null) return mainEpoch(data, moment);
  const startedAt = data.branchesById.get(branchId)?.startedAt;
  if (startedAt === null || startedAt === void 0) {
    return {
      startedAt: data.session.firstSeenAt,
      afterCompactionSegmentId: null
    };
  }
  let first = startedAt;
  for (const load of data.loads) {
    if (load.branchId === branchId && load.occurredAt < first) {
      first = load.occurredAt;
    }
  }
  return { startedAt: first, afterCompactionSegmentId: null };
}
function contextAt(data, anchor, pickMeasured) {
  const { branchId, moment } = anchor;
  const epoch = epochOf(data, branchId, moment);
  const requests = threadRequests(data, branchId);
  const counted = countedRequests(requests);
  const measuredRow = pickMeasured(counted);
  const measured = measuredRow === void 0 ? null : measuredSummary(data, measuredRow);
  const segment = epochSegment(data, epoch);
  const fixed = fixedLoad(
    data,
    branchId,
    counted,
    measuredRow,
    epoch.startedAt,
    moment
  );
  const items = withoutCountedInstructions(
    epochItems(data, branchId, requests, epoch.startedAt, moment),
    fixed
  );
  return {
    stepId: anchor.stepId,
    scope: scopeOf(data, branchId),
    measured,
    epoch,
    items,
    fixedLoad: fixed,
    compaction: segment === void 0 ? null : compactionView(data, requests, segment),
    totals: totalsFor(measured, items, fixed),
    states: {
      telemetry: data.session.sources.includes("telemetry"),
      tokensPartial: data.session.tokensPartial,
      joinedPartway: data.session.joinedPartway
    }
  };
}
function contextAtStep(data, stepId) {
  const step = data.stepsById.get(stepId);
  if (step === void 0) return null;
  const moment = step.endedAt ?? step.startedAt ?? data.session.lastSeenAt;
  return contextAt(
    data,
    { stepId: step.id, branchId: step.branchId, moment },
    (counted) => measuredRequest(counted, step, moment)
  );
}
function contextAtRequest(data, requestId) {
  const request = data.requests.find((row) => row.id === requestId);
  if (request?.startedAt == null) return null;
  const moment = request.startedAt - 1;
  return contextAt(
    data,
    { stepId: null, branchId: request.branchId, moment },
    (counted) => counted.find((row) => row.id === request.id)
  );
}
function sessionContext(storage, sessionId, ask) {
  const data = loadSessionData(storage, sessionId);
  if (data === void 0) return void 0;
  const found = "step" in ask ? contextAtStep(data, ask.step) : contextAtRequest(data, ask.request);
  return found ?? void 0;
}

// src/api/finding-wording.ts
var EXPIRED_DOC = {
  label: "Prompt caching: how long the cache lasts",
  url: "https://code.claude.com/docs/en/prompt-caching#cache-lifetime"
};
var MODEL_DOC = {
  label: "Prompt caching: switching models",
  url: "https://code.claude.com/docs/en/prompt-caching#switching-models"
};
var EFFORT_DOC = {
  label: "Prompt caching: changing the effort level",
  url: "https://code.claude.com/docs/en/prompt-caching#changing-effort-level"
};
var TOOLS_DOC = {
  label: "Prompt caching: connecting or removing an MCP server",
  url: "https://code.claude.com/docs/en/prompt-caching#connecting-or-removing-an-mcp-server"
};
var INSTRUCTIONS_DOC = {
  label: "Costs: move instructions from CLAUDE.md to skills",
  url: "https://code.claude.com/docs/en/costs#move-instructions-from-claude-md-to-skills"
};
var SKILLS_DOC = {
  label: "Skills: find unused skills",
  url: "https://code.claude.com/docs/en/skills#find-unused-skills"
};
var MAX_NAMED_SKILLS = 10;
function expiredWording(rebuild) {
  const written = formatTokens(rebuild.tokens);
  const gap = formatDuration(rebuild.gapMinutes * 6e4);
  return {
    headline: `Compact before a long break \xB7 ${written} written again after ${gap} away`,
    body: "The cache had expired, so the next message wrote the conversation again. You could run /compact before stepping away, or start a fresh session if you are not coming back to this work.",
    list: [],
    more: [],
    doc: EXPIRED_DOC,
    copy: null
  };
}
function modelWording(rebuild) {
  return {
    headline: `Pick your model at the start of a session \xB7 ${formatTokens(rebuild.tokens)} written again after the switch`,
    body: `Switching from ${rebuild.from} to ${rebuild.to} could not reuse the cache, so the conversation was written again. You could choose the model before the first message.`,
    list: [],
    more: [],
    doc: MODEL_DOC,
    copy: null
  };
}
function effortWording(rebuild) {
  return {
    headline: `Set effort at the start of a session \xB7 ${formatTokens(rebuild.tokens)} written again after the change`,
    body: `Changing effort from ${rebuild.from} to ${rebuild.to} on ${rebuild.model} started the cache over. You could pick it before the first message.`,
    list: [],
    more: [],
    doc: EFFORT_DOC,
    copy: null
  };
}
function toolsWording(rebuild) {
  const servers = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction"
  }).format(rebuild.servers);
  return {
    headline: `Add or remove tool servers at the start of a session \xB7 ${formatTokens(rebuild.tokens)} written again after ${servers} changed`,
    body: "Changing the tool list started the cache over. You could connect the servers you need before the first message.",
    list: [],
    more: [],
    doc: TOOLS_DOC,
    copy: null
  };
}
function listedFile({ path, tokens }) {
  return tokens === null ? `${path} \xB7 size not recorded` : `${path} \xB7 about ${formatTokens(tokens)}`;
}
function instructionsWording(startup) {
  const count = startup.files.length + startup.rest.length;
  const size = `${startup.estimated ? "about " : ""}${formatTokens(startup.tokens)}`;
  return {
    headline: `Trim the files Claude reads at the start of every session \xB7 ${size} across ${count} ${count === 1 ? "file" : "files"}`,
    body: "Always-loaded instruction files are sent with every request. You could move rarely needed parts into skills, which load only when used.",
    list: startup.files.map(listedFile),
    more: startup.rest.map(listedFile),
    doc: INSTRUCTIONS_DOC,
    copy: null
  };
}
function skillsWording(listing) {
  const { total, unused } = listing;
  const count = Array.isArray(unused) ? unused.length : unused.atLeast;
  const lead = Array.isArray(unused) ? `${count}` : `At least ${count}`;
  const subject = `${lead} of ${total} listed ${total === 1 ? "skill" : "skills"}`;
  const names = Array.isArray(unused) ? unused : [];
  return {
    headline: `Turn off skills you don't use \xB7 ${listing.estimated ? "about " : ""}${formatTokens(listing.tokens)} per request`,
    body: `${subject} ${count === 1 ? "was" : "were"} never used this session. You could turn off the ones you don't need; /skill-doctor shows each skill's cost and use.`,
    list: names.slice(0, MAX_NAMED_SKILLS),
    more: names.slice(MAX_NAMED_SKILLS),
    doc: SKILLS_DOC,
    copy: null
  };
}
var DENY_DOC = {
  label: "Permissions: read and edit rules",
  url: "https://code.claude.com/docs/en/permissions#read-and-edit"
};
var NAMES = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction"
});
function denyGapWording(gap) {
  const read = formatTokens(gap.tokens);
  const size = gap.basis === "estimated" ? `about ${read}` : read;
  return {
    headline: `Block reads of ${NAMES.format(gap.groups)} \xB7 ${size} read in this session`,
    body: "Claude read files here that are rarely worth the space. You could add a deny rule so it skips them. A Read deny also blocks edits and writes in those places.",
    list: gap.names,
    more: [],
    doc: DENY_DOC,
    copy: gap.rules.map((rule) => `"${rule}"`).join(",\n")
  };
}

// src/api/finding-deny-gaps.ts
var DENY_PATTERNS = {
  folders: /* @__PURE__ */ new Set([
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "__pycache__",
    "coverage"
  ]),
  lockfiles: /* @__PURE__ */ new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "poetry.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "Cargo.lock",
    "go.sum"
  ]),
  suffixes: [".min.js", ".min.css", ".map"]
};
var WORTH_A_LOOK = 5e3;
var WORTH_FIXING = 25e3;
function gapOf(relativePath) {
  const file = relativePath.at(-1) ?? "";
  const folder = relativePath.slice(0, -1).find((segment) => DENY_PATTERNS.folders.has(segment));
  if (folder !== void 0) {
    return { group: folder, name: folder, rule: `Read(**/${folder}/**)` };
  }
  if (DENY_PATTERNS.lockfiles.has(file)) {
    return { group: "lockfiles", name: file, rule: `Read(**/${file})` };
  }
  const suffix = DENY_PATTERNS.suffixes.find((ending) => file.endsWith(ending));
  if (suffix !== void 0) {
    return {
      group: "minified files and source maps",
      name: suffix,
      rule: `Read(**/*${suffix})`
    };
  }
  return null;
}
function pathBelow(project, filePath) {
  const root = project.replaceAll("\\", "/").replace(/\/+$/, "");
  const file = filePath.replaceAll("\\", "/");
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1).split("/") : null;
}
function readsInGaps(data, project) {
  const reads = [];
  for (const step of data.steps) {
    if (step.toolName !== "Read" || step.outcome === "failed") continue;
    const filePath = str(parseRecord(step.inputSummary), "file_path");
    const relativePath = filePath === void 0 ? null : pathBelow(project, filePath);
    const gap = relativePath === null ? null : gapOf(relativePath);
    if (gap !== null) reads.push({ step, gap });
  }
  return reads;
}
function isCovered(gap, rules) {
  return rules.some((rule) => {
    const text = rule.trim();
    return text === "Read" || text === "Read(*)" || text.includes(gap.name);
  });
}
function tokensRead(data, reads) {
  const measured = measuredStepSizes(data);
  const total = { tokens: 0, basis: "measured" };
  for (const { step } of reads) {
    const size = measured.get(step.id);
    if (size !== void 0) {
      total.tokens += size;
    } else {
      total.tokens += estimatedTokens(stepChars(step)) ?? 0;
      total.basis = "estimated";
    }
  }
  return total;
}
function gradeFor(tokens) {
  if (tokens >= WORTH_FIXING) return "Worth fixing";
  return tokens >= WORTH_A_LOOK ? "Worth a look" : null;
}
function unique(values) {
  return [...new Set(values)];
}
function denyGapFindings(data) {
  const project = data.session.projectPath;
  if (project === null) return [];
  const candidates = readsInGaps(data, project);
  if (candidates.length === 0) return [];
  const rules = readDenyRules(project, managedPaths(process.platform));
  if (rules === void 0) return [];
  const reads = candidates.filter(({ gap }) => !isCovered(gap, rules));
  const [first] = reads;
  if (first === void 0) return [];
  const measure = tokensRead(data, reads);
  const grade = gradeFor(measure.tokens);
  if (grade === null) return [];
  return [
    {
      id: "deny-gaps",
      kind: "deny-gap",
      grade,
      at: first.step.startedAt ?? data.session.firstSeenAt,
      requestId: null,
      turnId: null,
      measure,
      ...denyGapWording({
        ...measure,
        groups: unique(reads.map(({ gap }) => gap.group)),
        names: unique(reads.map(({ gap }) => gap.name)),
        rules: unique(reads.map(({ gap }) => gap.rule))
      })
    }
  ];
}

// src/api/finding-instructions.ts
var TRIM_FLOOR = 5e3;
var LISTED_FILES = 5;
function startupFiles(data, startedAt) {
  const byPath = /* @__PURE__ */ new Map();
  for (const { name, tokens } of epochInstructions(
    data,
    null,
    data.session.firstSeenAt,
    startedAt
  )) {
    if (byPath.get(name)?.tokens == null)
      byPath.set(name, { path: name, tokens });
  }
  return [...byPath.values()];
}
function reportedTotal(data, report, startedAt) {
  if (report?.memoryFiles == null) return null;
  const { reportedAt } = report;
  const loadedMeanwhile = data.loads.some(
    (load) => load.kind === "instructions" && load.branchId === null && load.occurredAt > startedAt && load.occurredAt <= reportedAt
  );
  return loadedMeanwhile ? null : report.memoryFiles;
}
function summedTotal(files) {
  let tokens = 0;
  for (const file of files) {
    if (file.tokens === null) return null;
    tokens += file.tokens;
  }
  return tokens;
}
function totalOf(data, files, startedAt, model) {
  const report = contextReportFor(data.contextReports, model);
  const reported = reportedTotal(data, report, startedAt);
  if (reported !== null) return { tokens: reported, basis: "from-context" };
  const summed = summedTotal(files);
  return summed === null ? null : { tokens: summed, basis: "estimated" };
}
function largestFirst(files) {
  return [...files].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}
function instructionFindings(data) {
  if (data.session.joinedPartway) return [];
  const first = firstMainRequest(data);
  if (first?.startedAt == null) return [];
  const files = startupFiles(data, first.startedAt);
  if (files.length === 0) return [];
  const total = totalOf(
    data,
    files,
    first.startedAt,
    first.model ?? data.session.model
  );
  if (total === null || total.tokens < TRIM_FLOOR) return [];
  const listed = largestFirst(files);
  return [
    {
      id: "instructions",
      kind: "instructions",
      grade: "Worth a look",
      at: first.startedAt,
      requestId: null,
      turnId: null,
      measure: total,
      ...instructionsWording({
        tokens: total.tokens,
        estimated: total.basis === "estimated",
        files: listed.slice(0, LISTED_FILES),
        rest: listed.slice(LISTED_FILES)
      })
    }
  ];
}

// src/api/finding-rebuilds.ts
var UNCACHED_BREAK = 1e5;
var EFFORT_SENSITIVE_MODEL = /^(?:claude-fable-5-2|claude-opus-5|claude-sonnet-5|claude-opus-4-8|claude-opus-4-7|claude-opus-4-6|claude-sonnet-4-6|claude-haiku-4-5)(?:-\d{8})?$/;
function isReportable(previous, current, cause) {
  const written = cacheWriteTokens(current) ?? 0;
  if (isRebuildWithCause(previous, current, cause) && written >= WRITE_FLOOR) {
    return true;
  }
  const uncached = (current.inputTokens ?? 0) + written;
  return (previous.cacheReadTokens ?? 0) > 0 && uncached >= UNCACHED_BREAK;
}
function mcpToolNames(data, request) {
  const shape = data.requestShapes.find(
    (row) => row.hash === request.shapeHash
  );
  if (shape === void 0) return void 0;
  const names = shape.tools.map((tool) => tool.name).filter((name) => mcpServerOf(name) !== null);
  return new Set(names);
}
function changedMcpServers(data, previous, current) {
  const before = mcpToolNames(data, previous);
  const after = mcpToolNames(data, current);
  if (before === void 0 || after === void 0) return [];
  const changed = [
    ...[...before].filter((name) => !after.has(name)),
    ...[...after].filter((name) => !before.has(name))
  ];
  const servers = changed.flatMap((name) => mcpServerOf(name) ?? []);
  return [...new Set(servers)].sort();
}
function namedRebuild(data, { previous, current, cause }, tokens) {
  switch (cause?.kind) {
    case "expired":
      return {
        kind: "expired",
        ...expiredWording({ tokens, gapMinutes: cause.gapMinutes })
      };
    case "model":
      return {
        kind: "model",
        ...modelWording({ tokens, from: cause.from, to: cause.to })
      };
    case "effort": {
      const model = current.model;
      if (model === null || !EFFORT_SENSITIVE_MODEL.test(model)) return null;
      const { from, to } = cause;
      return { kind: "effort", ...effortWording({ tokens, from, to, model }) };
    }
    case "tools": {
      const servers = changedMcpServers(data, previous, current);
      if (servers.length === 0) return null;
      return { kind: "tools", ...toolsWording({ tokens, servers }) };
    }
    // A compaction explains itself, and an unknown cause is never guessed.
    default:
      return null;
  }
}
function gradeOf(kind, expiredBefore) {
  return kind === "expired" && expiredBefore > 0 ? "Worth fixing" : "Worth a look";
}
function rebuildFindings(data) {
  const findings = [];
  let expiredBefore = 0;
  for (const pair of rebuildPairs(data, isReportable)) {
    const tokens = cacheWriteTokens(pair.current) ?? 0;
    const named = namedRebuild(data, pair, tokens);
    if (named === null) continue;
    findings.push({
      id: `rebuild-${pair.current.id}`,
      grade: gradeOf(named.kind, expiredBefore),
      at: pair.at,
      requestId: pair.current.id,
      turnId: pair.current.turnId,
      measure: { tokens, basis: "measured" },
      ...named
    });
    if (named.kind === "expired") expiredBefore += 1;
  }
  return findings;
}

// src/api/finding-skills.ts
var MIN_TURNS = 10;
var WITHHELD_NAME = "custom_skill";
function firstListing(data) {
  const load = data.loads.find((row) => row.kind === "skill-listing");
  if (load === void 0 || load.names === null) return void 0;
  return { ...load, names: load.names };
}
function isSettled(data) {
  if (data.session.status !== "live") return true;
  return data.turns.filter((turn) => !turn.flightpathCommand).length >= MIN_TURNS;
}
function usedSkillNames(loads) {
  const used = /* @__PURE__ */ new Set();
  for (const load of loads) {
    if (load.kind !== "skill" || load.name === null) continue;
    if (load.name === WITHHELD_NAME) return null;
    if (load.trigger === "agent" || load.trigger === "user_slash") {
      used.add(load.name);
    }
  }
  return used;
}
function unusedSkills(listed, used) {
  if ([...used].some((name) => !listed.includes(name))) {
    const atLeast = listed.length - used.size;
    return atLeast > 0 ? { atLeast } : null;
  }
  const unused = listed.filter((name) => !used.has(name)).sort((a, b) => a.localeCompare(b, "en"));
  return unused.length > 0 ? unused : null;
}
function listingTokens(data, listing) {
  const report = contextReportFor(data.contextReports, latestMainModel(data));
  if (report !== null && report.skills !== null) {
    return { tokens: report.skills, estimated: false };
  }
  const tokens = estimatedTokens(listing.sizeBytes);
  return tokens === null ? null : { tokens, estimated: true };
}
function skillFindings(data) {
  const listing = firstListing(data);
  if (listing === void 0 || data.session.joinedPartway) return [];
  if (!isSettled(data)) return [];
  const used = usedSkillNames(data.loads);
  if (used === null) return [];
  const unused = unusedSkills(listing.names, used);
  const size = listingTokens(data, listing);
  if (unused === null || size === null) return [];
  return [
    {
      id: "skills-unused",
      kind: "skills-unused",
      grade: "Did you know",
      at: listing.occurredAt,
      requestId: null,
      turnId: null,
      measure: {
        tokens: size.tokens,
        basis: size.estimated ? "estimated" : "from-context"
      },
      ...skillsWording({
        ...size,
        total: listing.names.length,
        unused
      })
    }
  ];
}

// src/api/terminal-line.ts
var LINE_GRADES = ["Worth fixing", "Worth a look"];
function countsPhrase(total, worthFixing) {
  if (total === 1) {
    const worth2 = worthFixing === 1 ? "fixing" : "a look";
    return `1 suggestion worth ${worth2} from this turn`;
  }
  const worth = worthFixing === 0 ? "all worth a look" : `${worthFixing} worth fixing`;
  return `${total} suggestions from this turn, ${worth}`;
}
function terminalLine(findings, turnId) {
  const counted = findings.filter(
    (finding) => finding.turnId === turnId && LINE_GRADES.includes(finding.grade)
  );
  if (counted.length === 0) return null;
  const worthFixing = counted.filter(
    (finding) => finding.grade === "Worth fixing"
  ).length;
  const pointer = counted.length === 1 ? "it" : "them";
  return `\u25CF flightpath has ${countsPhrase(counted.length, worthFixing)} \xB7 /flightpath:open to see ${pointer}`;
}

// src/api/findings.ts
var GRADE_RANK = {
  "Worth fixing": 0,
  "Worth a look": 1,
  "Did you know": 2
};
function detectFindings(data) {
  return [
    ...rebuildFindings(data),
    ...instructionFindings(data),
    ...skillFindings(data),
    ...denyGapFindings(data)
  ];
}
function byWorth(a, b) {
  return GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || b.measure.tokens - a.measure.tokens || a.at - b.at;
}
function sessionFindings(storage, sessionId) {
  const data = loadSessionData(storage, sessionId);
  if (data === void 0) return void 0;
  const dismissed = new Set(storage.listDismissals(sessionId));
  return detectFindings(data).filter((finding) => !dismissed.has(finding.id)).sort(byWorth);
}
function sessionTerminalLine(storage, sessionId, promptId) {
  const findings = sessionFindings(storage, sessionId);
  if (findings === void 0) return void 0;
  const turnId = storage.turnIdForPrompt(sessionId, promptId);
  return { line: turnId === void 0 ? null : terminalLine(findings, turnId) };
}
function dismissFinding(storage, sessionId, findingId) {
  const data = loadSessionData(storage, sessionId);
  if (data === void 0) return false;
  if (!detectFindings(data).some((finding) => finding.id === findingId)) {
    return false;
  }
  storage.dismissFinding(sessionId, findingId);
  return true;
}

// src/daemon/routes/read-api.ts
function sendNotFound(response) {
  response.writeHead(404).end();
}
function sendFound(response, payload) {
  if (payload === void 0) sendNotFound(response);
  else sendJson(response, 200, payload);
}
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
function askFor(kind, raw) {
  const id = raw === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(id)) return null;
  return kind === "step" ? { step: id } : { request: id };
}
function contextAsk(params) {
  const step = params.get("step");
  const request = params.get("request");
  if (step !== null && request === null) return askFor("step", step);
  if (request !== null && step === null) return askFor("request", request);
  return null;
}
function getSessions(ctx, request, response) {
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const payload = listSessions(
    ctx.storage,
    ctx.settings,
    url.searchParams.get("q")
  );
  sendJson(response, 200, payload);
}
function getSession(ctx, request, response, path) {
  const rest = path.slice("/api/sessions/".length);
  const slash = rest.lastIndexOf("/");
  const segment = slash === -1 ? "" : rest.slice(0, slash);
  const leaf = slash === -1 ? "" : rest.slice(slash + 1);
  const sessionId = segment !== "" && !segment.includes("/") ? decodeSegment(segment) : null;
  if (sessionId === null || leaf !== "snapshot" && leaf !== "tokens" && leaf !== "context" && leaf !== "findings" && leaf !== "terminal-line") {
    sendNotFound(response);
    return;
  }
  if (leaf === "snapshot") {
    sendFound(response, sessionSnapshot(ctx.storage, ctx.settings, sessionId));
    return;
  }
  const { searchParams } = new URL(request.url ?? "", "http://127.0.0.1");
  if (leaf === "context") {
    const ask = contextAsk(searchParams);
    if (ask === null) {
      response.writeHead(400).end();
      return;
    }
    sendFound(response, sessionContext(ctx.storage, sessionId, ask));
    return;
  }
  if (leaf === "findings") {
    sendFound(response, sessionFindings(ctx.storage, sessionId));
    return;
  }
  if (leaf === "terminal-line") {
    const promptId = searchParams.get("prompt") ?? "";
    sendFound(response, sessionTerminalLine(ctx.storage, sessionId, promptId));
    return;
  }
  const history = sessionTokens(ctx.storage, sessionId, {
    autoCompactWindow: readAutoCompactWindow(resolveClaudeConfigDir()),
    storePromptText: ctx.settings.storePromptText
  });
  sendFound(response, history);
}
var DISMISS_PATH = /^\/api\/sessions\/([^/]+)\/findings\/([^/]+)\/dismiss$/;
function dismissTarget(path) {
  const match = DISMISS_PATH.exec(path);
  if (match === null) return null;
  const sessionId = decodeSegment(match[1] ?? "");
  const findingId = decodeSegment(match[2] ?? "");
  return sessionId === null || findingId === null ? null : { sessionId, findingId };
}
function postDismissFinding(ctx, _request, response, path) {
  const target = dismissTarget(path);
  if (target === null || !dismissFinding(ctx.storage, target.sessionId, target.findingId)) {
    sendNotFound(response);
    return;
  }
  response.writeHead(200).end();
}
function getStep(ctx, _request, response, path) {
  const segment = path.slice("/api/steps/".length);
  const stepId = Number(segment);
  const detail = segment !== "" && !segment.includes("/") && Number.isInteger(stepId) && stepId > 0 ? stepDetail(ctx.storage, stepId) : void 0;
  if (detail === void 0) {
    sendNotFound(response);
    return;
  }
  sendJson(response, 200, detail);
}
function getStorageSummary(ctx, _request, response) {
  sendJson(response, 200, storageSummary(ctx.storage));
}

// src/daemon/routes/settings.ts
function settingsPayload(ctx) {
  const days = SETTING_SPECS.find((spec) => spec.name === "retentionDays")?.values ?? [ctx.settings.retentionDays];
  const purgeCounts = {};
  const staleCutoff = staleBefore(Date.now());
  for (const value of days) {
    purgeCounts[String(value)] = ctx.storage.countSessionsOlderThan(
      Date.now() - value * 24 * 60 * 60 * 1e3,
      staleCutoff
    );
  }
  return {
    settings: ctx.settings,
    boundPort: ctx.boundPort,
    fields: SETTING_SPECS,
    dataDir: ctx.dataDir,
    liveSessions: ctx.storage.liveSessions().map((row) => ({
      id: row.id,
      title: sessionTitle(row.firstPromptText, ctx.settings)
    })),
    retention: {
      databaseBytes: ctx.storage.databaseBytes(),
      sessionCount: ctx.storage.countSessions(),
      purgeCounts
    }
  };
}
function getSettings(ctx, _request, response) {
  sendJson(response, 200, settingsPayload(ctx));
}
function deleteAllData(ctx, _request, response) {
  void ctx.retention.deleteAllData().then((deleted) => {
    daemonLog(ctx.dataDir, `delete-all removed ${deleted} session(s)`);
    ctx.stream.noteAllSessions();
    sendJson(response, 200, { ok: true, deletedSessions: deleted });
  }).catch((error) => {
    daemonLog(ctx.dataDir, `delete-all failed (${errorMessage(error)})`);
    response.writeHead(500).end();
  });
}
function syncEndpointForPortChange(ctx) {
  try {
    if (syncTelemetryEndpoint({
      paths: setupPaths({
        dataDir: ctx.dataDir,
        configDir: resolveClaudeConfigDir()
      }),
      port: ctx.settings.port,
      token: ctx.token
    })) {
      daemonLog(ctx.dataDir, "telemetry endpoint moved to the new port");
    }
  } catch (error) {
    daemonLog(
      ctx.dataDir,
      `telemetry endpoint could not be updated (${errorMessage(error)})`
    );
  }
}
function updateSettings(ctx, values, response) {
  const previousPort = ctx.settings.port;
  try {
    ctx.applySettings(values);
  } catch (error) {
    daemonLog(
      ctx.dataDir,
      `settings could not be saved (${errorMessage(error)})`
    );
    response.writeHead(500).end();
    return;
  }
  daemonLog(ctx.dataDir, "settings saved");
  if (ctx.settings.port !== previousPort) {
    syncEndpointForPortChange(ctx);
  }
  sendJson(response, 200, settingsPayload(ctx));
  if (ctx.settings.port !== previousPort) {
    response.once("finish", () => void ctx.restart());
  }
}
function putSettings(ctx, request, response) {
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => sendJson(res, 400, { errors: { settings: "must be JSON" } }),
    (parsed) => {
      const result = validateSettingsInput(parsed);
      if (!result.ok) {
        sendJson(response, 400, { errors: result.errors });
        return;
      }
      updateSettings(ctx, result.values, response);
    }
  );
}
function setupOptions(ctx) {
  return {
    paths: setupPaths({
      dataDir: ctx.dataDir,
      configDir: resolveClaudeConfigDir()
    }),
    env: process.env,
    port: ctx.settings.port,
    token: ctx.token
  };
}
function setupStatusPayload(ctx) {
  const state = detectTelemetrySetup(setupOptions(ctx));
  return {
    ...state,
    boundPort: ctx.boundPort,
    configuredPort: ctx.settings.port
  };
}
function getTelemetrySetup(ctx, _request, response) {
  sendJson(response, 200, setupStatusPayload(ctx));
}
function mirrorSetupState(ctx, action) {
  try {
    ctx.applySettings({ telemetry: action === "on" });
  } catch (error) {
    daemonLog(
      ctx.dataDir,
      `settings mirror could not be saved (${errorMessage(error)})`
    );
  }
  daemonLog(ctx.dataDir, `telemetry setup ${action}`);
}
function postTelemetrySetup(ctx, request, response) {
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => sendJson(res, 400, { ok: false, message: "action must be on or off" }),
    (parsed) => {
      const action = isPlainObject(parsed) ? parsed.action : void 0;
      if (action !== "on" && action !== "off") {
        sendJson(response, 400, {
          ok: false,
          message: "action must be on or off"
        });
        return;
      }
      const outcome = action === "on" ? applyTelemetrySetup(setupOptions(ctx)) : undoTelemetrySetup({ paths: setupOptions(ctx).paths });
      if (outcome.ok) {
        mirrorSetupState(ctx, action);
      }
      sendJson(response, outcome.ok ? 200 : 400, {
        ok: outcome.ok,
        message: outcome.message,
        status: setupStatusPayload(ctx)
      });
    }
  );
}

// src/daemon/routes/stop.ts
function postStop(ctx, _request, response) {
  response.writeHead(204).end(() => void ctx.stop());
}

// src/daemon/routes/stream.ts
function getStream(ctx, request, response) {
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const sessionId = url.searchParams.get("session");
  const lastEventId = request.headers["last-event-id"];
  ctx.stream.serve(
    response,
    sessionId === null || sessionId === "" ? null : sessionId,
    typeof lastEventId === "string" ? lastEventId : null
  );
}

// src/daemon/routes/telemetry.ts
function postLogs(ctx, request, response) {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("protobuf")) {
    daemonLog(
      ctx.dataDir,
      "telemetry export refused: protobuf encoding is not supported; use OTLP/HTTP JSON"
    );
    response.writeHead(415).end();
    return;
  }
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => res.writeHead(400).end(),
    (parsed) => {
      const processed = ctx.telemetry.processExport(ctx.storage, parsed, {
        settings: ctx.settings,
        receivedAt: Date.now()
      });
      if (processed.accepted > 0) {
        ctx.touch();
        ctx.stream.noteAllSessions();
      }
      if (processed.dropped > 0 || processed.unknown > 0) {
        daemonLog(
          ctx.dataDir,
          `telemetry export: ${processed.accepted} accepted, ${processed.dropped} dropped, ${processed.unknown} unknown`
        );
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
  );
}

// src/daemon/routes/router.ts
var PUBLIC_ROUTES = [
  { method: "GET", path: "/", handle: serveViewPage },
  { method: "GET", path: "/view", handle: serveViewPage },
  { method: "GET", prefix: "/view/", handle: serveViewAsset },
  { method: "GET", path: "/settings", handle: serveSettingsRedirect }
];
var PROTECTED_ROUTES = [
  { method: "GET", path: "/api/settings", handle: getSettings },
  { method: "POST", path: "/api/delete-all-data", handle: deleteAllData },
  { method: "POST", path: "/api/stop", handle: postStop },
  { method: "PUT", path: "/api/settings", handle: putSettings },
  { method: "GET", path: "/api/telemetry-setup", handle: getTelemetrySetup },
  { method: "POST", path: "/api/telemetry-setup", handle: postTelemetrySetup },
  { method: "GET", path: "/api/sessions", handle: getSessions },
  { method: "GET", prefix: "/api/sessions/", handle: getSession },
  { method: "POST", prefix: "/api/sessions/", handle: postDismissFinding },
  { method: "GET", prefix: "/api/steps/", handle: getStep },
  { method: "GET", path: "/api/storage", handle: getStorageSummary },
  { method: "GET", path: "/api/stream", handle: getStream },
  { method: "GET", path: "/api/health", handle: getApiHealth },
  { method: "POST", path: "/v1/logs", handle: postLogs },
  // Health and the hook endpoint match the full URL: a query
  // string makes them a different address, as it always did.
  { method: "GET", url: "/health", handle: getHealth },
  { method: "POST", url: "/events/hook", handle: postHookEvent }
];
function routeMatches(route, request, path) {
  if (route.method !== request.method) return false;
  if (route.url !== void 0) return request.url === route.url;
  if (route.prefix !== void 0) return path.startsWith(route.prefix);
  return path === route.path;
}
function handleRequest(ctx, request, response) {
  if (!hostIsLoopback(request.headers.host)) {
    daemonLog(ctx.dataDir, `rejected ${request.method} ${request.url} 403`);
    response.writeHead(403).end();
    return;
  }
  const path = (request.url ?? "").split("?")[0] ?? "";
  if (path === "/" || path === "/view" || path === "/settings" || path.startsWith("/api/")) {
    response.setHeader("cache-control", "no-store");
  }
  for (const route of PUBLIC_ROUTES) {
    if (routeMatches(route, request, path)) {
      guardRequest(
        ctx,
        request,
        response,
        () => route.handle(ctx, request, response, path)
      );
      return;
    }
  }
  if (request.headers["x-flightpath-token"] !== ctx.token) {
    daemonLog(ctx.dataDir, `rejected ${request.method} ${request.url} 401`);
    response.writeHead(401).end();
    return;
  }
  for (const route of PROTECTED_ROUTES) {
    if (routeMatches(route, request, path)) {
      guardRequest(
        ctx,
        request,
        response,
        () => route.handle(ctx, request, response, path)
      );
      return;
    }
  }
  response.writeHead(404).end();
}

// src/daemon/stream.ts
import { randomBytes } from "node:crypto";

// src/daemon/stream-shaping.ts
function sorted(ids) {
  return [...ids].sort((a, b) => a - b);
}
function shapeSessionChanges(hub, capture, data, plan, emit) {
  const sessionId = data.session.id;
  const slice = turnSummariesFor(data, hub.settings(), plan.turnIds);
  emitTurns(capture, slice.turns, sessionId, emit);
  emitSteps(capture, data, slice.turns, plan, emit);
  emitHumans(capture, data, slice.turns, plan, emit);
  emitBranches(capture, data, plan, emit);
  emitSegmentsAndPauses(capture, data, plan, emit);
  emitSamples(data, plan, emit);
  emitSummary(hub, capture, data, slice, emit);
}
function emitTurns(capture, turns, sessionId, emit) {
  for (const turn of turns) {
    const head = {
      id: turn.id,
      sequence: turn.sequence,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      failures: turn.failures,
      steppedIn: turn.steppedIn,
      images: turn.images,
      files: turn.files
    };
    const json = JSON.stringify(head);
    if (capture.turnJson.get(turn.id) === json) continue;
    capture.turnJson.set(turn.id, json);
    emit.session({ event: "turn", data: { sessionId, turn: head } });
  }
}
function emitSteps(capture, data, turns, plan, emit) {
  const sessionId = data.session.id;
  const described = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    for (const step of turn.steps) {
      described.set(step.id, step);
    }
  }
  for (const id of sorted(plan.stepIds)) {
    let summary = described.get(id);
    if (summary === void 0) {
      const row = data.stepsById.get(id);
      if (row === void 0) continue;
      const turnId = plan.stepTurnIds.get(id);
      summary = stepSummaryOf(
        row,
        turnId === void 0 ? void 0 : data.turnsById.get(turnId),
        data
      );
    }
    const json = JSON.stringify(summary);
    if (capture.stepJson.get(id) === json) continue;
    capture.stepJson.set(id, json);
    emit.session({
      event: "step",
      data: {
        sessionId,
        turnId: plan.stepTurnIds.get(id) ?? null,
        step: summary
      }
    });
  }
  for (const id of capture.stepJson.keys()) {
    if (!capture.openSteps.has(id) && !capture.watchSteps.has(id)) {
      capture.stepJson.delete(id);
    }
  }
}
function emitHumans(capture, data, turns, plan, emit) {
  const sessionId = data.session.id;
  const described = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    for (const moment of turn.humanMoments) {
      described.set(moment.id, { moment, turnId: turn.id });
    }
  }
  for (const id of sorted(plan.humanIds)) {
    const entry = described.get(id);
    if (entry === void 0) continue;
    const json = JSON.stringify(entry.moment);
    if (capture.humanJson.get(id) === json) continue;
    capture.humanJson.set(id, json);
    emit.session({
      event: "human",
      data: { sessionId, turnId: entry.turnId, human: entry.moment }
    });
  }
  for (const id of capture.humanJson.keys()) {
    if (plan.humanTurnIds.get(id) !== capture.openTurnId) {
      capture.humanJson.delete(id);
    }
  }
}
function emitBranches(capture, data, plan, emit) {
  const sessionId = data.session.id;
  for (const id of sorted(plan.branchIds)) {
    const row = data.branchesById.get(id);
    if (row === void 0) continue;
    const summary = branchSummaryOf(data, row);
    const json = JSON.stringify(summary);
    if (capture.branchJson.get(id) === json) continue;
    capture.branchJson.set(id, json);
    emit.session({ event: "branch", data: { sessionId, branch: summary } });
  }
}
function emitSegmentsAndPauses(capture, data, plan, emit) {
  const sessionId = data.session.id;
  const segmentsById = new Map(data.segments.map((s) => [s.id, s]));
  for (const id of sorted(plan.segmentIds)) {
    const row = segmentsById.get(id);
    if (row === void 0) continue;
    const event = segmentEventOf(data, row);
    emit.session({ event: "segment", data: { sessionId, event } });
  }
  const pausesById = new Map(data.pauses.map((p) => [p.id, p]));
  for (const id of sorted(plan.pauseIds)) {
    const row = pausesById.get(id);
    if (row === void 0) continue;
    const event = pauseEventOf(row);
    const json = JSON.stringify(event);
    if (capture.pauseJson.get(id) === json) continue;
    capture.pauseJson.set(id, json);
    emit.session({ event: "segment", data: { sessionId, event } });
  }
}
function emitSamples(data, plan, emit) {
  if (plan.sampleIds.size === 0) return;
  const sessionId = data.session.id;
  const mainSamples = data.samplesByBranch.get(null) ?? [];
  const samplesById = new Map(mainSamples.map((s) => [s.id, s]));
  for (const id of sorted(plan.sampleIds)) {
    const row = samplesById.get(id);
    if (row === void 0) continue;
    const point = {
      id: row.id,
      at: row.sampledAt,
      contextTokens: row.contextTokens
    };
    emit.session({ event: "context", data: { sessionId, point } });
  }
}
function emitSummary(hub, capture, data, totals, emit) {
  const sessionId = data.session.id;
  const settings = hub.settings();
  const summary = snapshotSummary(data, hub.storage, settings, totals);
  const summaryJson = JSON.stringify(summary);
  if (summaryJson !== capture.summaryJson) {
    capture.summaryJson = summaryJson;
    emit.session({ event: "session", data: { sessionId, summary } });
  }
  const pickerState = hub.picker.get(sessionId);
  if (pickerState !== void 0) {
    const change = pickerRowChange(
      pickerState,
      data.session,
      settings,
      hub.storage
    );
    if (change !== void 0) {
      emit.picker({ event: "session", data: change });
    }
  }
}

// src/daemon/stream-capture.ts
function newCapture() {
  return {
    marks: {
      turnMax: 0,
      stepMax: 0,
      humanMax: 0,
      branchMax: 0,
      segmentMax: 0,
      pauseMax: 0,
      sampleMax: 0,
      loadMax: 0,
      attachmentMax: 0
    },
    sessionRowJson: "",
    stepJson: /* @__PURE__ */ new Map(),
    humanJson: /* @__PURE__ */ new Map(),
    branchJson: /* @__PURE__ */ new Map(),
    pauseJson: /* @__PURE__ */ new Map(),
    turnJson: /* @__PURE__ */ new Map(),
    summaryJson: null,
    openSteps: /* @__PURE__ */ new Set(),
    watchSteps: /* @__PURE__ */ new Set(),
    openBranches: /* @__PURE__ */ new Set(),
    openPauses: /* @__PURE__ */ new Set(),
    openTurns: /* @__PURE__ */ new Set(),
    openTurnId: null,
    data: null,
    requestMax: 0,
    changeSeq: 0,
    baseline: true,
    resync: false
  };
}
function captureSession(hub, sessionId, mode) {
  const capture = hub.captures.get(sessionId);
  if (capture === void 0) return;
  const sessionRow = hub.storage.sessionRow(sessionId);
  if (sessionRow === void 0) {
    noteSessionGone(hub, capture, sessionId);
    return;
  }
  const probe = hub.storage.streamProbe(sessionId);
  if (capture.data === null || capture.resync) {
    fullCapture(hub, capture, sessionRow, probe, mode);
    return;
  }
  deltaCapture(hub, capture, sessionRow, probe, mode);
}
function noteSessionGone(hub, capture, sessionId) {
  if (capture.baseline) return;
  hub.captures.delete(sessionId);
  hub.picker.delete(sessionId);
  const tombstone = {
    event: "session",
    data: { sessionId, deleted: true }
  };
  appendEntry(hub, "session", sessionId, tombstone);
  appendEntry(hub, "picker", sessionId, tombstone);
}
function emitFor(hub, capture, sessionId, mode) {
  if (capture.baseline && mode === "record") {
    return { session: () => void 0, picker: () => void 0 };
  }
  return {
    session: (message) => appendEntry(hub, "session", sessionId, message),
    picker: (message) => appendEntry(hub, "picker", sessionId, message)
  };
}
function fullCapture(hub, capture, sessionRow, probe, mode) {
  const data = loadSessionData(hub.storage, sessionRow.id);
  if (data === void 0) return;
  capture.data = data;
  capture.changeSeq = hub.storage.changeMaxSeq(sessionRow.id);
  hub.storage.clearSessionChanges(sessionRow.id);
  refreshOpenSets(capture, data);
  shapeSessionChanges(
    hub,
    capture,
    data,
    fullPlan(data),
    emitFor(hub, capture, sessionRow.id, mode)
  );
  finishPass(capture, probe, sessionRow);
}
function deltaCapture(hub, capture, sessionRow, probe, mode) {
  const held = capture.data;
  if (held === null) return;
  const delta = {};
  const moved = gatherFreshRows(hub, capture, sessionRow.id, probe, delta);
  const rowMoved = JSON.stringify(sessionRow) !== capture.sessionRowJson;
  if (rowMoved) {
    delta.session = sessionRow;
  }
  if (!moved && !rowMoved) return;
  const data = mergeSessionData(held, delta);
  capture.data = data;
  refreshOpenSets(capture, data);
  shapeSessionChanges(
    hub,
    capture,
    data,
    planFromDelta(data, delta, capture),
    emitFor(hub, capture, sessionRow.id, mode)
  );
  finishPass(capture, probe, sessionRow);
}
function gatherFreshRows(hub, capture, sessionId, probe, delta) {
  const storage = hub.storage;
  const marks = capture.marks;
  let moved = false;
  const take = (key, rows) => {
    if (rows !== void 0 && rows.length > 0) {
      delta[key] = rows;
      moved = true;
    }
  };
  if (probe.turnMax > marks.turnMax) {
    take("turns", storage.turnRowsSince(sessionId, marks.turnMax));
  }
  if (probe.stepMax > marks.stepMax) {
    take("steps", storage.stepRowsSince(sessionId, marks.stepMax));
  }
  if (probe.humanMax > marks.humanMax) {
    take("humans", storage.humanRowsSince(sessionId, marks.humanMax));
  }
  if (probe.branchMax > marks.branchMax) {
    take("branches", storage.branchRowsSince(sessionId, marks.branchMax));
  }
  if (probe.segmentMax > marks.segmentMax) {
    take("segments", storage.segmentRowsSince(sessionId, marks.segmentMax));
  }
  if (probe.pauseMax > marks.pauseMax) {
    take("pauses", storage.pauseRowsSince(sessionId, marks.pauseMax));
  }
  if (probe.sampleMax > marks.sampleMax) {
    take("samples", storage.sampleRowsSince(sessionId, marks.sampleMax));
  }
  if (probe.loadMax > marks.loadMax) {
    take("loads", storage.loadRowsSince(sessionId, marks.loadMax));
  }
  if (probe.attachmentMax > marks.attachmentMax) {
    take(
      "promptAttachments",
      storage.attachmentRowsSince(sessionId, marks.attachmentMax)
    );
  }
  take("requests", storage.requestRowsSince(sessionId, capture.requestMax));
  moved = gatherOpenRows(hub, capture, delta) || moved;
  moved = gatherBranchRequests(hub, capture, delta) || moved;
  moved = gatherChangedRows(hub, capture, delta) || moved;
  moved = gatherReports(hub, capture, delta) || moved;
  return moved;
}
function gatherReports(hub, capture, delta) {
  const held = capture.data;
  if (held === null) return false;
  const reports = hub.storage.contextReportsFor(held.session.id);
  if (JSON.stringify(reports) === JSON.stringify(held.contextReports)) {
    return false;
  }
  delta.contextReports = reports;
  return true;
}
function gatherChangedRows(hub, capture, delta) {
  const held = capture.data;
  if (held === null) return false;
  const storage = hub.storage;
  const changes = storage.changedRowsSince(held.session.id, capture.changeSeq);
  if (changes.length === 0) return false;
  let moved = false;
  const attachmentTurns = /* @__PURE__ */ new Set();
  let shapesMoved = false;
  let compactionFilesMoved = false;
  for (const change of changes) {
    if (change.tableName === "prompt_attachments") {
      attachmentTurns.add(change.rowId);
    } else if (change.tableName === "session_shapes") {
      shapesMoved = true;
    } else if (change.tableName === "compaction_files") {
      compactionFilesMoved = true;
    } else {
      moved = gatherChangedRow(hub, capture, delta, change) || moved;
    }
  }
  for (const turnId of attachmentTurns) {
    moved = gatherChangedAttachments(hub, capture, delta, turnId) || moved;
  }
  if (shapesMoved || requestsNameUnheldShape(held, delta)) {
    const shapes = storage.requestShapeRows(held.session.id);
    if (JSON.stringify(shapes) !== JSON.stringify(held.requestShapes)) {
      delta.requestShapes = shapes;
      moved = true;
    }
  }
  if (compactionFilesMoved) {
    const files = storage.compactionFileRows(held.session.id);
    if (JSON.stringify(files) !== JSON.stringify(held.compactionFiles)) {
      delta.compactionFiles = files;
      moved = true;
    }
  }
  const last = changes[changes.length - 1];
  if (last !== void 0) {
    capture.changeSeq = last.seq;
    storage.clearChangedRows(held.session.id, last.seq);
  }
  return moved;
}
function gatherChangedRow(hub, capture, delta, change) {
  const held = capture.data;
  if (held === null) return false;
  const storage = hub.storage;
  if (change.tableName === "requests") {
    const row = movedRow(storage.requestRowById(change.rowId), held.requests);
    if (row === void 0) return false;
    (delta.requests ??= []).push(row);
    return true;
  }
  if (change.tableName === "turns") {
    const row = movedRow(storage.turnRowById(change.rowId), held.turns);
    if (row === void 0) return false;
    (delta.turns ??= []).push(row);
    return true;
  }
  if (change.tableName === "branches") {
    const row = movedRow(storage.branchRowById(change.rowId), held.branches);
    if (row === void 0) return false;
    (delta.branches ??= []).push(row);
    return true;
  }
  if (change.tableName === "steps") {
    const read = storage.stepRowById(change.rowId);
    if (read === void 0) return false;
    const row = movedRow(stepRowOf(read), held.steps);
    if (row === void 0) return false;
    (delta.steps ??= []).push(row);
    return true;
  }
  if (change.tableName === "loads") {
    const row = movedRow(storage.loadRowById(change.rowId), held.loads);
    if (row === void 0) return false;
    (delta.loads ??= []).push(row);
    return true;
  }
  return false;
}
function movedRow(row, heldRows) {
  if (row === void 0) return void 0;
  const before = heldRows.find((held) => held.id === row.id);
  if (before === void 0) return void 0;
  return JSON.stringify(row) === JSON.stringify(before) ? void 0 : row;
}
function gatherChangedAttachments(hub, capture, delta, turnId) {
  const held = capture.data;
  if (held === null) return false;
  const rows = hub.storage.promptAttachmentsForTurn(held.session.id, turnId);
  const before = held.promptAttachments.filter((row) => row.turnId === turnId);
  if (JSON.stringify(rows) === JSON.stringify(before)) return false;
  (delta.replacedAttachmentTurns ??= []).push(turnId);
  if (rows.length > 0) {
    (delta.promptAttachments ??= []).push(...rows);
  }
  return true;
}
function requestsNameUnheldShape(held, delta) {
  const heldHashes = new Set(held.requestShapes.map((shape) => shape.hash));
  return (delta.requests ?? []).some(
    (request) => request.shapeHash !== null && !heldHashes.has(request.shapeHash)
  );
}
function gatherOpenRows(hub, capture, delta) {
  const held = capture.data;
  if (held === null) return false;
  const storage = hub.storage;
  let moved = false;
  for (const id of capture.openTurns) {
    const row = storage.turnRowById(id);
    const before = held.turnsById.get(id);
    if (row === void 0 || before === void 0) continue;
    if (JSON.stringify(row) === JSON.stringify(before)) continue;
    (delta.turns ??= []).push(row);
    moved = true;
  }
  moved = gatherOpenSteps(hub, capture, delta) || moved;
  for (const id of capture.openBranches) {
    const row = storage.branchRowById(id);
    const before = held.branchesById.get(id);
    if (row === void 0 || before === void 0) continue;
    if (JSON.stringify(row) === JSON.stringify(before)) continue;
    (delta.branches ??= []).push(row);
    moved = true;
  }
  for (const id of capture.openPauses) {
    const row = storage.pauseRowById(id);
    if (row === void 0) continue;
    const before = held.pauses.find((pause) => pause.id === id);
    if (before === void 0) continue;
    if (JSON.stringify(row) === JSON.stringify(before)) continue;
    (delta.pauses ??= []).push(row);
    moved = true;
  }
  const latestId = capture.marks.sampleMax;
  if (latestId > 0) {
    const row = storage.contextSampleRowById(latestId);
    const before = held.samples.find((sample) => sample.id === latestId);
    if (row !== void 0 && before !== void 0 && JSON.stringify(row) !== JSON.stringify(before)) {
      (delta.samples ??= []).push(row);
      moved = true;
    }
  }
  return moved;
}
function stepRowOf(read) {
  return {
    id: read.id,
    turnId: read.turnId,
    branchId: read.branchId,
    toolName: read.toolName,
    inputSummary: read.inputSummary,
    outcome: read.outcome,
    startedAt: read.startedAt,
    endedAt: read.endedAt,
    durationMs: read.durationMs,
    resultSize: read.resultSize,
    resultRequestId: read.resultRequestId,
    contextChars: read.contextChars,
    contextImages: read.contextImages,
    asyncLaunch: read.asyncLaunch,
    toolUseId: read.toolUseId,
    savedOutputBytes: read.savedOutputBytes
  };
}
function gatherOpenSteps(hub, capture, delta) {
  const held = capture.data;
  if (held === null) return false;
  let moved = false;
  const watched = /* @__PURE__ */ new Set([...capture.openSteps, ...capture.watchSteps]);
  for (const id of watched) {
    const read = hub.storage.stepRowById(id);
    const before = held.stepsById.get(id);
    if (read === void 0 || before === void 0) continue;
    const row = stepRowOf(read);
    if (JSON.stringify(row) === JSON.stringify(before)) continue;
    (delta.steps ??= []).push(row);
    moved = true;
  }
  return moved;
}
function gatherBranchRequests(hub, capture, delta) {
  const held = capture.data;
  if (held === null || capture.openBranches.size === 0) return false;
  const heldById = new Map(held.requests.map((row) => [row.id, row]));
  let moved = false;
  for (const branchId of capture.openBranches) {
    const rows = hub.storage.requestRowsForBranch(held.session.id, branchId);
    for (const row of rows) {
      const before = heldById.get(row.id);
      if (before !== void 0 && JSON.stringify(row) === JSON.stringify(before)) {
        continue;
      }
      (delta.requests ??= []).push(row);
      moved = true;
    }
  }
  return moved;
}
function planFromDelta(data, delta, capture) {
  const plan = emptyPlan(data);
  for (const step of delta.steps ?? []) plan.stepIds.add(step.id);
  for (const human of delta.humans ?? []) plan.humanIds.add(human.id);
  for (const branch of delta.branches ?? []) plan.branchIds.add(branch.id);
  for (const segment of delta.segments ?? []) plan.segmentIds.add(segment.id);
  for (const pause of delta.pauses ?? []) plan.pauseIds.add(pause.id);
  for (const sample of delta.samples ?? []) plan.sampleIds.add(sample.id);
  for (const turn of delta.turns ?? []) plan.turnIds.add(turn.id);
  for (const turnId of delta.replacedAttachmentTurns ?? []) {
    plan.turnIds.add(turnId);
  }
  addBranchActivity(data, delta, plan);
  for (const human of delta.humans ?? []) {
    if (human.stepId !== null) plan.stepIds.add(human.stepId);
  }
  for (const id of capture.openSteps) plan.stepIds.add(id);
  for (const id of capture.watchSteps) plan.stepIds.add(id);
  for (const id of capture.openBranches) plan.branchIds.add(id);
  for (const id of capture.openPauses) plan.pauseIds.add(id);
  for (const human of data.humans) {
    if (plan.humanTurnIds.get(human.id) === capture.openTurnId) {
      plan.humanIds.add(human.id);
    }
  }
  for (const id of plan.stepIds) {
    const turnId = plan.stepTurnIds.get(id);
    if (turnId !== void 0) plan.turnIds.add(turnId);
  }
  for (const id of plan.humanIds) {
    const turnId = plan.humanTurnIds.get(id);
    if (turnId !== void 0) plan.turnIds.add(turnId);
  }
  return plan;
}
function addBranchActivity(data, delta, plan) {
  const active = /* @__PURE__ */ new Set();
  for (const step of delta.steps ?? []) {
    if (step.branchId !== null) active.add(step.branchId);
  }
  for (const request of delta.requests ?? []) {
    if (request.branchId !== null) active.add(request.branchId);
  }
  for (const branchId of active) {
    plan.branchIds.add(branchId);
    const branch = data.branchesById.get(branchId);
    if (branch !== void 0 && branch.spawningStepId !== null) {
      plan.stepIds.add(branch.spawningStepId);
    }
  }
}
function humanTurnIds(data) {
  const grouped = groupByTurn(
    data.turnsById,
    data.humans,
    (event) => event.occurredAt
  );
  const turnIds = /* @__PURE__ */ new Map();
  for (const [turnId, events] of grouped) {
    for (const event of events) {
      turnIds.set(event.id, turnId);
    }
  }
  return turnIds;
}
function emptyPlan(data) {
  return {
    turnIds: /* @__PURE__ */ new Set(),
    stepIds: /* @__PURE__ */ new Set(),
    humanIds: /* @__PURE__ */ new Set(),
    branchIds: /* @__PURE__ */ new Set(),
    segmentIds: /* @__PURE__ */ new Set(),
    pauseIds: /* @__PURE__ */ new Set(),
    sampleIds: /* @__PURE__ */ new Set(),
    stepTurnIds: stepTurnIds(data),
    humanTurnIds: humanTurnIds(data)
  };
}
function fullPlan(data) {
  const plan = emptyPlan(data);
  for (const turn of data.turns) plan.turnIds.add(turn.id);
  for (const step of data.steps) plan.stepIds.add(step.id);
  for (const human of data.humans) plan.humanIds.add(human.id);
  for (const branch of data.branches) plan.branchIds.add(branch.id);
  for (const segment of data.segments) plan.segmentIds.add(segment.id);
  for (const pause of data.pauses) plan.pauseIds.add(pause.id);
  for (const sample of data.samples) plan.sampleIds.add(sample.id);
  return plan;
}
function refreshOpenSets(capture, data) {
  capture.openTurns = new Set(
    data.turns.filter((turn) => turn.endedAt === null).map((turn) => turn.id)
  );
  capture.openTurnId = null;
  for (const turn of data.turns) {
    if (turn.endedAt === null) capture.openTurnId = turn.id;
  }
  capture.openBranches = new Set(
    data.branches.filter((branch) => branch.endedAt === null).map((branch) => branch.id)
  );
  capture.openPauses = new Set(
    data.pauses.filter((pause) => pause.resumedAt === null).map((pause) => pause.id)
  );
  const openSteps = /* @__PURE__ */ new Set();
  const watchSteps = /* @__PURE__ */ new Set();
  for (const step of data.steps) {
    if (step.outcome === "open") {
      openSteps.add(step.id);
    }
    const branch = step.branchId !== null ? data.branchesById.get(step.branchId) : data.branchBySpawningStep.get(step.id);
    if (branch !== void 0 && branch.endedAt === null) {
      watchSteps.add(step.id);
    }
  }
  capture.openSteps = openSteps;
  capture.watchSteps = watchSteps;
}
function finishPass(capture, probe, sessionRow) {
  capture.marks = probe;
  capture.sessionRowJson = JSON.stringify(sessionRow);
  capture.baseline = false;
  capture.resync = false;
  const data = capture.data;
  if (data !== null) {
    for (const request of data.requests) {
      if (request.id > capture.requestMax) {
        capture.requestMax = request.id;
      }
    }
  }
}

// src/daemon/stream.ts
function pickerRowChange(state, row, settings, storage) {
  if (isEmptySession(row)) {
    if (state.hidden) return void 0;
    state.hidden = true;
    state.listJson = null;
    state.fingerprint = `${row.status}:${row.lastSeenAt}`;
    return {
      sessionId: row.id,
      hidden: true,
      emptyHidden: emptyHiddenCount(storage)
    };
  }
  const wasHidden = state.hidden;
  state.hidden = false;
  const item = sessionListItem(row, settings);
  const json = JSON.stringify(item);
  if (json === state.listJson) return void 0;
  state.listJson = json;
  state.fingerprint = `${row.status}:${row.lastSeenAt}`;
  return wasHidden ? {
    sessionId: row.id,
    session: item,
    emptyHidden: emptyHiddenCount(storage)
  } : { sessionId: row.id, session: item };
}
var BUFFER_SIZE = 2e3;
var CAPTURE_DEBOUNCE_MS = 25;
var SWEEP_MS = 2e3;
var HEARTBEAT_MS = 15e3;
function frame(id, message) {
  return `id: ${id}
event: ${message.event}
data: ${JSON.stringify(message.data)}

`;
}
function healthState(hub) {
  return currentHealth(hub.dataDir, hub.settings().autostart);
}
function captureHealth(hub) {
  const state = healthState(hub);
  const json = JSON.stringify(state);
  if (json === hub.healthJson) return;
  hub.healthJson = json;
  appendEntry(hub, "all", null, { event: "health", data: state });
}
function matches(connection, entry) {
  if (entry.scope === "all") return true;
  if (connection.sessionId === null) return entry.scope === "picker";
  return entry.scope === "session" && entry.sessionId === connection.sessionId;
}
function writeFrame(connection, text) {
  try {
    connection.response.write(text);
    return true;
  } catch {
    return false;
  }
}
function appendEntry(hub, scope, sessionId, message) {
  hub.sequence += 1;
  const entry = { id: hub.sequence, sessionId, scope, message };
  hub.buffer.push(entry);
  if (hub.buffer.length > BUFFER_SIZE) {
    const evicted = hub.buffer.shift();
    if (evicted !== void 0) hub.droppedThrough = evicted.id;
  }
  for (const connection of hub.connections) {
    if (entry.id > connection.lastSent && matches(connection, entry)) {
      if (writeFrame(connection, frame(`${hub.epoch}:${entry.id}`, message))) {
        connection.lastSent = entry.id;
      }
    }
  }
}
function scheduleFlush(hub) {
  if (hub.flushTimer !== null) return;
  hub.flushTimer = setTimeout(() => {
    hub.flushTimer = null;
    flush(hub);
  }, CAPTURE_DEBOUNCE_MS);
  hub.flushTimer.unref();
}
function dropUncapturedChanges(hub) {
  hub.storage.dropUncapturedChanges([...hub.captures.keys()]);
}
function flush(hub) {
  if (!hub.activated) {
    hub.storage.clearAllChanges();
    hub.pendingHealth = false;
    hub.pendingAll = false;
    hub.pending.clear();
    return;
  }
  if (hub.pendingHealth) {
    hub.pendingHealth = false;
    captureHealth(hub);
  }
  const all = hub.pendingAll;
  hub.pendingAll = false;
  const pending = [...hub.pending];
  hub.pending.clear();
  if (all) {
    capturePicker(hub);
    for (const sessionId of hub.captures.keys()) {
      captureSession(hub, sessionId, "emit");
    }
    dropUncapturedChanges(hub);
    return;
  }
  for (const sessionId of pending) {
    captureSession(hub, sessionId, "emit");
  }
  dropUncapturedChanges(hub);
}
function capturePicker(hub) {
  if (!hub.pickerBaselined) {
    for (const row of hub.storage.listSessionRows()) {
      hub.picker.set(row.id, {
        fingerprint: `${row.status}:${row.lastSeenAt}`,
        listJson: null,
        hidden: isEmptySession(row)
      });
    }
    hub.pickerBaselined = true;
    return;
  }
  const rows = hub.storage.sessionScanRows();
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    seen.add(row.id);
    const fingerprint = `${row.status}:${row.lastSeenAt}`;
    const state = hub.picker.get(row.id);
    if (state === void 0) {
      hub.picker.set(row.id, { fingerprint, listJson: null, hidden: false });
      shapeListItem(hub, row.id);
      continue;
    }
    if (state.fingerprint !== fingerprint) {
      state.fingerprint = fingerprint;
      shapeListItem(hub, row.id);
    }
  }
  for (const sessionId of [...hub.picker.keys()]) {
    if (!seen.has(sessionId)) {
      const state = hub.picker.get(sessionId);
      hub.picker.delete(sessionId);
      appendEntry(hub, "picker", sessionId, {
        event: "session",
        data: state !== void 0 && state.hidden ? {
          sessionId,
          deleted: true,
          emptyHidden: emptyHiddenCount(hub.storage)
        } : { sessionId, deleted: true }
      });
    }
  }
}
function shapeListItem(hub, sessionId) {
  const row = hub.storage.sessionRow(sessionId);
  const state = hub.picker.get(sessionId);
  if (row === void 0 || state === void 0) return;
  const data = pickerRowChange(state, row, hub.settings(), hub.storage);
  if (data === void 0) return;
  appendEntry(hub, "picker", sessionId, { event: "session", data });
}
function parseLastEventId(raw) {
  if (raw === null) return null;
  const split = raw.lastIndexOf(":");
  if (split < 1) return null;
  const seq = Number(raw.slice(split + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { epoch: raw.slice(0, split), seq };
}
function ensureCapture(hub, sessionId) {
  if (hub.captures.has(sessionId)) return;
  hub.captures.set(sessionId, newCapture());
  captureSession(hub, sessionId, "record");
  if (!hub.picker.has(sessionId)) {
    const row = hub.storage.sessionRow(sessionId);
    if (row !== void 0) {
      const empty = isEmptySession(row);
      hub.picker.set(sessionId, {
        fingerprint: `${row.status}:${row.lastSeenAt}`,
        listJson: empty ? null : JSON.stringify(sessionListItem(row, hub.settings())),
        hidden: empty
      });
    }
  }
}
function activate(hub) {
  if (hub.activated) return;
  hub.activated = true;
  capturePicker(hub);
  captureHealth(hub);
}
function serveConnection(hub, response, sessionId, lastEventIdRaw) {
  if (hub.restarting) {
    response.end();
    return;
  }
  activate(hub);
  if (sessionId !== null) ensureCapture(hub, sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const connection = {
    response,
    sessionId,
    lastSent: hub.sequence,
    heartbeat: setInterval(() => {
      writeFrame(connection, ": hb\n\n");
    }, HEARTBEAT_MS)
  };
  connection.heartbeat.unref();
  hub.connections.add(connection);
  response.on("close", () => {
    clearInterval(connection.heartbeat);
    hub.connections.delete(connection);
  });
  greetConnection(hub, connection, lastEventIdRaw);
}
function greetConnection(hub, connection, lastEventIdRaw) {
  writeFrame(
    connection,
    frame(`${hub.epoch}:${hub.sequence}`, {
      event: "health",
      data: healthState(hub)
    })
  );
  const last = parseLastEventId(lastEventIdRaw);
  if (last === null) {
    sendSync(hub, connection, 0, false);
    return;
  }
  if (last.epoch !== hub.epoch || last.seq < hub.droppedThrough) {
    writeFrame(
      connection,
      frame(`${hub.epoch}:${hub.sequence}`, { event: "reset", data: {} })
    );
    sendSync(hub, connection, 0, true);
    return;
  }
  let replayed = 0;
  for (const entry of hub.buffer) {
    if (entry.id <= last.seq || !matches(connection, entry)) continue;
    if (writeFrame(connection, frame(`${hub.epoch}:${entry.id}`, entry.message))) {
      connection.lastSent = entry.id;
      replayed += 1;
    }
  }
  connection.lastSent = hub.sequence;
  sendSync(hub, connection, replayed, false);
}
function sendSync(hub, connection, replayed, reset) {
  writeFrame(
    connection,
    frame(`${hub.epoch}:${hub.sequence}`, {
      event: "sync",
      data: { replayed, reset }
    })
  );
}
function stopHub(hub, final) {
  if (hub.sweep !== null) clearInterval(hub.sweep);
  hub.sweep = null;
  if (hub.flushTimer !== null) clearTimeout(hub.flushTimer);
  hub.flushTimer = null;
  const text = frame(`${hub.epoch}:${hub.sequence}`, final);
  for (const connection of hub.connections) {
    writeFrame(connection, text);
  }
  endConnections(hub);
}
function endConnections(hub) {
  for (const connection of hub.connections) {
    clearInterval(connection.heartbeat);
    try {
      connection.response.end();
    } catch {
    }
  }
  hub.connections.clear();
}
function newHubState(deps) {
  return {
    storage: deps.storage,
    settings: deps.settings,
    dataDir: deps.dataDir,
    epoch: randomBytes(4).toString("hex"),
    sequence: 0,
    droppedThrough: 0,
    buffer: [],
    connections: /* @__PURE__ */ new Set(),
    captures: /* @__PURE__ */ new Map(),
    picker: /* @__PURE__ */ new Map(),
    healthJson: null,
    sweep: null,
    pending: /* @__PURE__ */ new Set(),
    pendingAll: false,
    pendingHealth: false,
    restarting: false,
    flushTimer: null,
    pickerBaselined: false,
    activated: false
  };
}
function createStreamHub(deps) {
  const hub = newHubState(deps);
  return {
    epoch: hub.epoch,
    serve: (response, sessionId, lastEventId) => serveConnection(hub, response, sessionId, lastEventId),
    noteSession: (sessionId) => {
      if (!hub.captures.has(sessionId)) return;
      hub.pending.add(sessionId);
      scheduleFlush(hub);
    },
    noteAllSessions: () => {
      hub.pendingAll = true;
      scheduleFlush(hub);
    },
    noteHealth: () => {
      hub.pendingHealth = true;
      scheduleFlush(hub);
    },
    noteSettingsChanged: () => {
      for (const capture of hub.captures.values()) capture.resync = true;
      for (const state of hub.picker.values()) state.listJson = null;
      hub.pendingAll = true;
      scheduleFlush(hub);
    },
    connectionCount: () => hub.connections.size,
    start: () => {
      hub.sweep = setInterval(() => {
        if (!hub.activated) return;
        captureHealth(hub);
        capturePicker(hub);
        for (const sessionId of hub.captures.keys()) {
          captureSession(hub, sessionId, "emit");
        }
        dropUncapturedChanges(hub);
      }, SWEEP_MS);
      hub.sweep.unref();
    },
    stop: (final) => stopHub(hub, final),
    endConnections: () => endConnections(hub),
    beginRestart: () => {
      hub.restarting = true;
    },
    endRestart: () => {
      hub.restarting = false;
    }
  };
}

// src/daemon/server.ts
var DEFAULT_DRAIN_MS = 30 * 1e3;
var PORT_TRIES = 20;
function isNewerVersion(theirs, ours) {
  const parse = (value) => {
    const dash = value.indexOf("-");
    const core = dash === -1 ? value : value.slice(0, dash);
    const parts = core.split(".");
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    return {
      numbers: parts.map(Number),
      suffix: dash === -1 ? "" : value.slice(dash + 1)
    };
  };
  const incoming = parse(theirs);
  const own = parse(ours);
  if (incoming === null || own === null) return false;
  const length = Math.max(incoming.numbers.length, own.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (incoming.numbers[i] ?? 0) - (own.numbers[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (incoming.suffix === own.suffix) return false;
  if (incoming.suffix === "") return true;
  if (own.suffix === "") return false;
  return incoming.suffix > own.suffix;
}
function writePortFile(dataDir, port, rename = renameSync3) {
  const temporary = join12(dataDir, "port.tmp");
  writeFileSync6(temporary, String(port));
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(temporary, join12(dataDir, "port"));
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 5 || code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 20);
    }
  }
}
function loadOrCreateToken(dataDir) {
  const path = join12(dataDir, "token");
  if (existsSync5(path)) {
    return readFileSync11(path, "utf8").trim();
  }
  const token = randomBytes2(32).toString("hex");
  try {
    writeFileSync6(path, token, { flag: "wx", mode: 384 });
    return token;
  } catch {
    return readFileSync11(path, "utf8").trim();
  }
}
function openDaemonStorage(dataDir, lock) {
  try {
    const storage = openStorage({ dataDir });
    storage.clearAllChanges();
    return storage;
  } catch (error) {
    lock.release();
    if (typeof error === "object" && error !== null) {
      error.databaseOpen = true;
    }
    throw error;
  }
}
function track(runtime, work) {
  runtime.inFlight.add(work);
  void work.then(
    () => runtime.inFlight.delete(work),
    () => runtime.inFlight.delete(work)
  );
  return work;
}
function runRetention(runtime) {
  void track(runtime, runtime.retention.runOnce()).then((run) => {
    if (run.aged + run.capped > 0) {
      daemonLog(
        runtime.dataDir,
        `retention deleted ${run.aged + run.capped} session(s) (${run.aged} by age, ${run.capped} by size)`
      );
      runtime.stream.noteAllSessions();
    }
  }).catch((error) => {
    daemonLog(runtime.dataDir, `retention failed (${errorMessage(error)})`);
  });
}
function followTranscripts(runtime, envelope) {
  const event = envelope.event;
  const sessionId = typeof event.session_id === "string" ? event.session_id : void 0;
  const transcriptPath = typeof event.transcript_path === "string" ? event.transcript_path : void 0;
  if (sessionId === void 0) return;
  try {
    runtime.telemetry.flushSession(runtime.storage, sessionId, {
      settings: runtime.settings
    });
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `transcript follow failed for session ${sessionId} (${errorMessage(error)})`
    );
    return;
  }
  if (transcriptPath === void 0) return;
  void track(
    runtime,
    runtime.transcripts.follow(
      sessionId,
      transcriptPath,
      typeof event.cwd === "string" ? event.cwd : void 0,
      event.hook_event_name === "SessionEnd"
    )
  ).then(() => runtime.stream.noteSession(sessionId)).catch((error) => {
    daemonLog(
      runtime.dataDir,
      `transcript follow failed for session ${sessionId} (${errorMessage(error)})`
    );
  });
}
function noteVersion(runtime, envelope) {
  if (runtime.handoverVersion !== null) return;
  const theirs = envelope.plugin_version;
  if (typeof theirs === "string" && theirs.length > 0 && theirs !== "unknown" && runtime.version !== "unknown" && isNewerVersion(theirs, runtime.version)) {
    runtime.handoverVersion = theirs;
    daemonLog(
      runtime.dataDir,
      `plugin version ${theirs} arrived; this build (${runtime.version}) hands over once its current work is done`
    );
  }
}
function applySettings(runtime, values) {
  runtime.settings = { ...runtime.settings, ...values };
  saveSettings(runtime.dataDir, runtime.settings);
  if (runtime.idleOptionMs === void 0) {
    runtime.idleMs = runtime.settings.idleShutdownMinutes * 6e4;
  }
  runtime.stream.noteSettingsChanged();
}
function drainOneBufferFile(runtime, bufferDir, name) {
  const path = join12(bufferDir, name);
  try {
    const parsed = JSON.parse(readFileSync11(path, "utf8"));
    if (!isEnvelope(parsed)) {
      if (!runtime.loggedBadFiles.has(name)) {
        runtime.loggedBadFiles.add(name);
        daemonLog(
          runtime.dataDir,
          `buffer file ${name} is not an envelope; left in place`
        );
      }
      return false;
    }
    noteVersion(runtime, parsed);
    let stored = false;
    if (ingestEnvelope(runtime.storage, parsed) === "stored") {
      stored = true;
      followTranscripts(runtime, parsed);
    }
    runtime.lastActivity = Math.max(runtime.lastActivity, parsed.received_at);
    unlinkSync2(path);
    return stored;
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `buffer file ${name} could not be stored (${errorMessage(error)}); left in place`
    );
    return false;
  }
}
function drainBuffer(runtime) {
  const bufferDir = join12(runtime.dataDir, "buffer");
  let names;
  try {
    names = readdirSync4(bufferDir).sort();
  } catch {
    return;
  }
  let stored = 0;
  for (const name of names) {
    if (drainOneBufferFile(runtime, bufferDir, name)) {
      stored += 1;
    }
  }
  if (stored > 0) {
    daemonLog(runtime.dataDir, `drained ${stored}`);
    runtime.stream.noteAllSessions();
  }
  if (names.length > 0) {
    runtime.stream.noteHealth();
  }
  try {
    if (readdirSync4(bufferDir).length === 0) {
      resetDropped(runtime.dataDir);
    }
  } catch {
  }
  if (runtime.handoverVersion !== null) {
    void runtime.shutdown("handover");
  }
}
async function listenFrom(server, wanted) {
  let candidate = wanted;
  for (; ; ) {
    try {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(candidate, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolvePromise();
        });
      });
      return candidate;
    } catch (error) {
      if (error.code === "EADDRINUSE" && candidate < wanted + PORT_TRIES) {
        candidate += 1;
        continue;
      }
      throw error;
    }
  }
}
function requestedStopReason(dataDir) {
  return existsSync5(join12(dataDir, "off")) ? "off" : "signal";
}
async function shutdownDaemon(runtime, server, lock, reason) {
  if (runtime.closed) return;
  runtime.closed = true;
  runtime.stream.stop({
    event: "stopping",
    data: reason === "idle" ? { reason, idleMinutes: Math.round(runtime.idleMs / 6e4) } : { reason }
  });
  clearInterval(runtime.timers.drain);
  clearInterval(runtime.timers.idle);
  clearInterval(runtime.timers.refollow);
  clearInterval(runtime.timers.retention);
  clearInterval(runtime.timers.sessionWatch);
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  if (runtime.inFlight.size > 0) {
    await Promise.race([
      Promise.allSettled([...runtime.inFlight]),
      new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 5e3);
      })
    ]);
  }
  runtime.storage.close();
  lock.release();
  daemonLog(runtime.dataDir, "exited");
}
async function restartDaemon(runtime, server, lock) {
  if (runtime.closed) return;
  runtime.stream.beginRestart();
  runtime.stream.endConnections();
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
  try {
    runtime.boundPort = await listenFrom(server, runtime.settings.port);
  } catch (error) {
    daemonLog(
      runtime.dataDir,
      `could not listen on port ${runtime.settings.port} (${errorMessage(error)}); exiting`
    );
    await shutdownDaemon(runtime, server, lock, "listen-failed");
    return;
  }
  runtime.stream.endRestart();
  writePortFile(runtime.dataDir, runtime.boundPort);
  daemonLog(runtime.dataDir, `listening on 127.0.0.1:${runtime.boundPort}`);
  runtime.lastActivity = Date.now();
}
function startTimers(runtime, drainMs) {
  runtime.stream.start();
  runtime.timers.drain = setInterval(() => {
    drainBuffer(runtime);
    runtime.telemetry.dropStale(Date.now());
  }, drainMs);
  runtime.timers.idle = setInterval(() => {
    const now = Date.now();
    if (now - runtime.lastActivity < runtime.idleMs) return;
    runtime.cacheHold = cacheHold(
      runtime.storage,
      runtime.lastActivity,
      runtime.cacheHold
    );
    if (now >= runtime.cacheHold.until) void runtime.shutdown("idle");
  }, 1e3);
  runtime.timers.idle.unref();
  runtime.timers.refollow = setInterval(() => {
    void track(runtime, runtime.transcripts.refollowActive()).then(() => runtime.stream.noteAllSessions()).catch((error) => {
      daemonLog(
        runtime.dataDir,
        `transcript re-follow failed (${errorMessage(error)})`
      );
    });
  }, 1e3);
  runtime.timers.refollow.unref();
  runtime.timers.retention = setInterval(
    () => runRetention(runtime),
    RETENTION_INTERVAL_MS
  );
  runtime.timers.retention.unref();
  runtime.timers.sessionWatch = setInterval(
    () => runSessionWatch(runtime),
    SESSION_WATCH_INTERVAL_MS
  );
  runtime.timers.sessionWatch.unref();
  runSessionWatch(runtime);
  runRetention(runtime);
  drainBuffer(runtime);
  startImport(runtime);
}
function runSessionWatch(runtime) {
  void runtime.sessionWatch.runOnce().then((ended) => {
    if (ended.length > 0) {
      daemonLog(
        runtime.dataDir,
        `session-end watch ended ${ended.length} session(s) with no end event`
      );
      runtime.stream.noteAllSessions();
    }
  }).catch((error) => {
    daemonLog(
      runtime.dataDir,
      `session-end watch failed (${errorMessage(error)})`
    );
  });
}
function startImport(runtime) {
  void track(runtime, runtime.transcripts.importAll()).then((imported) => {
    if (imported.importedSessions > 0) {
      daemonLog(
        runtime.dataDir,
        `imported ${imported.importedSessions} transcript-only session(s)`
      );
      runtime.stream.noteAllSessions();
    }
  }).catch((error) => {
    daemonLog(
      runtime.dataDir,
      `transcript import failed (${errorMessage(error)})`
    );
  });
}
function createRuntime(parts) {
  const { dataDir, version, storage } = parts;
  const settings = loadSettings(
    dataDir,
    (message) => daemonLog(dataDir, message)
  );
  const startedAt = Date.now();
  const shutdownPlaceholder = () => Promise.resolve();
  const runtime = {
    dataDir,
    version,
    idleOptionMs: parts.idleOptionMs,
    storage,
    token: loadOrCreateToken(dataDir),
    startedAt,
    settings,
    idleMs: parts.idleOptionMs ?? settings.idleShutdownMinutes * 6e4,
    boundPort: 0,
    lastActivity: startedAt,
    cacheHold: null,
    handoverVersion: null,
    closed: false,
    inFlight: /* @__PURE__ */ new Set(),
    loggedBadFiles: /* @__PURE__ */ new Set(),
    timers: {},
    noteVersion: (envelope) => noteVersion(runtime, envelope),
    followTranscripts: (envelope) => followTranscripts(runtime, envelope),
    shutdown: shutdownPlaceholder,
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    touch: () => {
      runtime.lastActivity = Date.now();
    },
    applySettings: (values) => applySettings(runtime, values)
  };
  runtime.transcripts = createTranscriptFollower(storage, {
    dataDir,
    configDir: resolveClaudeConfigDir(),
    settings: () => runtime.settings
  });
  runtime.telemetry = createTelemetryIntake();
  runtime.retention = createRetention({
    storage,
    settings: () => runtime.settings
  });
  runtime.sessionWatch = createSessionWatch({ storage });
  runtime.stream = createStreamHub({
    storage,
    settings: () => runtime.settings,
    dataDir
  });
  return runtime;
}
async function startDaemon(options) {
  const { dataDir, version } = options;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  mkdirSync4(dataDir, { recursive: true });
  const lock = acquireDaemonLock(dataDir);
  if (lock === null) {
    daemonLog(dataDir, "another daemon holds the lock; exiting");
    return null;
  }
  const storage = openDaemonStorage(dataDir, lock);
  const runtime = createRuntime({
    dataDir,
    version,
    storage,
    idleOptionMs: options.idleMs
  });
  const server = createServer(
    (request, response) => handleRequest(runtime, request, response)
  );
  runtime.shutdown = (reason) => shutdownDaemon(runtime, server, lock, reason);
  runtime.stop = () => runtime.shutdown(requestedStopReason(dataDir));
  runtime.restart = () => restartDaemon(runtime, server, lock);
  try {
    runtime.boundPort = await listenFrom(server, runtime.settings.port);
  } catch (error) {
    storage.close();
    lock.release();
    throw error;
  }
  clearLastError(dataDir);
  writePortFile(dataDir, runtime.boundPort);
  unlinkIfPresent(startLockPath(dataDir));
  daemonLog(dataDir, `listening on 127.0.0.1:${runtime.boundPort}`);
  startTimers(runtime, drainMs);
  return {
    port: runtime.boundPort,
    shutdown: runtime.shutdown,
    stop: runtime.stop
  };
}

// src/version.ts
import { readFileSync as readFileSync12 } from "node:fs";
function pluginVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync12(new URL("../package.json", import.meta.url), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// src/daemon.ts
function positiveMs(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : void 0;
}
async function main() {
  const dataDir = resolveDataDir(process.env, process.platform, homedir3());
  const idleMs = positiveMs(process.env.FLIGHTPATH_IDLE_MS);
  const drainMs = positiveMs(process.env.FLIGHTPATH_DRAIN_MS);
  const daemon = await startDaemon({
    dataDir,
    version: pluginVersion(),
    ...idleMs !== void 0 ? { idleMs } : {},
    ...drainMs !== void 0 ? { drainMs } : {}
  });
  if (daemon === null) {
    return;
  }
  const stop = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch((error) => {
  try {
    const dataDir = resolveDataDir(process.env, process.platform, homedir3());
    writeLastError(dataDir, error);
    daemonLog(dataDir, `failed to start (${errorMessage(error)})`);
  } catch {
  }
  process.exit(1);
});
