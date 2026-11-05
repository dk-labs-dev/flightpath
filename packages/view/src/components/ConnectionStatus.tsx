import { useEffect } from "react";

import { useLiveStore } from "../live-store";

// The connection's word in the app bar, fed by the stream
// through the live store. The pill lives in a status region,
// so screen readers hear its changes politely. A catch-up
// settles to Live after six seconds; its banner, under the
// app bar, is ConnectionBanner's.
export function ConnectionStatus() {
  const status = useLiveStore((state) => state.status);

  useEffect(() => {
    if (status?.kind !== "caught-up") {
      return;
    }
    const caught = status;
    const timer = setTimeout(() => {
      if (useLiveStore.getState().status === caught) {
        useLiveStore.getState().setStatus({ kind: "live" });
      }
    }, 6000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <span role="status" className="connection-status">
      {status?.kind === "live" || status?.kind === "caught-up" ? (
        <span className="connection-pill connection-live">
          <span className="connection-dot" aria-hidden="true" />
          Live
        </span>
      ) : null}
      {status?.kind === "down" ? (
        <span className="connection-pill connection-down">
          <span className="connection-arc" aria-hidden="true" />
          {"Reconnecting…"}
        </span>
      ) : null}
      {status?.kind === "stopped" ? (
        <span className="connection-pill connection-stopped">
          <span className="connection-stop-dot" aria-hidden="true" />
          Recorder stopped
        </span>
      ) : null}
    </span>
  );
}
