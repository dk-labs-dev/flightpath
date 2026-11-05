import { useEffect } from "react";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { SessionsPayload } from "@flightpath/flightpath/api/payloads";
import type { StreamHealth } from "@flightpath/flightpath/daemon/stream-messages";

import { countingSink, startLiveStream } from "./live";
import { useLiveStore } from "./live-store";
import {
  noteContextNews,
  noteSessionReadsStale,
  type ShownContextStep,
} from "./session/api";
import { useSessionStore } from "./session/store";
import {
  applySessionMessage,
  reconcileSessions,
  SESSIONS_QUERY_KEY,
} from "./sessions/api";
import type { StreamSink } from "./stream";

/** The picker's step count: the cached list rows' steps summed. */
function cachedStepCount(client: QueryClient): number {
  const payload = client.getQueryData<SessionsPayload>(SESSIONS_QUERY_KEY);
  return payload?.sessions.reduce((total, row) => total + row.steps, 0) ?? 0;
}

/** The step the snapshot lens shows, read from the store:
 * the selection, or the latest step when none is selected.
 * A request is fixed, so none is shown while one is. */
function shownContextStep(): ShownContextStep | null {
  const state = useSessionStore.getState();
  if (state.latestStepId === null || state.selectedRequestId !== null) {
    return null;
  }
  const shown = state.selectedStepId ?? state.latestStepId;
  return { stepId: shown, isLatest: shown === state.latestStepId };
}

// The shell's stream for one route — the page's one stream.
// Its sink keeps the connection's state and the recorder's
// health in the live store on every route. Where the route's
// rows live decides the rest: on the picker's stream (no
// session selected) the sink writes list rows and tombstones
// into the sessions query's cache, and a catch-up reconciles
// the list with one reload; on a session's own stream the
// session store takes the changes, the summary, the reloaded
// snapshot and the session's end — the screen opens no stream
// of its own. The step count comes from what the sink holds:
// the session store's count, or the cached rows' counts summed.
export function useShellStream(token: string, sessionId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const counting = countingSink((next) => {
      useLiveStore.getState().setStatus(next);
      if (sessionId === null && next.kind === "caught-up") {
        reconcileSessions(queryClient);
      }
    });
    // The recorder's health is the banner's on every route:
    // it goes to the live store, never to a route's rows.
    const health = (next: StreamHealth): void => {
      useLiveStore.getState().setHealth(next);
    };
    const sink: StreamSink =
      sessionId === null
        ? {
            ...counting,
            change: (message) => {
              counting.change(message);
              applySessionMessage(queryClient, message);
            },
            health,
            stepCount: () => cachedStepCount(queryClient),
          }
        : {
            change: (message) => {
              useSessionStore.getState().change(message);
              // A context point or a step landing can change
              // the context at the latest step, and the token
              // history and the findings are reads of the same
              // rows: note them all.
              if (
                (message.event === "context" || message.event === "step") &&
                message.data.sessionId === sessionId
              ) {
                noteContextNews(queryClient, sessionId, shownContextStep);
                noteSessionReadsStale(queryClient, sessionId);
              }
            },
            summary: (summary) => {
              useSessionStore.getState().summary(summary);
              noteSessionReadsStale(queryClient, sessionId);
            },
            health,
            snapshot: (snapshot) =>
              useSessionStore.getState().snapshot(snapshot),
            deleted: () => useSessionStore.getState().deleted(),
            status: counting.status,
            stepCount: () => useSessionStore.getState().stepCount(),
          };
    const stream = startLiveStream(token, sessionId, sink);
    return () => {
      stream.stop();
      useLiveStore.getState().setStatus(null);
      useLiveStore.getState().setHealth(null);
    };
  }, [token, sessionId, queryClient]);
}
