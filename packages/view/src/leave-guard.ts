// The unsaved-changes guard: while the settings screen is
// mounted it registers how to ask; the route hook consults it
// before a change away from the settings screen applies.

type LeaveAsk = () => Promise<boolean>;

let currentAsk: LeaveAsk | null = null;

export function registerLeaveGuard(ask: LeaveAsk | null): void {
  currentAsk = ask;
}

export function leaveGuardActive(): boolean {
  return currentAsk !== null;
}

export function askToLeave(): Promise<boolean> {
  return currentAsk ? currentAsk() : Promise.resolve(true);
}
