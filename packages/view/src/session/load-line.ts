import type { SessionStore } from "./store.js";

/** The screen's words for a session that isn't ready to
 * show, or null once it is — one set, for every lens. */
export function sessionLoadLine(load: SessionStore["load"]): string | null {
  if (load === "loading" || load === "idle") return "Loading the session…";
  if (load === "missing") return "This session isn’t in the recordings.";
  if (load === "failed") {
    return "The session couldn’t be loaded — the recorder may be restarting. Retrying…";
  }
  return null;
}
