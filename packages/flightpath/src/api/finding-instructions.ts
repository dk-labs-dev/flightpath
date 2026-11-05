// The instruction files Claude Code reads before the first
// request. They ride on every request after it, so a large set
// is worth trimming. Only paths and sizes are read, never the
// files (ADR-0004).

import type { ContextReportRow } from "../storage/index.js";
import { epochInstructions, firstMainRequest } from "./context-at-step.js";
import { contextReportFor } from "./context-limit.js";
import { instructionsWording, type ListedFile } from "./finding-wording.js";
import type { Finding } from "./payloads.js";
import type { SessionData } from "./session-data.js";

// Below this the files are not worth a word: a clean session
// stays silent.
const TRIM_FLOOR = 5_000;

const LISTED_FILES = 5;

type Total = Finding["measure"];

// A file loaded again (a resume, a compaction) is one file; the
// copy that has a size stands for it.
function startupFiles(data: SessionData, startedAt: number): ListedFile[] {
  const byPath = new Map<string, ListedFile>();
  for (const { name, tokens } of epochInstructions(
    data,
    null,
    data.session.firstSeenAt,
    startedAt,
  )) {
    if (byPath.get(name)?.tokens == null)
      byPath.set(name, { path: name, tokens });
  }
  return [...byPath.values()];
}

// The report counts every file loaded when it was taken, so a
// load after the first request may be in its figure and not in
// ours: the figure then stands for something else.
function reportedTotal(
  data: SessionData,
  report: ContextReportRow | null,
  startedAt: number,
): number | null {
  if (report?.memoryFiles == null) return null;
  const { reportedAt } = report;
  const loadedMeanwhile = data.loads.some(
    (load) =>
      load.kind === "instructions" &&
      load.branchId === null &&
      load.occurredAt > startedAt &&
      load.occurredAt <= reportedAt,
  );
  return loadedMeanwhile ? null : report.memoryFiles;
}

// A file with no recorded size is never counted as empty, so
// without a measured total the sum cannot be known.
function summedTotal(files: ListedFile[]): number | null {
  let tokens = 0;
  for (const file of files) {
    if (file.tokens === null) return null;
    tokens += file.tokens;
  }
  return tokens;
}

function totalOf(
  data: SessionData,
  files: ListedFile[],
  startedAt: number,
  model: string | null,
): Total | null {
  const report = contextReportFor(data.contextReports, model);
  const reported = reportedTotal(data, report, startedAt);
  if (reported !== null) return { tokens: reported, basis: "from-context" };
  const summed = summedTotal(files);
  return summed === null ? null : { tokens: summed, basis: "estimated" };
}

function largestFirst(files: ListedFile[]): ListedFile[] {
  return [...files].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

export function instructionFindings(data: SessionData): Finding[] {
  // Without the session's start there is no telling which files
  // were loaded at it.
  if (data.session.joinedPartway) return [];
  const first = firstMainRequest(data);
  if (first?.startedAt == null) return [];
  const files = startupFiles(data, first.startedAt);
  if (files.length === 0) return [];
  const total = totalOf(
    data,
    files,
    first.startedAt,
    first.model ?? data.session.model,
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
        more: Math.max(0, listed.length - LISTED_FILES),
      }),
    },
  ];
}
