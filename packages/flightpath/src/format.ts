// One formatter for every count, token total, duration, size
// and time Flightpath writes — in the view and in the
// describer's sentences alike — so the same fact is never
// written two ways.

/** A plain count with thousands separators: "14,602". */
export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** A token count's rounded value and unit, worked out
 * once for both written forms: round in thousands first,
 * then choose the unit from the rounded value, so 999,960
 * rounds to 1,000.0K, which reads as 1.0M, never
 * "1000.0K". */
function roundedTokens(count: number): { value: number; unit: "K" | "M" } {
  const thousands = Math.round(count / 100) / 10;
  if (thousands >= 1_000) {
    return { value: Math.round(count / 100_000) / 10, unit: "M" };
  }
  return { value: thousands, unit: "K" };
}

/** A token count in words: under a thousand, the exact
 * count, since the K form rounds those to "0.0K". The
 * axis form drops the unit word and trims a whole value
 * ("50K", "1M"). */
export function formatTokens(
  count: number,
  options: { exact?: boolean; axis?: boolean } = {},
): string {
  if (options.axis) {
    if (count < 1_000) {
      return `${Math.round(count)}`;
    }
    const { value, unit } = roundedTokens(count);
    return Number.isInteger(value)
      ? `${value}${unit}`
      : `${value.toFixed(1)}${unit}`;
  }
  if (options.exact || count < 1_000) {
    return `${count.toLocaleString("en-US")} tokens`;
  }
  const { value, unit } = roundedTokens(count);
  return `${value.toFixed(1)}${unit} tokens`;
}

// Characters per token, from Claude Code's /context against the
// characters of four items: 2.81 to 2.99.
export const CHARS_PER_TOKEN = 2.9;

/** What the "est." tag says when hovered: the view's note beside it, word for word. */
export const ESTIMATE_HINT = `Worked out from the number of characters, at about ${CHARS_PER_TOKEN} per token. Close, not exact.`;

/** What the "measured" tag says when hovered: the view's note beside it, word for word. */
export const MEASURED_HINT =
  "This result arrived on its own, so its size is exact: how much the context grew, minus Claude's reply.";

/** The tokens a size stands for — the size of a step's
 * result in characters, of a load in bytes; an unknown size
 * stays unknown. */
export function estimatedTokens(size: number): number;
export function estimatedTokens(size: number | null): number | null;
export function estimatedTokens(size: number | null): number | null {
  return size === null ? null : Math.ceil(size / CHARS_PER_TOKEN);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// The label for a moment: relative while the session is live or
// the moment is within the last hour, the clock time otherwise.
// The clock time is always available through formatClock for the
// title and accessible label beside a relative label.
export function formatTimeLabel(
  thenMs: number,
  options: { nowMs: number; live: boolean },
): string {
  const ageMs = options.nowMs - thenMs;
  if (options.live || ageMs < 3_600_000) {
    if (ageMs < 45_000) {
      return "just now";
    }
    if (ageMs < 3_600_000) {
      return `${Math.max(1, Math.round(ageMs / 60_000))}m ago`;
    }
    return `${Math.round(ageMs / 3_600_000)}h ago`;
  }
  return formatClock(thenMs);
}

/** A day's words: the weekday, then the date in full. */
function formatDayWords(date: Date): string {
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const rest = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${weekday} ${rest}`;
}

/** The full date and time in one line, for a title that
 * spells out exactly when something started. */
export function formatDateTime(thenMs: number): string {
  return `${formatDayWords(new Date(thenMs))}, ${formatClock(thenMs)}`;
}

/** The local day's start for a moment, on the local clock. */
export function startOfDay(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A day's heading: Today or Yesterday while those words are
 * true, the weekday and date after that. Days are read off
 * the local clock, so a traveller's folders follow the clock. */
export function formatDayHeading(dayMs: number, nowMs: number): string {
  const start = startOfDay(dayMs);
  const today = startOfDay(nowMs);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (start.getTime() === today.getTime()) {
    return "Today";
  }
  if (start.getTime() === yesterday.getTime()) {
    return "Yesterday";
  }
  return formatDayWords(start);
}

/** An age in prose: "9 minutes", "1 second", "2 hours".
 * The status command adds "old"; the view's banner adds
 * "ago". */
export function formatAge(thenMs: number, nowMs: number): string {
  const seconds = Math.max(1, Math.round((nowMs - thenMs) / 1000));
  const amount = (value: number, unit: string): string =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 90) return amount(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return amount(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return amount(hours, "hour");
  return amount(Math.round(hours / 24), "day");
}

export function formatClock(thenMs: number): string {
  const date = new Date(thenMs);
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) {
    hours = 12;
  }
  return `${hours}:${minutes} ${suffix}`;
}
