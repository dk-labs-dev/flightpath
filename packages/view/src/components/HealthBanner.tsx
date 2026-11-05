import { useEffect, useState } from "react";

import type { StreamHealth } from "@flightpath/flightpath/daemon/stream-messages";

import {
  cantStartCause,
  droppedLine,
  healthAction,
  healthProblem,
  waitingLine,
  type HealthAction,
  type HealthProblem,
} from "../health-state";
import { useLiveStore } from "../live-store";
import { AlertIcon } from "./icons";

// The recorder health banner, under the app bar on every
// screen: one banner at a time, the most serious problem the
// stream's health reports. While the stream is down the app
// bar's Reconnecting is the message instead — a health
// reading from before the drop could be stale — and while
// the recorder is stopped the connection banner is the one
// that shows.
export function HealthBanner() {
  const health = useLiveStore((state) => state.health);
  const status = useLiveStore((state) => state.status);
  if (
    status?.kind === "down" ||
    status?.kind === "stopped" ||
    health === null
  ) {
    return null;
  }
  const problem = healthProblem(health);
  if (problem === null) {
    return null;
  }
  if (problem.kind === "dropped") {
    return (
      <section className="health-banner health-dropped">
        <span className="health-icon">
          <AlertIcon />
        </span>
        <p className="health-line">{droppedLine(problem.dropped)}</p>
      </section>
    );
  }
  return <CantStartBanner health={health} problem={problem} />;
}

function CantStartBanner({
  health,
  problem,
}: {
  health: StreamHealth;
  problem: Extract<HealthProblem, { kind: "cant-start" }>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const action = healthAction(problem);
  const waiting = waitingLine(health, Date.now());

  return (
    <section className="health-banner health-cant-start" key={problem.error.at}>
      <span className="health-icon">
        <AlertIcon />
      </span>
      <div className="health-body">
        <div role="alert">
          <h2 className="health-headline">
            {"Flightpath can't start its recorder"}
          </h2>
          <p className="health-cause">
            {cantStartCause(problem.error, problem.start)}
          </p>
        </div>
        {waiting !== null ? <p className="health-waiting">{waiting}</p> : null}
        {action?.kind === "database" ? (
          <p className="health-path">
            The database file is <code>{action.path}</code> — check it
            isn&rsquo;t damaged or held by another program.
          </p>
        ) : null}
        <HealthActions
          action={action}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen(!detailsOpen)}
        />
        {detailsOpen ? (
          <p className="health-details">{problem.error.message}</p>
        ) : null}
      </div>
    </section>
  );
}

function HealthActions({
  action,
  detailsOpen,
  onToggleDetails,
}: {
  action: HealthAction;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyPath = (path: string): void => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => setCopied(true))
      .catch(() => {
        // The path stays on screen to copy by hand.
      });
  };

  return (
    <div className="health-actions">
      {action?.kind === "port" ? (
        <a className="banner-primary" href="#settings?focus=port">
          Change the port
        </a>
      ) : null}
      {action?.kind === "database" ? (
        <button
          type="button"
          className="banner-primary"
          onClick={() => copyPath(action.path)}
        >
          {copied ? "Copied" : "Copy the path"}
        </button>
      ) : null}
      <button
        type="button"
        className="banner-secondary"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
      >
        {detailsOpen ? "Hide the details" : "Show the details"}
      </button>
    </div>
  );
}
