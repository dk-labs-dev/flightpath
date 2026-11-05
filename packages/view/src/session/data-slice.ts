// The store's data collections as one slice: the shape
// buildRows takes, selected shallowly so a stream change
// re-renders only what it touched. The steps tree and the
// snapshot lens's step picker both read the session through
// it, so the two can never read different rows.

import { useShallow } from "zustand/react/shallow";

import { useSessionStore } from "./store.js";
import type { SessionData } from "./types.js";

export function useSessionDataSlice(): SessionData {
  return useSessionStore(
    useShallow((s): SessionData => ({
      turns: s.turns,
      steps: s.steps,
      humans: s.humans,
      branches: s.branches,
      events: s.events,
      samples: s.samples,
      stepsByTurn: s.stepsByTurn,
      humansByTurn: s.humansByTurn,
      stepsByBranch: s.stepsByBranch,
      openStepIds: s.openStepIds,
    })),
  );
}
