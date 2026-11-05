// The session screen's reads: one snapshot when the screen
// opens (and again when the stream says the gap is too old),
// one step's detail when a step is opened, the context at a
// step or a request behind its own query, refreshed by the
// stream while that step is the session's latest, and the token
// history and the findings, each behind its own query,
// invalidated together by the stream. The token travels in a
// header, never the address (ADR-0022).

import {
  queryOptions,
  skipToken,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import type {
  ContextAsk,
  ContextAtStep,
  Finding,
  SessionSnapshot,
  StepDetail,
  TokenHistory,
} from "@flightpath/flightpath/api/payloads";

function headers(token: string): Record<string, string> {
  return { "x-flightpath-token": token };
}

/** The snapshot, or null when the daemon has no such session. */
export async function loadSnapshot(
  token: string,
  sessionId: string,
): Promise<SessionSnapshot | null> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    { headers: headers(token) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`snapshot answered ${response.status}`);
  }
  return (await response.json()) as SessionSnapshot;
}

/** One step's detail, or null when the step is gone. */
export async function loadStepDetail(
  token: string,
  stepId: number,
): Promise<StepDetail | null> {
  const response = await fetch(`/api/steps/${stepId}`, {
    headers: headers(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`step detail answered ${response.status}`);
  }
  return (await response.json()) as StepDetail;
}

/** The context query's key, and the key the stream's news
 * invalidates while the step is latest. */
export function contextQueryKey(sessionId: string, ask: ContextAsk) {
  return "step" in ask
    ? (["context", sessionId, "step", ask.step] as const)
    : (["context", sessionId, "request", ask.request] as const);
}

/** One step's or one request's context, or null when it is gone. */
export async function loadContextAt(
  token: string,
  sessionId: string,
  ask: ContextAsk,
): Promise<ContextAtStep | null> {
  const query = "step" in ask ? `step=${ask.step}` : `request=${ask.request}`;
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/context?${query}`,
    { headers: headers(token) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`context answered ${response.status}`);
  }
  return (await response.json()) as ContextAtStep;
}

/** One context query, built once for the lens's own read.
 * While the session, its token or the ask is unknown the
 * query stands down: skipToken keeps it from running. */
function contextOptions(
  sessionId: string | null,
  token: string | null,
  ask: ContextAsk | null,
) {
  return queryOptions({
    queryKey: contextQueryKey(sessionId ?? "", ask ?? { step: 0 }),
    queryFn:
      sessionId === null || token === null || ask === null
        ? skipToken
        : () => loadContextAt(token, sessionId, ask),
  });
}

/** The step a context note is about: the one the lens
 * shows, and whether it is the session's latest. Only the
 * latest step's context can still change. */
export interface ShownContextStep {
  stepId: number;
  isLatest: boolean;
}

/** The context behind its query: loaded when the lens opens
 * or the ask changes, and kept current by the stream's news
 * while the ask is the latest step (see noteContextNews) —
 * never by polling. */
export function useContextAt(
  sessionId: string | null,
  token: string | null,
  ask: ContextAsk | null,
) {
  return useQuery(contextOptions(sessionId, token, ask));
}

/** At most one invalidation per second for a session's
 * context, however busy the stream runs: the first note
 * lands at once, and a burst inside the second earns one
 * more at its end. */
const CONTEXT_STALE_MS = 1_000;

const contextStaleNotes = new Map<
  string,
  {
    last: number;
    timer: ReturnType<typeof setTimeout> | null;
    shownStep: () => ShownContextStep | null;
  }
>();

function invalidateContext(
  client: QueryClient,
  sessionId: string,
  stepId: number,
): void {
  void client.invalidateQueries({
    queryKey: contextQueryKey(sessionId, { step: stepId }),
  });
}

/**
 * Note stream news — a context point, or a step landing —
 * against the step the lens is showing, so that step's
 * query is invalidated, throttled to one refetch a second.
 * A step that isn't the latest is fixed: its context can't
 * change, so no note is taken for it. The shown step is
 * handed over as a read, not a value: it is resolved on
 * arrival, and again when a held-back refresh fires, so a
 * step that lands inside the second becomes the latest and
 * takes the refresh itself.
 */
export function noteContextNews(
  client: QueryClient,
  sessionId: string,
  shownStep: () => ShownContextStep | null,
): void {
  const shown = shownStep();
  if (shown === null || !shown.isLatest) return;
  const now = Date.now();
  const state = contextStaleNotes.get(sessionId) ?? {
    last: 0,
    timer: null,
    shownStep,
  };
  state.shownStep = shownStep;
  contextStaleNotes.set(sessionId, state);
  const wait = state.last + CONTEXT_STALE_MS - now;
  if (wait <= 0) {
    state.last = now;
    invalidateContext(client, sessionId, shown.stepId);
    return;
  }
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.last = Date.now();
    const current = state.shownStep();
    if (current !== null && current.isLatest) {
      invalidateContext(client, sessionId, current.stepId);
    }
  }, wait);
}

export function tokensQueryKey(sessionId: string) {
  return ["tokens", sessionId] as const;
}

/** The token history, or null when the daemon has no such session. */
export async function loadTokenHistory(
  token: string,
  sessionId: string,
): Promise<TokenHistory | null> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/tokens`,
    { headers: headers(token) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`token history answered ${response.status}`);
  }
  return (await response.json()) as TokenHistory;
}

/** The token history's query, built once for the lens's
 * own read and the screen's prefetch alike. While the
 * session or its token is unknown the query stands down:
 * skipToken keeps it from running at all. */
export function tokenHistoryOptions(
  sessionId: string | null,
  token: string | null,
) {
  return queryOptions({
    queryKey: tokensQueryKey(sessionId ?? ""),
    queryFn:
      sessionId === null || token === null
        ? skipToken
        : () => loadTokenHistory(token, sessionId),
  });
}

/** The token history behind its query: loaded once when the
 * lens opens, and kept current by the stream's news (see
 * noteSessionReadsStale) — never by polling. */
export function useTokenHistory(
  sessionId: string | null,
  token: string | null,
) {
  return useQuery(tokenHistoryOptions(sessionId, token));
}

export function findingsQueryKey(sessionId: string) {
  return ["findings", sessionId] as const;
}

/** The session's findings, or null when the daemon has no such session. */
export async function loadFindings(
  token: string,
  sessionId: string,
): Promise<Finding[] | null> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/findings`,
    { headers: headers(token) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`findings answered ${response.status}`);
  }
  return (await response.json()) as Finding[];
}

/** The findings' query. While the session or its token is
 * unknown the query stands down, as the token history's does. */
export function findingsOptions(
  sessionId: string | null,
  token: string | null,
) {
  return queryOptions({
    queryKey: findingsQueryKey(sessionId ?? ""),
    queryFn:
      sessionId === null || token === null
        ? skipToken
        : () => loadFindings(token, sessionId),
  });
}

/** The findings behind their query: read while the steps
 * lens is on screen, and kept current by the stream's news
 * (see noteSessionReadsStale) — never by polling. */
export function useFindings(sessionId: string | null, token: string | null) {
  return useQuery(findingsOptions(sessionId, token));
}

/** Dismiss one finding. The daemon answers 200 again when the
 * finding was already dismissed. */
export async function dismissFinding(
  token: string,
  sessionId: string,
  findingId: string,
): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/findings/${encodeURIComponent(findingId)}/dismiss`,
    { method: "POST", headers: headers(token) },
  );
  if (!response.ok) {
    throw new Error(`dismissing a finding answered ${response.status}`);
  }
}

/** At most one invalidation per second per session, however
 * busy the stream runs: the first note lands at once, and a
 * burst inside the second earns one more at its end. */
const SESSION_READS_STALE_MS = 1_000;

const staleNotes = new Map<
  string,
  { last: number; timer: ReturnType<typeof setTimeout> | null }
>();

function invalidateSessionReads(client: QueryClient, sessionId: string): void {
  void client.invalidateQueries({ queryKey: tokensQueryKey(sessionId) });
  void client.invalidateQueries({ queryKey: findingsQueryKey(sessionId) });
}

/**
 * Note that the stream brought a change the session's derived
 * reads can reflect — a context point, a step, or the session's
 * own summary — so the token history's and the findings'
 * queries are invalidated together, throttled to one refetch a
 * second. The wiring lives with the shell's stream; the
 * throttle lives here, beside the queries it throttles.
 */
export function noteSessionReadsStale(
  client: QueryClient,
  sessionId: string,
): void {
  const now = Date.now();
  const state = staleNotes.get(sessionId) ?? { last: 0, timer: null };
  staleNotes.set(sessionId, state);
  const wait = state.last + SESSION_READS_STALE_MS - now;
  if (wait <= 0) {
    state.last = now;
    invalidateSessionReads(client, sessionId);
    return;
  }
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.last = Date.now();
    invalidateSessionReads(client, sessionId);
  }, wait);
}
