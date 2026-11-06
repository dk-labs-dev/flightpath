// The allow-list: the security boundary of intake redaction.
//
// Redaction keeps text by allow-list, never by deny-list. A string
// survives only when its key appears in one of the tables below (and it
// is still scrubbed for secrets afterwards). Every other string is
// replaced by its length, so structure and sizes survive while content
// does not. Adding a field to these tables is the deliberate act that
// lets new text reach disk; when a field's safety is unclear, it stays
// out.
//
// The tables are data, in one place, so a review can check the whole
// boundary at a glance.

/** Fields every hook event may keep as text. */
export const COMMON_TEXT_KEYS: ReadonlySet<string> = new Set([
  "session_id",
  "prompt_id",
  "transcript_path",
  "cwd",
  "permission_mode",
  "hook_event_name",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_use_id",
]);

/**
 * Extra text fields for specific hook events, beyond the common set.
 * Events not listed here keep only the common fields as text.
 * Numbers and booleans are always kept (SessionStart's resume cache
 * fields, for example, are numbers and need no entry here).
 */
export const EVENT_TEXT_KEYS: Readonly<Record<string, readonly string[]>> = {
  UserPromptSubmit: ["prompt", "prompt_kind"],
  UserPromptExpansion: ["command_name", "command_args", "command_source"],
  SessionStart: ["source", "model"],
  Notification: ["notification_type"],
  PreCompact: ["trigger"],
  PostCompact: ["trigger"],
  InstructionsLoaded: ["file_path", "memory_type"],
};

/**
 * The one field per event that holds the person's own words. Redaction
 * keeps at most the prompt text limit of it, cut after scrubbing.
 */
export const EVENT_PROMPT_KEY: Readonly<Record<string, string>> = {
  UserPromptSubmit: "prompt",
  UserPromptExpansion: "command_args",
};

/**
 * Text fields kept inside the items of one array field of a
 * specific hook event. A PostToolBatch names the calls it
 * closes: the tool-use ids and tool names in its `tool_calls`
 * items are identifiers, never content, and the recorder needs
 * them to close the steps the batch names. The calls' inputs
 * and responses in the same items stay sizes.
 */
export const EVENT_ARRAY_ITEM_TEXT_KEYS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  PostToolBatch: { tool_calls: ["tool_use_id", "tool_name"] },
};

/**
 * Text fields kept inside `tool_input`, for tools we know. Tools not
 * listed here (including every `mcp__*` tool) keep no input text at
 * all: keys and sizes only. Content-bearing keys (`content`,
 * `new_string`, `old_string`, cell sources) are absent on purpose —
 * that absence is what reduces them to sizes.
 */
export const TOOL_INPUT_TEXT_KEYS: ReadonlySet<string> = new Set([
  "file_path",
  "notebook_path",
  "path",
  "command",
  "description",
  "pattern",
  "glob",
  "url",
  "skill",
  "subagent_type",
]);

/**
 * Tools whose inputs are understood well enough to use the table
 * above. Subagent launches arrive as `Agent` (current) or `Task`
 * (older versions); both are listed so the spawning step keeps its
 * `subagent_type` either way.
 */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
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
  "AskUserQuestion",
]);

/**
 * AskUserQuestion is special-cased: the questions and the option labels
 * are the record of what the human was asked and what they chose, so
 * they are kept (ADR-0017). These keys stay text at any depth inside
 * its input and response; option descriptions and everything else
 * reduce to sizes.
 */
export const ASK_USER_QUESTION_TEXT_KEYS: ReadonlySet<string> = new Set([
  "question",
  "header",
  "label",
  "answers",
  "answer",
]);

/**
 * Text fields kept inside a hook payload's `effort` object:
 * the level is one of a fixed set of effort names the hooks
 * documentation lists as a common field, never user content.
 */
export const HOOK_EFFORT_TEXT: ReadonlySet<string> = new Set(["level"]);

/** Telemetry attribute keys whose string values are safe to keep. */
export const TELEMETRY_TEXT_KEYS: ReadonlySet<string> = new Set([
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
  "hook_event",
]);

/**
 * Telemetry attribute keys that carry counts and durations.
 * Several arrive as string values in a real export; a string
 * under one of these keys is kept only when it parses as a
 * finite number, so the intake can read it as the number it is.
 */
export const TELEMETRY_NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "duration_ms",
  "total_duration_ms",
  "num_hooks",
  "prompt_length",
  "pre_tokens",
  "post_tokens",
]);

/**
 * Keys whose value is a boolean that a real export sends as a
 * string: kept when the string is exactly "true" or "false",
 * reduced to its size otherwise, the same discipline as the
 * numeric keys above.
 */
export const TELEMETRY_BOOLEAN_KEYS: ReadonlySet<string> = new Set(["success"]);

/**
 * Telemetry identity: attribute keys matching this are dropped whole,
 * at any depth, in attributes and resource attributes alike — email,
 * account, user and organization identifiers (ADR-0017).
 */
export const TELEMETRY_IDENTITY_KEY: RegExp =
  /email|account|organi[sz]ation|org_?id|user_?id|user\.id/i;

/**
 * Telemetry cost: attribute keys matching this are dropped whole,
 * like identity. Flightpath records tokens, never dollars
 * (ADR-0005), so a cost figure has no path to disk at all.
 */
export const TELEMETRY_COST_KEY: RegExp = /cost/i;

/**
 * Transcript entry fields kept as text. The transcript walker uses
 * these only at the envelope level (entry, message, content blocks),
 * never at any depth: inside tool inputs and results, strings reduce
 * to sizes however they are keyed.
 */
export const TRANSCRIPT_ENTRY_TEXT: ReadonlySet<string> = new Set([
  "type",
  "sessionId",
  "uuid",
  "parentUuid",
  "timestamp",
  "requestId",
]);

/** Transcript message fields kept as text (usage numbers ride along). */
export const TRANSCRIPT_MESSAGE_TEXT: ReadonlySet<string> = new Set([
  "role",
  "model",
  "id",
]);
