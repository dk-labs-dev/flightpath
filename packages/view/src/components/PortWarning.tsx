// The port move's warning text, shown as the confirmation
// dialog's body: who is recording now (named, up to five),
// what happens to their telemetry — said only when telemetry
// is on, because only then is a restart owed — and what the
// move does to open tabs.

export interface PortWarningInfo {
  sessions: { id: string; title: string }[];
  telemetryOn: boolean;
  newPort: number;
  currentPort: number;
}

function sessionsBullet(info: PortWarningInfo): string {
  const { sessions } = info;
  if (sessions.length === 0) {
    return "No Claude Code sessions are recording now.";
  }
  const names = sessions
    .slice(0, 5)
    .map((session) => `“${session.title}”`)
    .join(", ");
  const list =
    sessions.length > 5 ? `${names}, and ${sessions.length - 5} more` : names;
  const noun = sessions.length === 1 ? "session" : "sessions";
  if (info.telemetryOn) {
    return (
      `Restart the ${sessions.length} Claude Code ${noun} recording now: ` +
      `${list}. Their telemetry keeps going to the old port and is lost ` +
      `until they restart. Recording through hooks and transcripts ` +
      `carries on.`
    );
  }
  const pronoun = sessions.length === 1 ? "It carries" : "They carry";
  return (
    `The ${sessions.length} Claude Code ${noun} recording now: ${list}. ` +
    `${pronoun} on recording at the new port — hooks find it on their ` +
    `own, so nothing needs a restart.`
  );
}

export function PortWarningBody({ info }: { info: PortWarningInfo }) {
  const bullet = sessionsBullet(info);
  const colon = info.sessions.length > 0 ? bullet.indexOf(":") : -1;
  const lead =
    colon >= 0 ? (
      <>
        <b>{bullet.slice(0, colon + 1)}</b>
        {bullet.slice(colon + 1)}
      </>
    ) : (
      bullet
    );
  return (
    <ul className="port-warning-list">
      <li>{lead}</li>
      <li>
        This page reloads at{" "}
        <span className="mono">{`127.0.0.1:${info.newPort}`}</span>. Other open
        Flightpath tabs stop updating; reopen them from /flightpath:status.
      </li>
      <li>New sessions pick up the new port by themselves.</li>
    </ul>
  );
}
