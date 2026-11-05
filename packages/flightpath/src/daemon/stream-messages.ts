// The live stream's wire contract (ADR-0009), typed once: every message
// the hub sends is one of these, its payload the very shape the snapshot
// would show. Every message carries `id: <epoch>:<n>` on the wire, the
// epoch minted when the daemon starts, so a reconnect after a restart
// can never be mistaken for a replay. `reset`, `sync` and `stopping` are
// per-connection, never buffered: reset says the gap is too old and the
// page reloads; sync closes a replay; stopping is the daemon's last
// word, written straight to the open connections as it stops.

import type {
  BranchSummary,
  HumanMoment,
  LastError,
  SessionEvent,
  SessionListItem,
  SnapshotSummary,
  StartProblem,
  StepSummary,
  TurnHead,
} from "../api/payloads.js";

interface StreamContextPoint {
  id: number;
  at: number;
  contextTokens: number;
}

export interface StreamHealth {
  buffered: number;
  oldestAt: number | null;
  dropped: number;
  lastError: LastError | null;
  /** The last error classed once where it was recorded. */
  problem: StartProblem | null;
  /** Whether new sessions start the recorder on their own; the page words a stopped recorder's next step from it. */
  autostart: boolean;
}

export type ShutdownReason =
  "idle" | "off" | "signal" | "handover" | "listen-failed";

/** A session's own change: its summary on its own stream, its
 * list row on the picker's, or word it left the list — deleted,
 * or `hidden` (emptied out). A change carries the new
 * `emptyHidden` count when the count moved with it. */
export type SessionChange =
  | { sessionId: string; summary: SnapshotSummary }
  | { sessionId: string; session: SessionListItem; emptyHidden?: number }
  | { sessionId: string; deleted: true; emptyHidden?: number }
  | { sessionId: string; hidden: true; emptyHidden: number };

export type StreamMessage =
  | { event: "turn"; data: { sessionId: string; turn: TurnHead } }
  | {
      event: "step";
      data: { sessionId: string; turnId: number | null; step: StepSummary };
    }
  | {
      event: "human";
      data: { sessionId: string; turnId: number; human: HumanMoment };
    }
  | { event: "segment"; data: { sessionId: string; event: SessionEvent } }
  | { event: "branch"; data: { sessionId: string; branch: BranchSummary } }
  | { event: "context"; data: { sessionId: string; point: StreamContextPoint } }
  | { event: "session"; data: SessionChange }
  | { event: "health"; data: StreamHealth }
  | { event: "reset"; data: Record<string, never> }
  | { event: "sync"; data: { replayed: number; reset: boolean } }
  | {
      event: "stopping";
      data:
        | { reason: "idle"; idleMinutes: number }
        | { reason: Exclude<ShutdownReason, "idle"> };
    };
