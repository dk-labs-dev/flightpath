// Cache rebuilds that name a cause worth acting on. The curve
// marks every rebuild; a finding is kept for the causes the
// person can avoid, and only when the size is worth a word.

import type { RequestRow } from "../storage/index.js";
import { cacheWriteTokens } from "../storage/request-tokens.js";
import { mcpServerOf } from "./context-at-step.js";
import {
  effortWording,
  expiredWording,
  modelWording,
  toolsWording,
} from "./finding-wording.js";
import type { Finding, FindingKind } from "./payloads.js";
import type { SessionData } from "./session-data.js";
import { isCacheRebuild, rebuildPairs, type RebuildPair } from "./tokens.js";

// Below this a rewrite is noise: a clean session stays silent.
const WRITE_FLOOR = 5_000;

// Anthropic's session-report plugin calls a request with more
// than this many uncached tokens (input plus cache writes) a
// cache break. A partial rebuild that large is reported too.
const UNCACHED_BREAK = 100_000;

// Claude Code's prompt-caching page says changing effort keeps
// the cache on the 5.5 models. The list names the models where
// it does not; a model that is not listed gets no effort finding.
// Claude Code may report a name with a date suffix, such as
// claude-haiku-4-5-20251001.
const EFFORT_SENSITIVE_MODEL =
  /^(?:claude-opus-4-6|claude-sonnet-4-6|claude-haiku-4-5)(?:-\d{8})?$/;

type NamedRebuild = Pick<
  Finding,
  "kind" | "headline" | "body" | "list" | "more" | "doc" | "copy"
>;

// A request after a cold one is warming up, not rebuilding,
// whatever its size, for the large partial rebuild as well.
function isReportable(previous: RequestRow, current: RequestRow): boolean {
  const written = cacheWriteTokens(current) ?? 0;
  if (isCacheRebuild(previous, current) && written >= WRITE_FLOOR) return true;
  const uncached = (current.inputTokens ?? 0) + written;
  return (previous.cacheReadTokens ?? 0) > 0 && uncached >= UNCACHED_BREAK;
}

function mcpToolNames(
  data: SessionData,
  request: RequestRow,
): Set<string> | undefined {
  const shape = data.requestShapes.find(
    (row) => row.hash === request.shapeHash,
  );
  if (shape === undefined) return undefined;
  const names = shape.tools
    .map((tool) => tool.name)
    .filter((name) => mcpServerOf(name) !== null);
  return new Set(names);
}

// A hash that changed with the same MCP tools is a prompt change
// alone, which the docs do not name as a cause.
function changedMcpServers(
  data: SessionData,
  previous: RequestRow,
  current: RequestRow,
): string[] {
  const before = mcpToolNames(data, previous);
  const after = mcpToolNames(data, current);
  if (before === undefined || after === undefined) return [];
  const changed = [
    ...[...before].filter((name) => !after.has(name)),
    ...[...after].filter((name) => !before.has(name)),
  ];
  const servers = changed.flatMap((name) => mcpServerOf(name) ?? []);
  return [...new Set(servers)].sort();
}

function namedRebuild(
  data: SessionData,
  { previous, current, cause }: RebuildPair,
  tokens: number,
): NamedRebuild | null {
  switch (cause?.kind) {
    case "expired":
      return {
        kind: "expired",
        ...expiredWording({ tokens, gapMinutes: cause.gapMinutes }),
      };
    case "model":
      return {
        kind: "model",
        ...modelWording({ tokens, from: cause.from, to: cause.to }),
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

// The first expired rebuild is worth a look; a session that
// keeps letting the cache lapse has a habit worth fixing.
function gradeOf(kind: FindingKind, expiredBefore: number): Finding["grade"] {
  return kind === "expired" && expiredBefore > 0
    ? "Worth fixing"
    : "Worth a look";
}

export function rebuildFindings(data: SessionData): Finding[] {
  const findings: Finding[] = [];
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
      ...named,
    });
    if (named.kind === "expired") expiredBefore += 1;
  }
  return findings;
}
