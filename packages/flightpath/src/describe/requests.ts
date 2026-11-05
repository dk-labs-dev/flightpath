// Model requests: no sentence of their own — the panel fact
// for the request behind a step.

import type { RequestRow } from "../storage/index.js";
import { notRecorded } from "./format.js";
import type { Fact } from "./rows.js";

function partOfWords(
  querySource: string | null,
  telemetrySeen: boolean | undefined,
): string {
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

/** A request's panel fact: it has no row sentence of its own. */
export function describeRequest(
  request: RequestRow,
  ctx: { telemetrySeen?: boolean } = {},
): Fact[] {
  return [
    {
      label: "Part of",
      value: partOfWords(request.querySource, ctx.telemetrySeen),
    },
  ];
}
