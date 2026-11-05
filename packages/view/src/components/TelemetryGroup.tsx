import { useState, type ReactNode } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TelemetrySetupStatus } from "@flightpath/flightpath/settings/types";

import { ConfirmDialog } from "./ConfirmDialog";
import { GroupBand } from "./SettingsGroup";
import {
  fetchTelemetry,
  postTelemetryAction,
  TELEMETRY_QUERY_KEY,
} from "../settings/api";

// The Claude Code telemetry card: its own status read and
// a confirmation before anything is written to the user's
// Claude Code settings file. A 500 from the daemon — the
// router's guard answering a thrown handler — reads as
// "could not be changed", apart from a daemon that cannot
// be reached at all.

function pill(status: TelemetrySetupStatus): ReactNode {
  switch (status.state) {
    case "on":
      return <span className="pill pill-on">On</span>;
    case "off":
      return <span className="pill pill-off">Off</span>;
    case "elsewhere":
      return <span className="pill pill-warn">Set up elsewhere</span>;
    case "error":
      return <span className="pill pill-warn">Needs attention</span>;
  }
}

function stateLines(status: TelemetrySetupStatus): ReactNode {
  if (status.state === "on") {
    return (
      <>
        <p>
          {`Telemetry is on for Flightpath, sending to this daemon at ${status.endpoint}.`}
        </p>
        {status.boundPort !== status.configuredPort && (
          <p className="field-help">
            {`The configured port was taken, so the daemon is on ${status.boundPort} instead; sessions record without telemetry until the port frees up.`}
          </p>
        )}
      </>
    );
  }
  if (status.state === "elsewhere") {
    return (
      <>
        <p>{`Telemetry is configured elsewhere: ${status.where}.`}</p>
        <p className="field-help">{status.detail}</p>
      </>
    );
  }
  if (status.state === "error") {
    return <p>{status.message}</p>;
  }
  return <p>Telemetry is off.</p>;
}

function fileLine(status: TelemetrySetupStatus): string {
  return status.state === "on"
    ? "Flightpath added telemetry settings to your Claude Code settings file and removes exactly those when you turn it off."
    : "Turning it on adds telemetry settings to your Claude Code settings file; turning it off removes exactly those.";
}

export function TelemetryGroup({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TELEMETRY_QUERY_KEY,
    queryFn: () => fetchTelemetry(token),
  });
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const [message, setMessage] = useState("");
  const action = useMutation({
    mutationFn: (next: "on" | "off") => postTelemetryAction(token, next),
  });

  const run = async (next: "on" | "off"): Promise<void> => {
    setConfirm(null);
    const result = await action.mutateAsync(next);
    if (result.kind === "answered") {
      queryClient.setQueryData(TELEMETRY_QUERY_KEY, result.reply.status);
      setMessage(result.reply.message);
    } else if (result.kind === "server-error") {
      setMessage("Telemetry could not be changed; nothing was saved.");
    } else {
      setMessage("Could not reach the daemon; nothing was changed.");
    }
  };

  const status = query.data;
  return (
    <section className="settings-group" aria-labelledby="group-telemetry-h">
      <GroupBand
        headingId="group-telemetry-h"
        title="Claude Code telemetry"
        description="Extra detail from Claude Code itself, with your consent."
      >
        {status !== undefined && pill(status)}
      </GroupBand>
      <div className="group-fields">
        {status === undefined ? (
          <p className="field-help">Loading…</p>
        ) : (
          <TelemetryBody
            status={status}
            confirm={confirm}
            message={message}
            setConfirm={setConfirm}
            run={run}
          />
        )}
      </div>
    </section>
  );
}

interface BodyProps {
  status: TelemetrySetupStatus;
  confirm: "on" | "off" | null;
  message: string;
  setConfirm: (next: "on" | "off" | null) => void;
  run: (next: "on" | "off") => Promise<void>;
}

function TelemetryBody({
  status,
  confirm,
  message,
  setConfirm,
  run,
}: BodyProps) {
  return (
    <>
      {stateLines(status)}
      {confirm !== null && (
        <ConfirmDialog
          title={
            confirm === "on"
              ? "Turn on Claude Code telemetry?"
              : "Turn off Claude Code telemetry?"
          }
          body={confirm === "on" ? turnOnBody : turnOffBody}
          actions={[
            {
              label: confirm === "on" ? "Turn on" : "Turn off",
              kind: confirm === "on" ? "primary" : "danger",
              onClick: () => void run(confirm),
            },
            {
              label: "Cancel",
              kind: "secondary",
              onClick: () => setConfirm(null),
            },
          ]}
          onDismiss={() => setConfirm(null)}
        />
      )}
      <div className="telemetry-action-row">
        <p className="telemetry-expl">
          Adds what transcripts don't hold: background requests (titles,
          suggestions, compaction), who approved each action, and exact timings.
          It stays on this machine, and account identity is dropped.{" "}
          {fileLine(status)}
        </p>
        {actionButton(status, setConfirm)}
      </div>
      <p className="field-help">
        This check reads your environment, your settings file, and managed
        settings files. It cannot see policy delivered by your OS (a macOS
        configuration profile or the Windows registry) or by an organization
        console, so telemetry set in one of those places will not show here.
      </p>
      {message !== "" && (
        <p className="group-status" role="status">
          {message}
        </p>
      )}
    </>
  );
}

const turnOnBody: ReactNode = (
  <p>
    Flightpath adds its telemetry settings to your Claude Code settings file (
    <span className="mono">~/.claude/settings.json</span>) so Claude Code sends
    its telemetry to this computer. It never leaves this machine. It applies
    from your next session, and turning it off removes exactly what was added.
  </p>
);

const turnOffBody: ReactNode = (
  <p>
    Flightpath removes the settings it added to your Claude Code settings file.
    Recording carries on from hooks and transcripts, without background requests
    or exact timings.
  </p>
);

function actionButton(
  status: TelemetrySetupStatus,
  setConfirm: (next: "on" | "off" | null) => void,
): ReactNode {
  if (status.state !== "on" && status.state !== "off") {
    return null;
  }
  const next = status.state === "on" ? "off" : "on";
  return (
    <button type="button" className="btn" onClick={() => setConfirm(next)}>
      {`Turn ${next}…`}
    </button>
  );
}
