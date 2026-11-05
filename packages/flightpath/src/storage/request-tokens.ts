// What the requests table records about tokens: the one sum
// every total is built from, a cache write, the overhead query.

import type { DatabaseSync } from "./sqlite.js";

// A request's total: its five token columns, each zero when unrecorded.
export const REQUEST_TOKEN_SUM =
  "COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)" +
  " + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_5m_tokens, 0)" +
  " + COALESCE(cache_write_1h_tokens, 0)";

/** A request's total in TypeScript: REQUEST_TOKEN_SUM's five
 * columns, each zero when unrecorded — output included, the
 * measure every "tokens processed" figure reports. */
export function requestTotalTokens(request: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}): number {
  return (
    (request.inputTokens ?? 0) +
    (request.outputTokens ?? 0) +
    (request.cacheReadTokens ?? 0) +
    (request.cacheWrite5mTokens ?? 0) +
    (request.cacheWrite1hTokens ?? 0)
  );
}

/**
 * A request's context: what it sent — its input and its cache,
 * never its output, which is no part of the window it ran in.
 * The follower's context samples are this sum over the usage
 * a response entry reported; each unrecorded count is zero.
 */
export function requestContextTokens(request: {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}): number {
  return (
    (request.inputTokens ?? 0) +
    (request.cacheReadTokens ?? 0) +
    (request.cacheWrite5mTokens ?? 0) +
    (request.cacheWrite1hTokens ?? 0)
  );
}

export function cacheWriteTokens(request: {
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}): number | null {
  if (
    request.cacheWrite5mTokens === null &&
    request.cacheWrite1hTokens === null
  ) {
    return null;
  }
  return (request.cacheWrite5mTokens ?? 0) + (request.cacheWrite1hTokens ?? 0);
}

// What Flightpath's own commands cost (ADR-0021): the requests
// of the turns a Flightpath command reached the model in, on
// the requests index. Named for the plan test.
export const OVERHEAD_SQL = `SELECT COALESCE(SUM(${REQUEST_TOKEN_SUM}), 0) AS total
  FROM requests r JOIN turns t ON t.id = r.turn_id
  WHERE r.session_id = ? AND t.flightpath_command = 1`;

export function flightpathOverheadTokens(
  db: DatabaseSync,
  sessionId: string,
): number {
  const row = db.prepare(OVERHEAD_SQL).get(sessionId) as { total: number };
  return row.total;
}
