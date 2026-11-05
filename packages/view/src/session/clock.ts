// The one-second clock, in its own store so a tick never
// re-runs the session store's selectors.

import { useEffect } from "react";
import { create } from "zustand";

interface ClockState {
  nowMs: number;
  setNow: (nowMs: number) => void;
}

export const useClockStore = create<ClockState>()((set) => ({
  nowMs: 0,
  setNow: (nowMs) => set({ nowMs }),
}));

/** Keep the shared clock moving while a screen that reads it
 *  is up: set it to now, then tick once a second. */
export function useClockTick(): void {
  useEffect(() => {
    useClockStore.getState().setNow(Date.now());
    const tick = setInterval(() => {
      useClockStore.getState().setNow(Date.now());
    }, 1_000);
    return () => clearInterval(tick);
  }, []);
}
