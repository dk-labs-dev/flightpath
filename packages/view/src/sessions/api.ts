// The picker's reads: the session list, loaded once through
// TanStack Query and kept current by the live stream — the
// stream with no session selected sends exactly these rows,
// so nothing polls what the stream already pushes. The
// sink writes each row and tombstone into the query's cache
// (wiring: shell-stream); a catch-up reconciles with one
// reload, because a gap too old for the daemon's ring can
// have swallowed a tombstone. Token in a header (ADR-0022).

import { useQuery, type QueryClient } from "@tanstack/react-query";

import type {
  SessionListItem,
  SessionsPayload,
} from "@flightpath/flightpath/api/payloads";
import type { StreamMessage } from "@flightpath/flightpath/daemon/stream-messages";

export const SESSIONS_QUERY_KEY = ["sessions"] as const;

async function loadSessions(token: string): Promise<SessionsPayload> {
  const response = await fetch("/api/sessions", {
    headers: { "x-flightpath-token": token },
  });
  if (!response.ok) {
    throw new Error(`session list answered ${response.status}`);
  }
  return (await response.json()) as SessionsPayload;
}

export interface SessionListState {
  /** The last list read, or null until the first one lands. */
  sessions: SessionListItem[] | null;
  /** Sessions the list left out for having nothing in them. */
  emptyHidden: number;
  /** True when the latest load failed; the last list stays on screen. */
  failed: boolean;
}

const LOAD_RETRY_MS = 2_000;

export function useSessions(token: string): SessionListState {
  const query = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => loadSessions(token),
    // Freshness is the stream's job; this is only
    // recovery — while a load has failed it retries
    // until one lands, keeping "Retrying…" true.
    refetchInterval: (current) =>
      current.state.status === "error" ? LOAD_RETRY_MS : false,
  });
  return {
    sessions: query.data?.sessions ?? null,
    emptyHidden: query.data?.emptyHidden ?? 0,
    failed: query.isError,
  };
}

/** The cached order, matching the server's list query —
 * live first, then latest activity — so a streamed row and
 * a reloaded row never disagree. */
function inListOrder(sessions: SessionListItem[]): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    const liveDelta =
      (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1);
    return liveDelta !== 0 ? liveDelta : b.lastActivityAt - a.lastActivityAt;
  });
}

/**
 * Apply one stream message to the cached list: a row
 * replaces its own row or takes its place in the order,
 * a tombstone removes its row, and a hidden note removes
 * the row of a session that emptied out of the list.
 * A message that moves the hidden count carries the new
 * count with it. A summary is not a list row.
 */
export function applySessionMessage(
  client: QueryClient,
  message: StreamMessage,
): void {
  if (message.event !== "session") {
    return;
  }
  const data = message.data;
  if ("summary" in data) {
    return;
  }
  client.setQueryData<SessionsPayload>(SESSIONS_QUERY_KEY, (current) => {
    if (current === undefined) {
      return current;
    }
    if ("deleted" in data || "hidden" in data) {
      return {
        ...current,
        sessions: current.sessions.filter(
          (session) => session.id !== data.sessionId,
        ),
        emptyHidden: data.emptyHidden ?? current.emptyHidden,
      };
    }
    const row = data.session;
    const rest = current.sessions.filter((session) => session.id !== row.id);
    return {
      ...current,
      sessions: inListOrder([...rest, row]),
      emptyHidden: data.emptyHidden ?? current.emptyHidden,
    };
  });
}

/** One reload of the list, after a catch-up closes a gap. */
export function reconcileSessions(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
}
