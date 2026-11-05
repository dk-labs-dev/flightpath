// The picker's shaping, with no rendering in it: a folder's
// name, the search and project filters, and the day folders.
// Days are read off the local clock, so a test — or a traveller
// — that moves the clock moves the folders with it.

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";
import {
  formatClock,
  formatDayHeading,
  startOfDay,
} from "@flightpath/flightpath/format";

/** A live session heard from longer ago than this, with no
 * step running, reads as quiet rather than active. */
export const QUIET_AFTER_MS = 5 * 60 * 1000;

/**
 * The one quiet rule, shared by the picker and the session
 * summary: when the session went quiet, or null when it is
 * not quiet — heard from within the last few minutes, or
 * running a step, a session is simply live.
 */
function quietSinceFor(
  status: string,
  hasOpenStep: boolean,
  lastActivityAt: number,
  nowMs: number,
): number | null {
  if (status !== "live" || hasOpenStep) {
    return null;
  }
  return nowMs - lastActivityAt >= QUIET_AFTER_MS ? lastActivityAt : null;
}

/** When a live session went quiet, or null when it is not quiet. */
export function quietSince(
  session: SessionListItem,
  nowMs: number,
): number | null {
  return quietSinceFor(
    session.status,
    session.hasOpenStep,
    session.lastActivityAt,
    nowMs,
  );
}

/** The facts a session's state label is read from, in the
 * shape both the summary and the picker item already carry. */
export interface SessionStateSource {
  status: string;
  hasOpenStep: boolean;
  lastActivityAt: number;
  endedAt: number | null;
  endSeen: boolean;
}

export interface SessionStateLabel {
  text: string;
  tone: "live" | "quiet" | "ended";
}

/**
 * The one wording of a session's state, shared by the summary
 * badge and the picker's live card so the two never word the
 * same state differently. The tone names how the badge is
 * drawn: live and quiet carry a dot, ended is an outline.
 */
export function sessionStateLabel(
  session: SessionStateSource,
  nowMs: number,
): SessionStateLabel {
  const quietAt = quietSinceFor(
    session.status,
    session.hasOpenStep,
    session.lastActivityAt,
    nowMs,
  );
  if (quietAt !== null) {
    return {
      text: `Live · quiet since ${formatClock(quietAt)}`,
      tone: "quiet",
    };
  }
  if (session.status === "live") {
    return { text: "Live", tone: "live" };
  }
  if (session.status === "ended") {
    const at = formatClock(session.endedAt ?? session.lastActivityAt);
    return session.endSeen
      ? { text: `Ended ${at}`, tone: "ended" }
      : { text: `Ended ${at} · no exit seen`, tone: "ended" };
  }
  return { text: "Paused", tone: "ended" };
}

/** The folder's own name: the last part of its path, on either separator. */
export function projectName(project: string | null): string | null {
  if (project === null) {
    return null;
  }
  const parts = project.split(/[\\/]+/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? null;
}

/** The distinct project names in the list, in the order they first appear. */
export function projectNames(sessions: SessionListItem[]): string[] {
  const names: string[] = [];
  for (const session of sessions) {
    const name = projectName(session.project);
    if (name !== null && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function matchesQuery(session: SessionListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return (
    session.title.toLowerCase().includes(needle) ||
    (session.project ?? "").toLowerCase().includes(needle) ||
    (projectName(session.project) ?? "").toLowerCase().includes(needle)
  );
}

/** Search over titles and folders, narrowed by the project filter. */
export function filterSessions(
  sessions: SessionListItem[],
  query: string,
  project: string | null,
): SessionListItem[] {
  return sessions.filter(
    (session) =>
      matchesQuery(session, query) &&
      (project === null || projectName(session.project) === project),
  );
}

export interface DayFolder {
  /** The local day's start, as a string key. */
  key: string;
  heading: string;
  sessions: SessionListItem[];
}

/**
 * The day folders, by start time, newest first: a session sits
 * under the day it started, even one that ran past midnight.
 */
export function groupByDay(
  sessions: SessionListItem[],
  nowMs: number,
): DayFolder[] {
  const byKey = new Map<string, DayFolder>();
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  for (const session of sorted) {
    const start = startOfDay(session.startedAt);
    const key = start.toISOString();
    let folder = byKey.get(key);
    if (folder === undefined) {
      folder = {
        key,
        heading: formatDayHeading(session.startedAt, nowMs),
        sessions: [],
      };
      byKey.set(key, folder);
    }
    folder.sessions.push(session);
  }
  return [...byKey.values()];
}
