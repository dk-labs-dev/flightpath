import { describe, expect, it } from "vitest";

import type { SummaryCache } from "@flightpath/flightpath/api/payloads";

import {
  CACHE_LIFETIME_DOCS,
  cacheClock,
  cacheClockLines,
  type CacheClockSession,
} from "../src/session/cache-clock.js";

const MINUTE = 60_000;
const ENDED_AT = 1_000_000_000;
const IDLE: CacheClockSession = { live: true, stepRunning: false };

function cache(
  lifetime: SummaryCache["lifetime"],
  contextTokens = 91_130,
): SummaryCache {
  return { lifetime, endedAt: ENDED_AT, contextTokens };
}

/** The clock when `left` milliseconds remain of the lifetime. */
function withLeft(
  lifetime: SummaryCache["lifetime"],
  left: number,
  session: CacheClockSession = IDLE,
) {
  const length = lifetime === "1h" ? 60 * MINUTE : 5 * MINUTE;
  return cacheClock(cache(lifetime), ENDED_AT + length - left, session);
}

describe("when the cache clock speaks", () => {
  it("stays silent on an hour's cache until ten minutes are left", () => {
    expect(withLeft("1h", 10 * MINUTE + 1_000)).toBeNull();
    expect(withLeft("1h", 10 * MINUTE)).toEqual({
      phase: "warm",
      minutes: 10,
      tokens: 91_130,
    });
  });

  it("stays silent on a five-minute cache until two minutes are left", () => {
    expect(withLeft("5m", 2 * MINUTE + 1_000)).toBeNull();
    expect(withLeft("5m", 2 * MINUTE)).toEqual({
      phase: "warm",
      minutes: 2,
      tokens: 91_130,
    });
  });

  it("says expired once the lifetime has run out, however long ago", () => {
    expect(withLeft("1h", 0)?.phase).toBe("expired");
    expect(withLeft("5m", -MINUTE)?.phase).toBe("expired");
    expect(withLeft("1h", -3 * 24 * 60 * MINUTE)?.phase).toBe("expired");
  });

  it("stays silent while a step is running", () => {
    expect(
      withLeft("1h", 5 * MINUTE, { live: true, stepRunning: true }),
    ).toBeNull();
    expect(
      withLeft("1h", -MINUTE, { live: true, stepRunning: true }),
    ).toBeNull();
  });

  it("stays silent once the session is not live", () => {
    expect(
      withLeft("1h", 5 * MINUTE, { live: false, stepRunning: false }),
    ).toBeNull();
    expect(
      withLeft("1h", -MINUTE, { live: false, stepRunning: false }),
    ).toBeNull();
  });

  it("stays silent without a cache", () => {
    expect(cacheClock(null, ENDED_AT, IDLE)).toBeNull();
  });

  it("gives the same answer for the same time however the clock got there", () => {
    const at = ENDED_AT + 55 * MINUTE;
    const first = cacheClock(cache("1h"), at, IDLE);
    cacheClock(cache("1h"), at + 20 * MINUTE, IDLE);
    expect(cacheClock(cache("1h"), at, IDLE)).toEqual(first);
  });
});

describe("the cache clock's words", () => {
  function linesAt(left: number) {
    const clock = withLeft("1h", left);
    if (clock === null) throw new Error("the clock should speak");
    return cacheClockLines(clock);
  }

  it.each([
    [30_000, "Cache warm for less than a minute"],
    [MINUTE, "Cache warm for about 1 more minute"],
    [2 * MINUTE, "Cache warm for about 2 more minutes"],
  ])("reads %i ms left as %s", (left, headline) => {
    expect(linesAt(left).headline).toBe(headline);
  });

  it("says what a cold cache would write, in tokens", () => {
    expect(linesAt(5 * MINUTE).detail).toBe(
      "After that, your next message could write about 91.1K tokens again.",
    );
    expect(
      cacheClockLines({ phase: "expired", minutes: 0, tokens: 91_130 }),
    ).toEqual({
      headline: "Cache expired",
      detail: "Your next message could write about 91.1K tokens.",
    });
  });

  it.each(["1h", "5m"] as const)(
    "never mentions compaction or money on a %s cache",
    (lifetime) => {
      for (const left of [90_000, -MINUTE]) {
        const clock = withLeft(lifetime, left);
        if (clock === null) throw new Error("the clock should speak");
        const { headline, detail } = cacheClockLines(clock);
        expect(`${headline} ${detail}`).not.toMatch(/compact|\$|dollar/i);
      }
    },
  );

  it("links to the documentation's cache lifetime section", () => {
    expect(CACHE_LIFETIME_DOCS).toBe(
      "https://code.claude.com/docs/en/prompt-caching#cache-lifetime",
    );
  });
});
