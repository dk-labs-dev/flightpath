// The cold-cache clock's words and timing, as pure functions of
// the last request's cache, the time and the session's state.
// The summary carries when the cache started, never how long is
// left, so it does not change while a session idles.

import { CACHE_LIFETIME_MS } from "@flightpath/flightpath/api/cache-lifetime";
import { formatTokens } from "@flightpath/flightpath/format";
import type { SummaryCache } from "@flightpath/flightpath/api/payloads";

import { countLine } from "../counts.js";

export const CACHE_LIFETIME_DOCS =
  "https://code.claude.com/docs/en/prompt-caching#cache-lifetime";

const MINUTE_MS = 60_000;

// How much of a lifetime's end the clock speaks for: the last
// tenth of an hour, the last two of five minutes.
const SPEAKS_WITHIN_MS = { "1h": 10 * MINUTE_MS, "5m": 2 * MINUTE_MS };

export interface CacheClock {
  phase: "warm" | "expired";
  /** Whole minutes left; zero once expired. */
  minutes: number;
  tokens: number;
}

export interface CacheClockSession {
  live: boolean;
  stepRunning: boolean;
}

/** What the clock shows now, or null while it stays silent: the
 * session is not live and idle, or the cache has time to spare. */
export function cacheClock(
  cache: SummaryCache | null,
  nowMs: number,
  session: CacheClockSession,
): CacheClock | null {
  if (cache === null || !session.live || session.stepRunning) return null;
  const left = cache.endedAt + CACHE_LIFETIME_MS[cache.lifetime] - nowMs;
  if (left <= 0) {
    return { phase: "expired", minutes: 0, tokens: cache.contextTokens };
  }
  if (left > SPEAKS_WITHIN_MS[cache.lifetime]) return null;
  return {
    phase: "warm",
    minutes: Math.floor(left / MINUTE_MS),
    tokens: cache.contextTokens,
  };
}

/** The clock's two lines: the headline and what follows from it. */
export function cacheClockLines(clock: CacheClock): {
  headline: string;
  detail: string;
} {
  const size = formatTokens(clock.tokens);
  if (clock.phase === "expired") {
    return {
      headline: "Cache expired",
      detail: `Your next message could write about ${size}.`,
    };
  }
  return {
    headline:
      clock.minutes === 0
        ? "Cache warm for less than a minute"
        : `Cache warm for about ${countLine(clock.minutes, "more minute", "more minutes")}`,
    detail: `After that, your next message could write about ${size} again.`,
  };
}
