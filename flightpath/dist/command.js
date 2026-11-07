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

// src/util/fs.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch {
  }
}
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
var init_fs = __esm({
  "src/util/fs.ts"() {
    "use strict";
  }
});

// src/commands.ts
function actionOf(commandName) {
  const name = commandName.replace(/^\//, "");
  for (const action of COMMAND_ACTIONS) {
    if (name === `flightpath:${action}`) return action;
  }
  return null;
}
function expandedCommandName(prompt) {
  return EXPANDED_FORM.exec(prompt)?.[1] ?? null;
}
function expandedAction(prompt) {
  const name = expandedCommandName(prompt);
  return name === null ? null : actionOf(name);
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
var COMMAND_ACTIONS, EXPANDED_FORM;
var init_commands = __esm({
  "src/commands.ts"() {
    "use strict";
    COMMAND_ACTIONS = [
      "status",
      "stop",
      "start",
      "off",
      "forget",
      "open"
    ];
    EXPANDED_FORM = /^<command-message>[^<]*<\/command-message>\s*<command-name>([^<\s]+)<\/command-name>/;
  }
});

// src/settings/index.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join7, resolve, win32 } from "node:path";
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
    parsed = JSON.parse(readFileSync4(join7(dataDir, "settings.json"), "utf8"));
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
function settingsScreenUrl(dataDir) {
  const address = readDaemonAddress(dataDir);
  if (address === null) return null;
  return `http://127.0.0.1:${address.port}/#settings&token=${address.token}`;
}
var SETTING_SPECS, SPEC_BY_NAME;
var init_settings = __esm({
  "src/settings/index.ts"() {
    "use strict";
    init_fs();
    SETTING_SPECS = [
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
    SPEC_BY_NAME = new Map(SETTING_SPECS.map((spec) => [spec.name, spec]));
  }
});

// src/storage/request-tokens.ts
function flightpathOverheadTokens(db, sessionId) {
  const row = db.prepare(OVERHEAD_SQL).get(sessionId);
  return row.total;
}
var REQUEST_TOKEN_SUM, OVERHEAD_SQL;
var init_request_tokens = __esm({
  "src/storage/request-tokens.ts"() {
    "use strict";
    REQUEST_TOKEN_SUM = "COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_1h_tokens, 0)";
    OVERHEAD_SQL = `SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) AS total
  FROM requests r JOIN turns t ON t.id = r.turn_id
  WHERE r.session_id = ? AND t.flightpath_command = 1`;
  }
});

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
var init_warning_filter = __esm({
  "src/storage/warning-filter.ts"() {
    "use strict";
  }
});

// src/storage/sqlite.ts
var sqlite, DatabaseSync;
var init_sqlite = __esm({
  "src/storage/sqlite.ts"() {
    "use strict";
    init_warning_filter();
    installSqliteWarningFilter();
    sqlite = process.getBuiltinModule(
      "node:sqlite"
    );
    DatabaseSync = sqlite.DatabaseSync;
  }
});

// src/util/json.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bool(record, key) {
  return record[key] === true;
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
var init_json = __esm({
  "src/util/json.ts"() {
    "use strict";
  }
});

// src/effort.ts
function effortLevel(value) {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  return EFFORT_LEVELS.has(level) ? level : null;
}
var EFFORT_LEVELS;
var init_effort = __esm({
  "src/effort.ts"() {
    "use strict";
    EFFORT_LEVELS = /* @__PURE__ */ new Set([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  }
});

// src/prompt-kind.ts
function isAgentMessage(prompt) {
  return prompt.trimStart().startsWith(`${AGENT_MESSAGE_OPENING} from="`);
}
var AGENT_MESSAGE_OPENING, TASK_NOTIFICATION_OPENING;
var init_prompt_kind = __esm({
  "src/prompt-kind.ts"() {
    "use strict";
    init_commands();
    AGENT_MESSAGE_OPENING = "<agent-message";
    TASK_NOTIFICATION_OPENING = "<task-notification>";
  }
});

// src/redact/allowlist.ts
var init_allowlist = __esm({
  "src/redact/allowlist.ts"() {
    "use strict";
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
var PROMPT_TEXT_LIMIT, UPDATE_TURN_PROMPT, UPDATE_TURN_PROMPT_IF_UNSET, FILL_TURN_PROMPT_FIGURES;
var init_prompt_text = __esm({
  "src/storage/prompt-text.ts"() {
    "use strict";
    PROMPT_TEXT_LIMIT = 2e3;
    UPDATE_TURN_PROMPT = "UPDATE turns SET prompt_text = ?, prompt_chars = ?, prompt_lines = ? WHERE id = ?";
    UPDATE_TURN_PROMPT_IF_UNSET = `${UPDATE_TURN_PROMPT} AND prompt_text IS NULL`;
    FILL_TURN_PROMPT_FIGURES = "UPDATE turns SET prompt_chars = ?, prompt_lines = ? WHERE id = ? AND prompt_chars IS NULL";
  }
});

// src/redact/index.ts
var init_redact = __esm({
  "src/redact/index.ts"() {
    "use strict";
    init_allowlist();
    init_secrets();
    init_prompt_text();
    init_json();
  }
});

// src/util/event-loop.ts
var init_event_loop = __esm({
  "src/util/event-loop.ts"() {
    "use strict";
  }
});

// src/transcripts/parse.ts
var CLAUDE_OPENINGS, NON_PROMPT_OPENINGS, COMMAND_OPENINGS;
var init_parse = __esm({
  "src/transcripts/parse.ts"() {
    "use strict";
    init_effort();
    init_prompt_kind();
    init_redact();
    init_secrets();
    init_json();
    CLAUDE_OPENINGS = [
      { marker: "<command-name>", command: true },
      { marker: "<local-command-stdout>", command: true },
      { marker: "<local-command-stderr>", command: true },
      { marker: "<local-command-caveat>", command: false },
      { marker: TASK_NOTIFICATION_OPENING, command: false },
      { marker: AGENT_MESSAGE_OPENING, command: false }
    ];
    NON_PROMPT_OPENINGS = CLAUDE_OPENINGS.map(
      (opening) => opening.marker
    );
    COMMAND_OPENINGS = CLAUDE_OPENINGS.filter(
      (opening) => opening.command
    ).map((opening) => opening.marker);
  }
});

// src/transcripts/follower.ts
import { homedir as homedir2 } from "node:os";
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, join as join8, relative, sep } from "node:path";
function resolveClaudeConfigDir(env = process.env, home = homedir2()) {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== void 0 && configured.length > 0 ? configured : join8(home, ".claude");
}
var CHUNK_BYTES, MAX_LINE_BYTES, DAY_MS, TAIL_BYTES;
var init_follower = __esm({
  "src/transcripts/follower.ts"() {
    "use strict";
    init_redact();
    init_secrets();
    init_settings();
    init_request_tokens();
    init_event_loop();
    init_json();
    init_fs();
    init_parse();
    CHUNK_BYTES = 1 * 1024 * 1024;
    MAX_LINE_BYTES = 16 * 1024 * 1024;
    DAY_MS = 24 * 60 * 60 * 1e3;
    TAIL_BYTES = 256 * 1024;
  }
});

// src/settings-files.ts
import { existsSync as existsSync2, readFileSync as readFileSync5, readdirSync as readdirSync2 } from "node:fs";
import { join as join9 } from "node:path";
function userAndProjectSettingsFiles(cwd) {
  const configDir = resolveClaudeConfigDir();
  return [
    join9(configDir, "settings.json"),
    join9(configDir, "settings.local.json"),
    join9(cwd, ".claude", "settings.json"),
    join9(cwd, ".claude", "settings.local.json")
  ];
}
function isMissing(error) {
  return error.code === "ENOENT";
}
function readSettingsFiles(files) {
  const read = { settings: [], unreadable: false };
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync5(file, "utf8"));
      if (isPlainObject(parsed)) read.settings.push(parsed);
      else read.unreadable = true;
    } catch (error) {
      if (!isMissing(error)) read.unreadable = true;
    }
  }
  return read;
}
var init_settings_files = __esm({
  "src/settings-files.ts"() {
    "use strict";
    init_follower();
    init_json();
  }
});

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
var init_branch_link = __esm({
  "src/storage/branch-link.ts"() {
    "use strict";
  }
});

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
var init_conditions = __esm({
  "src/storage/conditions.ts"() {
    "use strict";
  }
});

// src/storage/skill-load.ts
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
var MATCH_WINDOW_MS, NEAREST;
var init_skill_load = __esm({
  "src/storage/skill-load.ts"() {
    "use strict";
    MATCH_WINDOW_MS = 1e4;
    NEAREST = "ORDER BY ABS(occurred_at - ?), id LIMIT 1";
  }
});

// src/util/host-process.ts
function sameProcessStart(a, b) {
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
var START_TIME_TOLERANCE_MS, WINDOWS_STARTED_AT_PROPERTY, WINDOWS_TABLE_SCRIPT;
var init_host_process = __esm({
  "src/util/host-process.ts"() {
    "use strict";
    START_TIME_TOLERANCE_MS = 2e3;
    WINDOWS_STARTED_AT_PROPERTY = `@{n='StartedAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}`;
    WINDOWS_TABLE_SCRIPT = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,${WINDOWS_STARTED_AT_PROPERTY},Name,CommandLine | ConvertTo-Json -Compress`;
  }
});

// src/journey/index.ts
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
var FILL_REQUEST_EFFORT_SQL;
var init_journey = __esm({
  "src/journey/index.ts"() {
    "use strict";
    init_commands();
    init_effort();
    init_prompt_kind();
    init_settings_files();
    init_branch_link();
    init_conditions();
    init_prompt_text();
    init_skill_load();
    init_host_process();
    init_json();
    FILL_REQUEST_EFFORT_SQL = "UPDATE requests SET effort = ? WHERE session_id = ? AND turn_id = ? AND effort IS NULL";
  }
});

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
function readHookStats(raw2) {
  const empty = {
    executions: 0,
    total_ms: 0,
    max_ms: 0,
    by_hook: {}
  };
  if (typeof raw2 !== "string") return empty;
  try {
    const parsed = JSON.parse(raw2);
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
var init_store = __esm({
  "src/telemetry/store.ts"() {
    "use strict";
    init_conditions();
    init_json();
  }
});

// src/telemetry/index.ts
var init_telemetry = __esm({
  "src/telemetry/index.ts"() {
    "use strict";
    init_effort();
    init_redact();
    init_settings();
    init_json();
    init_store();
  }
});

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
function recordSkillText(st, input) {
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
    recordSkillText: (input) => recordSkillText(st, input),
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
var DELETE_PROMPT_ATTACHMENTS_SQL, INSERT_CLAUDE_MESSAGE_SQL;
var init_ingest = __esm({
  "src/transcripts/ingest.ts"() {
    "use strict";
    init_branch_link();
    init_conditions();
    init_prompt_text();
    init_skill_load();
    init_json();
    DELETE_PROMPT_ATTACHMENTS_SQL = "DELETE FROM prompt_attachments WHERE session_id = ? AND turn_id = ?";
    INSERT_CLAUDE_MESSAGE_SQL = `INSERT INTO human_events (session_id, turn_id, kind, occurred_at, detail)
  SELECT ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM human_events
    WHERE session_id = ? AND occurred_at = ? AND kind = ? AND detail = ?
  )`;
  }
});

// src/transcripts/index.ts
var init_transcripts = __esm({
  "src/transcripts/index.ts"() {
    "use strict";
    init_follower();
    init_ingest();
  }
});

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
var SESSION_AGGREGATES, COUNT_SESSIONS_SQL, SESSION_LIST_SQL, SESSION_ROW_SQL, LIVE_SESSION_HOSTS_SQL, LIVE_SESSIONS_SQL, TURN_ROWS_SQL, STEP_ROWS_SQL, HUMAN_ROWS_SQL, BRANCH_ROWS_SQL, SEGMENT_ROWS_SQL, PAUSE_ROWS_SQL, REQUEST_COLUMNS, REQUEST_ROWS_SQL, LOAD_ROWS_SQL, ATTACHMENT_ROWS_SQL, SESSION_SHAPES_SQL, SAMPLE_ROWS_SQL, CONTEXT_REPORTS_SQL, COMPACTION_FILES_SQL, DISMISSALS_SQL, DISMISS_FINDING_SQL, TURN_FOR_PROMPT_SQL, TURN_ROWS_SINCE_SQL, STEP_ROWS_SINCE_SQL, HUMAN_ROWS_SINCE_SQL, BRANCH_ROWS_SINCE_SQL, SEGMENT_ROWS_SINCE_SQL, PAUSE_ROWS_SINCE_SQL, REQUEST_ROWS_SINCE_SQL, SAMPLE_ROWS_SINCE_SQL, REQUEST_ROWS_FOR_BRANCH_SQL, LOAD_ROWS_SINCE_SQL, ATTACHMENT_ROWS_SINCE_SQL, ATTACHMENTS_FOR_TURN_SQL, ROW_CHANGES_SINCE_SQL, CHANGE_MAX_SEQ_SQL, CLEAR_ROW_CHANGES_SQL, CLEAR_SESSION_ROW_CHANGES_SQL, CLEAR_ALL_ROW_CHANGES_SQL, CHANGE_SESSIONS_SQL, REQUEST_BY_ID_SQL, STEP_BY_ID_SQL, TURN_BY_ID_SQL, BRANCH_BY_ID_SQL, PAUSE_BY_ID_SQL, SAMPLE_BY_ID_SQL, LOAD_BY_ID_SQL, SESSION_SCAN_SQL, STREAM_PROBE_SQL;
var init_read = __esm({
  "src/storage/read.ts"() {
    "use strict";
    init_json();
    init_request_tokens();
    SESSION_AGGREGATES = `
    (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turnCount,
    (SELECT COUNT(*) FROM requests WHERE session_id = s.id) AS requestCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id) AS stepCount,
    (SELECT COUNT(*) FROM steps WHERE session_id = s.id AND outcome = 'open') AS openStepCount,
    (SELECT COUNT(*) FROM pauses WHERE session_id = s.id) AS pauseCount,
    (SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) FROM requests WHERE session_id = s.id) AS tokensProcessed,
    (SELECT cs.context_tokens FROM context_samples cs WHERE cs.session_id = s.id ORDER BY cs.sampled_at DESC, cs.id DESC LIMIT 1) AS contextNow,
    (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText`;
    COUNT_SESSIONS_SQL = "SELECT COUNT(*) AS n FROM sessions";
    SESSION_LIST_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id ORDER BY (s.status = 'live') DESC, s.last_seen_at DESC`;
    SESSION_ROW_SQL = `SELECT s.id, s.project_path AS projectPath, s.model, s.status, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.joined_partway AS joinedPartway, s.end_seen AS endSeen, s.tokens_partial AS tokensPartial, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt, c.sources_seen AS sourcesSeen, c.permission_modes AS permissionModes, ${SESSION_AGGREGATES} FROM sessions s LEFT JOIN session_conditions c ON c.session_id = s.id WHERE s.id = ?`;
    LIVE_SESSION_HOSTS_SQL = `SELECT s.id, s.last_seen_at AS lastSeenAt, s.host_pid AS hostPid, s.host_started_at AS hostStartedAt FROM sessions s WHERE s.status = 'live' ORDER BY s.id ASC`;
    LIVE_SESSIONS_SQL = `SELECT s.id, (SELECT prompt_text FROM turns WHERE session_id = s.id ORDER BY sequence ASC LIMIT 1) AS firstPromptText FROM sessions s WHERE s.status = 'live' ORDER BY s.first_seen_at ASC`;
    TURN_ROWS_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? ORDER BY sequence ASC";
    STEP_ROWS_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? ORDER BY started_at ASC, id ASC";
    HUMAN_ROWS_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
    BRANCH_ROWS_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? ORDER BY started_at ASC, id ASC";
    SEGMENT_ROWS_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? ORDER BY started_at ASC, id ASC";
    PAUSE_ROWS_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? ORDER BY paused_at ASC, id ASC";
    REQUEST_COLUMNS = "id, turn_id AS turnId, branch_id AS branchId, model, query_source AS querySource, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_5m_tokens AS cacheWrite5mTokens, cache_write_1h_tokens AS cacheWrite1hTokens, token_source AS tokenSource, started_at AS startedAt, duration_ms AS durationMs, effort, shape_hash AS shapeHash, cache_lifetimes AS cacheLifetimes";
    REQUEST_ROWS_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? ORDER BY started_at ASC, id ASC`;
    LOAD_ROWS_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? ORDER BY occurred_at ASC, id ASC";
    ATTACHMENT_ROWS_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? ORDER BY id ASC";
    SESSION_SHAPES_SQL = "SELECT hash, system_bytes AS systemBytes, tools FROM request_shapes WHERE hash IN (SELECT hash FROM session_shapes WHERE session_id = ?) OR hash IN (SELECT shape_hash FROM requests WHERE session_id = ? AND shape_hash IS NOT NULL) ORDER BY hash ASC";
    SAMPLE_ROWS_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? ORDER BY sampled_at ASC, id ASC";
    CONTEXT_REPORTS_SQL = "SELECT model, window, autocompact_buffer AS autocompactBuffer, system_prompt AS systemPrompt, system_tools AS systemTools, mcp_instructions AS mcpInstructions, memory_files AS memoryFiles, skills, reported_at AS reportedAt FROM context_reports WHERE session_id = ? ORDER BY reported_at ASC";
    COMPACTION_FILES_SQL = "SELECT id, at, name, size_bytes AS sizeBytes, reread FROM compaction_files WHERE session_id = ? ORDER BY at ASC, id ASC";
    DISMISSALS_SQL = "SELECT finding_id AS findingId FROM finding_dismissals WHERE session_id = ?";
    DISMISS_FINDING_SQL = "INSERT INTO finding_dismissals (session_id, finding_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT (session_id, finding_id) DO NOTHING";
    TURN_FOR_PROMPT_SQL = "SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?";
    TURN_ROWS_SINCE_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC";
    STEP_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE session_id = ? AND id > ? ORDER BY id ASC";
    HUMAN_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, step_id AS stepId, kind, occurred_at AS occurredAt, decision, decision_source AS decisionSource, detail FROM human_events WHERE session_id = ? AND id > ? ORDER BY id ASC";
    BRANCH_ROWS_SINCE_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE session_id = ? AND id > ? ORDER BY id ASC";
    SEGMENT_ROWS_SINCE_SQL = "SELECT id, kind, started_at AS startedAt, context_tokens AS contextTokens FROM segments WHERE session_id = ? AND id > ? ORDER BY id ASC";
    PAUSE_ROWS_SINCE_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE session_id = ? AND id > ? ORDER BY id ASC";
    REQUEST_ROWS_SINCE_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND id > ? ORDER BY id ASC`;
    SAMPLE_ROWS_SINCE_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE session_id = ? AND id > ? ORDER BY id ASC";
    REQUEST_ROWS_FOR_BRANCH_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ? AND branch_id = ? ORDER BY started_at ASC, id ASC`;
    LOAD_ROWS_SINCE_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE session_id = ? AND id > ? ORDER BY id ASC";
    ATTACHMENT_ROWS_SINCE_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND id > ? ORDER BY id ASC";
    ATTACHMENTS_FOR_TURN_SQL = "SELECT id, turn_id AS turnId, kind, name, size_bytes AS sizeBytes, line_count AS lineCount FROM prompt_attachments WHERE session_id = ? AND turn_id = ? ORDER BY id ASC";
    ROW_CHANGES_SINCE_SQL = "SELECT seq, table_name AS tableName, row_id AS rowId FROM row_changes WHERE session_id = ? AND seq > ? ORDER BY seq ASC";
    CHANGE_MAX_SEQ_SQL = "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM row_changes WHERE session_id = ?";
    CLEAR_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ? AND seq <= ?";
    CLEAR_SESSION_ROW_CHANGES_SQL = "DELETE FROM row_changes WHERE session_id = ?";
    CLEAR_ALL_ROW_CHANGES_SQL = "DELETE FROM row_changes";
    CHANGE_SESSIONS_SQL = "SELECT DISTINCT session_id AS sessionId FROM row_changes";
    REQUEST_BY_ID_SQL = `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`;
    STEP_BY_ID_SQL = "SELECT id, session_id AS sessionId, turn_id AS turnId, branch_id AS branchId, tool_name AS toolName, input_summary AS inputSummary, outcome, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs, result_size AS resultSize, result_request_id AS resultRequestId, context_chars AS contextChars, context_images AS contextImages, async_launch AS asyncLaunch, tool_use_id AS toolUseId, saved_output_bytes AS savedOutputBytes FROM steps WHERE id = ?";
    TURN_BY_ID_SQL = "SELECT id, sequence, started_at AS startedAt, ended_at AS endedAt, prompt_text AS promptText, flightpath_command AS flightpathCommand, prompt_chars AS promptChars, prompt_lines AS promptLines, image_count AS imageCount, image_bytes AS imageBytes FROM turns WHERE id = ?";
    BRANCH_BY_ID_SQL = "SELECT id, agent_id AS agentId, agent_type AS agentType, kind, spawning_step_id AS spawningStepId, started_at AS startedAt, ended_at AS endedAt, total_tokens AS totalTokens FROM branches WHERE id = ?";
    PAUSE_BY_ID_SQL = "SELECT id, paused_at AS pausedAt, resumed_at AS resumedAt FROM pauses WHERE id = ?";
    SAMPLE_BY_ID_SQL = "SELECT id, request_id AS requestId, sampled_at AS sampledAt, context_tokens AS contextTokens FROM context_samples WHERE id = ?";
    LOAD_BY_ID_SQL = "SELECT id, kind, name, trigger, memory_type AS memoryType, file_path AS filePath, occurred_at AS occurredAt, source, size_bytes AS sizeBytes, item_count AS itemCount, names, branch_id AS branchId, parent_load_id AS parentLoadId, line_count AS lineCount FROM loads WHERE id = ?";
    SESSION_SCAN_SQL = "SELECT id, status, last_seen_at AS lastSeenAt FROM sessions ORDER BY id ASC";
    STREAM_PROBE_SQL = `SELECT
  (SELECT COALESCE(MAX(id), 0) FROM turns WHERE session_id = ?) AS turnMax,
  (SELECT COALESCE(MAX(id), 0) FROM steps WHERE session_id = ?) AS stepMax,
  (SELECT COALESCE(MAX(id), 0) FROM human_events WHERE session_id = ?) AS humanMax,
  (SELECT COALESCE(MAX(id), 0) FROM branches WHERE session_id = ?) AS branchMax,
  (SELECT COALESCE(MAX(id), 0) FROM segments WHERE session_id = ?) AS segmentMax,
  (SELECT COALESCE(MAX(id), 0) FROM pauses WHERE session_id = ?) AS pauseMax,
  (SELECT COALESCE(MAX(id), 0) FROM context_samples WHERE session_id = ?) AS sampleMax,
  (SELECT COALESCE(MAX(id), 0) FROM loads WHERE session_id = ?) AS loadMax,
  (SELECT COALESCE(MAX(id), 0) FROM prompt_attachments WHERE session_id = ?) AS attachmentMax`;
  }
});

// src/storage/schema.ts
var MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12, MIGRATION_13, MIGRATION_14, MIGRATION_15, MIGRATION_16, MIGRATION_17, MIGRATION_18, MIGRATION_19, MIGRATION_20, MIGRATION_21, MIGRATION_22, MIGRATION_23, MIGRATION_24, MIGRATIONS, FORGET_ORDER;
var init_schema = __esm({
  "src/storage/schema.ts"() {
    "use strict";
    MIGRATION_1 = `
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
    MIGRATION_2 = `
-- Token completeness (ADR-0019): set when a source skipped entries
-- that should have carried token usage, so the session's token data
-- is known incomplete rather than silently short.
ALTER TABLE sessions ADD COLUMN tokens_partial INTEGER NOT NULL DEFAULT 0;
`;
    MIGRATION_3 = `
-- Hook execution counts and timings from telemetry, as JSON.
ALTER TABLE session_conditions ADD COLUMN hook_stats TEXT;
`;
    MIGRATION_4 = `
-- Finding a session's open steps (turn end, branch end) is
-- served by this index instead of scanning every step the
-- session has: the cost is the number of open steps, not the
-- session's length.
CREATE INDEX steps_session_outcome ON steps (session_id, outcome);
`;
    MIGRATION_5 = `
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
    MIGRATION_6 = `
-- A stored prompt's full size: its length and line count,
-- recorded before the stored text is cut to its first 2,000
-- characters. Rows already stored get theirs from the one-time
-- pass in storage/index.ts, which also redacts and caps their
-- text; it finds its rows by prompt_chars still being NULL.
ALTER TABLE turns ADD COLUMN prompt_chars INTEGER;
ALTER TABLE turns ADD COLUMN prompt_lines INTEGER;
`;
    MIGRATION_7 = `
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
    MIGRATION_8 = `
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
    MIGRATION_9 = `
-- Which closer ended a turn or a branch: 'concluded' when
-- the daemon's conclusion ended it, null for a real closing
-- (a stop, a new prompt, an end event). A revival reopens
-- exactly the rows the conclusion closed, so the mark has
-- to name the closer; steps carry the same distinction in
-- outcome_source.
ALTER TABLE turns ADD COLUMN end_source TEXT;
ALTER TABLE branches ADD COLUMN end_source TEXT;
`;
    MIGRATION_10 = `
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
    MIGRATION_11 = `
-- A step result's size as it entered context, beside its
-- raw size: the characters of the result's text as the
-- transcript carried it, and the count of its images
-- (counted, never read). Null until the transcript names
-- them: a result no transcript carried is unknown, never 0.
ALTER TABLE steps ADD COLUMN context_chars INTEGER;
ALTER TABLE steps ADD COLUMN context_images INTEGER;
`;
    MIGRATION_12 = `
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
    MIGRATION_13 = `
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
    MIGRATION_14 = `
-- What a /context report gave for the system prompt, the MCP
-- server instructions and the skills listing, in tokens:
-- Claude Code's own count of each. Null where the report
-- listed no such row, and for reports stored before these
-- columns existed.
ALTER TABLE context_reports ADD COLUMN system_prompt INTEGER;
ALTER TABLE context_reports ADD COLUMN mcp_instructions INTEGER;
ALTER TABLE context_reports ADD COLUMN skills INTEGER;
`;
    MIGRATION_15 = `
-- Whether a step's result only announced a subagent started in
-- the background (1), as against carrying the answer (0). Null
-- until the transcript names the result. The subagent's report
-- arrives later, as a hand-back.
ALTER TABLE steps ADD COLUMN async_launch INTEGER;
`;
    MIGRATION_16 = `
-- What a /context report gave for the system tools, in
-- tokens: Claude Code's own count of the tool definitions.
-- Null where the report listed no such row, and for reports
-- stored before this column existed.
ALTER TABLE context_reports ADD COLUMN system_tools INTEGER;
`;
    MIGRATION_17 = `
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
    MIGRATION_18 = `
-- What from_command marked is restated (ADR-0021): it flagged
-- other commands' turns, never Flightpath's, so every stored
-- value is cleared rather than carried into the new meaning \u2014
-- keeping one would bill that command's cost to Flightpath.
ALTER TABLE turns RENAME COLUMN from_command TO flightpath_command;
UPDATE turns SET flightpath_command = 0;
`;
    MIGRATION_19 = `
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
    MIGRATION_20 = `
-- What a /context report gave for the memory files (the
-- instruction files loaded at session start), in tokens:
-- Claude Code's own count of them. Null where the report
-- listed no such row, and for reports stored before this
-- column existed.
ALTER TABLE context_reports ADD COLUMN memory_files INTEGER;
`;
    MIGRATION_21 = `
-- The names a startup listing carries, as a JSON array: the
-- skills Claude Code listed to the model. Names only (ADR-0004).
-- Null for every other load, and for listings stored before
-- this column existed.
ALTER TABLE loads ADD COLUMN names TEXT;
`;
    MIGRATION_22 = `
-- The subagent a startup listing belongs to: a subagent's
-- transcript re-sends the listings for its own context. Null
-- for the main thread's loads, and for every load stored
-- before this column existed.
ALTER TABLE loads ADD COLUMN branch_id INTEGER REFERENCES branches(id);
`;
    MIGRATION_23 = `
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
    MIGRATION_24 = `
-- A subagent's definition was never in its transcript: the
-- loads stored as agent-definition were the reminder or a
-- preloaded skill, mislabelled. Subagents' preloaded skills
-- are loads of kind preloaded-skill now.
DELETE FROM loads WHERE kind = 'agent-definition';
`;
    MIGRATIONS = [
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
    FORGET_ORDER = [
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
  }
});

// src/storage/index.ts
var storage_exports = {};
__export(storage_exports, {
  ATTACHMENTS_FOR_TURN_SQL: () => ATTACHMENTS_FOR_TURN_SQL,
  ATTACHMENT_ROWS_SINCE_SQL: () => ATTACHMENT_ROWS_SINCE_SQL,
  ATTACHMENT_ROWS_SQL: () => ATTACHMENT_ROWS_SQL,
  BRANCH_BY_ID_SQL: () => BRANCH_BY_ID_SQL,
  BRANCH_ROWS_SINCE_SQL: () => BRANCH_ROWS_SINCE_SQL,
  BRANCH_ROWS_SQL: () => BRANCH_ROWS_SQL,
  CHANGE_MAX_SEQ_SQL: () => CHANGE_MAX_SEQ_SQL,
  COMPACTION_FILES_SQL: () => COMPACTION_FILES_SQL,
  DISMISSALS_SQL: () => DISMISSALS_SQL,
  HUMAN_ROWS_SINCE_SQL: () => HUMAN_ROWS_SINCE_SQL,
  HUMAN_ROWS_SQL: () => HUMAN_ROWS_SQL,
  LIVE_SESSIONS_SQL: () => LIVE_SESSIONS_SQL,
  LIVE_SESSION_HOSTS_SQL: () => LIVE_SESSION_HOSTS_SQL,
  LOAD_ROWS_SINCE_SQL: () => LOAD_ROWS_SINCE_SQL,
  LOAD_ROWS_SQL: () => LOAD_ROWS_SQL,
  PAUSE_BY_ID_SQL: () => PAUSE_BY_ID_SQL,
  PAUSE_ROWS_SINCE_SQL: () => PAUSE_ROWS_SINCE_SQL,
  PAUSE_ROWS_SQL: () => PAUSE_ROWS_SQL,
  REQUEST_BY_ID_SQL: () => REQUEST_BY_ID_SQL,
  REQUEST_ROWS_FOR_BRANCH_SQL: () => REQUEST_ROWS_FOR_BRANCH_SQL,
  REQUEST_ROWS_SINCE_SQL: () => REQUEST_ROWS_SINCE_SQL,
  REQUEST_ROWS_SQL: () => REQUEST_ROWS_SQL,
  ROW_CHANGES_SINCE_SQL: () => ROW_CHANGES_SINCE_SQL,
  SAMPLE_BY_ID_SQL: () => SAMPLE_BY_ID_SQL,
  SAMPLE_ROWS_SINCE_SQL: () => SAMPLE_ROWS_SINCE_SQL,
  SAMPLE_ROWS_SQL: () => SAMPLE_ROWS_SQL,
  SEGMENT_ROWS_SINCE_SQL: () => SEGMENT_ROWS_SINCE_SQL,
  SEGMENT_ROWS_SQL: () => SEGMENT_ROWS_SQL,
  SESSION_LIST_SQL: () => SESSION_LIST_SQL,
  SESSION_ROW_SQL: () => SESSION_ROW_SQL,
  SESSION_SCAN_SQL: () => SESSION_SCAN_SQL,
  SESSION_SHAPES_SQL: () => SESSION_SHAPES_SQL,
  STEP_BY_ID_SQL: () => STEP_BY_ID_SQL,
  STEP_ROWS_SINCE_SQL: () => STEP_ROWS_SINCE_SQL,
  STEP_ROWS_SQL: () => STEP_ROWS_SQL,
  STREAM_PROBE_SQL: () => STREAM_PROBE_SQL,
  TURN_BY_ID_SQL: () => TURN_BY_ID_SQL,
  TURN_FOR_PROMPT_SQL: () => TURN_FOR_PROMPT_SQL,
  TURN_ROWS_SINCE_SQL: () => TURN_ROWS_SINCE_SQL,
  TURN_ROWS_SQL: () => TURN_ROWS_SQL,
  openStorage: () => openStorage
});
import { mkdirSync, statSync as statSync2 } from "node:fs";
import { join as join10 } from "node:path";
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
          bytes += statSync2(path).size;
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
  mkdirSync(options.dataDir, { recursive: true });
  const dbPath = join10(options.dataDir, "flightpath.db");
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
var MAX_SCHEMA_VERSION;
var init_storage = __esm({
  "src/storage/index.ts"() {
    "use strict";
    init_journey();
    init_secrets();
    init_telemetry();
    init_transcripts();
    init_prompt_text();
    init_read();
    init_schema();
    init_sqlite();
    init_read();
    MAX_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  }
});

// src/command-handler.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync6,
  statSync as statSync3,
  writeFileSync as writeFileSync4
} from "node:fs";
import { join as join11 } from "node:path";

// src/buffer.ts
init_fs();
import { readdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var DROPPED_FILE = "buffer-dropped";
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

// src/command-handler.ts
init_commands();

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

// src/daemon/last-error.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
init_fs();
var LAST_ERROR_FILE = "last-error";
function readLastError(dataDir) {
  try {
    const parsed = JSON.parse(
      readFileSync3(join4(dataDir, LAST_ERROR_FILE), "utf8")
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
    return { kind: "database", path: join4(dataDir, "flightpath.db") };
  }
  return { kind: "other" };
}
function nextStepFor(lastError, dataDir) {
  const problem = startProblem(lastError, dataDir);
  if (problem.kind === "port") {
    return "change the daemon's port in settings";
  }
  if (problem.kind === "database") {
    return `the database file is ${problem.path} \u2014 check it isn't damaged or held by another program`;
  }
  return null;
}

// src/daemon/lock.ts
init_fs();
import { join as join5 } from "node:path";
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
  return join5(dataDir, "daemon-start.lock");
}

// src/daemon/spawn.ts
import { closeSync, existsSync, openSync, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";
var START_LOCK_WINDOW_MS = 1e4;
function daemonEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join6(here, "daemon.js");
  return existsSync(beside) ? beside : join6(here, "..", "daemon.js");
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

// src/format.ts
var CHARS_PER_TOKEN = 2.9;
var ESTIMATE_HINT = `Worked out from the number of characters, at about ${CHARS_PER_TOKEN} per token. Close, not exact.`;
function formatAge(thenMs, nowMs) {
  const seconds = Math.max(1, Math.round((nowMs - thenMs) / 1e3));
  const amount = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 90) return amount(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return amount(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return amount(hours, "hour");
  return amount(Math.round(hours / 24), "day");
}

// src/open.ts
import { spawn } from "node:child_process";
init_fs();
var spawnDetached = (file, args, options) => spawn(file, args, options);
function liveViewUrl(dataDir, sessionId) {
  const address = readDaemonAddress(dataDir);
  if (address === null) return null;
  const session = encodeURIComponent(sessionId);
  const token = encodeURIComponent(address.token);
  return `http://127.0.0.1:${address.port}/#session/${session}&token=${token}`;
}
function openerFor(platform) {
  switch (platform) {
    case "win32":
      return { file: "cmd", args: ["/c", "start", '""'], quoteAddress: true };
    case "darwin":
      return { file: "open", args: [], quoteAddress: false };
    case "linux":
      return { file: "xdg-open", args: [], quoteAddress: false };
    default:
      return null;
  }
}
function hasDisplay(platform, env) {
  if (platform !== "linux") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
function openLiveView(url, platform = process.platform, env = process.env, spawnOpener = spawnDetached) {
  const opener = openerFor(platform);
  if (opener === null || !hasDisplay(platform, env)) return false;
  const address = opener.quoteAddress ? `"${url}"` : url;
  let child;
  try {
    child = spawnOpener(opener.file, [...opener.args, address], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: opener.quoteAddress
    });
  } catch {
    return false;
  }
  child.on("error", () => {
  });
  child.unref();
  return child.pid !== void 0;
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
async function waitForLiveViewUrl(dataDir, sessionId, waitMs = 2e3) {
  const deadline = Date.now() + waitMs;
  for (; ; ) {
    if (daemonLive(dataDir)) {
      const url = liveViewUrl(dataDir, sessionId);
      if (url !== null) return url;
    }
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

// src/command-handler.ts
init_settings();
init_request_tokens();
init_sqlite();
init_fs();
init_json();
function daemonAddress(dataDir) {
  if (!daemonLive(dataDir)) {
    return "not running";
  }
  try {
    const port = readFileSync6(join11(dataDir, "port"), "utf8").trim();
    return port.length > 0 ? `127.0.0.1:${port}` : "not running";
  } catch {
    return "not running";
  }
}
function sessionFacts(dataDir, sessionId) {
  const facts = { sources: [], overheadTokens: 0 };
  const dbPath = join11(dataDir, "flightpath.db");
  if (!existsSync3(dbPath)) return facts;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const conditions = db.prepare(
      "SELECT sources_seen FROM session_conditions WHERE session_id = ?"
    ).get(sessionId);
    facts.sources = parseStringArray(conditions?.sources_seen);
    facts.overheadTokens = flightpathOverheadTokens(db, sessionId);
  } catch {
  } finally {
    db?.close();
  }
  return facts;
}
function databaseSize(dataDir) {
  let bytes = 0;
  for (const name of ["flightpath.db", "flightpath.db-wal"]) {
    try {
      bytes += statSync3(join11(dataDir, name)).size;
    } catch {
    }
  }
  return bytes;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function ageText(oldestAt) {
  return `${formatAge(oldestAt, Date.now())} old`;
}
function lastErrorLines(dataDir) {
  const lastError = readLastError(dataDir);
  if (lastError === null) {
    return [];
  }
  const lines = [
    `last start error: ${lastError.message} (${new Date(lastError.at).toISOString()})`
  ];
  const step = nextStepFor(lastError, dataDir);
  if (step !== null) lines.push(`next step: ${step}`);
  return lines;
}
function status(dataDir, sessionId) {
  const lines = [];
  const pausePath = join11(dataDir, "pause", pauseFileName(sessionId));
  if (existsSync3(join11(dataDir, "off"))) {
    lines.push(
      "flightpath is off in all sessions \u2014 /flightpath:start turns it back on"
    );
  } else if (existsSync3(pausePath)) {
    lines.push("flightpath is paused for this session");
  } else {
    lines.push("flightpath is recording");
  }
  const facts = sessionFacts(dataDir, sessionId);
  const address = daemonAddress(dataDir);
  lines.push(`daemon: ${address}`);
  lines.push(`data folder: ${dataDir}`);
  const buffer = bufferStats(dataDir);
  if (buffer.count > 0 && buffer.oldestAt !== null) {
    lines.push(
      `buffered events: ${buffer.count} waiting, oldest ${ageText(buffer.oldestAt)}`
    );
  }
  const dropped = droppedCount(dataDir);
  if (dropped > 0) {
    lines.push(
      `dropped events: about ${dropped} (the buffer was full; their transcripts still cover those sessions)`
    );
  }
  lines.push(...lastErrorLines(dataDir));
  lines.push(
    `recordings kept for: ${loadSettings(dataDir).retentionDays} days`
  );
  lines.push(`database size: ${formatBytes(databaseSize(dataDir))}`);
  lines.push(
    `capture sources for this session: ${facts.sources.length > 0 ? facts.sources.join(", ") : "none yet"}`
  );
  lines.push(
    `flightpath overhead in this session: ${facts.overheadTokens} tokens`
  );
  const url = settingsScreenUrl(dataDir);
  lines.push(
    `settings: ${address !== "not running" && url !== null ? url : "run /flightpath:start to open the settings screen"}`
  );
  lines.push("live view: /flightpath:open opens it in the browser");
  return lines.join("\n");
}
async function runStop(dataDir, sessionId) {
  const pausePath = join11(dataDir, "pause", pauseFileName(sessionId));
  mkdirSync2(join11(dataDir, "pause"), { recursive: true });
  writeFileSync4(pausePath, "");
  const { openStorage: openStorage2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const storage = openStorage2({ dataDir });
  storage.recordPause(sessionId);
  storage.close();
  return "flightpath: recording paused for this session \u2014 /flightpath:start resumes";
}
async function runStart(dataDir, sessionId) {
  const pausePath = join11(dataDir, "pause", pauseFileName(sessionId));
  const wasOff = existsSync3(join11(dataDir, "off"));
  unlinkIfPresent(join11(dataDir, "off"));
  unlinkIfPresent(pausePath);
  unlinkIfPresent(`${pausePath}.auto`);
  const { openStorage: openStorage2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const storage = openStorage2({ dataDir });
  storage.recordResume(sessionId);
  storage.close();
  if (wasOff) {
    await ensureDaemon(dataDir);
    return "flightpath: recording on \u2014 it was off in all sessions";
  }
  return "flightpath: recording on for this session";
}
var STOP_REQUEST_MS = 2e3;
async function askDaemonToStop(dataDir) {
  const address = readDaemonAddress(dataDir);
  if (address === null) return false;
  const { request } = await import("node:http");
  return new Promise((resolvePromise) => {
    const asking = request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/stop",
        headers: { "x-flightpath-token": address.token },
        agent: false,
        timeout: STOP_REQUEST_MS
      },
      (reply) => {
        reply.resume();
        resolvePromise(reply.statusCode === 204);
      }
    );
    asking.on("timeout", () => asking.destroy());
    asking.on("error", () => resolvePromise(false));
    asking.end();
  });
}
async function stopDaemon(dataDir) {
  const pid = readDaemonPid(dataDir);
  if (pid === null || !pidAlive(pid)) return;
  if (await askDaemonToStop(dataDir)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
  }
}
async function runOff(dataDir) {
  writeFileSync4(join11(dataDir, "off"), "");
  await stopDaemon(dataDir);
  return "flightpath: off in all sessions \u2014 /flightpath:start turns it back on";
}
async function runOpen(dataDir, sessionId) {
  if (!daemonLive(dataDir)) {
    await ensureDaemon(dataDir);
  }
  const url = await waitForLiveViewUrl(dataDir, sessionId);
  if (url === null) {
    return "flightpath: the live view could not be opened \u2014 the daemon did not start; /flightpath:status shows the last start error";
  }
  return openLiveView(url) ? `flightpath: opened the live view \xB7 ${url}` : `flightpath: open this link to see the live view \xB7 ${url}`;
}
async function runForget(dataDir, sessionId) {
  const { openStorage: openStorage2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  const storage = openStorage2({ dataDir });
  storage.forgetSession(sessionId);
  storage.close();
  const pausePath = join11(dataDir, "pause", pauseFileName(sessionId));
  mkdirSync2(join11(dataDir, "pause"), { recursive: true });
  writeFileSync4(pausePath, "");
  return "flightpath: this session's recording is deleted, and recording is paused so nothing new is captured";
}
function actionIn(payload) {
  if (payload.hook_event_name === "UserPromptSubmit") {
    return typeof payload.prompt === "string" ? expandedAction(payload.prompt) : null;
  }
  const commandName = typeof payload.command_name === "string" ? payload.command_name : "";
  return actionOf(commandName);
}
async function run(raw2) {
  const payload = JSON.parse(raw2);
  const action = actionIn(payload);
  if (action === null) {
    return "";
  }
  const dataDir = resolveDataDir();
  mkdirSync2(dataDir, { recursive: true });
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  switch (action) {
    case "status":
      return status(dataDir, sessionId);
    case "stop":
      return runStop(dataDir, sessionId);
    case "start":
      return runStart(dataDir, sessionId);
    case "off":
      return runOff(dataDir);
    case "forget":
      return runForget(dataDir, sessionId);
    case "open":
      return runOpen(dataDir, sessionId);
  }
}
async function answerCommand(raw2) {
  let reply;
  try {
    reply = await run(raw2);
  } catch {
    reply = "flightpath: something went wrong handling that command";
  }
  if (reply !== "") {
    process.stdout.write(
      `${JSON.stringify({ decision: "block", reason: reply })}
`
    );
  }
}

// src/command.ts
init_fs();
var raw = readStdin();
if (raw.trim().length > 0) {
  await answerCommand(raw);
}
