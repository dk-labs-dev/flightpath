import { create } from "zustand";

import type { StreamHealth } from "@flightpath/flightpath/daemon/stream-messages";

import type { StreamStatus } from "./stream";

interface LiveState {
  status: StreamStatus | null;
  health: StreamHealth | null;
  setStatus: (status: StreamStatus | null) => void;
  setHealth: (health: StreamHealth | null) => void;
}

/** The shell's live state: the stream's wiring writes it,
 * the indicator, the health banner and the nav's status line
 * read it. */
export const useLiveStore = create<LiveState>()((set) => ({
  status: null,
  health: null,
  setStatus: (status) => set({ status }),
  setHealth: (health) => set({ health }),
}));
