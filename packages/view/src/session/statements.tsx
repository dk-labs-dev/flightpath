// The plain statements about what a session's record can't
// show, shared by the lenses that read the record: each line
// shows only while its flag holds, in the same words on
// every lens, so a gap in the record is described once and
// described the same way wherever it matters.

import type { ContextAtStep } from "@flightpath/flightpath/api/payloads";

/** The record's gaps, as the read API reports them. */
export type SessionStates = ContextAtStep["states"];

export function SessionStatements({ states }: { states: SessionStates }) {
  return (
    <>
      {!states.telemetry && (
        <p className="session-note" role="note">
          Recorded without telemetry: Claude Code&rsquo;s background requests
          aren&rsquo;t included, so totals cover your own requests only.
        </p>
      )}
      {states.tokensPartial && (
        <p className="session-note" role="note">
          Part of this session&rsquo;s transcript couldn&rsquo;t be read, so
          some requests are missing from these figures.
        </p>
      )}
      {states.joinedPartway && (
        <p className="session-note" role="note">
          Flightpath started recording partway through this session; earlier
          context isn&rsquo;t shown.
        </p>
      )}
    </>
  );
}
