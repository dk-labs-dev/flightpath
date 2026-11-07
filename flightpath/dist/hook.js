if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\.js$/.test(process.argv[1])) process.stdout.write(`{"systemMessage":"● flightpath needs Node 24 or later; this is Node ${process.versions.node} · see Install in the README"}\n`); process.exit(0); }
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/storage/prompt-text.ts
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
var PROMPT_TEXT_LIMIT, UPDATE_TURN_PROMPT, UPDATE_TURN_PROMPT_IF_UNSET;
var init_prompt_text = __esm({
  "src/storage/prompt-text.ts"() {
    "use strict";
    PROMPT_TEXT_LIMIT = 2e3;
    UPDATE_TURN_PROMPT = "UPDATE turns SET prompt_text = ?, prompt_chars = ?, prompt_lines = ? WHERE id = ?";
    UPDATE_TURN_PROMPT_IF_UNSET = `${UPDATE_TURN_PROMPT} AND prompt_text IS NULL`;
  }
});

// src/util/json.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var init_json = __esm({
  "src/util/json.ts"() {
    "use strict";
  }
});

// src/util/host-process.ts
var host_process_exports = {};
__export(host_process_exports, {
  WINDOWS_STARTED_AT_PROPERTY: () => WINDOWS_STARTED_AT_PROPERTY,
  captureHostProcess: () => captureHostProcess,
  findHostProcess: () => findHostProcess,
  isClaudeCommand: () => isClaudeCommand,
  parseProcStat: () => parseProcStat,
  parseWindowsProcessTable: () => parseWindowsProcessTable,
  parseWindowsStartTimes: () => parseWindowsStartTimes,
  processExists: () => processExists,
  readProcessLinux: () => readProcessLinux,
  readProcessStartTimes: () => readProcessStartTimes,
  sameProcessStart: () => sameProcessStart
});
import { spawn, spawnSync } from "node:child_process";
import { readFileSync as readFileSync6 } from "node:fs";
function sameProcessStart(a, b) {
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
function isClaudeCommand(argv) {
  const program = (argv[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (program === "claude" || program === "claude.exe") {
    return true;
  }
  if (program !== "node" && program !== "node.exe") {
    return false;
  }
  const entry = argv[1] ?? "";
  return /(^|[/\\])claude-code([/\\]|$)/.test(entry);
}
function findHostProcess(read, startPid) {
  const seen = /* @__PURE__ */ new Set();
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (pid <= 0 || seen.has(pid)) {
      return null;
    }
    seen.add(pid);
    const info = read(pid);
    if (info === null) {
      return null;
    }
    if (isClaudeCommand(info.argv)) {
      return { pid: info.pid, startedAt: info.startedAt };
    }
    pid = info.parentPid;
  }
  return null;
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
    const match = /^btime (\d+)$/m.exec(readFileSync6("/proc/stat", "utf8"));
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
    stat = readFileSync6(`/proc/${pid}/stat`, "utf8");
    cmdline = readFileSync6(`/proc/${pid}/cmdline`, "utf8");
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
function readProcessLinux(pid) {
  return readProcessLinuxAt(pid, bootTimeSeconds());
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
function commandLineEntry(commandLine) {
  const tokens = [];
  let token = "";
  let quoted = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === " " || char === "	")) {
      if (token !== "") {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (token !== "") {
    tokens.push(token);
  }
  return tokens[1] ?? "";
}
function parseWindowsProcessTable(text) {
  const table = /* @__PURE__ */ new Map();
  for (const row of windowsRows(text)) {
    if (typeof row.ProcessId !== "number" || typeof row.ParentProcessId !== "number" || typeof row.StartedAt !== "number") {
      continue;
    }
    table.set(row.ProcessId, {
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      startedAt: row.StartedAt,
      argv: [
        typeof row.Name === "string" ? row.Name : "",
        typeof row.CommandLine === "string" ? commandLineEntry(row.CommandLine) : ""
      ]
    });
  }
  return table;
}
function readProcessTableWindows() {
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT],
      { encoding: "utf8", timeout: 1e4, windowsHide: true }
    );
    return parseWindowsProcessTable(result.stdout ?? "");
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function captureHostProcess() {
  if (process.platform === "linux") {
    return findHostProcess(linuxProcessReader(), process.ppid);
  }
  if (process.platform === "win32") {
    const table = readProcessTableWindows();
    return findHostProcess((pid) => table.get(pid) ?? null, process.ppid);
  }
  return null;
}
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
var MAX_ANCESTORS, TICKS_PER_SECOND, START_TIME_TOLERANCE_MS, WINDOWS_STARTED_AT_PROPERTY, WINDOWS_TABLE_SCRIPT;
var init_host_process = __esm({
  "src/util/host-process.ts"() {
    "use strict";
    MAX_ANCESTORS = 8;
    TICKS_PER_SECOND = 100;
    START_TIME_TOLERANCE_MS = 2e3;
    WINDOWS_STARTED_AT_PROPERTY = `@{n='StartedAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}`;
    WINDOWS_TABLE_SCRIPT = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,${WINDOWS_STARTED_AT_PROPERTY},Name,CommandLine | ConvertTo-Json -Compress`;
  }
});

// src/redact/allowlist.ts
var COMMON_TEXT_KEYS, EVENT_TEXT_KEYS, EVENT_PROMPT_KEY, EVENT_ARRAY_ITEM_TEXT_KEYS, TOOL_INPUT_TEXT_KEYS, KNOWN_TOOLS, ASK_USER_QUESTION_TEXT_KEYS, HOOK_EFFORT_TEXT, TELEMETRY_TEXT_KEYS, TELEMETRY_NUMERIC_KEYS, TELEMETRY_BOOLEAN_KEYS, TELEMETRY_IDENTITY_KEY, TELEMETRY_COST_KEY, TRANSCRIPT_ENTRY_TEXT, TRANSCRIPT_MESSAGE_TEXT;
var init_allowlist = __esm({
  "src/redact/allowlist.ts"() {
    "use strict";
    COMMON_TEXT_KEYS = /* @__PURE__ */ new Set([
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
    EVENT_TEXT_KEYS = {
      UserPromptSubmit: ["prompt", "prompt_kind"],
      UserPromptExpansion: ["command_name", "command_args", "command_source"],
      SessionStart: ["source", "model"],
      Notification: ["notification_type"],
      PreCompact: ["trigger"],
      PostCompact: ["trigger"],
      InstructionsLoaded: ["file_path", "memory_type"]
    };
    EVENT_PROMPT_KEY = {
      UserPromptSubmit: "prompt",
      UserPromptExpansion: "command_args"
    };
    EVENT_ARRAY_ITEM_TEXT_KEYS = {
      PostToolBatch: { tool_calls: ["tool_use_id", "tool_name"] }
    };
    TOOL_INPUT_TEXT_KEYS = /* @__PURE__ */ new Set([
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
    KNOWN_TOOLS = /* @__PURE__ */ new Set([
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
    ASK_USER_QUESTION_TEXT_KEYS = /* @__PURE__ */ new Set([
      "question",
      "header",
      "label",
      "answers",
      "answer"
    ]);
    HOOK_EFFORT_TEXT = /* @__PURE__ */ new Set(["level"]);
    TELEMETRY_TEXT_KEYS = /* @__PURE__ */ new Set([
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
    TELEMETRY_NUMERIC_KEYS = /* @__PURE__ */ new Set([
      "duration_ms",
      "total_duration_ms",
      "num_hooks",
      "prompt_length",
      "pre_tokens",
      "post_tokens"
    ]);
    TELEMETRY_BOOLEAN_KEYS = /* @__PURE__ */ new Set(["success"]);
    TELEMETRY_IDENTITY_KEY = /email|account|organi[sz]ation|org_?id|user_?id|user\.id/i;
    TELEMETRY_COST_KEY = /cost/i;
    TRANSCRIPT_ENTRY_TEXT = /* @__PURE__ */ new Set([
      "type",
      "sessionId",
      "uuid",
      "parentUuid",
      "timestamp",
      "requestId"
    ]);
    TRANSCRIPT_MESSAGE_TEXT = /* @__PURE__ */ new Set([
      "role",
      "model",
      "id"
    ]);
  }
});

// src/redact/secrets.ts
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
var MYSQL_CLIENT, PATTERNS;
var init_secrets = __esm({
  "src/redact/secrets.ts"() {
    "use strict";
    MYSQL_CLIENT = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/;
    PATTERNS = [
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
  }
});

// src/redact/index.ts
var redact_exports = {};
__export(redact_exports, {
  REDACTION_VERSION: () => REDACTION_VERSION,
  redactHookEvent: () => redactHookEvent,
  redactTelemetryRecord: () => redactTelemetryRecord,
  redactTranscriptEntry: () => redactTranscriptEntry
});
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
function walkObject(obj, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[scrubSecrets(key)] = walkValue(value, textKeys.has(key));
  }
  return out;
}
function walkDeepObject(obj, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[scrubSecrets(key)] = (key === "answers" || key === "answer") && isPlainObject(value) ? redactAnswersMap(value, textKeys) : walkDeepValue(value, textKeys.has(key), textKeys);
  }
  return out;
}
function redactAnswersMap(obj, textKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
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
var REDACTION_VERSION, NO_TEXT;
var init_redact = __esm({
  "src/redact/index.ts"() {
    "use strict";
    init_allowlist();
    init_secrets();
    init_prompt_text();
    init_json();
    REDACTION_VERSION = 1;
    NO_TEXT = /* @__PURE__ */ new Set();
  }
});

// src/hook.ts
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync as readdirSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { join as join7 } from "node:path";

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
function readDaemonAddress(dataDir) {
  try {
    const port = Number(readFileSync(join(dataDir, "port"), "utf8").trim());
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
      return null;
    }
    return { port, token };
  } catch {
    return null;
  }
}

// src/buffer.ts
var BUFFER_LIMIT = 2e4;
var DROPPED_FILE = "buffer-dropped";
function droppedCount(dataDir) {
  try {
    const value = Number.parseInt(
      readFileSync2(join2(dataDir, DROPPED_FILE), "utf8").trim(),
      10
    );
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
function noteDropped(dataDir) {
  writeFileSync2(join2(dataDir, DROPPED_FILE), `${droppedCount(dataDir) + 1}
`);
}

// src/data-dir.ts
import { existsSync } from "node:fs";
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
function isRecordingOff(dataDir, event) {
  if (existsSync(join3(dataDir, "off"))) {
    return true;
  }
  const sessionId = event.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 && existsSync(join3(dataDir, "pause", pauseFileName(sessionId)));
}

// src/daemon/spawn.ts
import { closeSync, existsSync as existsSync2, openSync, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname, join as join5 } from "node:path";
import { fileURLToPath } from "node:url";

// src/daemon/lock.ts
import { join as join4 } from "node:path";
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
function startLockPath(dataDir) {
  return join4(dataDir, "daemon-start.lock");
}

// src/daemon/spawn.ts
var START_LOCK_WINDOW_MS = 1e4;
function daemonEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join5(here, "daemon.js");
  return existsSync2(beside) ? beside : join5(here, "..", "daemon.js");
}
async function ensureDaemon(dataDir) {
  if (daemonLive(dataDir)) {
    return;
  }
  const lockPath = startLockPath(dataDir);
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < START_LOCK_WINDOW_MS) {
        return;
      }
      unlinkSync2(lockPath);
      fd = openSync(lockPath, "wx");
    } catch {
      return;
    }
  }
  closeSync(fd);
  const { spawn: spawn2 } = await import("node:child_process");
  const child = spawn2(process.execPath, [daemonEntry()], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {
  });
  child.unref();
}

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

// src/prompt-kind.ts
var AGENT_MESSAGE_OPENING = "<agent-message";
var TASK_NOTIFICATION_OPENING = "<task-notification>";
function isAgentMessage(prompt) {
  return prompt.trimStart().startsWith(`${AGENT_MESSAGE_OPENING} from="`);
}
function isTaskNotification(prompt) {
  return prompt.trimStart().startsWith(TASK_NOTIFICATION_OPENING);
}
function classifyPrompt(prompt) {
  if (isFlightpathCommand(prompt)) return "flightpath-command";
  if (isAgentMessage(prompt)) return "agent-message";
  if (isTaskNotification(prompt)) return "task-notification";
  return "typed";
}

// src/settings/index.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join6, resolve, win32 } from "node:path";
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
    parsed = JSON.parse(readFileSync3(join6(dataDir, "settings.json"), "utf8"));
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

// src/hook.ts
init_prompt_text();

// src/util/errors.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
init_json();
import { readFileSync as readFileSync4 } from "node:fs";
function readStdinEvent() {
  let raw;
  try {
    raw = readFileSync4(0, "utf8");
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

// src/version.ts
import { readFileSync as readFileSync5 } from "node:fs";
function pluginVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync5(new URL("../package.json", import.meta.url), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// src/hook.ts
var DELIVERY_TIMEOUT_MS = 300;
var ERROR_LOG_CAP_BYTES = 64 * 1024;
function logError(dataDir, error) {
  try {
    const logs = join7(dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    const path = join7(logs, "hook-errors.log");
    let size = 0;
    try {
      size = statSync2(path).size;
    } catch {
      size = 0;
    }
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${errorMessage(error)}
`;
    appendFileSync(path, line, {
      flag: size > ERROR_LOG_CAP_BYTES ? "w" : "a"
    });
  } catch {
  }
}
async function deliver(address, envelope) {
  const reply = await loopbackRequest(
    address,
    { method: "POST", path: "/events/hook", body: JSON.stringify(envelope) },
    DELIVERY_TIMEOUT_MS
  );
  return reply !== null && reply.status >= 200 && reply.status < 300;
}
function bufferEvent(dataDir, envelope) {
  const buffer = join7(dataDir, "buffer");
  mkdirSync(buffer, { recursive: true });
  if (readdirSync2(buffer).length >= BUFFER_LIMIT) {
    noteDropped(dataDir);
    return;
  }
  const name = `${envelope.received_at}-${envelope.id}.json`;
  writeFileSync3(join7(buffer, name), JSON.stringify(envelope), { flag: "wx" });
}
function noteAutostartPause(dataDir, event) {
  const sessionId = event.session_id;
  if (event.hook_event_name !== "SessionStart" || typeof sessionId !== "string" || sessionId.length === 0) {
    return;
  }
  const settings = loadSettings(dataDir);
  if (!settings.autostart && event.source === "startup") {
    try {
      const pauseDir = join7(dataDir, "pause");
      mkdirSync(pauseDir, { recursive: true });
      writeFileSync3(join7(pauseDir, pauseFileName(sessionId)), "");
      writeFileSync3(join7(pauseDir, `${pauseFileName(sessionId)}.auto`), "");
    } catch (error) {
      logError(dataDir, error);
    }
  }
}
async function noteHostProcess(event) {
  if (event.hook_event_name !== "SessionStart") {
    return;
  }
  try {
    const { captureHostProcess: captureHostProcess2 } = await Promise.resolve().then(() => (init_host_process(), host_process_exports));
    const host = captureHostProcess2();
    if (host !== null) {
      event.host_pid = host.pid;
      event.host_started_at = host.startedAt;
    }
  } catch {
  }
}
async function buildEnvelope(event, settings) {
  const promptText = typeof event.prompt === "string" ? event.prompt : null;
  const { REDACTION_VERSION: REDACTION_VERSION2, redactHookEvent: redactHookEvent2 } = await Promise.resolve().then(() => (init_redact(), redact_exports));
  const redacted = redactHookEvent2(event);
  if (promptText !== null) {
    const columns = promptTextColumns(promptText);
    redacted.prompt_kind = classifyPrompt(promptText);
    redacted.prompt_chars = columns.chars;
    redacted.prompt_lines = columns.lines;
    if (!settings.storePromptText) {
      redacted.prompt = { chars: promptText.length };
    }
  }
  return {
    id: randomBytes(16).toString("hex"),
    received_at: Date.now(),
    redaction_version: REDACTION_VERSION2,
    plugin_version: pluginVersion(),
    event: redacted
  };
}
async function main() {
  const event = readStdinEvent();
  if (event === null) {
    return;
  }
  const dataDir = resolveDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    logError(dataDir, error);
    return;
  }
  noteAutostartPause(dataDir, event);
  if (isRecordingOff(dataDir, event)) {
    return;
  }
  const settings = loadSettings(dataDir);
  if (typeof event.cwd === "string" && isExcludedFolder(event.cwd, settings.excludedFolders)) {
    return;
  }
  await noteHostProcess(event);
  const envelope = await buildEnvelope(event, settings);
  const address = readDaemonAddress(dataDir);
  const delivered = address !== null && await deliver(address, envelope);
  if (!delivered) {
    try {
      bufferEvent(dataDir, envelope);
    } catch (error) {
      logError(dataDir, error);
    }
    try {
      await ensureDaemon(dataDir);
    } catch (error) {
      logError(dataDir, error);
    }
  }
}
try {
  await main();
} catch {
}
