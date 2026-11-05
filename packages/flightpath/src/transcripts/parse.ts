// Parsing one transcript line into what the reader may use.
//
// A transcript entry holds the whole conversation, so this is
// the extraction boundary: the parser takes the request id, the
// model, the token counts, timestamps, the prompt id, tool-use
// ids and interrupt markers, and — from the request entries
// newer versions write — a request's effort and the sizes and
// names of what it was sent. A prompt's images and attachments
// reduce to media types, names and sizes here; the image data
// itself is measured, never read out. Message text is
// read only to recognize an interrupt marker (a boolean, never
// stored) and, when the user keeps prompt text, to hand the
// prompt to the turn the entry opens, exactly as the hook does.
// Whatever is stored passes through redactTranscriptEntry first
// (ADR-0017, ADR-0019).

import { effortLevel } from "../effort.js";
import {
  AGENT_MESSAGE_OPENING,
  TASK_NOTIFICATION_OPENING,
} from "../prompt-kind.js";
import { REDACTION_VERSION, redactTranscriptEntry } from "../redact/index.js";
import { scrubSecrets } from "../redact/secrets.js";
import type { ReportCategories } from "../storage/read.js";
import { countOf, isPlainObject, textOf } from "../util/json.js";

interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  /** Cache-write tokens; the total when no split is reported. */
  cacheWrite5mTokens: number | null;
  /** Null when the entry reports no 5m/1h split. */
  cacheWrite1hTokens: number | null;
}

/** One image in a prompt: its media type and encoded size. */
interface ParsedImage {
  mediaType: string | null;
  /** The base64 payload's length: the size that was sent. */
  bytes: number;
}

/**
 * One tool result's size as it was sent: the characters of
 * its text, and its images counted, never read (ADR-0004).
 * `asyncLaunch` is set when the result only announced a
 * subagent that was started in the background.
 */
export interface ParsedResultSize {
  chars: number;
  images: number;
  asyncLaunch: boolean;
  /** The size of the output Claude Code saved to a file, when this result is its notice. */
  savedBytes: number | null;
}

/**
 * What a `/context` report in the transcript states: the
 * model it describes, the window it names, and the
 * category rows it lists, in tokens; a row the report does
 * not list, or writes in a form that is not read, is null.
 */
export interface ParsedContextReport extends ReportCategories {
  model: string;
  window: number;
  autocompactBuffer: number | null;
}

/** A local command's report, measured here and never kept (ADR-0004). */
interface ParsedCommandOutput {
  command: string;
  chars: number;
}

/** One thing that came with a prompt, as name and size only. */
export interface ParsedAttachment {
  kind: "file";
  name: string | null;
  /** The file's absolute path, for naming it when it has no display path. */
  path: string | null;
  sizeBytes: number | null;
  /** The lines of the file's content, when the entry counts them. */
  lineCount: number | null;
  /** Named after a compaction without being read in again. */
  referenceOnly: boolean;
}

/**
 * One thing Claude Code adds at session start, reduced to the
 * facts the store keeps. The text itself is measured here and
 * never carried further. The instruction files' entry is its
 * own shape because it exists only to fill a size the
 * InstructionsLoaded hook couldn't stat — the hook's row is
 * missing when the file was already gone — so it carries each
 * file as path and content length, and the follower needs
 * nothing else from it.
 */
type ParsedStartupItem =
  | {
      kind:
        | "mcp-instructions"
        | "agent-listing"
        | "deferred-tool-names"
        | "hook-output";
      name: string | null;
      count: number | null;
      chars: number;
    }
  | {
      kind: "skill-listing";
      name: null;
      count: number | null;
      chars: number;
      /** The skills the listing names, by name alone. */
      names: string[];
    }
  | {
      kind: "instructions";
      files: { path: string; chars: number }[];
    };

/** What the step list keeps of Claude Code's own entries (ADR-0004). */
export type ParsedClaudeMessage =
  | { kind: "command"; name: string }
  | {
      kind: "handback";
      agentType: string | null;
      agentId: string | null;
      chars: number;
    }
  | { kind: "notice"; chars: number };

/** One tool definition in a request's shape: name and size. */
export interface ParsedToolShape {
  name: string;
  bytes: number;
  mcp: boolean;
}

export type ParsedEntry =
  | {
      kind: "request";
      timestampMs: number | null;
      version: string | undefined;
      requestId: string | null;
      /**
       * The client id of the request entry that preceded this
       * response, when the entry carries one: how a held request
       * entry finds the request it describes.
       */
      requestRef: string | null;
      model: string | null;
      usage: ParsedUsage;
      /**
       * The entry's tool calls as the redacted entry kept
       * them: id, name, and the input reduced to sizes. The
       * one list of the request's calls: every reader takes
       * the ids from here.
       */
      toolUses: { id: string; name: string; inputSummary: string | null }[];
      redacted: Record<string, unknown>;
    }
  | {
      kind: "user";
      timestampMs: number | null;
      version: string | undefined;
      promptId: string | null;
      isInterrupt: boolean;
      /** True for Claude Code's own housekeeping entries. */
      isMeta: boolean;
      /**
       * The origin Claude Code recorded for the entry ("human",
       * "peer", "task-notification", …), or null when it
       * recorded none (older versions).
       */
      originKind: string | null;
      /** What Claude Code itself said, when the entry is that. */
      claudeMessage: ParsedClaudeMessage | null;
      /** True for the summary entry a compaction leaves behind. */
      isCompactSummary: boolean;
      /**
       * True for a local command's own entries: the invocation
       * (`<command-name>…`) and its output (`<local-command-…>`).
       */
      isCommandEntry: boolean;
      /**
       * True when the first text block opens with one of Claude
       * Code's own openings, not words the person typed. A
       * boolean only; the text itself is never kept (ADR-0004).
       */
      opensWithClaudeOpening: boolean;
      /** The entry's `/context` report, when it carries one. */
      contextReport: ParsedContextReport | null;
      commandOutput: ParsedCommandOutput | null;
      /**
       * A skill's text, on the meta entry that carries it: the
       * skill's name and the text's bytes. The text is never kept.
       */
      skillText: { name: string; bytes: number } | null;
      /**
       * The skill's name, on the meta entry that opens with
       * `<command-message>NAME</command-message>`: how a
       * subagent's preloaded skills are told apart.
       */
      commandMessageName: string | null;
      /** Each tool result's size as it was sent, by tool-use id. */
      toolResultSizes: Map<string, ParsedResultSize>;
      /** Tool results the entry reports as errors. */
      errorResultIds: string[];
      /**
       * Tool results whose content is an interrupt marker: in a
       * real transcript the interrupted tool is answered by an
       * error result carrying the marker text, and only then by
       * the marker entry itself.
       */
      interruptResultIds: string[];
      /** The prompt text, only when the caller keeps prompt text. */
      promptText: string | null;
      /** The prompt's images, as media type and encoded size. */
      images: ParsedImage[];
      /** The prompt text's length and line count, always read. */
      promptChars: number;
      promptLines: number;
      promptBytes: number;
      redacted: Record<string, unknown>;
    }
  | {
      kind: "attachment";
      timestampMs: number | null;
      version: string | undefined;
      /** The file the entry attaches, as name and size only. */
      attachment: ParsedAttachment;
      redacted: Record<string, unknown>;
    }
  | {
      /** Claude Code's marker that a compaction just happened. */
      kind: "compaction-boundary";
      timestampMs: number | null;
      version: string | undefined;
      redacted: Record<string, unknown>;
    }
  | {
      kind: "startup-item";
      timestampMs: number | null;
      version: string | undefined;
      /** What was added at session start, as name/count/size. */
      item: ParsedStartupItem;
      redacted: Record<string, unknown>;
    }
  | {
      kind: "api-request";
      timestampMs: number | null;
      version: string | undefined;
      /** The entry's client id; the response entries name it as
       *  their requestRef. */
      clientId: string | null;
      /** The hash naming the shape this request was sent with,
       *  as its shape entry wrote it. */
      shapeHash: string | null;
      effort: string | null;
      /** The cache lifetime of each cached block, in order. */
      cacheLifetimes: string[];
      /** Context-management edits applied, by type. */
      contextEdits: string[];
      redacted: Record<string, unknown>;
    }
  | {
      kind: "api-request-shape";
      timestampMs: number | null;
      version: string | undefined;
      /** The hash the entry names its own shape by. */
      shapeHash: string | null;
      /** The system prompt's size in bytes; null when absent. */
      systemBytes: number | null;
      tools: ParsedToolShape[];
      redacted: Record<string, unknown>;
    }
  | {
      kind: "api-request-blob";
      timestampMs: number | null;
      version: string | undefined;
      redacted: Record<string, unknown>;
    }
  | {
      /**
       * A finished background subagent's task notification,
       * queued in the main transcript: the two ids it names —
       * the subagent's and its launching call's — are the whole
       * of what is read from it.
       */
      kind: "task-notification";
      timestampMs: number | null;
      version: string | undefined;
      taskId: string | null;
      toolUseId: string | null;
      redacted: Record<string, unknown>;
    }
  | {
      kind: "other";
      timestampMs: number | null;
      version: string | undefined;
      redacted: Record<string, unknown>;
    }
  | { kind: "unknown"; reason: string };

export interface ParseOptions {
  /** Mirror of the storePromptText setting, read by the caller. */
  keepPromptText: boolean;
}

export type ParsedUserEntry = Extract<ParsedEntry, { kind: "user" }>;

// The openings of Claude Code's own user entries, in one
// place. `command` marks a local command's own entries —
// its invocation and the output it prints — against the rest.
const CLAUDE_OPENINGS: readonly { marker: string; command: boolean }[] = [
  { marker: "<command-name>", command: true },
  { marker: "<local-command-stdout>", command: true },
  { marker: "<local-command-stderr>", command: true },
  { marker: "<local-command-caveat>", command: false },
  { marker: TASK_NOTIFICATION_OPENING, command: false },
  { marker: AGENT_MESSAGE_OPENING, command: false },
];

const NON_PROMPT_OPENINGS: readonly string[] = CLAUDE_OPENINGS.map(
  (opening) => opening.marker,
);

const COMMAND_OPENINGS: readonly string[] = CLAUDE_OPENINGS.filter(
  (opening) => opening.command,
).map((opening) => opening.marker);

/**
 * A user entry is a typed prompt unless its origin names
 * someone other than the person, or its first text block
 * opens with one of Claude Code's own openings. A command
 * entry is a command whatever its origin says.
 */
export function isTypedPrompt(parsed: ParsedUserEntry): boolean {
  if (parsed.originKind !== null && parsed.originKind !== "human") {
    return false;
  }
  return !parsed.opensWithClaudeOpening;
}

const COMMAND_NAME = /^<command-name>\s*(\S+?)\s*<\/command-name>/;

// A command run in the terminal leaves its name in an entry of
// its own; /context leaves only its report, a meta entry that
// opens with this heading.
const CONTEXT_REPORT_OPENING = "## Context Usage";

function commandNameOf(
  entry: Record<string, unknown>,
  texts: string[],
): string | null {
  const opening = texts[0]?.trimStart() ?? "";
  if (entry.isMeta === true && opening.startsWith(CONTEXT_REPORT_OPENING)) {
    return "/context";
  }
  return COMMAND_NAME.exec(opening)?.[1] ?? null;
}

/**
 * Whether a user entry is Claude Code speaking, and if so
 * what to keep of it. A recorded origin decides; an entry
 * with none is a command only by its text, and a typed
 * prompt carries the origin "human" and is never one.
 */
function claudeMessageOf(
  entry: Record<string, unknown>,
  origin: Record<string, unknown> | undefined,
  texts: string[],
  chars: number,
): ParsedClaudeMessage | null {
  const originKind = origin === undefined ? undefined : textOf(origin.kind);
  if (originKind === "peer" && origin?.handback === true) {
    return {
      kind: "handback",
      agentType: textOf(origin.name) ?? null,
      agentId: textOf(origin.from) ?? null,
      chars,
    };
  }
  if (originKind === "task-notification") return { kind: "notice", chars };
  if (originKind !== undefined) return null;
  const name = commandNameOf(entry, texts);
  return name === null ? null : { kind: "command", name: scrubSecrets(name) };
}

// The two texts Claude Code writes into a user entry when the
// user interrupts. They are recognized, never stored: the entry
// reduces to sizes under redaction like any other text.
const INTERRUPT_TEXTS: ReadonlySet<string> = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

function timestampOf(entry: Record<string, unknown>): number | null {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function versionOf(entry: Record<string, unknown>): string | undefined {
  return textOf(entry.version);
}

interface ContentBlocks {
  texts: string[];
  toolResultSizes: Map<string, ParsedResultSize>;
  errorResultIds: string[];
  interruptResultIds: string[];
  images: ParsedImage[];
}

function readContent(content: unknown): ContentBlocks {
  const blocks: ContentBlocks = {
    texts: [],
    toolResultSizes: new Map(),
    errorResultIds: [],
    interruptResultIds: [],
    images: [],
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
      // The image itself is never read: its media type and the
      // encoded size are the record (ADR-0004).
      const source = isPlainObject(block.source) ? block.source : undefined;
      blocks.images.push({
        mediaType:
          source !== undefined ? (textOf(source.media_type) ?? null) : null,
        bytes:
          source !== undefined && typeof source.data === "string"
            ? source.data.length
            : 0,
      });
    } else if (block.type === "tool_result") {
      const id = textOf(block.tool_use_id);
      if (id === undefined) continue;
      const texts = toolResultTexts(block.content);
      blocks.toolResultSizes.set(id, {
        chars: texts.reduce((sum, text) => sum + text.length, 0),
        images: toolResultImages(block.content),
        asyncLaunch: false,
        savedBytes: savedOutputBytes(texts),
      });
      if (block.is_error === true) blocks.errorResultIds.push(id);
      if (texts.some((text) => INTERRUPT_TEXTS.has(text.trim()))) {
        blocks.interruptResultIds.push(id);
      }
    }
  }
  return blocks;
}

/**
 * A tool result's own content, as text: the string itself, or
 * its text blocks' text.
 */
function toolResultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is Record<string, unknown> =>
        isPlainObject(part) &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string);
}

const SAVED_OUTPUT_OPENING = "<persisted-output>";
const SAVED_OUTPUT_SIZE = /Output too large \((\d+(?:\.\d+)?)(KB|MB)\)/;

/** Bytes a saved-output notice gives for the file; null for any other result. */
function savedOutputBytes(texts: string[]): number | null {
  const notice = texts.find((text) =>
    text.trimStart().startsWith(SAVED_OUTPUT_OPENING),
  );
  const size = notice === undefined ? null : SAVED_OUTPUT_SIZE.exec(notice);
  if (size?.[1] === undefined) return null;
  return Math.round(Number(size[1]) * (size[2] === "MB" ? 1_000_000 : 1_000));
}

/**
 * Flags the result of a tool that started a subagent in the
 * background. The entry's `toolUseResult` says so, and it
 * names no tool use, so it speaks for the entry only when the
 * entry holds a single result.
 */
function markAsyncLaunch(
  results: Map<string, ParsedResultSize>,
  toolUseResult: unknown,
): void {
  if (!isPlainObject(toolUseResult) || results.size !== 1) return;
  if (toolUseResult.status !== "async_launched") return;
  for (const size of results.values()) size.asyncLaunch = true;
}

function toolResultImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => isPlainObject(part) && part.type === "image")
    .length;
}

function usageOf(message: Record<string, unknown>): ParsedUsage | undefined {
  const usage = message.usage;
  if (!isPlainObject(usage)) return undefined;
  const inputTokens = countOf(usage.input_tokens);
  const outputTokens = countOf(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  let cacheWrite5mTokens: number | null = null;
  let cacheWrite1hTokens: number | null = null;
  const split = isPlainObject(usage.cache_creation)
    ? usage.cache_creation
    : undefined;
  const split5m =
    split !== undefined ? countOf(split.ephemeral_5m_input_tokens) : undefined;
  const split1h =
    split !== undefined ? countOf(split.ephemeral_1h_input_tokens) : undefined;
  if (split5m !== undefined || split1h !== undefined) {
    cacheWrite5mTokens = split5m ?? 0;
    cacheWrite1hTokens = split1h ?? 0;
  } else {
    // No split reported: the total rides in the 5m column and the
    // 1h column stays null, so the stored value claims no more
    // precision than the entry reported.
    cacheWrite5mTokens = countOf(usage.cache_creation_input_tokens) ?? null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: countOf(usage.cache_read_input_tokens) ?? null,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
  };
}

/**
 * The transcript's own record of a call, for a step the
 * hooks never reported.
 */
function toolUsesOf(redacted: Record<string, unknown>): {
  id: string;
  name: string;
  inputSummary: string | null;
}[] {
  const message = isPlainObject(redacted.message)
    ? redacted.message
    : undefined;
  const content =
    message !== undefined && Array.isArray(message.content)
      ? message.content
      : [];
  const uses: { id: string; name: string; inputSummary: string | null }[] = [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== "tool_use") continue;
    const id = textOf(block.id);
    if (id === undefined) continue;
    uses.push({
      id,
      name: textOf(block.name) ?? "unknown",
      inputSummary: isPlainObject(block.input)
        ? JSON.stringify(block.input)
        : null,
    });
  }
  return uses;
}

function parseAssistantEntry(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry {
  const usage = usageOf(message);
  if (usage === undefined) {
    // An assistant entry without usable usage is exactly the
    // shape that must mark the session partial, not be guessed.
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
    redacted,
  };
}

/**
 * The size of an attached file: the byte length of the text
 * its content carries, as `content.file.content` — the one
 * layout the capture shows for a file attachment. The content
 * itself is never read out; only its length is taken.
 */
function attachmentContentBytes(content: unknown): number | null {
  const file = attachedFile(content);
  return typeof file?.content === "string"
    ? Buffer.byteLength(file.content, "utf8")
    : null;
}

/** The file an attachment's content holds, as the capture lays it out. */
function attachedFile(content: unknown): Record<string, unknown> | undefined {
  return isPlainObject(content) && isPlainObject(content.file)
    ? content.file
    : undefined;
}

/** The line count the attachment states for its content. */
function attachmentContentLines(content: unknown): number | null {
  const lines = attachedFile(content)?.numLines;
  return typeof lines === "number" ? lines : null;
}

/** The strings in a value that is an array; anything else is none. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function joinedLength(texts: string[]): number {
  let total = 0;
  for (const text of texts) total += text.length;
  return total;
}

/**
 * What one startup attachment adds, when it adds anything the
 * store names. The text itself is never read out. A hook whose
 * output is empty adds nothing, and neither does a delta that
 * only removes. `hook_system_message` stays out: an error
 * line, not a load.
 */
function parseStartupItem(
  attachment: Record<string, unknown>,
): ParsedStartupItem | null {
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

function skillListingItem(
  attachment: Record<string, unknown>,
): ParsedStartupItem | null {
  const names = stringList(attachment.names);
  const chars =
    typeof attachment.content === "string" ? attachment.content.length : 0;
  const count =
    countOf(attachment.skillCount) ?? (names.length > 0 ? names.length : null);
  if (chars === 0 && (count ?? 0) === 0) return null;
  return {
    kind: "skill-listing",
    name: null,
    count,
    chars,
    names: names.map(scrubSecrets),
  };
}

/**
 * A delta that adds named text: MCP servers' instructions
 * (their blocks) or the names of tools loaded on demand
 * (their lines). The count is the names it adds; the size is
 * the added text's total length. A delta that only removes
 * adds nothing.
 */
function deltaItem(
  attachment: Record<string, unknown>,
  kind: "mcp-instructions" | "deferred-tool-names",
  textsKey: "addedBlocks" | "addedLines",
): ParsedStartupItem | null {
  const names = stringList(attachment.addedNames).length;
  const chars = joinedLength(stringList(attachment[textsKey]));
  if (chars === 0 && names === 0) return null;
  // A delta that adds text but names nothing counts
  // nothing: no count reads as none, never as zero.
  return { kind, name: null, count: names === 0 ? null : names, chars };
}

/**
 * A session-start hook's output: it reaches the model as
 * context; the hook's captured stdout is its own log, not
 * what was sent. An empty output adds nothing.
 */
function hookOutputItem(
  attachment: Record<string, unknown>,
): ParsedStartupItem | null {
  const content = attachment.content;
  if (typeof content !== "string" || content.length === 0) return null;
  const hookName = textOf(attachment.hookName);
  return {
    kind: "hook-output",
    // A hook's name is text from the transcript: it passes
    // the same secret scrubbing as any stored text.
    name: hookName === undefined ? null : scrubSecrets(hookName),
    count: null,
    chars: content.length,
  };
}

/** The instruction files' entry: each file, as path and size. */
function instructionsItem(
  attachment: Record<string, unknown>,
): ParsedStartupItem | null {
  const rawFiles = Array.isArray(attachment.files) ? attachment.files : [];
  const files: { path: string; chars: number }[] = [];
  for (const raw of rawFiles) {
    if (!isPlainObject(raw)) continue;
    const path = textOf(raw.path);
    if (path === undefined) continue;
    files.push({
      path,
      chars: typeof raw.content === "string" ? raw.content.length : 0,
    });
  }
  if (files.length === 0) return null;
  return { kind: "instructions", files };
}

/**
 * An attachment entry: the files a prompt carried arrive as
 * their own entries, with no message. A file attachment is a
 * prompt fact; the startup kinds name what was added at
 * session start; the rest record nothing here.
 */
function parseAttachmentEntry(
  entry: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry {
  const attachment = isPlainObject(entry.attachment)
    ? entry.attachment
    : undefined;
  if (attachment === undefined) {
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry),
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
        redacted: redactTranscriptEntry(entry),
      };
    }
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry),
    };
  }
  return fileAttachment(entry, attachment, timestampMs, version, false);
}

function fileAttachment(
  entry: Record<string, unknown>,
  attachment: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
  referenceOnly: boolean,
): ParsedEntry {
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
      name: displayPath === undefined ? null : scrubSecrets(displayPath),
      path: filename === undefined ? null : scrubSecrets(filename),
      sizeBytes: attachmentContentBytes(attachment.content),
      lineCount: attachmentContentLines(attachment.content),
      referenceOnly,
    },
    redacted: redactTranscriptEntry(entry),
  };
}

/** A size as `/context` writes it: a decimal and its unit,
 * or a bare count when the size is under a thousand. */
function contextSize(value: string, unit: string): number {
  const amount = Number.parseFloat(value);
  const lowerUnit = unit.toLowerCase();
  if (lowerUnit === "m") return Math.round(amount * 1_000_000);
  if (lowerUnit === "k") return Math.round(amount * 1_000);
  return Math.round(amount);
}

const CATEGORY_ROW = /^\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i;

/** The report's category table as label to tokens: only
 * rows whose size is a decimal, with a unit or none. */
function categorySizes(lines: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of lines) {
    const row = line.match(CATEGORY_ROW);
    if (row?.[1] !== undefined && row[2] !== undefined) {
      sizes.set(row[1], contextSize(row[2], row[3] ?? ""));
    }
  }
  return sizes;
}

function contextReportText(texts: string[]): string | undefined {
  return texts.find((candidate) =>
    candidate.trimStart().startsWith(CONTEXT_REPORT_OPENING),
  );
}

/**
 * What a `/context` report states, or null: the model and
 * window lines must both match, or the report is left
 * unread and the model list stands; a category row that
 * doesn't match reads as none.
 */
function contextReportOf(text: string): ParsedContextReport | null {
  const lines = text.split("\n");
  const modelLine = lines.find((line) => line.startsWith("**Model:**"));
  const model = modelLine?.match(/^\*\*Model:\*\*\s*(\S+)\s*$/)?.[1];
  const tokensLine = lines.find((line) => line.startsWith("**Tokens:**"));
  const tokens = tokensLine?.match(
    /^\*\*Tokens:\*\*\s*[\d.]+\s*[km]\s*\/\s*([\d.]+)\s*([km])\b/i,
  );
  if (
    model === undefined ||
    tokens?.[1] === undefined ||
    tokens[2] === undefined
  ) {
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
    skills: sizes.get("Skills") ?? null,
  };
}

const SKILL_TEXT_OPENING = "Base directory for this skill:";

/** The last part of the skill's folder, whichever separator the path uses. */
const SKILL_FOLDER_NAME = /([^\\/]+)[\\/]*$/;

function skillText(
  entry: Record<string, unknown>,
  texts: string[],
): { name: string; bytes: number } | null {
  const opening = texts[0]?.trimStart() ?? "";
  if (entry.isMeta !== true || !opening.startsWith(SKILL_TEXT_OPENING)) {
    return null;
  }
  const folder = opening.slice(SKILL_TEXT_OPENING.length).split("\n")[0] ?? "";
  const name = SKILL_FOLDER_NAME.exec(folder.trim())?.[1];
  if (name === undefined) return null;
  return {
    name: scrubSecrets(name),
    bytes: texts.reduce(
      (sum, text) => sum + Buffer.byteLength(text, "utf8"),
      0,
    ),
  };
}

const COMMAND_MESSAGE_NAME = /^<command-message>([^<]+)<\/command-message>/;

function commandMessageName(
  entry: Record<string, unknown>,
  texts: string[],
): string | null {
  if (entry.isMeta !== true) return null;
  const name = COMMAND_MESSAGE_NAME.exec(texts[0]?.trimStart() ?? "")?.[1];
  return name === undefined ? null : scrubSecrets(name);
}

function isInterruptText(texts: string[]): boolean {
  return texts.some((text) => INTERRUPT_TEXTS.has(text.trim()));
}

function parseUserEntry(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
  options: ParseOptions,
): ParsedEntry {
  const blocks = readContent(message.content);
  markAsyncLaunch(blocks.toolResultSizes, entry.toolUseResult);
  const isInterrupt = isInterruptText(blocks.texts);
  // A user entry's own text is the prompt only when it is not
  // carrying tool results back. The stored entry's redaction keeps
  // only this text's size, so the prompt is scrubbed here with the
  // hook path's secret rules (ADR-0017). The unscrubbed join is
  // measured in passing only; it is never stored.
  const isPrompt = blocks.toolResultSizes.size === 0;
  const joined =
    options.keepPromptText && isPrompt
      ? scrubSecrets(blocks.texts.join("\n"))
      : "";
  const promptTextAll = isPrompt ? blocks.texts.join("\n") : "";
  const origin = isPlainObject(entry.origin) ? entry.origin : undefined;
  const firstText = blocks.texts[0]?.trimStart();
  // Only a meta entry carries the report: a typed prompt
  // that pastes one is the user's own text, not a reading.
  const report =
    entry.isMeta === true ? contextReportText(blocks.texts) : undefined;
  return {
    kind: "user",
    timestampMs,
    version,
    promptId: textOf(entry.promptId) ?? null,
    isInterrupt,
    isMeta: entry.isMeta === true,
    originKind: origin !== undefined ? (textOf(origin.kind) ?? null) : null,
    claudeMessage: claudeMessageOf(
      entry,
      origin,
      blocks.texts,
      promptTextAll.length,
    ),
    isCompactSummary: entry.isCompactSummary === true,
    isCommandEntry:
      firstText !== undefined &&
      COMMAND_OPENINGS.some((opening) => firstText.startsWith(opening)),
    opensWithClaudeOpening:
      firstText !== undefined &&
      NON_PROMPT_OPENINGS.some((opening) => firstText.startsWith(opening)),
    contextReport: report === undefined ? null : contextReportOf(report),
    commandOutput:
      report === undefined
        ? null
        : { command: "/context", chars: report.length },
    skillText: skillText(entry, blocks.texts),
    commandMessageName: commandMessageName(entry, blocks.texts),
    toolResultSizes: blocks.toolResultSizes,
    errorResultIds: blocks.errorResultIds,
    interruptResultIds: blocks.interruptResultIds,
    promptText: joined.length > 0 ? joined : null,
    images: blocks.images,
    promptChars: promptTextAll.length,
    promptLines:
      promptTextAll.length === 0 ? 0 : promptTextAll.split("\n").length,
    promptBytes: Buffer.byteLength(promptTextAll, "utf8"),
    redacted: redactTranscriptEntry(entry),
  };
}

/**
 * The cache lifetime of each cached block, in the order the
 * request entry's cacheControl names them: a block controlled
 * as ephemeral without a stated lifetime uses the five-minute
 * default.
 */
function cacheLifetimesOf(cacheControl: unknown): string[] {
  if (!Array.isArray(cacheControl)) return [];
  const lifetimes: string[] = [];
  for (const item of cacheControl) {
    if (!isPlainObject(item)) continue;
    const value = isPlainObject(item.value) ? item.value : undefined;
    if (value === undefined) continue;
    const ttl = textOf(value.ttl);
    if (ttl !== undefined) lifetimes.push(ttl);
    else if (value.type === "ephemeral") lifetimes.push("5m");
  }
  return lifetimes;
}

/**
 * One content block's size in bytes: its text in UTF-8 when
 * it has text, otherwise its JSON. The one measure every
 * block size in this file uses.
 */
function blockBytes(block: unknown): number {
  if (isPlainObject(block) && typeof block.text === "string") {
    return Buffer.byteLength(block.text, "utf8");
  }
  return Buffer.byteLength(JSON.stringify(block) ?? "", "utf8");
}

/** A system value's size in bytes: its text blocks in total. */
function systemBytesOf(system: unknown): number | null {
  if (typeof system === "string") return Buffer.byteLength(system, "utf8");
  if (!Array.isArray(system)) return null;
  let bytes = 0;
  for (const block of system) {
    bytes += blockBytes(block);
  }
  return bytes;
}

function toolsOf(tools: unknown): ParsedToolShape[] {
  if (!Array.isArray(tools)) return [];
  const shapes: ParsedToolShape[] = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const name = textOf(tool.name) ?? "unknown";
    shapes.push({
      name,
      bytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
      mcp: name.startsWith("mcp__"),
    });
  }
  return shapes;
}

function contextEditsOf(params: Record<string, unknown> | undefined): string[] {
  const management =
    params !== undefined && isPlainObject(params.context_management)
      ? params.context_management
      : undefined;
  if (management === undefined || !Array.isArray(management.edits)) {
    return [];
  }
  const types: string[] = [];
  for (const edit of management.edits) {
    if (!isPlainObject(edit)) continue;
    const type = textOf(edit.type);
    if (type !== undefined) types.push(type);
  }
  return types;
}

function parseApiRequestEntry(
  entry: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry {
  const params = isPlainObject(entry.params) ? entry.params : undefined;
  const outputConfig =
    params !== undefined && isPlainObject(params.output_config)
      ? params.output_config
      : undefined;
  return {
    kind: "api-request",
    timestampMs,
    version,
    clientId: textOf(entry.id) ?? null,
    shapeHash: textOf(entry.shapeHash) ?? null,
    effort: effortLevel(outputConfig?.effort),
    cacheLifetimes: cacheLifetimesOf(entry.cacheControl),
    contextEdits: contextEditsOf(params),
    redacted: redactTranscriptEntry(entry),
  };
}

function parseApiRequestShapeEntry(
  entry: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry {
  const shape = isPlainObject(entry.shape) ? entry.shape : undefined;
  const systemBytes = shape === undefined ? null : systemBytesOf(shape.system);
  const tools = shape === undefined ? [] : toolsOf(shape.tools);
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
      redaction_version: REDACTION_VERSION,
    },
  };
}

function blobBlockSize(block: unknown): { type: string; bytes: number } {
  return {
    type: isPlainObject(block) ? (textOf(block.type) ?? "unknown") : "unknown",
    bytes: blockBytes(block),
  };
}

function parseApiRequestBlobEntry(
  entry: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry {
  const message = isPlainObject(entry.message) ? entry.message : undefined;
  const content =
    message !== undefined && Array.isArray(message.content)
      ? message.content
      : [];
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
        role: message !== undefined ? (textOf(message.role) ?? null) : null,
        blocks: content.map(blobBlockSize),
      },
      redaction_version: REDACTION_VERSION,
    },
  };
}

/** The id a task notification names in one of its tags, or
 * null when the tag is absent or empty. */
function notificationId(content: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = content.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = content.indexOf(`</${tag}>`, from);
  if (end === -1) return null;
  const value = content.slice(from, end).trim();
  return value === "" ? null : value;
}

/**
 * A queue entry carrying a task notification, parsed for the
 * two ids it names; null when the entry queues anything else.
 * The notification's text and summary are never read, and the
 * stored copy is the redacted entry, whose content is a size.
 */
function parseTaskNotification(
  entry: Record<string, unknown>,
  timestampMs: number | null,
  version: string | undefined,
): ParsedEntry | null {
  if (textOf(entry.operation) !== "enqueue") return null;
  const content = textOf(entry.content);
  if (content === undefined || !content.includes("<task-notification>")) {
    return null;
  }
  return {
    kind: "task-notification",
    timestampMs,
    version,
    taskId: notificationId(content, "task-id"),
    toolUseId: notificationId(content, "tool-use-id"),
    redacted: redactTranscriptEntry(entry),
  };
}

/** Parse one JSONL line. Never throws. */
export function parseTranscriptLine(
  line: string,
  options: ParseOptions,
): ParsedEntry {
  let entry: unknown;
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
  // The request entries newer versions write carry no message:
  // they describe a request the assistant entries record, so
  // they are recognized by type before the message check.
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
      redacted: redactTranscriptEntry(entry),
    };
  }
  const message = isPlainObject(entry.message) ? entry.message : undefined;
  if (message === undefined) {
    // Bookkeeping entries (summaries, snapshots, queue markers)
    // carry no message and nothing the reader needs.
    return {
      kind: "other",
      timestampMs,
      version,
      redacted: redactTranscriptEntry(entry),
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
