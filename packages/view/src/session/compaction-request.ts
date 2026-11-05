// Rows in the steps lens with no step to open take the
// snapshot to a request instead: a compaction's row at the
// first request after it, a turn without steps at its last.

import type { QueryClient } from "@tanstack/react-query";
import type { TokenHistory } from "@flightpath/flightpath/api/payloads";

import { sessionHref } from "../route.js";
import { tokenHistoryOptions } from "./api.js";
import { useSessionStore } from "./store.js";

/** The request a row opens, found in the history read as the
 * row is asked; null when none qualifies or the history can't
 * be read. */
async function requestFor(
  client: QueryClient,
  find: (history: TokenHistory) => number | undefined,
): Promise<number | null> {
  const { sessionId, token } = useSessionStore.getState();
  if (sessionId === null || token === null) return null;
  try {
    const history = await client.fetchQuery(
      tokenHistoryOptions(sessionId, token),
    );
    return history === null ? null : (find(history) ?? null);
  } catch {
    return null;
  }
}

/** Opens the snapshot lens at the request the history gives;
 * with none, at the place the lens already has. The history
 * takes a moment to read, so the person may have gone
 * elsewhere by then — if the address changed, it stays
 * theirs. */
function openSnapshotAt(
  client: QueryClient,
  find: (history: TokenHistory) => number | undefined,
): void {
  const { sessionId } = useSessionStore.getState();
  if (sessionId === null) return;
  const addressAtClick = window.location.hash;
  void requestFor(client, find).then((requestId) => {
    if (window.location.hash !== addressAtClick) return;
    window.location.hash = sessionHref(
      sessionId,
      "snapshot",
      requestId === null ? {} : { request: requestId },
    );
  });
}

/** The first main-thread request after the compaction row's
 * event, whether or not a step followed. */
export function openSnapshotAfterCompaction(
  client: QueryClient,
  eventKey: string,
): void {
  const event = useSessionStore.getState().events.get(eventKey);
  openSnapshotAt(client, (history) =>
    event === undefined
      ? undefined
      : history.main.find((point) => point.at > event.at)?.requestId,
  );
}

/** The last main-thread request that answered the turn. */
export function openSnapshotAtTurn(client: QueryClient, turnId: number): void {
  openSnapshotAt(
    client,
    (history) =>
      history.main.filter((point) => point.turnId === turnId).at(-1)?.requestId,
  );
}
