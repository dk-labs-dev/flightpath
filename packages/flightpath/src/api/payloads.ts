// The read API's payload shapes, and the recorder's error shape the stream's
// health carries: plain types, importing nothing that runs, so a reader that
// runs without Node — the browser view — can name exactly what the daemon sends.

import type { Fact } from "../describe/index.js";

export interface StepSummary {
  id: number;
  toolName: string;
  outcome: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  branchId: number | null;
  /** The request that first carried this step's result, if any. */
  resultRequestId: number | null;
  sentence: string;
}

export interface HumanMoment {
  id: number;
  kind: string;
  occurredAt: number;
  sentence: string;
}

export interface TurnSummary {
  id: number;
  sequence: number;
  startedAt: number | null;
  endedAt: number | null;
  failures: number;
  steppedIn: number;
  /** The images and attached files the prompt carried. */
  images: number;
  files: number;
  steps: StepSummary[];
  humanMoments: HumanMoment[];
}

/** A turn's head: the summary without its steps and moments,
 * as the live stream reports a turn's own change. */
export type TurnHead = Pick<
  TurnSummary,
  | "id"
  | "sequence"
  | "startedAt"
  | "endedAt"
  | "failures"
  | "steppedIn"
  | "images"
  | "files"
>;

export interface BranchSummary {
  id: number;
  agentId: string | null;
  agentType: string | null;
  kind: string | null;
  /** The step that started the branch, which its row stands for. */
  spawningStepId: number | null;
  startedAt: number | null;
  endedAt: number | null;
  totalTokens: number | null;
  steps: number;
  requests: number;
  sentence: string;
}

export interface SessionEvent {
  kind: "segment" | "pause";
  id: number;
  at: number;
  sentence: string;
  /** A segment's recorded kind, such as compact; a pause has none. */
  segmentKind?: string;
}

export interface ContextPoint {
  at: number;
  contextTokens: number;
}

/** The prompt cache the main thread's last request left behind. */
export interface SummaryCache {
  lifetime: "1h" | "5m";
  /** When that request finished, which is when the lifetime starts. */
  endedAt: number;
  /** The context it sent: what a cold cache would write again. */
  contextTokens: number;
}

export interface SnapshotSummary {
  id: string;
  title: string;
  project: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  model: string | null;
  permissionModes: string[];
  sources: string[];
  /** False when the daemon concluded the end; no end event arrived. */
  endSeen: boolean;
  note: string;
  counts: {
    turns: number;
    steps: number;
    requests: number;
    branches: number;
    humanMoments: number;
  };
  failures: number;
  steppedIn: number;
  tokensProcessed: number;
  contextNow: number | null;
  window: ContextWindow;
  overheadTokens: number;
  waitingSince: number | null;
  lastStepAt: number | null;
  /** Null when no lifetime was recorded, the last request had no
   * context, or a compaction came after it. */
  cache: SummaryCache | null;
}

export interface SessionSnapshot {
  summary: SnapshotSummary;
  turns: TurnSummary[];
  branches: BranchSummary[];
  sessionEvents: SessionEvent[];
  contextSamples: ContextPoint[];
}

/** One stored session, shaped for the session picker. */
export interface SessionListItem {
  id: string;
  /** The session's title, by the read side's one title rule. */
  title: string;
  /** The folder the session ran in, or null when none was recorded. */
  project: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  /** False when the daemon concluded the end; no end event arrived. */
  endSeen: boolean;
  /** True while a step is running: the session is not quiet. */
  hasOpenStep: boolean;
  turns: number;
  steps: number;
  tokensProcessed: number;
  /** The latest recorded context size, or null when none was sampled. */
  contextNow: number | null;
  sources: string[];
  /** The phrases that apply to this session, joined in one line. */
  note: string;
}

/** GET /api/sessions — live sessions first. */
export interface SessionsPayload {
  sessions: SessionListItem[];
  /** Sessions left out of the list for having nothing in them. */
  emptyHidden: number;
}

/** The recorder's last start error, as the health payload
 * carries it. */
export interface LastError {
  at: number;
  message: string;
  code?: string;
}

/** A start failure classed once, where it is recorded: the
 * health payload carries the class, and each reader words
 * its own next step from it — none re-tests the error. */
export type StartProblem =
  | {
      kind: "port";
      port: number | null;
      reason: "in-use" | "not-allowed";
    }
  | { kind: "database"; path: string }
  | { kind: "other" };

export interface StepRequest {
  id: number;
  model: string | null;
  startedAt: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  facts: Fact[];
}

export interface StepDetail {
  id: number;
  sessionId: string;
  toolName: string;
  outcome: string | null;
  sentence: string;
  facts: Fact[];
  /** For a Read of a saved tool output: the step that printed it, when recorded. */
  savedOutputStepId: number | null;
  requests: StepRequest[];
}

// The token history: one session's context series for the main
// thread and each subagent, the per-turn figures, and the room
// left in the window. Unknown figures are null, never zero.

export interface TokenPoint {
  requestId: number;
  /** When the request started. */
  at: number;
  /** The context it sent: input + cache read + cache write (5m + 1h). */
  tokens: number;
  turnId: number | null;
  /** The lifetime of the cache this point's thread is riding:
   * its own write's, else the previous point's, else null. */
  cacheLifetime: "1h" | "5m" | null;
}

export interface BranchSeries {
  branchId: number;
  agentType: string | null;
  /**
   * The type of the subagent this one was launched from, for
   * a nested subagent; null when it was launched from the main
   * conversation. Derived from the spawning step's branch.
   */
  parentAgentType: string | null;
  spawningStepId: number | null;
  points: TokenPoint[];
  /** Summed from the branch's own requests, never the stored total. */
  tokensProcessed: number;
  /** The characters of the branch's hand-back; null when none was recorded. */
  returnedChars: number | null;
  /** What the subagent started with; null when none of it was recorded. */
  startedWith: BranchStart | null;
}

/** The parts of a subagent's start the record names. */
export type BranchStartPart = "task" | "skills" | "CLAUDE.md" | "listings";

/** A subagent's start, estimated from the sizes recorded. */
export interface BranchStart {
  tokens: number;
  /** The parts recorded, in the order a subagent receives them. */
  parts: BranchStartPart[];
}

export interface BackgroundWork {
  branchId: number;
  agentType: string | null;
  /** Null when the branch has no requests recorded — never zero. */
  tokensProcessed: number | null;
}

export interface TurnTokens {
  turnId: number;
  sequence: number;
  /** Sums over the turn's main requests. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The turn's first and last main points, and their difference. */
  contextStart: number | null;
  contextEnd: number | null;
  contextChange: number | null;
  /** The prompt's first line, when its text was kept and
   * the keep-text setting is on; otherwise null. */
  promptLine: string | null;
  /** The prompt's length in characters, when it was recorded; otherwise null. */
  promptChars: number | null;
}

/** Where a context window's size came from: Claude's model
 * list, a `/context` report in the transcript, a measured
 * sample past the listed window, or nowhere — never a guess. */
export type ContextWindowSource =
  "model-list" | "context-command" | "inferred" | "unknown";

/** A context window: its size, or null when it isn't known. */
export interface ContextWindow {
  tokens: number | null;
  source: ContextWindowSource;
  /** When the `/context` report behind the size was written:
   * epoch milliseconds; null unless the source is a report. */
  reportedAt: number | null;
}

export interface Room {
  window: ContextWindow;
  autoCompact: {
    tokens: number;
    source: "setting" | "model-default" | "context-command";
  } | null;
  /** Measured from the latest main point. */
  toLimit: number | null;
  toAutoCompact: number | null;
  turnsLeft: { value: number; estimated: true } | null;
}

/** A file a skill attached when it loaded, by its path in the
 * project and its size; the tokens are an estimate. */
export interface SkillFile {
  loadId: number;
  path: string;
  bytes: number | null;
  lines: number | null;
  tokens: number | null;
}

/** The files a skill attached, with their tokens together. */
export interface SkillFiles {
  tokens: number;
  items: SkillFile[];
}

/** An item's tokens with the files a skill attached counted in.
 * Null when neither the item nor its files have a known size. */
export function itemTokens(item: {
  tokens: number | null;
  files?: SkillFiles | null;
}): number | null {
  const filesTokens = item.files?.tokens;
  if (filesTokens === undefined) return item.tokens;
  return (item.tokens ?? 0) + filesTokens;
}

/**
 * One item inside a rise: what entered the context between
 * the rise's two requests. Every size but the reply's and a
 * step's measured one is an estimate (characters or bytes
 * ÷ 2.9); an unknown size is null, never zero.
 */
export type RiseItem =
  | { kind: "reply"; requestId: number; tokens: number; estimated: false }
  | {
      kind: "step";
      stepId: number;
      label: string;
      chars: number | null;
      rawChars: number | null;
      tokens: number | null;
      /** False when the size is read off the rise itself. */
      estimated: boolean;
    }
  | {
      kind: "branch-return";
      stepId: number;
      branchId: number | null;
      label: string;
      chars: number | null;
      tokens: number | null;
      estimated: true;
    }
  | {
      kind: "prompt";
      turnId: number;
      chars: number | null;
      tokens: number | null;
      estimated: true;
    }
  | {
      kind: "attachment";
      turnId: number;
      attachmentKind: "image" | "file";
      name: string | null;
      bytes: number | null;
      tokens: number | null;
      estimated: true;
    }
  | {
      kind: "load";
      loadId: number;
      loadKind: ListedLoadKind;
      name: string;
      bytes: number | null;
      tokens: number | null;
      /** The files a skill attached; null for every other load. */
      files: SkillFiles | null;
      estimated: true;
    }
  | { kind: "other"; tokens: number; estimated: true };

/** The rise floor: the smallest rise the history names, flat at any limit. */
export const RISE_FLOOR = 2_000;

/**
 * One big rise in the main series, with the items that
 * explain it ranked largest first (unknown sizes last). The
 * link says how the step items were found: by the recorded
 * result link, by the time window, or not found at all.
 */
export interface Rise {
  id: string;
  fromRequestId: number;
  toRequestId: number;
  /** The later request's start. */
  at: number;
  /** Measured: the later point's tokens minus the earlier's. */
  delta: number;
  link: "exact" | "by_time" | "none";
  items: RiseItem[];
}

/**
 * One fall in the main series. A drop is a segment event,
 * never a step's fault: it carries a compaction's segment
 * when one opened between the two requests, else no cause.
 */
export interface Drop {
  id: string;
  fromRequestId: number;
  toRequestId: number;
  at: number;
  before: number;
  after: number;
  cause: "compaction" | "unknown";
  segmentId: number | null;
}

/**
 * Why a request rebuilt the prompt cache. Each kind
 * carries the facts it was decided from; a rebuild whose
 * cause is null has none — no cause is ever guessed.
 */
export type RebuildCause =
  | { kind: "compaction"; expected: true; segmentId: number }
  | {
      kind: "expired";
      expected: false;
      gapMinutes: number;
      lifetime: "5m" | "1h";
    }
  | { kind: "model"; expected: false; from: string; to: string }
  | { kind: "effort"; expected: false; from: string; to: string }
  | { kind: "tools"; expected: false };

/**
 * One main request that rebuilt the prompt cache, with
 * the measured write and context it sent.
 */
export interface Rebuild {
  id: string;
  requestId: number;
  /** When the rebuilding request started. */
  at: number;
  /** Its cache write, the 5-minute and 1-hour buckets together. */
  written: number;
  /** The context it sent. */
  context: number;
  cause: RebuildCause | null;
}

export interface TokenHistory {
  sessionId: string;
  states: {
    telemetry: boolean;
    tokensPartial: boolean;
    joinedPartway: boolean;
  };
  /** The first main point. */
  base: TokenPoint | null;
  main: TokenPoint[];
  /** Branches of kind "user" only. */
  branches: BranchSeries[];
  /** Every other kind of branch, and branches of no kind. */
  background: BackgroundWork[];
  turns: TurnTokens[];
  room: Room;
  /** Big rises in the main series, largest first. */
  rises: Rise[];
  /** Every fall in the main series, in the order it happened. */
  drops: Drop[];
  /** Every cache rebuild in the main series, in the order it happened. */
  rebuilds: Rebuild[];
}

// Context at a step: what the agent had been given in the
// step's epoch, by name and size, never contents. Every
// size but a reply's and a measured result's is an estimate
// (characters or bytes ÷ 2.9); an unknown size is null,
// never zero.

export type ListedLoadKind = "skill" | "instructions" | "command-output";

export type ContextItem =
  | {
      kind: "prompt";
      turnId: number;
      sequence: number;
      chars: number | null;
      tokens: number | null;
    }
  | {
      kind: "image" | "file";
      turnId: number;
      name: string | null;
      bytes: number | null;
      /** A text file's estimate from its bytes; an image's tokens
       * can't be told from the rest of its request, so null. */
      tokens: number | null;
    }
  | {
      kind: ListedLoadKind;
      loadId: number;
      name: string;
      bytes: number | null;
      tokens: number | null;
      /** The files a skill attached; null for every other load. */
      files: SkillFiles | null;
    }
  | {
      kind: "file-read";
      stepId: number;
      path: string;
      chars: number | null;
      tokens: number | null;
      /** True when the size is read off the context's rise. */
      measured: boolean;
    }
  | {
      kind: "tool-result";
      stepId: number;
      label: string;
      chars: number | null;
      tokens: number | null;
      /** True when the size is read off the context's rise. */
      measured: boolean;
    }
  | {
      kind: "subagent-result";
      stepId: number;
      branchId: number | null;
      label: string;
      chars: number | null;
      tokens: number | null;
    }
  | { kind: "reply"; requestId: number; tokens: number };

/** One instruction file in the fixed load, sized as the
 * load that carried it recorded it. */
export interface InstructionLoad {
  loadId: number;
  name: string;
  bytes: number | null;
  tokens: number | null;
}

/**
 * One thing Claude Code adds at session start, in the fixed
 * load. The size is the characters of text that reached the
 * model, and the estimate from them.
 */
export interface StartupLoad {
  loadId: number;
  kind:
    | "skill-listing"
    | "mcp-instructions"
    | "agent-listing"
    | "deferred-tool-names"
    | "hook-output"
    | "preloaded-skill"
    | "task-prompt";
  /** A hook's name, or a preloaded skill's; a subagent's task
   * carries the type of the subagent that launched it (null: the
   * main conversation); the other kinds none. */
  name: string | null;
  /** How many of the thing it names, when it counts them. */
  count: number | null;
  chars: number;
  tokens: number;
  /** True when `tokens` is the figure a `/context` report gave. */
  fromContext: boolean;
}

/**
 * The fixed load: what is sent on every request before any
 * work. Split from the measured request's recorded shape
 * when one was recorded; otherwise the thread's base total,
 * not split; otherwise nothing recorded at all.
 */
export type FixedLoad =
  | {
      kind: "split";
      requestId: number;
      /** The parts' sizes summed, computed once by the
       * API; readers print it rather than summing again. */
      total: number;
      system: { chars: number; tokens: number; fromContext: boolean };
      /** Built-in and plugin tools, largest first. */
      tools: { name: string; chars: number; tokens: number }[];
      /** The tools' total as a `/context` report gave it, which
       * the tools' sizes are shared out to; null when they are
       * estimates alone. */
      toolsReported: number | null;
      /** MCP tools grouped by server. */
      mcp: { server: string; tools: number; chars: number; tokens: number }[];
      instructions: InstructionLoad[];
      /** What was added at session start, largest first. */
      startup: StartupLoad[];
    }
  | { kind: "total"; tokens: number }
  | null;

/**
 * One thing put back after a compaction. A `file` is a record of
 * what the transcript showed returning. A `file-read` is the
 * official docs' rule (the most recently read files come back),
 * used only when no file was recorded. A `skill` always follows
 * the docs' rule.
 */
export type RestoredItem =
  | { kind: "file-read" | "skill"; ref: number; name: string }
  | {
      /** A file the transcript recorded after the compaction. */
      kind: "file";
      ref: number;
      name: string;
      /** Read in full again; false when Claude Code only named it. */
      reread: boolean;
      /** The estimate for a re-read file; null when only named. */
      tokens: number | null;
    };

/** What a compaction dropped (the stretch before it) and what came back. */
export interface CompactionView {
  segmentId: number;
  /** When the compaction happened: the segment's start. */
  at: number;
  before: ContextItem[];
  /** A record when files were recorded, the docs' rule otherwise. */
  restored: RestoredItem[];
  /** What a skill, or a file the docs' rule restored, says of itself. */
  restoredNote: "restored by Claude Code (per its docs)";
}

/** What a context read is asked at: a step or a request, by id. */
export type ContextAsk = { step: number } | { request: number };

export interface ContextAtStep {
  /** The step the read was asked at; null when it was asked at a request. */
  stepId: number | null;
  scope:
    | { kind: "main" }
    | { kind: "branch"; branchId: number; agentType: string | null };
  /** The request that measured the context at the step, and
   * its share of its model's window, when the window is known. */
  measured: {
    requestId: number;
    tokens: number;
    window: ContextWindow;
    share: number | null;
  } | null;
  /** The epoch the items entered in: from the session's
   * start or from the compaction that opened it. */
  epoch: { startedAt: number; afterCompactionSegmentId: number | null };
  /** In the order they entered. */
  items: ContextItem[];
  /** What the measured request carried before any work. */
  fixedLoad: FixedLoad;
  /** The compaction that opened this stretch, when one did. */
  compaction: CompactionView | null;
  totals: {
    measured: number | null;
    /** The sum of the items' tokens, leaving out an
     * instruction file the fixed load already counts. */
    items: number;
    /** What the fixed load and the items name, never more
     * than was measured; the items alone when nothing was. */
    named: number;
    /** What the items and the fixed load don't explain, or
     * null when they explain it all or overshoot — never
     * spread over the items. */
    other: number | null;
  };
  states: {
    telemetry: boolean;
    tokensPartial: boolean;
    joinedPartway: boolean;
  };
}

/** How much a finding is worth acting on, in rank order. */
export type FindingGrade = "Worth fixing" | "Worth a look" | "Did you know";

/** What a finding is about; a cache rebuild's kind is its named
 * cause, and "deny-gap" is reads no permission rule covers. */
export type FindingKind =
  | "expired"
  | "model"
  | "effort"
  | "tools"
  | "instructions"
  | "skills-unused"
  | "deny-gap";

/**
 * One suggestion for a session, computed from its stored rows
 * and worded here, so every reader shows the same sentences.
 */
export interface Finding {
  /** Stable across reads: "rebuild-<requestId>" for a cache rebuild,
   * "skills-unused" for the session's listed but unused skills,
   * "deny-gaps" for its reads no deny rule covers. */
  id: string;
  kind: FindingKind;
  grade: FindingGrade;
  /** When the finding's request started. */
  at: number;
  /** The main-thread request the finding is about, and the turn
   * it ran in; both null for a finding about the session as a
   * whole, and the turn null for a request outside any turn. */
  requestId: number | null;
  turnId: number | null;
  /** An imperative naming the thing, then its measured size. */
  headline: string;
  body: string;
  /** Lines shown under the body, one item each: paths or names, never contents. Empty when there are none. */
  list: string[];
  /** The one official doc page that explains it. */
  doc: { label: string; url: string };
  /** How the size was found: counted on a request, taken from a /context report, or worked out from characters. */
  measure: { tokens: number; basis: "measured" | "from-context" | "estimated" };
  /** Text for a Copy button, when the suggestion is text to paste. */
  copy: string | null;
}
