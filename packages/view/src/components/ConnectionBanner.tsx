import { formatCount } from "@flightpath/flightpath/format";

import { useLiveStore } from "../live-store";
import type { StreamStatus } from "../stream";

/** The catch-up banner's line: a bare "Reconnected" when the
 * reconnect brought nothing new; with steps, the count agrees
 * with its number. */
function caughtUpLine(steps: number): string {
  if (steps === 0) return "Reconnected";
  if (steps === 1) return "Reconnected · caught up 1 step";
  return `Reconnected · caught up ${formatCount(steps)} steps`;
}

type StoppedStatus = Extract<StreamStatus, { kind: "stopped" }>;

/** Why the recorder stopped, in one sentence, from what
 * actually happened — never a fixed sentence. */
function stoppedCause(status: StoppedStatus): string {
  if (status.reason === "off") {
    return "Recording is off in all sessions.";
  }
  if (status.reason === "unanswered") {
    return "Flightpath's recorder isn't answering, so nothing new is being recorded.";
  }
  const minutes = `${formatCount(status.idleMinutes)} minute${
    status.idleMinutes === 1 ? "" : "s"
  }`;
  return (
    "The recorder isn't running, so nothing new is being recorded. " +
    `It stopped after ${minutes} with no activity.`
  );
}

/** The next step that restarts recording, from the cause:
 * the off switch is turned back on with its own command;
 * every other stop is ended by a session starting — and
 * with autostart off a session alone does not restart it,
 * so the next step names the command too. */
function stoppedNextStep(status: StoppedStatus, autostart: boolean): string {
  if (status.reason === "off") {
    return "Run /flightpath:start in a Claude Code session to turn it back on.";
  }
  if (!autostart) {
    return "Start a Claude Code session and run /flightpath:start in it to restart recording.";
  }
  return "Start a Claude Code session to restart it.";
}

// The banner under the app bar for the connection's own
// news. A stopped recorder shows as an alert, so it is
// announced once; the health banner stays hidden while the
// recorder is stopped, so only one banner ever shows.
export function ConnectionBanner() {
  const status = useLiveStore((state) => state.status);
  const health = useLiveStore((state) => state.health);
  if (status?.kind === "caught-up") {
    return (
      <div className="connection-banner connection-caught" role="status">
        <span>{caughtUpLine(status.steps)}</span>
        {status.away !== null ? (
          <span className="connection-away">{status.away}</span>
        ) : null}
      </div>
    );
  }
  if (status?.kind === "stopped") {
    return (
      <div
        role="alert"
        className="connection-banner connection-stopped-banner connection-alert"
      >
        <p className="connection-cause">{stoppedCause(status)}</p>
        <p className="connection-next">
          {stoppedNextStep(status, health?.autostart ?? true)}
        </p>
      </div>
    );
  }
  return null;
}
