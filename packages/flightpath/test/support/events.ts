import type { Storage } from "../../src/storage/index.js";
import { iso } from "./time.js";

export type EventFields = Record<string, unknown>;

export function hookEvent(name: string, fields: EventFields = {}): EventFields {
  return { hook_event_name: name, ...fields };
}

export function sessionStartEvent(
  source: string,
  sessionId = "s1",
  fields: EventFields = {},
): EventFields {
  return hookEvent("SessionStart", {
    session_id: sessionId,
    source,
    cwd: "/work/app",
    ...fields,
  });
}

export function userPromptEvent(
  sessionId: string,
  prompt: string,
  fields: EventFields = {},
): EventFields {
  return hookEvent("UserPromptSubmit", {
    session_id: sessionId,
    prompt,
    cwd: "/work/app",
    ...fields,
  });
}

/** A command prompt as Claude Code submits it when no expansion follows. */
export function expandedCommandPrompt(commandName: string): string {
  return `<command-message>${commandName}</command-message>\n<command-name>/${commandName}</command-name>`;
}

export function expansion(
  sessionId: string,
  commandName: string,
  args = "",
): EventFields {
  return hookEvent("UserPromptExpansion", {
    session_id: sessionId,
    command_name: commandName,
    command_args: args,
  });
}

interface HookEnvelopeOptions {
  id?: string;
  receivedAt?: number;
  pluginVersion?: string;
}

function hookEnvelope(
  event: EventFields,
  options: HookEnvelopeOptions = {},
): string {
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : "unknown";
  const receivedAt = options.receivedAt ?? Date.now();
  return JSON.stringify({
    id: options.id ?? `env-${sessionId}-${receivedAt}`,
    received_at: receivedAt,
    redaction_version: 1,
    plugin_version: options.pluginVersion ?? "0.0.0",
    event,
  });
}

let envelopeSequence = 0;

export function sequencedHookEnvelope(
  idPrefix: string,
  event: EventFields,
): string {
  envelopeSequence += 1;
  return hookEnvelope(event, { id: `${idPrefix}-${envelopeSequence}` });
}

export function daemonPromptEnvelope(
  id: string,
  receivedAt: number,
  pluginVersion = "0.0.0",
  sessionId = "daemon-session",
): string {
  return hookEnvelope(userPromptEvent(sessionId, "hello"), {
    id,
    receivedAt,
    pluginVersion,
  });
}

export function recordHookEvent(
  storage: Storage,
  event: EventFields,
  receivedAt: number,
): void {
  const sessionId = event.session_id as string;
  const envelopeId = `env-${sessionId}-${receivedAt}`;
  storage.insertEnvelopeJourney(
    {
      source: "hook",
      sessionId,
      receivedAt,
      redactionVersion: 1,
      envelopeId,
      body: JSON.stringify({ id: envelopeId, event }),
    },
    event,
  );
}

export interface TranscriptLineOptions {
  sessionId?: string;
  uuid?: string;
  version?: string;
  extra?: EventFields;
}

export function transcriptUserLine(
  at: number,
  options: TranscriptLineOptions & {
    content?: unknown;
    promptId?: string;
  } = {},
): string {
  const sessionId = options.sessionId ?? "sess-live";
  return JSON.stringify({
    type: "user",
    sessionId,
    uuid: options.uuid ?? `u-${at}`,
    timestamp: iso(at),
    version: options.version ?? "2.0.0",
    ...(options.promptId === undefined ? {} : { promptId: options.promptId }),
    message: { role: "user", content: options.content ?? "write the report" },
    ...options.extra,
  });
}

export function transcriptAssistantLine(
  at: number,
  requestId: string,
  usage: EventFields,
  options: TranscriptLineOptions & { content?: unknown[] } = {},
): string {
  const sessionId = options.sessionId ?? "sess-live";
  return JSON.stringify({
    type: "assistant",
    sessionId,
    uuid: options.uuid ?? `a-${at}`,
    timestamp: iso(at),
    version: options.version ?? "2.0.0",
    requestId,
    message: {
      role: "assistant",
      model: "claude-sonnet",
      usage,
      content: options.content ?? [{ type: "text", text: "working on it" }],
    },
    ...options.extra,
  });
}

/** Cache control naming the first system block, at one hour. */
export const CACHE_CONTROL_1H = [
  { path: ["system", 0], value: { type: "ephemeral", ttl: "1h" } },
];

/** One request's own entry: its effort, cache control and edits. */
export function apiRequestLine(
  at: number,
  clientId: string,
  fields: {
    effort?: string;
    cacheControl?: unknown[];
    edits?: { type: string }[];
    shapeHash?: string;
  } = {},
): string {
  return JSON.stringify({
    type: "api-request",
    sessionId: "sess-live",
    id: clientId,
    timestamp: iso(at),
    version: "2.1.311",
    querySource: "repl_main_thread",
    shapeHash: fields.shapeHash ?? "a".repeat(64),
    params: {
      model: "claude-sonnet",
      ...(fields.effort === undefined
        ? {}
        : { output_config: { effort: fields.effort } }),
      ...(fields.edits === undefined
        ? {}
        : { context_management: { edits: fields.edits } }),
    },
    keep: 0,
    tail: [],
    cacheControl: fields.cacheControl ?? [],
    requestDigest: "b".repeat(64),
  });
}

/** A request shape entry: the system and tools a request ran with. */
export function apiRequestShapeLine(
  at: number,
  fields: { system: unknown; tools: unknown },
  sessionId = "sess-live",
): string {
  return JSON.stringify({
    type: "api-request-shape",
    sessionId,
    shapeHash: "a".repeat(64),
    timestamp: iso(at),
    version: "2.1.311",
    shape: { system: fields.system, tools: fields.tools },
  });
}

/** A file the prompt carried, as Claude Code writes it: its own entry. */
export function fileAttachmentLine(
  at: number,
  fields: {
    displayPath: string;
    filename: string;
    content: string;
    lines?: number;
    parentUuid?: string;
  },
): string {
  const lines = fields.lines ?? 1;
  return JSON.stringify({
    type: "attachment",
    sessionId: "sess-live",
    uuid: `att-${at}-${fields.displayPath}`,
    timestamp: iso(at),
    version: "2.1.311",
    parentUuid: fields.parentUuid ?? `u-${at}`,
    isSidechain: false,
    attachment: {
      type: "file",
      filename: fields.filename,
      displayPath: fields.displayPath,
      content: {
        type: "text",
        file: {
          filePath: fields.displayPath,
          content: fields.content,
          numLines: lines,
          startLine: 1,
          totalLines: lines,
        },
      },
    },
  });
}

/** The attachment Claude Code writes after a skill's files: it names no file. */
export function commandPermissionsLine(at: number): string {
  return JSON.stringify({
    type: "attachment",
    sessionId: "sess-live",
    uuid: `permissions-${at}`,
    timestamp: iso(at),
    version: "2.1.311",
    attachment: { type: "command_permissions", allowedTools: [] },
  });
}

/** The marker Claude Code writes when a compaction has just run. */
export function compactBoundaryLine(at: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    sessionId: "sess-live",
    uuid: `boundary-${at}`,
    timestamp: iso(at),
    version: "2.1.311",
  });
}

/** A file Claude Code names after a compaction without reading it again. */
export function compactFileReferenceLine(
  at: number,
  displayPath: string,
): string {
  return JSON.stringify({
    type: "attachment",
    sessionId: "sess-live",
    uuid: `ref-${at}`,
    timestamp: iso(at),
    version: "2.1.311",
    isSidechain: false,
    attachment: {
      type: "compact_file_reference",
      filename: `/work/app/${displayPath}`,
      displayPath,
    },
  });
}
