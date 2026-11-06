// One session's token history: the context series of the main
// thread and of each subagent branch, the per-turn figures and
// the room left in the window — a pure function of the loaded
// session, so a live session's history is its held data read
// the same way, and the tests need no database.

import { firstLine } from "../describe/format.js";
import {
  describeStep,
  handbackName,
  SUBAGENT_TOOLS,
} from "../describe/index.js";
import { estimatedTokens } from "../format.js";
import {
  cacheWriteTokens,
  requestContextTokens,
  requestTotalTokens,
} from "../storage/request-tokens.js";
import type {
  BranchRow,
  ContextReportRow,
  LoadRow,
  PromptAttachmentRow,
  RequestRow,
  StepRow,
  Storage,
} from "../storage/index.js";
import { CACHE_LIFETIME_MS } from "./cache-lifetime.js";
import {
  contextReportFor,
  contextWindowFor,
  samplesForModel,
} from "./context-limit.js";
import { itemTokens, RISE_FLOOR } from "./payloads.js";
import type {
  BackgroundWork,
  BranchSeries,
  BranchStart,
  BranchStartPart,
  ContextWindow,
  Drop,
  ListedLoadKind,
  Rebuild,
  RebuildCause,
  Rise,
  RiseItem,
  Room,
  SkillFiles,
  TokenHistory,
  TokenPoint,
  TurnTokens,
} from "./payloads.js";
import {
  backgroundReports,
  handbackOf,
  latestMainModel,
  launchedInBackground,
  loadSessionData,
  stepContext,
  type BackgroundReport,
  type SessionData,
} from "./session-data.js";

/** The context a point measures: any of its four counts recorded. */
export function hasContextCount(request: RequestRow): boolean {
  return (
    request.inputTokens !== null ||
    request.cacheReadTokens !== null ||
    request.cacheWrite5mTokens !== null ||
    request.cacheWrite1hTokens !== null
  );
}

/**
 * One thread's points from its requests, in the order they
 * started: a request joins the series when it started and
 * recorded a context count. The series is never built from
 * context samples — a sample exists for requests that are not
 * session context at all, like a title generation, and its
 * small total would plant a cliff in the line.
 */
export function seriesPoints(requests: RequestRow[]): TokenPoint[] {
  const started: { request: RequestRow; at: number }[] = [];
  for (const request of requests) {
    if (request.startedAt === null || !hasContextCount(request)) continue;
    started.push({ request, at: request.startedAt });
  }
  started.sort((a, b) => a.at - b.at || a.request.id - b.request.id);
  const points: TokenPoint[] = [];
  let lifetime: "1h" | "5m" | null = null;
  for (const { request, at } of started) {
    // The lifetime is the request's own write's, else the
    // previous point's: a read alone never changes it. A
    // write is an amount over zero — a reported cache split
    // stores both buckets, the unwritten one as zero.
    if ((request.cacheWrite1hTokens ?? 0) > 0) lifetime = "1h";
    else if ((request.cacheWrite5mTokens ?? 0) > 0) lifetime = "5m";
    points.push({
      requestId: request.id,
      at,
      tokens: requestContextTokens(request),
      turnId: request.turnId,
      cacheLifetime: lifetime,
    });
  }
  return points;
}

/** Requests grouped by the branch they ran in. */
function requestsByBranch(requests: RequestRow[]): Map<number, RequestRow[]> {
  const byBranch = new Map<number, RequestRow[]>();
  for (const request of requests) {
    if (request.branchId === null) continue;
    const own = byBranch.get(request.branchId) ?? [];
    own.push(request);
    byBranch.set(request.branchId, own);
  }
  return byBranch;
}

/** A subagent's display type, the generic name when it has none. */
function agentTypeName(branch: BranchRow): string {
  return branch.agentType ?? "subagent";
}

/**
 * The display type of the subagent a branch was launched
 * from: its spawning step's branch's type, falling back to
 * the generic name the lanes use. Null when the branch was
 * launched from the main conversation, or its spawning step
 * or parent branch is not recorded.
 */
export function parentAgentTypeOf(
  data: SessionData,
  branch: BranchRow,
): string | null {
  if (branch.spawningStepId === null) return null;
  const starter = data.stepsById.get(branch.spawningStepId);
  if (starter === undefined || starter.branchId === null) return null;
  const parent = data.branchesById.get(starter.branchId);
  if (parent === undefined || parent.id === branch.id) return null;
  return agentTypeName(parent);
}

/** The load kinds Claude Code adds at start-up: listings and hook output. */
export const LISTING_KINDS: readonly string[] = [
  "skill-listing",
  "mcp-instructions",
  "agent-listing",
  "deferred-tool-names",
  "hook-output",
];

/** What a subagent starts with: the load kinds behind each part. */
const START_PARTS: { part: BranchStartPart; kinds: readonly string[] }[] = [
  { part: "task", kinds: ["task-prompt"] },
  { part: "skills", kinds: ["preloaded-skill"] },
  { part: "CLAUDE.md", kinds: ["instructions"] },
  { part: "listings", kinds: LISTING_KINDS },
];

/** A subagent's start from its own loads, sized as the
 * Snapshot sizes the same rows; null when none was recorded. */
function startedWith(loads: LoadRow[]): BranchStart | null {
  const parts: BranchStartPart[] = [];
  let tokens = 0;
  for (const { part, kinds } of START_PARTS) {
    const own = loads.filter((load) => kinds.includes(load.kind));
    if (own.length === 0) continue;
    parts.push(part);
    for (const load of own) tokens += estimatedTokens(load.sizeBytes ?? 0);
  }
  return parts.length === 0 ? null : { tokens, parts };
}

/** Loads grouped by the subagent they belong to. */
function loadsByBranch(loads: LoadRow[]): Map<number, LoadRow[]> {
  const byBranch = new Map<number, LoadRow[]>();
  for (const load of loads) {
    if (load.branchId === null) continue;
    const own = byBranch.get(load.branchId) ?? [];
    own.push(load);
    byBranch.set(load.branchId, own);
  }
  return byBranch;
}

/**
 * Each branch's place in the history: a user branch gets its
 * own series, every other kind is background work. Either
 * way the processed total is measured from the branch's own
 * requests — the stored branch total is empty in real
 * recordings — and background with no requests is null.
 */
function branchHistories(data: SessionData): {
  branches: BranchSeries[];
  background: BackgroundWork[];
} {
  const byBranch = requestsByBranch(data.requests);
  const startsByBranch = loadsByBranch(data.loads);
  const branches: BranchSeries[] = [];
  const background: BackgroundWork[] = [];
  const ordered = [...data.branches].sort((a, b) => a.id - b.id);
  for (const branch of ordered) {
    const own = byBranch.get(branch.id) ?? [];
    const processed = own.reduce(
      (sum, request) => sum + requestTotalTokens(request),
      0,
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
        startedWith: startedWith(startsByBranch.get(branch.id) ?? []),
      });
    } else {
      background.push({
        branchId: branch.id,
        agentType: branch.agentType,
        tokensProcessed: own.length === 0 ? null : processed,
      });
    }
  }
  return { branches, background };
}

/** Rows and points grouped by the turn they belong to. */
function groupMainByTurn<T extends { turnId: number | null }>(
  rows: T[],
): Map<number, T[]> {
  const byTurn = new Map<number, T[]>();
  for (const row of rows) {
    if (row.turnId === null) continue;
    const own = byTurn.get(row.turnId) ?? [];
    own.push(row);
    byTurn.set(row.turnId, own);
  }
  return byTurn;
}

/**
 * Each turn's figures: sums over its main requests, and the
 * context change from its first main point to its last. A
 * turn with no main requests is all zeros and null context —
 * zero there is true. Also collects the context changes of
 * the turns that ended and grew, in sequence order, which
 * the room's estimate reads.
 */
function turnHistories(
  data: SessionData,
  mainRequests: RequestRow[],
  main: TokenPoint[],
  storePromptText: boolean,
): { turns: TurnTokens[]; endedChanges: number[] } {
  const requests = groupMainByTurn(mainRequests);
  const points = groupMainByTurn(main);
  const turns: TurnTokens[] = [];
  const endedChanges: number[] = [];
  const ordered = [...data.turns].sort(
    (a, b) => a.sequence - b.sequence || a.id - b.id,
  );
  for (const turn of ordered) {
    const own = requests.get(turn.id) ?? [];
    const turnPoints = points.get(turn.id) ?? [];
    const first = turnPoints[0];
    const last = turnPoints[turnPoints.length - 1];
    const contextStart = first === undefined ? null : first.tokens;
    const contextEnd = last === undefined ? null : last.tokens;
    const shaped: TurnTokens = {
      turnId: turn.id,
      sequence: turn.sequence,
      input: own.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      output: own.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
      cacheRead: own.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0),
      cacheWrite: own.reduce((sum, r) => sum + (cacheWriteTokens(r) ?? 0), 0),
      contextStart,
      contextEnd,
      contextChange:
        contextStart === null || contextEnd === null
          ? null
          : contextEnd - contextStart,
      promptLine:
        storePromptText && turn.promptText !== null
          ? firstLine(turn.promptText).trim()
          : null,
      promptChars: turn.promptChars,
    };
    turns.push(shaped);
    if (
      turn.endedAt !== null &&
      shaped.contextChange !== null &&
      shaped.contextChange > 0
    ) {
      endedChanges.push(shaped.contextChange);
    }
  }
  return { turns, endedChanges };
}

/** The median of a non-empty list, or null for an empty one. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/**
 * The auto-compact point: a `/context` report's buffer
 * against the window when the report gave one, else the
 * user's setting, else the 1M models' documented default,
 * else unknown — the 200K default is not known, so it is
 * not guessed.
 */
function autoCompactPoint(
  window: ContextWindow,
  reported: ContextReportRow | null,
  autoCompactWindow: number | null,
): Room["autoCompact"] {
  if (
    reported !== null &&
    reported.autocompactBuffer !== null &&
    window.tokens !== null
  ) {
    return {
      tokens: window.tokens - reported.autocompactBuffer,
      source: "context-command",
    };
  }
  if (autoCompactWindow !== null) {
    return { tokens: autoCompactWindow, source: "setting" };
  }
  if (window.tokens === 1_000_000) {
    return { tokens: 967_000, source: "model-default" };
  }
  return null;
}

/**
 * The room left in the window, measured from the latest main
 * point. Turns left divides what remains to the compact
 * point by the median growth of the last five ended turns.
 */
function roomLeft(
  data: SessionData,
  autoCompactWindow: number | null,
  main: TokenPoint[],
  endedChanges: number[],
): Room {
  const model = latestMainModel(data);
  const reported = contextReportFor(data.contextReports, model);
  const window = contextWindowFor(
    model,
    samplesForModel(data.samples, data.requests, model),
    reported,
  );
  const autoCompact = autoCompactPoint(window, reported, autoCompactWindow);
  const latest = main[main.length - 1];
  const toLimit =
    latest === undefined || window.tokens === null
      ? null
      : window.tokens - latest.tokens;
  const toAutoCompact =
    autoCompact === null || latest === undefined
      ? null
      : autoCompact.tokens - latest.tokens;
  const recent = endedChanges.slice(-5);
  const growth = recent.length >= 3 ? median(recent) : null;
  // Past the compact point there are no turns left, not a
  // negative count of them.
  const turnsLeft: Room["turnsLeft"] =
    growth === null || toAutoCompact === null
      ? null
      : {
          value: toAutoCompact <= 0 ? 0 : Math.floor(toAutoCompact / growth),
          estimated: true,
        };
  return { window, autoCompact, toLimit, toAutoCompact, turnsLeft };
}

/** A step's sentence, as the describer words it — both
 * reads name a step by it. Given the project's folder, a file
 * inside it is worded relative to it. */
export function stepLabel(
  data: SessionData,
  step: StepRow,
  projectPath?: string,
): string {
  const turn =
    step.turnId === null ? undefined : data.turnsById.get(step.turnId);
  const context = stepContext(step, turn, data);
  return describeStep(
    step,
    projectPath === undefined ? context : { ...context, projectPath },
  ).sentence;
}

/** The size of a step that entered context: the
 * transcript's count when it named one, else the result's
 * whole size. */
export function stepChars(step: StepRow): number | null {
  return step.contextChars ?? step.resultSize;
}

/** The human events that put text of their own into the
 * context; a permission answer or a question's answer is the
 * step's result, not a second thing. */
const CONTEXT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "command",
  "handback",
  "notice",
  "interrupt",
]);

/** Under this, the rise didn't hold the result and the reply
 * as assumed, so the estimate stands rather than a figure
 * the subtraction left over. */
const MEASURED_FLOOR = 10;

/** Whether a load, a compaction or a message of Claude Code's
 * entered the main thread between two moments. A subagent's
 * start-up listings went to the subagent's context. */
function enteredBetween(data: SessionData, from: number, to: number): boolean {
  const inWindow = (at: number): boolean => at > from && at <= to;
  return (
    data.loads.some(
      (load) => load.branchId === null && inWindow(load.occurredAt),
    ) ||
    data.segments.some((segment) => inWindow(segment.startedAt)) ||
    data.humans.some(
      (event) =>
        CONTEXT_EVENT_KINDS.has(event.kind) && inWindow(event.occurredAt),
    )
  );
}

function switchedModel(previous: RequestRow, request: RequestRow): boolean {
  return (
    previous.model !== null &&
    request.model !== null &&
    previous.model !== request.model
  );
}

/** A tool result with its size read off the context's rise. */
export interface MeasuredResult {
  step: StepRow;
  tokens: number;
}

/**
 * The size of the one tool result a request carried, when
 * nothing else entered since the request before it: the
 * rise between them, less the reply that made the call,
 * whose output tokens are exact. A request carrying several
 * results, a new prompt, a load, a compaction, a message of
 * Claude Code's, a model switch or a cache rebuild leaves
 * the estimate standing, since the rise holds more than the
 * result.
 */
export function measuredResult(
  data: SessionData,
  previous: RequestRow,
  request: RequestRow,
): MeasuredResult | null {
  const [step, ...others] = data.stepsByResult.get(request.id) ?? [];
  const { startedAt: from, outputTokens: reply } = previous;
  const to = request.startedAt;
  if (step === undefined || others.length > 0) return null;
  if (from === null || to === null || reply === null) return null;
  if (request.turnId !== previous.turnId) return null;
  if (switchedModel(previous, request)) return null;
  if (isCacheRebuild(previous, request)) return null;
  if (enteredBetween(data, from, to)) return null;
  const tokens =
    requestContextTokens(request) - requestContextTokens(previous) - reply;
  return tokens < MEASURED_FLOOR ? null : { step, tokens };
}

/** A load's name, the same in both reads: an instructions
 * load is named by its file, and a load with no recorded
 * name reads as its kind. */
export function loadName(load: LoadRow): string {
  return load.kind === "instructions" || load.kind === "skill-file"
    ? (load.filePath ?? load.name ?? load.kind)
    : (load.name ?? load.kind);
}

/** The files a skill's load attached, with their estimated
 * tokens; null when it attached none. The files are loads of
 * their own kind, so no read lists them apart from the skill. */
export function skillFilesOf(
  data: SessionData,
  load: LoadRow,
): SkillFiles | null {
  const rows = data.skillFilesByLoad.get(load.id);
  if (rows === undefined) return null;
  const items = rows.map((row) => ({
    loadId: row.id,
    path: loadName(row),
    bytes: row.sizeBytes,
    lines: row.lineCount,
    tokens: estimatedTokens(row.sizeBytes),
  }));
  return {
    tokens: items.reduce((sum, file) => sum + (file.tokens ?? 0), 0),
    items,
  };
}

/** The main thread's load kinds a read lists, the same in
 * both reads. A subagent's instruction files are its own. */
export function isListedLoad(
  load: LoadRow,
): load is LoadRow & { kind: ListedLoadKind } {
  return (
    load.branchId === null &&
    (load.kind === "skill" ||
      load.kind === "instructions" ||
      load.kind === "command-output")
  );
}

/** The attachment kinds a read lists as items of their
 * own, the same in both reads. */
export function isListedAttachment(
  row: PromptAttachmentRow,
): row is PromptAttachmentRow & { kind: "image" | "file" } {
  return row.kind === "image" || row.kind === "file";
}

/** A text file's tokens, estimated from its bytes. An image's
 * are in no figure Claude Code reports, so they stay unknown,
 * never zero. */
export function attachmentTokens(
  row: PromptAttachmentRow & { kind: "image" | "file" },
): number | null {
  return row.kind === "file" ? estimatedTokens(row.sizeBytes) : null;
}

export function promptAttachmentsByTurn(
  rows: PromptAttachmentRow[],
): Map<number, PromptAttachmentRow[]> {
  const byTurn = new Map<number, PromptAttachmentRow[]>();
  for (const row of rows) {
    const own = byTurn.get(row.turnId) ?? [];
    own.push(row);
    byTurn.set(row.turnId, own);
  }
  return byTurn;
}

/**
 * One step inside a rise: a branch's spawning step reads as
 * the branch's return, any other step as itself. A background
 * launch returned only its notice, so it is a plain step; the
 * report is listed apart, when it enters. The raw size rides
 * along only when less entered than was made.
 */
function stepItem(
  data: SessionData,
  step: StepRow,
  measured: MeasuredResult | null,
): RiseItem {
  const label = stepLabel(data, step, data.session.projectPath ?? undefined);
  const chars = stepChars(step);
  const measuredTokens = measured?.step.id === step.id ? measured.tokens : null;
  if (SUBAGENT_TOOLS.has(step.toolName) && !launchedInBackground(step)) {
    const branch = data.branchBySpawningStep.get(step.id);
    return {
      kind: "branch-return",
      stepId: step.id,
      branchId: branch === undefined ? null : branch.id,
      label,
      chars,
      tokens: estimatedTokens(chars),
      estimated: true,
    };
  }
  return {
    kind: "step",
    stepId: step.id,
    label,
    chars,
    rawChars:
      step.contextChars !== null &&
      step.resultSize !== null &&
      step.contextChars < step.resultSize
        ? step.resultSize
        : null,
    tokens: measuredTokens ?? estimatedTokens(chars),
    estimated: measuredTokens === null,
  };
}

/** The main thread's background reports that entered between
 * two requests, each a return of its subagent. */
function reportItems(
  reports: BackgroundReport[],
  from: TokenPoint,
  to: TokenPoint,
): RiseItem[] {
  return reports
    .filter(
      ({ handback }) =>
        handback.occurredAt > from.at && handback.occurredAt <= to.at,
    )
    .map(({ branch, spawning, handback }): RiseItem => ({
      kind: "branch-return",
      stepId: spawning.id,
      branchId: branch.id,
      label: handbackName(handback.agentType),
      chars: handback.chars,
      tokens: estimatedTokens(handback.chars),
      estimated: true,
    }));
}

/**
 * The prompt a rise's later request opened its turn with,
 * and the images and files that came with it. Attachment
 * rows of the prompt's own kinds are its text, already
 * counted in the prompt item, so only images and files
 * become items of their own.
 */
function promptItems(
  data: SessionData,
  turnId: number,
  attachments: PromptAttachmentRow[],
): RiseItem[] {
  const items: RiseItem[] = [];
  const turn = data.turnsById.get(turnId);
  if (turn !== undefined) {
    items.push({
      kind: "prompt",
      turnId,
      chars: turn.promptChars,
      tokens: estimatedTokens(turn.promptChars),
      estimated: true,
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
      estimated: true,
    });
  }
  return items;
}

/** One load as a rise item; a kind the lens doesn't name
 * makes no item. */
function loadItem(data: SessionData, load: LoadRow): RiseItem | null {
  if (!isListedLoad(load)) return null;
  return {
    kind: "load",
    loadId: load.id,
    loadKind: load.kind,
    name: loadName(load),
    bytes: load.sizeBytes,
    tokens: estimatedTokens(load.sizeBytes),
    files: skillFilesOf(data, load),
    estimated: true,
  };
}

/**
 * The session's rows indexed for the pair walk, so the
 * walk stays one pass over the series whatever the session
 * holds: main steps by the time they ended, attachments by
 * turn, and the background reports the main thread received.
 */
interface RiseIndex {
  mainStepsByEnd: { step: StepRow; endedAt: number }[];
  attachmentsByTurn: Map<number, PromptAttachmentRow[]>;
  reports: BackgroundReport[];
}

function buildRiseIndex(data: SessionData): RiseIndex {
  const mainStepsByEnd: { step: StepRow; endedAt: number }[] = [];
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
    reports: backgroundReports(data, null),
  };
}

interface RiseSteps {
  link: Rise["link"];
  steps: StepRow[];
}

/** The first index whose step ended after `at`. */
function firstEndedAfter(
  entries: { step: StepRow; endedAt: number }[],
  at: number,
): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid];
    if (entry === undefined || entry.endedAt <= at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The steps a rise is explained by, and how they were
 * found. When the session's transcript link exists at all,
 * it alone decides: a rise it doesn't name is "none",
 * never the time rule's guess — a millisecond's slip in a
 * timestamp must not be able to make the answer confidently
 * wrong. Without the link, the time rule: main-thread steps
 * that ended inside the window between the two requests.
 */
function riseSteps(
  data: SessionData,
  index: RiseIndex,
  from: TokenPoint,
  to: TokenPoint,
): RiseSteps {
  if (data.stepsByResult.size > 0) {
    const steps = data.stepsByResult.get(to.requestId) ?? [];
    return { link: steps.length === 0 ? "none" : "exact", steps };
  }
  const steps: StepRow[] = [];
  let i = firstEndedAfter(index.mainStepsByEnd, from.at);
  for (; i < index.mainStepsByEnd.length; i++) {
    const entry = index.mainStepsByEnd[i];
    if (entry === undefined || entry.endedAt > to.at) {
      break;
    }
    steps.push(entry.step);
  }
  return { link: steps.length === 0 ? "none" : "by_time", steps };
}

/** Items ranked largest first; an unknown size ranks last. */
function rankItems(items: RiseItem[]): RiseItem[] {
  return [...items].sort((a, b) => {
    const sizeA = itemTokens(a);
    const sizeB = itemTokens(b);
    if (sizeA === null) return sizeB === null ? 0 : 1;
    if (sizeB === null) return -1;
    return sizeB - sizeA;
  });
}

function buildRise(
  data: SessionData,
  index: RiseIndex,
  requestsById: Map<number, RequestRow>,
  firstOfTurn: Set<number>,
  loads: RiseItem[],
  from: TokenPoint,
  to: TokenPoint,
  delta: number,
): Rise {
  const { link, steps } = riseSteps(data, index, from, to);
  const earlier = requestsById.get(from.requestId);
  const later = requestsById.get(to.requestId);
  const measured =
    earlier === undefined || later === undefined
      ? null
      : measuredResult(data, earlier, later);
  const items: RiseItem[] = steps.map((step) => stepItem(data, step, measured));
  if (to.turnId !== null && firstOfTurn.has(to.requestId)) {
    items.push(
      ...promptItems(
        data,
        to.turnId,
        index.attachmentsByTurn.get(to.turnId) ?? [],
      ),
    );
  }
  items.push(...reportItems(index.reports, from, to));
  items.push(...loads);
  if (earlier !== undefined && earlier.outputTokens !== null) {
    items.push({
      kind: "reply",
      requestId: from.requestId,
      tokens: earlier.outputTokens,
      estimated: false,
    });
  }
  const known = items.reduce((sum, item) => sum + (itemTokens(item) ?? 0), 0);
  // The gap is named as its own item, never spread over the
  // others; an estimate that overshoots the measured rise
  // stands as it is.
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
    items: rankItems(items),
  };
}

/** The compaction segment that opened between two points, if one did. */
function compactionBetween(
  data: SessionData,
  from: TokenPoint,
  to: TokenPoint,
) {
  return data.segments.find(
    (row) =>
      row.kind === "compact" &&
      row.startedAt > from.at &&
      row.startedAt <= to.at,
  );
}

function buildDrop(data: SessionData, from: TokenPoint, to: TokenPoint): Drop {
  const segment = compactionBetween(data, from, to);
  return {
    id: `drop-${to.requestId}`,
    fromRequestId: from.requestId,
    toRequestId: to.requestId,
    at: to.at,
    before: from.tokens,
    after: to.tokens,
    cause: segment === undefined ? "unknown" : "compaction",
    segmentId: segment === undefined ? null : segment.id,
  };
}

interface RisePair {
  from: TokenPoint;
  to: TokenPoint;
  delta: number;
}

/** Each consecutive pair of main points, in the order the
 * requests started — the walk every pair-shaped read of the
 * series shares. */
function forEachPair(
  main: TokenPoint[],
  visit: (from: TokenPoint, to: TokenPoint) => void,
): void {
  for (let i = 1; i < main.length; i++) {
    const from = main[i - 1];
    const to = main[i];
    if (from === undefined || to === undefined) continue;
    visit(from, to);
  }
}

/**
 * Each rise pair's load items, found in one pass over the
 * loads: pairs are met in series order and their windows
 * never overlap, so a load once passed belongs to no later
 * pair's window.
 */
function loadsForPairs(data: SessionData, pairs: RisePair[]): RiseItem[][] {
  const grouped = pairs.map((): RiseItem[] => []);
  let cursor = 0;
  pairs.forEach((pair, index) => {
    while (cursor < data.loads.length) {
      const load = data.loads[cursor];
      if (load === undefined || load.occurredAt > pair.to.at) break;
      cursor += 1;
      if (load.occurredAt <= pair.from.at) continue;
      const item = loadItem(data, load);
      if (item !== null) grouped[index]?.push(item);
    }
  });
  return grouped;
}

/**
 * The main series read pair by pair: each rise at or above
 * the floor with its items, and every fall. The floor is
 * RISE_FLOOR, flat, at any room limit: a share-of-limit
 * floor would hide the small step-caused rises the lens
 * exists to explain, and size ranking already puts them
 * last.
 */
function risesAndDrops(
  data: SessionData,
  requestsById: Map<number, RequestRow>,
  main: TokenPoint[],
): { rises: Rise[]; drops: Drop[] } {
  const index = buildRiseIndex(data);
  const firstOfTurn = new Set<number>();
  const seenTurns = new Set<number>();
  for (const point of main) {
    if (point.turnId === null || seenTurns.has(point.turnId)) continue;
    seenTurns.add(point.turnId);
    firstOfTurn.add(point.requestId);
  }
  const pairs: RisePair[] = [];
  const drops: Drop[] = [];
  forEachPair(main, (from, to) => {
    const delta = to.tokens - from.tokens;
    if (delta < 0) {
      drops.push(buildDrop(data, from, to));
    } else if (delta >= RISE_FLOOR) {
      pairs.push({ from, to, delta });
    }
  });
  const loads = loadsForPairs(data, pairs);
  const rises = pairs.map((pair, i) =>
    buildRise(
      data,
      index,
      requestsById,
      firstOfTurn,
      loads[i] ?? [],
      pair.from,
      pair.to,
      pair.delta,
    ),
  );
  rises.sort((a, b) => b.delta - a.delta);
  return { rises, drops };
}

/**
 * A rebuild's cause. A compaction comes first because it
 * explains the rewrite whatever else changed alongside
 * it. The lifetime a point rides is its recorded one,
 * never inferred from anything else. A reload that
 * returns the same tools at the same sizes is
 * indistinguishable from no change, so it stays unknown.
 */
function rebuildCause(
  data: SessionData,
  previous: RequestRow,
  current: RequestRow,
  from: TokenPoint,
  to: TokenPoint,
): RebuildCause | null {
  const segment = compactionBetween(data, from, to);
  if (segment !== undefined) {
    return { kind: "compaction", expected: true, segmentId: segment.id };
  }
  const expired = expiredCause(previous, from, to);
  if (expired !== null) return expired;
  if (
    previous.model !== null &&
    current.model !== null &&
    previous.model !== current.model
  ) {
    return {
      kind: "model",
      expected: false,
      from: previous.model,
      to: current.model,
    };
  }
  if (
    previous.effort !== null &&
    current.effort !== null &&
    previous.effort !== current.effort
  ) {
    return {
      kind: "effort",
      expected: false,
      from: previous.effort,
      to: current.effort,
    };
  }
  if (
    previous.shapeHash !== null &&
    current.shapeHash !== null &&
    previous.shapeHash !== current.shapeHash
  ) {
    return { kind: "tools", expected: false };
  }
  return null;
}

/**
 * The expiry cause, when the gap before this request ran
 * past the lifetime the previous point rode. The gap is
 * measured from when the previous request ended — or from
 * its start, when its duration went unrecorded.
 */
function expiredCause(
  previous: RequestRow,
  from: TokenPoint,
  to: TokenPoint,
): RebuildCause | null {
  const lifetime = from.cacheLifetime;
  if (lifetime === null) return null;
  const gap = to.at - (from.at + (previous.durationMs ?? 0));
  if (gap <= CACHE_LIFETIME_MS[lifetime]) return null;
  return {
    kind: "expired",
    expected: false,
    gapMinutes: Math.round(gap / 60_000),
    lifetime,
  };
}

/**
 * Whether a request rebuilt the cache: it wrote more than
 * half the context it sent, when the request before it had
 * read from the cache. A request that follows a cold one is
 * still warming up, not rebuilding, however much it writes.
 */
function isCacheRebuild(previous: RequestRow, current: RequestRow): boolean {
  return (
    (cacheWriteTokens(current) ?? 0) > requestContextTokens(current) / 2 &&
    (previous.cacheReadTokens ?? 0) > 0
  );
}

// Below this a rewrite is noise: a clean session stays silent.
export const WRITE_FLOOR = 5_000;

/**
 * Whether a request rebuilt the cache, either by writing more
 * than half its context or, after a model, effort or tool-server
 * change, by writing at least WRITE_FLOOR. Claude Code can reuse
 * part of the cached prefix across such a change, so the share
 * written is smaller than a full rebuild's. Other causes keep
 * the half rule: from the size alone, ordinary growth would
 * read as a rebuild.
 */
export function isRebuildWithCause(
  previous: RequestRow,
  current: RequestRow,
  cause: RebuildCause | null,
): boolean {
  if (isCacheRebuild(previous, current)) return true;
  const changed =
    cause?.kind === "model" ||
    cause?.kind === "effort" ||
    cause?.kind === "tools";
  return (
    changed &&
    (cacheWriteTokens(current) ?? 0) >= WRITE_FLOOR &&
    (previous.cacheReadTokens ?? 0) > 0
  );
}

/** A request that rebuilt the cache, beside the one before it. */
export interface RebuildPair {
  previous: RequestRow;
  current: RequestRow;
  /** When the rebuilding request started. */
  at: number;
  cause: RebuildCause | null;
}

/** The main thread's requests: the series the curve is drawn from. */
export function mainSeries(data: SessionData): RequestRow[] {
  return data.requests.filter(
    (request) => request.branchId === null && request.querySource === "main",
  );
}

/** The main series' consecutive requests that `isRebuild`
 * accepts, in the order they happened, each with its cause. */
export function rebuildPairs(
  data: SessionData,
  isRebuild: (
    previous: RequestRow,
    current: RequestRow,
    cause: RebuildCause | null,
  ) => boolean,
): RebuildPair[] {
  const requests = mainSeries(data);
  const requestsById = new Map(requests.map((r) => [r.id, r]));
  const pairs: RebuildPair[] = [];
  forEachPair(seriesPoints(requests), (from, to) => {
    const previous = requestsById.get(from.requestId);
    const current = requestsById.get(to.requestId);
    if (previous === undefined || current === undefined) return;
    const cause = rebuildCause(data, previous, current, from, to);
    if (!isRebuild(previous, current, cause)) return;
    pairs.push({ previous, current, at: to.at, cause });
  });
  return pairs;
}

function cacheRebuilds(data: SessionData): Rebuild[] {
  return rebuildPairs(data, isRebuildWithCause).map(
    ({ current, at, cause }) => ({
      id: `rebuild-${current.id}`,
      requestId: current.id,
      at,
      written: cacheWriteTokens(current) ?? 0,
      context: requestContextTokens(current),
      cause,
    }),
  );
}

export function tokenHistory(
  data: SessionData,
  context: { autoCompactWindow: number | null; storePromptText: boolean },
): TokenHistory {
  const mainRequests = mainSeries(data);
  const main = seriesPoints(mainRequests);
  const requestsById = new Map(mainRequests.map((r) => [r.id, r]));
  const { branches, background } = branchHistories(data);
  const { turns, endedChanges } = turnHistories(
    data,
    mainRequests,
    main,
    context.storePromptText,
  );
  const { rises, drops } = risesAndDrops(data, requestsById, main);
  return {
    sessionId: data.session.id,
    states: {
      telemetry: data.session.sources.includes("telemetry"),
      tokensPartial: data.session.tokensPartial,
      joinedPartway: data.session.joinedPartway,
    },
    base: main[0] ?? null,
    main,
    branches,
    background,
    turns,
    room: roomLeft(data, context.autoCompactWindow, main, endedChanges),
    rises,
    drops,
    rebuilds: cacheRebuilds(data),
  };
}

/** GET /api/sessions/:id/tokens — one session's token history. */
export function sessionTokens(
  storage: Storage,
  sessionId: string,
  context: { autoCompactWindow: number | null; storePromptText: boolean },
): TokenHistory | undefined {
  const data = loadSessionData(storage, sessionId);
  return data === undefined ? undefined : tokenHistory(data, context);
}
