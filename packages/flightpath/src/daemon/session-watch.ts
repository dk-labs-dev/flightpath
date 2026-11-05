// The session-end watch: once a minute, the daemon asks of every live
// session whether its Claude Code session is still there. The hook noted
// the process at the session's start: a process gone — or restarted
// under the same id — ends the session within about a minute, and a
// live process overrides quiet however long it lasts. A session with
// no process noted falls back to ten quiet minutes.

import type { LiveSessionHost } from "../storage/read.js";
import {
  processExists,
  readProcessStartTimes,
  sameProcessStart,
} from "../util/host-process.js";

export const SESSION_WATCH_INTERVAL_MS = 60 * 1000;
export const SESSION_QUIET_LIMIT_MS = 10 * 60 * 1000;

/** The slice of storage the watch reads and writes. */
export interface SessionWatchStorage {
  liveSessionHosts(): LiveSessionHost[];
  /** End the session this row describes, unseen, at its last event —
   * only when the stored row is still exactly this row: an event
   * landing mid-pass moves the row, and false says it did not land. */
  endSessionUnseenIfUnchanged(session: LiveSessionHost): boolean;
}

export interface SessionWatch {
  /** One pass over the live sessions; a pass asked for while
   * one is still running is skipped, and ends nothing. */
  runOnce(now?: number): Promise<string[]>;
}

export interface SessionWatchDeps {
  storage: SessionWatchStorage;
  /** Whether a process exists; defaults to a signal-0 probe. */
  exists?: (pid: number) => boolean;
  /** The noted processes' start times, read in one query;
   * a process missing from the result could not be re-read. */
  startedAts?: (pids: number[]) => Promise<Map<number, number>>;
}

// True when the noted process is certainly gone: it does not exist, or
// its start time sits well outside the reading's noise (the id was
// reused). One that exists but cannot be re-read counts as there.
function processIsGone(
  exists: (pid: number) => boolean,
  startTimes: Map<number, number>,
  session: LiveSessionHost,
): boolean {
  const pid = session.hostPid;
  if (pid === null) {
    return false;
  }
  if (!exists(pid)) {
    return true;
  }
  if (session.hostStartedAt === null) {
    return false;
  }
  const current = startTimes.get(pid);
  return (
    current !== undefined && !sameProcessStart(current, session.hostStartedAt)
  );
}

export function createSessionWatch(deps: SessionWatchDeps): SessionWatch {
  const exists = deps.exists ?? processExists;
  const startedAts = deps.startedAts ?? readProcessStartTimes;
  let running = false;
  return {
    runOnce: async (now = Date.now()) => {
      if (running) {
        return [];
      }
      running = true;
      try {
        const sessions = deps.storage.liveSessionHosts();
        // Start times are read only for processes that exist; when
        // none does, the query — a PowerShell run — is skipped.
        const notedPids = [
          ...new Set(
            sessions
              .map((session) => session.hostPid)
              .filter((pid) => pid !== null),
          ),
        ].filter((pid) => exists(pid));
        const startTimes = await startedAts(notedPids);
        const ended: string[] = [];
        for (const session of sessions) {
          const gone =
            session.hostPid !== null
              ? processIsGone(exists, startTimes, session)
              : now - session.lastSeenAt >= SESSION_QUIET_LIMIT_MS;
          if (gone && deps.storage.endSessionUnseenIfUnchanged(session)) {
            ended.push(session.id);
          }
        }
        return ended;
      } finally {
        running = false;
      }
    },
  };
}
