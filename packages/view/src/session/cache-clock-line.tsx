// The cold-cache clock in the summary header: quiet until the
// cache is near its end, then two lines and a link to how the
// cache works.

import type { SummaryCache } from "@flightpath/flightpath/api/payloads";

import {
  CACHE_LIFETIME_DOCS,
  cacheClock,
  cacheClockLines,
} from "./cache-clock.js";
import { useClockStore } from "./clock.js";

function ClockIcon() {
  return (
    <svg
      className="cache-clock-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Silent, the wrapper takes no room in the header but stays
 * in the page. */
function wrapperClass(phase: "warm" | "expired" | null): string {
  if (phase === null) return "visually-hidden";
  return phase === "warm" ? "cache-clock cache-clock-warm" : "cache-clock";
}

/** The status region stays in the page while the clock is
 * silent, so a screen reader is already listening when its
 * first words arrive. The clock ticks each second but the words
 * change only when a minute turns, so the region is rewritten
 * once a minute at most. */
export function CacheClockLine({
  cache,
  live,
  stepRunning,
}: {
  cache: SummaryCache | null;
  live: boolean;
  stepRunning: boolean;
}) {
  const nowMs = useClockStore((s) => s.nowMs);
  const clock = cacheClock(cache, nowMs, { live, stepRunning });
  const lines = clock === null ? null : cacheClockLines(clock);
  return (
    <div className={wrapperClass(clock?.phase ?? null)}>
      {lines !== null && <ClockIcon />}
      <div className="cache-clock-body">
        <div role="status" className="cache-clock-lines">
          {lines !== null && (
            <>
              <b className="cache-clock-headline">{lines.headline}</b>
              <span className="cache-clock-detail">{lines.detail}</span>
            </>
          )}
        </div>
        {lines !== null && (
          <a href={CACHE_LIFETIME_DOCS} target="_blank" rel="noreferrer">
            Prompt caching: how long the cache lasts
          </a>
        )}
      </div>
    </div>
  );
}
