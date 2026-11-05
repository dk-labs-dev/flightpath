import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { askToLeave, leaveGuardActive } from "./leave-guard";

export type Lens = "steps" | "tokens" | "snapshot";

/** What an address asks a lens to focus on: a step, in
 * every lens, a request, which the snapshot lens reads
 * where a turn ran no step, and a rise or a rebuild. All are
 * parsed from the address and kept in the route. */
export interface RouteFocus {
  step?: number;
  request?: number;
  rise?: string;
  rebuild?: string;
}

export type Route =
  | { screen: "sessions" }
  | { screen: "settings" }
  | { screen: "session"; id: string; lens: Lens; focus: RouteFocus };

function lensOf(segment: string | undefined): Lens {
  // An unknown lens is the Steps lens: an address written by
  // a newer version, or typed by hand, still opens the
  // session it names.
  return segment === "tokens" || segment === "snapshot" ? segment : "steps";
}

function focusOf(query: string | undefined): RouteFocus {
  if (query === undefined) return {};
  const params = new URLSearchParams(query);
  const focus: RouteFocus = {};
  const step = params.get("step");
  // A step that isn't a whole number names nothing, and the
  // address simply carries no focus.
  if (step !== null && /^\d+$/.test(step)) {
    focus.step = Number(step);
  }
  const request = params.get("request");
  if (request !== null && /^\d+$/.test(request)) {
    focus.request = Number(request);
  }
  const rise = params.get("rise");
  if (rise !== null && rise !== "") {
    focus.rise = rise;
  }
  const rebuild = params.get("rebuild");
  if (rebuild !== null && rebuild !== "") {
    focus.rebuild = rebuild;
  }
  return focus;
}

// Exported for its test; the hook below is the app's only caller.
export function parseRoute(hash: string): Route {
  const session = /^#session\/([^/?&]+)(?:\/([^/?&]+))?(?:\?([\s\S]*))?/.exec(
    hash,
  );
  if (session?.[1]) {
    return {
      screen: "session",
      id: decodeURIComponent(session[1]),
      lens: lensOf(session[2]),
      focus: focusOf(session[3]),
    };
  }
  if (hash.startsWith("#settings")) {
    return { screen: "settings" };
  }
  return { screen: "sessions" };
}

/** The address of a session screen: the steps lens is the
 * bare address, and a focus rides in the query. Every link
 * to a session is built here, so the forms the parser reads
 * and the forms the screens write never drift apart. */
export function sessionHref(
  id: string,
  lens: Lens = "steps",
  focus: RouteFocus = {},
): string {
  const base = `#session/${encodeURIComponent(id)}`;
  const path = lens === "steps" ? base : `${base}/${lens}`;
  const params = new URLSearchParams();
  if (focus.step !== undefined) params.set("step", String(focus.step));
  if (focus.request !== undefined) {
    params.set("request", String(focus.request));
  }
  if (focus.rise !== undefined) params.set("rise", focus.rise);
  if (focus.rebuild !== undefined) params.set("rebuild", focus.rebuild);
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

/** Whether settings was opened at the port field: the health
 * banner's link carries `?focus=port` in the hash, and the
 * settings screen — not the route's own focus move — puts
 * focus on the field. */
export function portFocusAsked(): boolean {
  const query = window.location.hash.split("?")[1];
  if (query === undefined) return false;
  return new URLSearchParams(query).get("focus") === "port";
}

// The route follows the hash. A route change that comes from
// navigation moves focus to the screen; the first render does
// not, so opening the page leaves focus where the browser puts
// it. Leaving the settings screen while it holds unsaved
// changes waits for its guard's answer: the hash is put back
// when the answer is no, and the remembered route applies
// when it is yes.
export function useRoute(): {
  current: Route;
  screenRef: RefObject<HTMLElement | null>;
} {
  const [current, setCurrent] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const screenRef = useRef<HTMLElement>(null);
  const focusOnRouteChange = useRef(false);
  const currentRef = useRef(current);
  const pendingRoute = useRef<Route | null>(null);
  const asking = useRef(false);

  const applyRoute = useCallback((next: Route) => {
    focusOnRouteChange.current = true;
    currentRef.current = next;
    setCurrent(next);
  }, []);

  useEffect(() => {
    const settleLeave = (leave: boolean) => {
      asking.current = false;
      const target = pendingRoute.current;
      pendingRoute.current = null;
      if (leave && target !== null) {
        applyRoute(target);
        return;
      }
      history.replaceState(null, "", `${window.location.pathname}#settings`);
    };
    const onHashChange = () => {
      const next = parseRoute(window.location.hash);
      const leavingSettings =
        currentRef.current.screen === "settings" && next.screen !== "settings";
      if (!leavingSettings || !leaveGuardActive()) {
        if (next.screen === "settings") {
          pendingRoute.current = null;
        }
        applyRoute(next);
        return;
      }
      // The newest target wins; an ask already open answers for
      // all of them, so a second navigation re-opens nothing.
      pendingRoute.current = next;
      if (!asking.current) {
        asking.current = true;
        void askToLeave().then(settleLeave);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [applyRoute]);

  useEffect(() => {
    if (!focusOnRouteChange.current) return;
    focusOnRouteChange.current = false;
    const screen = screenRef.current;
    // On the port route the settings screen focuses its field.
    if (screen && !(current.screen === "settings" && portFocusAsked())) {
      screen.focus({ preventScroll: true });
      screen.scrollTop = 0;
    }
  }, [current]);

  return { current, screenRef };
}
