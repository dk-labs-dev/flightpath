import type { SessionSnapshot } from "@flightpath/flightpath/api/payloads";

import {
  LiveStream,
  type SnapshotLoad,
  type StreamSink,
  type StreamStatus,
} from "./stream";

// The stream's wiring for the shell: which stream a route
// opens, and the snapshot a reset reloads. The client itself
// (stream.ts) stays free of the shell's concerns.

async function fetchSnapshot(
  token: string,
  sessionId: string,
): Promise<SnapshotLoad> {
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { headers: { "x-flightpath-token": token } },
    );
    if (response.status === 404) {
      return { kind: "gone" };
    }
    if (!response.ok) {
      return { kind: "failed" };
    }
    return {
      kind: "loaded",
      snapshot: (await response.json()) as SessionSnapshot,
    };
  } catch {
    // A snapshot that cannot load is a failed reload: the
    // client keeps retrying it rather than reporting a
    // catch-up it never loaded.
    return { kind: "failed" };
  }
}

/** Start the stream for one route: a session's own stream on
 * its route, the picker's stream everywhere else. Everything
 * the stream says lands in the caller's sink. */
export function startLiveStream(
  token: string,
  sessionId: string | null,
  sink: StreamSink,
): LiveStream {
  const stream = new LiveStream({
    sessionId,
    token,
    loadSnapshot: (id) => fetchSnapshot(token, id),
    sink,
  });
  stream.start();
  return stream;
}

/** A sink for a caller that holds no rows: it follows the
 * connection's state and counts the step ids it is shown,
 * so the catch-up banner's count stays true. */
export function countingSink(
  report: (status: StreamStatus) => void,
): StreamSink {
  const stepIds = new Set<number>();
  return {
    change: (message) => {
      if (message.event === "step") stepIds.add(message.data.step.id);
    },
    summary: () => undefined,
    health: () => undefined,
    snapshot: (snapshot) => {
      stepIds.clear();
      for (const turn of snapshot.turns) {
        for (const step of turn.steps) stepIds.add(step.id);
      }
    },
    deleted: () => {
      stepIds.clear();
    },
    status: report,
    stepCount: () => stepIds.size,
  };
}
