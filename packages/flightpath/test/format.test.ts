import { describe, expect, it } from "vitest";

import {
  estimatedTokens,
  formatClock,
  formatCount,
  formatDateTime,
  formatDayHeading,
  formatDuration,
  formatSize,
  formatTimeLabel,
  formatTokens,
} from "../src/format.js";

// The one formatter every screen and sentence uses: the same
// fact is written the same way everywhere it appears.
describe("formatCount", () => {
  it("writes counts with thousands separators", () => {
    expect(formatCount(14_602)).toBe("14,602");
    expect(formatCount(900)).toBe("900");
  });
});
describe("formatTokens", () => {
  it("writes thousands with one decimal and a K", () => {
    expect(formatTokens(48_000)).toBe("48.0K tokens");
    expect(formatTokens(1_000)).toBe("1.0K tokens");
  });

  it("writes the exact count under a thousand", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(312)).toBe("312 tokens");
    expect(formatTokens(900)).toBe("900 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
  });

  it("writes millions with an M", () => {
    expect(formatTokens(1_250_000)).toBe("1.3M tokens");
    expect(formatTokens(999_960)).toBe("1.0M tokens");
    expect(formatTokens(999_999)).toBe("1.0M tokens");
  });

  it("writes the full count when exact matters", () => {
    expect(formatTokens(48_000, { exact: true })).toBe("48,000 tokens");
  });

  it("writes the axis form short, with no unit word", () => {
    expect(formatTokens(0, { axis: true })).toBe("0");
    expect(formatTokens(999, { axis: true })).toBe("999");
    expect(formatTokens(50_000, { axis: true })).toBe("50K");
    expect(formatTokens(85_000, { axis: true })).toBe("85K");
    expect(formatTokens(250_000, { axis: true })).toBe("250K");
    expect(formatTokens(1_000_000, { axis: true })).toBe("1M");
    expect(formatTokens(1_500_000, { axis: true })).toBe("1.5M");
    expect(formatTokens(999_999, { axis: true })).toBe("1M");
  });
});

describe("estimatedTokens", () => {
  it("counts 2.9 characters to a token, as /context did for a 6,474-character file", () => {
    expect(estimatedTokens(6_474)).toBe(2_233);
  });

  it("rounds up to a whole token", () => {
    expect(estimatedTokens(29)).toBe(10);
    expect(estimatedTokens(30)).toBe(11);
    expect(estimatedTokens(1)).toBe(1);
    expect(estimatedTokens(0)).toBe(0);
  });

  it("keeps an unknown size unknown", () => {
    expect(estimatedTokens(null)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("writes minutes and seconds together", () => {
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(41)).toBe("41ms");
  });

  it("drops a zero seconds part", () => {
    expect(formatDuration(26 * 60_000)).toBe("26m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
  });

  it("writes ninety minutes as hours and minutes, never bare minutes", () => {
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("formatSize", () => {
  it("writes megabytes with one decimal", () => {
    expect(formatSize(3_100_000)).toBe("3.1 MB");
    expect(formatSize(512_000)).toBe("512.0 KB");
    expect(formatSize(900)).toBe("900 B");
  });
});

describe("formatTimeLabel", () => {
  const now = new Date(2026, 9, 25, 12, 46, 0).getTime();

  it("is relative while live, however long ago", () => {
    const then = now - 5 * 3_600_000;
    expect(formatTimeLabel(then, { nowMs: now, live: true })).toBe("5h ago");
  });

  it("is relative within the last hour when not live", () => {
    const then = now - 2 * 60_000;
    expect(formatTimeLabel(then, { nowMs: now, live: false })).toBe("2m ago");
    expect(formatTimeLabel(now - 10_000, { nowMs: now, live: false })).toBe(
      "just now",
    );
  });

  it("is the clock time for older moments when not live", () => {
    const then = new Date(2026, 9, 25, 9, 5, 0).getTime();
    expect(formatTimeLabel(then, { nowMs: now, live: false })).toBe("9:05 AM");
  });
});

describe("formatClock", () => {
  it("writes a twelve-hour clock time", () => {
    expect(formatClock(new Date(2026, 9, 25, 12, 46).getTime())).toBe(
      "12:46 PM",
    );
    expect(formatClock(new Date(2026, 9, 25, 0, 5).getTime())).toBe("12:05 AM");
  });
});

describe("formatDateTime", () => {
  it("writes the full date and time in one line", () => {
    const then = new Date(2026, 9, 26, 14, 5, 9).getTime();
    expect(formatDateTime(then)).toBe("Monday 26 October 2026, 2:05 PM");
  });
});

describe("formatDayHeading", () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();

  it("calls the current day Today and the day before Yesterday", () => {
    expect(formatDayHeading(new Date(2026, 9, 26, 1, 0).getTime(), now)).toBe(
      "Today",
    );
    expect(formatDayHeading(new Date(2026, 9, 25, 23, 0).getTime(), now)).toBe(
      "Yesterday",
    );
  });

  it("writes the weekday and date for older days", () => {
    expect(formatDayHeading(new Date(2026, 9, 20, 9, 0).getTime(), now)).toBe(
      "Tuesday 20 October 2026",
    );
  });
});
