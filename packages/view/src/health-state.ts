// What the recorder's health means for the shell: which
// problem the banner shows (the most serious one), the words
// it shows it with, and the nav's status line that agrees
// with it. The readings arrive on the live stream, the
// banner's only source. The failure arrives already classed
// by the daemon; the words below are worded from that class,
// never from re-testing the error.

import type {
  LastError,
  StartProblem,
} from "@flightpath/flightpath/api/payloads";
import type { StreamHealth } from "@flightpath/flightpath/daemon/stream-messages";
import {
  formatAge,
  formatClock,
  formatCount,
} from "@flightpath/flightpath/format";

import type { StreamStatus } from "./stream.js";

export type HealthProblem =
  | { kind: "cant-start"; error: LastError; start: StartProblem }
  | { kind: "dropped"; dropped: number };

/** The one problem the banner shows, or null: a recorder
 * that can't start outranks dropped events. */
export function healthProblem(
  health: StreamHealth | null,
): HealthProblem | null {
  if (health === null) return null;
  if (health.lastError !== null) {
    return {
      kind: "cant-start",
      error: health.lastError,
      start: health.problem ?? { kind: "other" },
    };
  }
  if (health.dropped > 0) {
    return { kind: "dropped", dropped: health.dropped };
  }
  return null;
}

export type HealthAction =
  { kind: "port" } | { kind: "database"; path: string } | null;

/** The banner's one action, from the failure's class. */
export function healthAction(problem: HealthProblem): HealthAction {
  if (problem.kind !== "cant-start") {
    return null;
  }
  if (problem.start.kind === "port") return { kind: "port" };
  if (problem.start.kind === "database") {
    return { kind: "database", path: problem.start.path };
  }
  return null;
}

/** The cause in a sentence, worded from the failure's class.
 * The bind and database classes get their own sentences;
 * anything else is the recorded line itself. */
export function cantStartCause(error: LastError, start: StartProblem): string {
  const at = formatClock(error.at);
  if (start.kind === "port") {
    if (start.reason === "not-allowed") {
      return start.port !== null
        ? `The recorder isn't allowed to use port ${start.port}, so it couldn't start at ${at}.`
        : `The recorder isn't allowed to use its port, so it couldn't start at ${at}.`;
    }
    if (start.port !== null) {
      return `Port ${start.port} is in use by another program, and the recorder couldn't bind it at ${at}.`;
    }
    return `The recorder couldn't bind its port at ${at}.`;
  }
  if (start.kind === "database") {
    return `The recorder couldn't open its database at ${at}.`;
  }
  return error.message;
}

/** The waiting line under the cause, or null when nothing
 * is waiting. */
export function waitingLine(health: StreamHealth, now: number): string | null {
  if (health.buffered === 0 || health.oldestAt === null) return null;
  const events =
    health.buffered === 1
      ? "1 event is waiting"
      : `${formatCount(health.buffered)} events are waiting`;
  return (
    `${events} on this machine, the oldest from ` +
    `${formatAge(health.oldestAt, now)} ago. Nothing is lost yet: ` +
    "they're stored the moment the recorder starts."
  );
}

/** The dropped events line; the count and the noun agree. */
export function droppedLine(dropped: number): string {
  const noun = dropped === 1 ? "event" : "events";
  return (
    `About ${formatCount(dropped)} ${noun} dropped: the buffer was ` +
    "full; transcripts still cover these sessions."
  );
}

export interface NavStatus {
  text: string;
  tone: "ok" | "warning" | "failure";
}

/** The nav's status line: it agrees with the banner, and a
 * stream that is down outranks a stale reading. A recorder
 * known to have stopped outranks both: it is not coming
 * back on its own. */
export function navStatus(
  health: StreamHealth | null,
  status: StreamStatus | null,
  port: string,
): NavStatus {
  if (status?.kind === "stopped") {
    return { text: "Recorder stopped", tone: "failure" };
  }
  if (status?.kind === "down") {
    return { text: "Recorder unreachable", tone: "warning" };
  }
  const problem = healthProblem(health);
  if (problem?.kind === "cant-start") {
    return { text: "Recorder can't start", tone: "failure" };
  }
  if (problem?.kind === "dropped") {
    return {
      text: `Recorder running · ${formatCount(problem.dropped)} dropped`,
      tone: "warning",
    };
  }
  return { text: `Recorder running · ${port}`, tone: "ok" };
}
