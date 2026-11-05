// One session screen's place, kept across reloads and stream
// resets: the selected step, the collapsed turns and the
// scroll position. The stream never touches this — a reset
// reloads the session's data, and the screen reads its place
// back from here. The position hangs from a row — the
// selected step's, or the first visible — plus its offset
// into that row: rows are estimates until they are measured.

export interface SessionViewState {
  selectedStepId: number | null;
  collapsedTurnIds: number[];
  scrollTop: number;
  anchorKey: string | null;
  anchorOffset: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function key(sessionId: string): string {
  return `flightpath-view:${sessionId}`;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage can refuse (private modes, disabled cookies):
    // the place is then kept nowhere, which the screen treats
    // as a first visit.
    return null;
  }
}

/** The saved place, or null when nothing was saved: a saved
 * place is restored as it stands — an empty collapsed list
 * means every turn stood open — and the screen's defaults
 * belong only to a first visit. */
export function loadViewState(
  sessionId: string,
  storage: StorageLike | null = browserStorage(),
): SessionViewState | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key(sessionId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<SessionViewState>;
    return {
      selectedStepId:
        typeof parsed.selectedStepId === "number"
          ? parsed.selectedStepId
          : null,
      collapsedTurnIds: Array.isArray(parsed.collapsedTurnIds)
        ? parsed.collapsedTurnIds.filter((id) => typeof id === "number")
        : [],
      scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
      anchorKey: typeof parsed.anchorKey === "string" ? parsed.anchorKey : null,
      anchorOffset:
        typeof parsed.anchorOffset === "number" ? parsed.anchorOffset : 0,
    };
  } catch {
    return null;
  }
}

export function saveViewState(
  sessionId: string,
  state: SessionViewState,
  storage: StorageLike | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(key(sessionId), JSON.stringify(state));
  } catch {
    // A refused write leaves the previous place in storage;
    // nothing else can be done about it here.
  }
}
