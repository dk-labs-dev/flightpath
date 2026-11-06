import { join } from "node:path";

import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser, type SeededBrowser } from "./support/browser.js";
import { openExplainNote } from "./support/explain.js";
import {
  seedBranch,
  seedConditions,
  seedRequest,
  seedRequestExact,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";
import { telemetryExport, telemetryRecord } from "./support/telemetry.js";
import { dataTheme, newThemedPage } from "./support/theme-page.js";

// The live test's reload witness lives on the window, in a
// property of its own it declares here.
declare global {
  interface Window {
    fpTokensMarker?: string;
  }
}

// The tokens lens in a real browser: a click on the curve
// selects the step that landed at that point and writes it
// to the address; a request the stream brings redraws the
// curve with no reload and no poll; and the room stacks
// under the curve at phone width, axe-clean. The planted
// session is the daemon's own fixture shape, shifted to
// fifteen minutes ago so the daemon's retention keeps it.

const PLANTED = "sess-tokens";
const LIVE = "sess-live";
const ROOMY = "sess-roomy";
const CLIMB = "sess-climb";
const RISING = "sess-rising";
const LANES = "sess-lanes";
const IDLE = "sess-idle";
const SHIFT = Date.now() - 900_000;

const MAIN: {
  id: number;
  turnId: number;
  at: number;
  input: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  output: number;
  total: number;
}[] = [
  { id: 1, turnId: 1, at: 1_000, input: 20_000, output: 300, total: 20_000 },
  {
    id: 2,
    turnId: 1,
    at: 6_000,
    input: 2_000,
    cacheRead: 50_000,
    cacheWrite5m: 3_000,
    output: 400,
    total: 55_000,
  },
  {
    id: 3,
    turnId: 1,
    at: 10_000,
    input: 3_000,
    cacheRead: 70_000,
    output: 500,
    total: 73_000,
  },
  {
    id: 4,
    turnId: 2,
    at: 15_000,
    input: 1_000,
    cacheRead: 72_000,
    output: 200,
    total: 73_000,
  },
  {
    id: 5,
    turnId: 2,
    at: 21_000,
    input: 5_000,
    cacheRead: 80_000,
    output: 200,
    total: 85_000,
  },
  {
    id: 6,
    turnId: 2,
    at: 23_000,
    input: 1_000,
    cacheRead: 84_000,
    output: 200,
    total: 85_000,
  },
  {
    id: 7,
    turnId: 3,
    at: 31_000,
    input: 3_000,
    cacheRead: 90_000,
    output: 600,
    total: 93_000,
  },
  {
    id: 8,
    turnId: 3,
    at: 36_000,
    input: 3_000,
    cacheRead: 190_000,
    output: 700,
    total: 193_000,
  },
  {
    id: 9,
    turnId: 3,
    at: 39_000,
    input: 2_000,
    cacheRead: 195_000,
    output: 300,
    total: 197_000,
  },
  {
    id: 10,
    turnId: 3,
    at: 46_000,
    input: 2_000,
    cacheRead: 200_000,
    output: 300,
    total: 202_000,
  },
  {
    id: 11,
    turnId: 3,
    at: 55_000,
    input: 2_000,
    cacheRead: 200_000,
    output: 300,
    total: 202_000,
  },
  {
    id: 12,
    turnId: 3,
    at: 70_000,
    input: 2_000,
    cacheRead: 200_000,
    output: 300,
    total: 202_000,
  },
  {
    id: 13,
    turnId: 3,
    at: 76_000,
    input: 5_000,
    cacheRead: 20_000,
    output: 300,
    total: 25_000,
  },
  {
    id: 14,
    turnId: 3,
    at: 80_000,
    input: 2_000,
    cacheRead: 25_000,
    output: 300,
    total: 27_000,
  },
];

function seedPlanted(db: DatabaseSync): void {
  seedSession(db, {
    id: PLANTED,
    model: "claude-sonnet",
    joinedPartway: true,
    firstSeenAt: SHIFT,
    lastSeenAt: SHIFT + 80_000,
  });
  db.prepare("UPDATE sessions SET tokens_partial = 1 WHERE id = ?").run(
    PLANTED,
  );
  seedConditions(db, PLANTED, { sources: ["hook", "telemetry"] });
  const turns = [
    { id: 1, sequence: 1, startedAt: 0, endedAt: 9_000 },
    { id: 2, sequence: 2, startedAt: 11_000, endedAt: 25_000 },
    { id: 3, sequence: 3, startedAt: 30_000, endedAt: 40_000 },
  ];
  for (const turn of turns) {
    seedTurn(db, {
      ...turn,
      sessionId: PLANTED,
      startedAt: SHIFT + turn.startedAt,
      endedAt: SHIFT + turn.endedAt,
      promptChars: 21,
    });
  }
  seedSegment(db, {
    id: 1,
    sessionId: PLANTED,
    kind: "startup",
    startedAt: SHIFT,
    contextTokens: 20_000,
  });
  seedSegment(db, {
    id: 2,
    sessionId: PLANTED,
    kind: "compact",
    startedAt: SHIFT + 76_000,
    contextTokens: 25_000,
  });
  for (const seed of MAIN) {
    const { total, at, ...request } = seed;
    seedRequestExact(db, {
      sessionId: PLANTED,
      ...request,
      startedAt: SHIFT + at,
    });
    seedSample(db, {
      sessionId: PLANTED,
      requestId: seed.id,
      sampledAt: SHIFT + at,
      contextTokens: total,
    });
  }
  seedStep(db, {
    id: 5,
    sessionId: PLANTED,
    turnId: 3,
    toolName: "Read",
    startedAt: SHIFT + 32_000,
    endedAt: SHIFT + 35_999,
    resultSize: 200_000,
    resultRequestId: 10,
  });
  seedStep(db, {
    id: 6,
    sessionId: PLANTED,
    turnId: 3,
    toolName: "Bash",
    startedAt: SHIFT + 31_500,
    endedAt: SHIFT + 33_000,
    resultSize: 90_000,
    resultRequestId: 8,
  });
}

function seedRoomy(db: DatabaseSync): void {
  // A session that stays under its 200K limit, so the limit
  // line stands on the plot: the label checks measure it
  // against its own line. It compacts once, like the planted
  // session, so the compaction label meets its tick here too.
  seedSession(db, {
    id: ROOMY,
    model: "claude-sonnet-4-6",
    firstSeenAt: SHIFT,
    lastSeenAt: SHIFT + 60_000,
  });
  seedConditions(db, ROOMY, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 61,
    sessionId: ROOMY,
    sequence: 1,
    startedAt: SHIFT,
    endedAt: SHIFT + 60_000,
    promptChars: 21,
  });
  seedSegment(db, {
    id: 61,
    sessionId: ROOMY,
    kind: "startup",
    startedAt: SHIFT,
    contextTokens: 20_000,
  });
  seedSegment(db, {
    id: 62,
    sessionId: ROOMY,
    kind: "compact",
    startedAt: SHIFT + 41_000,
    contextTokens: 45_000,
  });
  const totals = [20_000, 60_000, 110_000, 150_000, 45_000, 60_000];
  totals.forEach((total, index) => {
    const at = 1_000 + index * 10_000;
    seedRequestExact(db, {
      id: 61 + index,
      sessionId: ROOMY,
      turnId: 61,
      model: "claude-sonnet-4-6",
      startedAt: SHIFT + at,
      input: 2_000,
      cacheRead: Math.max(0, total - 2_000),
      output: 300,
    });
    seedSample(db, {
      sessionId: ROOMY,
      requestId: 61 + index,
      sampledAt: SHIFT + at,
      contextTokens: total,
    });
  });
}

function seedRising(db: DatabaseSync): void {
  // A session whose context only grows, so its peak is its
  // last point, at the plot's right edge: the base label,
  // centred on the peak, has to be pulled back inside.
  seedSession(db, {
    id: RISING,
    model: "claude-sonnet-4-6",
    firstSeenAt: SHIFT,
    lastSeenAt: SHIFT + 50_000,
  });
  seedConditions(db, RISING, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 111,
    sessionId: RISING,
    sequence: 1,
    startedAt: SHIFT,
    endedAt: SHIFT + 50_000,
    promptChars: 21,
  });
  seedSegment(db, {
    id: 111,
    sessionId: RISING,
    kind: "startup",
    startedAt: SHIFT,
    contextTokens: 44_200,
  });
  [44_200, 70_000, 100_000, 130_000, 160_000].forEach((total, index) => {
    const at = 1_000 + index * 10_000;
    seedRequestExact(db, {
      id: 111 + index,
      sessionId: RISING,
      turnId: 111,
      model: "claude-sonnet-4-6",
      startedAt: SHIFT + at,
      input: 2_000,
      cacheRead: total - 2_000,
      output: 300,
    });
    seedSample(db, {
      sessionId: RISING,
      requestId: 111 + index,
      sampledAt: SHIFT + at,
      contextTokens: total,
    });
  });
}

function seedClimb(db: DatabaseSync): void {
  // A session that climbs again after its compaction, the
  // usual case once files are read back in: the line keeps
  // moving under where the "compacted" label stands. Its
  // second compaction falls from near the top of the scale
  // and lands high, where the label's stand has no room
  // above the landing's own level.
  seedSession(db, {
    id: CLIMB,
    model: "claude-sonnet",
    firstSeenAt: SHIFT,
    lastSeenAt: SHIFT + 147_000,
  });
  seedConditions(db, CLIMB, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 71,
    sessionId: CLIMB,
    sequence: 1,
    startedAt: SHIFT,
    endedAt: SHIFT + 147_000,
    promptChars: 21,
  });
  seedSegment(db, {
    id: 71,
    sessionId: CLIMB,
    kind: "startup",
    startedAt: SHIFT,
    contextTokens: 16_000,
  });
  seedSegment(db, {
    id: 72,
    sessionId: CLIMB,
    kind: "compact",
    startedAt: SHIFT + 60_000,
    contextTokens: 45_000,
  });
  seedSegment(db, {
    id: 73,
    sessionId: CLIMB,
    kind: "compact",
    startedAt: SHIFT + 140_000,
    contextTokens: 198_000,
  });
  const totals: number[] = [];
  for (let second = 0; second <= 147; second += 1) {
    if (second <= 35) totals.push(16_000 + 4_000 * second);
    else if (second <= 59) totals.push(156_000);
    else if (second === 60) totals.push(45_000);
    else if (second <= 88) totals.push(45_000 + 6_000 * (second - 60));
    else if (second <= 139) totals.push(213_000);
    else totals.push(198_000);
  }
  totals.forEach((total, second) => {
    seedRequestExact(db, {
      id: 1_000 + second,
      sessionId: CLIMB,
      turnId: 71,
      startedAt: SHIFT + second * 1_000,
      input: 2_000,
      cacheRead: Math.max(0, total - 2_000),
      output: 300,
    });
    seedSample(db, {
      sessionId: CLIMB,
      requestId: 1_000 + second,
      sampledAt: SHIFT + second * 1_000,
      contextTokens: total,
    });
  });
}

function seedLanes(db: DatabaseSync): void {
  // A session with one user subagent and one background
  // branch: the subagent's lane stands under the curve, and
  // clicking it selects the step that spawned it.
  seedSession(db, {
    id: LANES,
    model: "claude-sonnet",
    firstSeenAt: SHIFT,
    lastSeenAt: SHIFT + 80_000,
  });
  seedConditions(db, LANES, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 91,
    sessionId: LANES,
    sequence: 1,
    startedAt: SHIFT,
    endedAt: SHIFT + 80_000,
    promptChars: 21,
  });
  seedSegment(db, {
    id: 91,
    sessionId: LANES,
    kind: "startup",
    startedAt: SHIFT,
    contextTokens: 20_000,
  });
  const totals = [20_000, 55_000, 73_000, 85_000];
  totals.forEach((total, index) => {
    const at = 1_000 + index * 10_000;
    seedRequestExact(db, {
      id: 91 + index,
      sessionId: LANES,
      turnId: 91,
      startedAt: SHIFT + at,
      input: 2_000,
      cacheRead: Math.max(0, total - 2_000),
      output: 300,
    });
    seedSample(db, {
      sessionId: LANES,
      requestId: 91 + index,
      sampledAt: SHIFT + at,
      contextTokens: total,
    });
  });
  seedStep(db, {
    id: 91,
    sessionId: LANES,
    turnId: 91,
    toolName: "Task",
    startedAt: SHIFT + 11_000,
    endedAt: SHIFT + 19_000,
  });
  seedBranch(db, {
    id: 91,
    sessionId: LANES,
    agentType: "Explore",
    kind: "user",
    spawningStepId: 91,
    startedAt: SHIFT + 12_000,
    endedAt: SHIFT + 20_000,
  });
  seedRequest(db, {
    id: 95,
    sessionId: LANES,
    turnId: 91,
    branchId: 91,
    querySource: "subagent",
    startedAt: SHIFT + 13_000,
    inputTokens: 8_000,
    outputTokens: 100,
  });
  seedRequest(db, {
    id: 96,
    sessionId: LANES,
    turnId: 91,
    branchId: 91,
    querySource: "subagent",
    startedAt: SHIFT + 16_000,
    inputTokens: 1_000,
    cacheReadTokens: 46_000,
    outputTokens: 100,
  });
  seedBranch(db, {
    id: 92,
    sessionId: LANES,
    kind: "internal",
    startedAt: SHIFT + 30_000,
    endedAt: SHIFT + 31_000,
  });
  seedRequest(db, {
    id: 97,
    sessionId: LANES,
    branchId: 92,
    querySource: "background",
    startedAt: SHIFT + 30_000,
    inputTokens: 3_100,
    outputTokens: 0,
  });
}

function seedLive(db: DatabaseSync): void {
  const now = Date.now();
  seedSession(db, {
    id: LIVE,
    model: "claude-sonnet",
    status: "live",
    firstSeenAt: now - 60_000,
    lastSeenAt: now - 40_000,
  });
  seedConditions(db, LIVE, { sources: ["hook", "telemetry"] });
  seedSegment(db, {
    id: 51,
    sessionId: LIVE,
    kind: "startup",
    startedAt: now - 60_000,
    contextTokens: 20_000,
  });
  seedTurn(db, {
    id: 51,
    sessionId: LIVE,
    sequence: 1,
    startedAt: now - 60_000,
    endedAt: null,
    promptChars: 21,
  });
  seedRequestExact(db, {
    id: 501,
    sessionId: LIVE,
    turnId: 51,
    startedAt: now - 50_000,
    input: 30_000,
    output: 200,
  });
  seedSample(db, {
    sessionId: LIVE,
    requestId: 501,
    sampledAt: now - 50_000,
    contextTokens: 30_000,
  });
  seedRequestExact(db, {
    id: 502,
    sessionId: LIVE,
    turnId: 51,
    startedAt: now - 40_000,
    input: 10_000,
    cacheRead: 30_000,
    output: 200,
  });
  seedSample(db, {
    sessionId: LIVE,
    requestId: 502,
    sampledAt: now - 40_000,
    contextTokens: 40_000,
  });
}

function seedIdle(db: DatabaseSync): void {
  // A session that works for eight minutes, sits idle for
  // seventy-two, then works again. On the time strip the
  // first minutes squeeze against the whole span: the
  // eight-minute point stands close enough to the first
  // that the two labels' words would run together if the
  // strip kept them apart by their centres alone. The
  // last request writes more than half the context it
  // sends after the one before it read from the cache, so
  // its tooltip carries the rebuild's line.
  const start = Date.now() - 90 * 60_000;
  seedSession(db, {
    id: IDLE,
    model: "claude-sonnet",
    firstSeenAt: start,
    lastSeenAt: start + 83 * 60_000,
  });
  seedConditions(db, IDLE, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 81,
    sessionId: IDLE,
    sequence: 1,
    startedAt: start,
    endedAt: start + 83 * 60_000,
    promptChars: 21,
  });
  seedSegment(db, {
    id: 81,
    sessionId: IDLE,
    kind: "startup",
    startedAt: start,
    contextTokens: 20_000,
  });
  const points: {
    at: number;
    total: number;
    cacheRead: number;
    cacheWrite5m: number;
  }[] = [
    { at: 0, total: 20_000, cacheRead: 0, cacheWrite5m: 3_000 },
    {
      at: 8 * 60_000,
      total: 55_000,
      cacheRead: 50_000,
      cacheWrite5m: 3_000,
    },
    {
      at: 80 * 60_000,
      total: 85_000,
      cacheRead: 80_000,
      cacheWrite5m: 2_000,
    },
    {
      at: 83 * 60_000,
      total: 90_000,
      cacheRead: 0,
      cacheWrite5m: 60_000,
    },
  ];
  points.forEach((point, index) => {
    seedRequestExact(db, {
      id: 81 + index,
      sessionId: IDLE,
      turnId: 81,
      startedAt: start + point.at,
      input: 2_000,
      cacheRead: point.cacheRead,
      cacheWrite5m: point.cacheWrite5m,
      output: 300,
    });
    seedSample(db, {
      sessionId: IDLE,
      requestId: 81 + index,
      sampledAt: start + point.at,
      contextTokens: point.total,
    });
  });
}

let started: SeededBrowser;
let browser: Browser;

beforeAll(async () => {
  started = await startSeededBrowser("flightpath-tokens-lens-", (db) => {
    seedPlanted(db);
    seedLive(db);
    seedRoomy(db);
    seedClimb(db);
    seedRising(db);
    seedLanes(db);
    seedIdle(db);
  });
  browser = started.browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openTokens(page: Page, session: string): Promise<void> {
  await page.goto(
    `${started.base}/#session/${session}/tokens?token=${started.token}`,
  );
  await page.waitForSelector("svg.tokens-curve-svg");
  await page.waitForSelector("polyline.tokens-curve-line");
}

/** A check that runs at phone and desktop widths alike:
 * a page at each width, the session's tokens lens open on
 * it, the check run, the page closed. */
async function atBothWidths(
  session: string,
  check: (page: Page) => Promise<void>,
): Promise<void> {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
    });
    await openTokens(page, session);
    await check(page);
    await page.close();
  }
}

/** Every label on the curve — the spans in the labels
 * layer — with their boxes, read from the elements
 * themselves. */
async function curveLabels(page: Page): Promise<LabelRect[]> {
  return page.evaluate(() => {
    const spans = document.querySelectorAll(".tokens-curve-labels > span");
    return [...spans].map((span) => {
      const rect = span.getBoundingClientRect();
      return {
        text: span.textContent ?? "",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
  });
}

/** The base label's right edge stands inside the plot's, read
 * from the page once the label has settled. */
async function expectBaseLabelInsidePlot(page: Page): Promise<void> {
  const svg = await svgFrame(page);
  expect(svg).not.toBeNull();
  if (svg === null) return;
  // The plot's right edge, read from the drawing: the grid
  // lines run to it.
  const rightUnit = await page.evaluate(() => {
    let right = 0;
    for (const line of document.querySelectorAll(".tokens-grid-line")) {
      right = Math.max(right, Number(line.getAttribute("x2")));
    }
    return right;
  });
  const plotRight = toScreen(svg, rightUnit, 0).x;
  await expect
    .poll(async () => {
      const label = (await curveLabels(page)).find((l) =>
        l.text.startsWith("base"),
      );
      return label === undefined ? Number.NaN : label.x + label.width;
    })
    .toBeLessThanOrEqual(plotRight + 1);
}

/** The time strip's labels: the curve labels whose whole
 * text is a clock time. */
async function timeLabels(page: Page): Promise<LabelRect[]> {
  const labels = await curveLabels(page);
  return labels.filter((label) => /^\d{1,2}:\d{2} [AP]M$/.test(label.text));
}

/** How far a lens's first element stands below the tab
 * bar: the head's bottom to the element's top. */
async function firstCardGap(page: Page, lensSelector: string): Promise<number> {
  return page.evaluate((selector) => {
    const lens = document.querySelector(selector);
    const head = document.querySelector(".session-head");
    const first = lens?.firstElementChild;
    if (lens === null || head === null || first === undefined || first === null)
      return -1;
    return (
      first.getBoundingClientRect().top - head.getBoundingClientRect().bottom
    );
  }, lensSelector);
}

interface SvgFrame {
  viewBox: number[];
  frame: { x: number; y: number; width: number; height: number };
}

/** The drawing's own frame: its viewBox and where it stands
 * on the screen, both read from the SVG itself. */
async function svgFrame(
  page: Page,
  selector = "svg.tokens-curve-svg",
): Promise<SvgFrame | null> {
  return page.evaluate((sel) => {
    const svg = document.querySelector(sel);
    if (svg === null) return null;
    const frame = svg.getBoundingClientRect();
    return {
      viewBox: (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number),
      frame: {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
    };
  }, selector);
}

/** A point in the drawing's own units, placed on the screen
 * through its viewBox: the mapping every check reads through,
 * so no drawing size is restated in a test. */
function toScreen(
  svg: SvgFrame,
  x: number,
  y: number,
): { x: number; y: number } {
  const [originX = 0, originY = 0, unitsWide = 1, unitsHigh = 1] = svg.viewBox;
  return {
    x: svg.frame.x + ((x - originX) / unitsWide) * svg.frame.width,
    y: svg.frame.y + ((y - originY) / unitsHigh) * svg.frame.height,
  };
}

interface LabelRect {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > 1 && overlapY > 1;
}

/** No two of the rects overlap; the error names the kind
 * of label, so a failure says which labels collided. */
function expectNoOverlaps(rects: LabelRect[], kind: string): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a === undefined || b === undefined) continue;
      if (rectsOverlap(a, b)) {
        throw new Error(`${kind} overlap: "${a.text}" and "${b.text}"`);
      }
    }
  }
}

/** A drawn line against the boxes it must not cross: the
 * texts of the boxes any of the line's segments pass
 * through, walked along the line itself — a sample every
 * two pixels along each segment, so a segment crossing a
 * box between two of the line's points is still caught.
 * The curve's labels and the lane's words are measured
 * this way. */
async function lineCrossings(
  page: Page,
  lineSelector: string,
  svgSelector: string,
  boxSelector: string,
): Promise<{ missing: boolean; crossed: string[] }> {
  const svg = await svgFrame(page, svgSelector);
  if (svg === null || (await page.locator(lineSelector).count()) === 0) {
    return { missing: true, crossed: [] };
  }
  const points = (await drawnPoints(page, lineSelector)).map(([x, y]) =>
    toScreen(svg, x, y),
  );
  return page.evaluate(
    (check) => {
      const samples: { x: number; y: number }[] = [];
      for (let i = 1; i < check.points.length; i++) {
        const from = check.points[i - 1];
        const to = check.points[i];
        if (from === undefined || to === undefined) continue;
        const steps = Math.max(
          1,
          Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2),
        );
        for (let step = 0; step <= steps; step++) {
          samples.push({
            x: from.x + ((to.x - from.x) * step) / steps,
            y: from.y + ((to.y - from.y) * step) / steps,
          });
        }
      }
      const crossed: string[] = [];
      for (const box of document.querySelectorAll(check.boxes)) {
        const rect = box.getBoundingClientRect();
        for (const sample of samples) {
          if (
            sample.x > rect.x &&
            sample.x < rect.x + rect.width &&
            sample.y > rect.y &&
            sample.y < rect.y + rect.height
          ) {
            crossed.push(box.textContent ?? "");
            break;
          }
        }
      }
      return { missing: false, crossed };
    },
    { boxes: boxSelector, points },
  );
}

/** The label checks, run at phone and desktop widths alike:
 * every label stands inside the card at a readable height,
 * no two labels overlap, no label crosses its own line
 * or tick — the limit and auto-compact labels against their
 * dashed lines, "compacted" against its tick, each measured
 * from the elements' own boxes — and no label covers the
 * curve's own line, walked along the polyline's segments. */
async function expectLabelsClear(page: Page): Promise<void> {
  const card = page.locator(".tokens-card").first();
  const curveBox = await card.boundingBox();
  expect(curveBox).not.toBeNull();
  if (curveBox === null) return;
  await expect
    .poll(async () => page.locator(".tokens-curve-labels > span").count())
    .toBeGreaterThanOrEqual(8);
  const labels = await curveLabels(page);
  for (const label of labels) {
    expect(label.height).toBeGreaterThanOrEqual(10);
    expect(label.x).toBeGreaterThanOrEqual(curveBox.x - 1);
    expect(label.y).toBeGreaterThanOrEqual(curveBox.y - 1);
    expect(label.x + label.width).toBeLessThanOrEqual(
      curveBox.x + curveBox.width + 1,
    );
    expect(label.y + label.height).toBeLessThanOrEqual(
      curveBox.y + curveBox.height + 1,
    );
  }
  expectNoOverlaps(labels, "curve labels");
  const crossings = await page.evaluate(() => {
    const pairs: [string, string][] = [
      [".tokens-limit-label", ".tokens-limit-line"],
      [".tokens-autocompact-label", ".tokens-autocompact-line"],
      [".tokens-compaction-label", ".tokens-compaction-tick"],
    ];
    const crosses = (labelSelector: string, lineSelector: string): string[] => {
      const found: string[] = [];
      for (const labelEl of document.querySelectorAll(labelSelector)) {
        const a = labelEl.getBoundingClientRect();
        for (const lineEl of document.querySelectorAll(lineSelector)) {
          const b = lineEl.getBoundingClientRect();
          const overlapX =
            Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY =
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 0 && overlapY > 0) {
            found.push(
              `${labelSelector} "${labelEl.textContent ?? ""}" crosses ${lineSelector}`,
            );
          }
        }
      }
      return found;
    };
    return pairs.flatMap(([label, line]) => crosses(label, line));
  });
  expect(crossings).toEqual([]);
  const { missing, crossed } = await lineCrossings(
    page,
    "polyline.tokens-curve-line",
    "svg.tokens-curve-svg",
    ".tokens-curve-labels > span",
  );
  const covered = missing
    ? ["the curve's line is missing"]
    : crossed.map((text) => `"${text}" covers the curve's line`);
  expect(covered).toEqual([]);
}

/** The lane's line stays on its own row, below its words,
 * and crosses neither the type's nor the figures' box. */
async function expectLaneLineClear(page: Page): Promise<void> {
  const sparkBox = await page.locator("svg.tokens-lane-spark").boundingBox();
  const typeBox = await page.locator(".tokens-lane-type").boundingBox();
  const figuresBox = await page.locator(".tokens-lane-figures").boundingBox();
  expect(sparkBox).not.toBeNull();
  expect(typeBox).not.toBeNull();
  expect(figuresBox).not.toBeNull();
  if (sparkBox === null || typeBox === null || figuresBox === null) return;
  expect(typeBox.y + typeBox.height).toBeLessThanOrEqual(sparkBox.y + 1);
  expect(figuresBox.y + figuresBox.height).toBeLessThanOrEqual(sparkBox.y + 1);
  const { missing, crossed } = await lineCrossings(
    page,
    "polyline.tokens-lane-line",
    "svg.tokens-lane-spark",
    ".tokens-lane-type, .tokens-lane-figures",
  );
  const covered = missing
    ? ["the lane's line is missing"]
    : crossed.map((text) => `the lane's line crosses "${text}"`);
  expect(covered).toEqual([]);
}

/** How far each lane point stands from the curve's place
 * for the same moment, in screen pixels: each drawing's
 * own frame read the one way, and the point's viewBox x
 * put on the screen through both. A lane drawn in a
 * narrower box than the curve's drifts at the edges,
 * and only screen pixels show it. */
async function lanePointDrift(page: Page): Promise<number[]> {
  const curve = await svgFrame(page);
  const lane = await svgFrame(page, "svg.tokens-lane-spark");
  if (curve === null || lane === null) return [];
  const xs = await page.evaluate(() => {
    const line = document.querySelector("polyline.tokens-lane-line");
    return (line?.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/)
      .filter((pair) => pair.length > 0)
      .map((pair) => Number(pair.split(",")[0]));
  });
  return xs.map((vx) =>
    Math.abs(toScreen(lane, vx, 0).x - toScreen(curve, vx, 0).x),
  );
}

/** The lanes session open at one width, its lane's line
 * drawn. */
async function openLanesAtWidth(width: number): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width, height: 844 },
  });
  await openTokens(page, LANES);
  await expect
    .poll(() => page.locator("polyline.tokens-lane-line").count())
    .toBe(1);
  return page;
}

async function drawnPoints(
  page: Page,
  selector = "polyline.tokens-curve-line",
): Promise<[number, number][]> {
  const points = await page.locator(selector).getAttribute("points");
  return (points ?? "")
    .trim()
    .split(/\s+/)
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const [x, y] = pair.split(",");
      return [Number(x), Number(y)] as [number, number];
    });
}

/** A click on a drawn point, placed on the screen through
 * the drawing's own frame: the viewBox follows the frame's
 * measured width, so the point's place is read from the
 * drawing — never a fixed width or height. */
async function clickPoint(page: Page, point: [number, number]): Promise<void> {
  const svg = await svgFrame(page);
  if (svg === null) throw new Error("no curve frame");
  const at = toScreen(svg, point[0], point[1]);
  await page.mouse.click(at.x, at.y);
}

describe("the tokens lens in a browser", () => {
  it("selects the step that landed at the clicked point", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openTokens(page, PLANTED);
    // The planted session's two plain statements show.
    await expect.poll(() => page.locator(".tokens-note").count()).toBe(2);
    const points = await drawnPoints(page);
    expect(points).toHaveLength(14);
    const target = points[7];
    expect(target).toBeDefined();
    if (target === undefined) return;
    // Request 8's point: clicking it selects step 6, whose
    // result that request first carried. Step 5 ended in the
    // same span but its result first counted in request 10,
    // so the end time alone would pick the wrong step. The
    // address carries the step.
    await clickPoint(page, target);
    await expect.poll(() => new URL(page.url()).hash).toContain("step=6");
    await expect
      .poll(() => page.locator(".tokens-selected-line").count())
      .toBe(1);
    await page.close();
  }, 60_000);

  it("stacks the room under the curve at phone width, axe-clean", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openTokens(page, PLANTED);
    const cards = page.locator(".tokens-card");
    await expect.poll(() => cards.count()).toBe(4);
    const curveBox = await cards.nth(0).boundingBox();
    const roomBox = await cards.nth(1).boundingBox();
    expect(curveBox).not.toBeNull();
    expect(roomBox).not.toBeNull();
    if (curveBox === null || roomBox === null) return;
    expect(roomBox.y).toBeGreaterThanOrEqual(curveBox.y + curveBox.height - 1);
    // The plot keeps its full height at phone width, so the
    // words keep the spacing they have on a wide screen.
    const svgBox = await page.locator("svg.tokens-curve-svg").boundingBox();
    expect(svgBox).not.toBeNull();
    if (svgBox === null) return;
    expect(svgBox.height).toBeGreaterThanOrEqual(200);
    // Every label stands inside the card at a readable
    // height, no two overlap, and none crosses its own line.
    await expectLabelsClear(page);
    // The viewBox follows the frame's measured width, so the
    // point dots keep their shape instead of stretching with
    // the screen: a dot's box is square within a pixel.
    const dot = await page.locator(".tokens-point").first().boundingBox();
    expect(dot).not.toBeNull();
    if (dot !== null) {
      expect(Math.abs(dot.width - dot.height)).toBeLessThanOrEqual(1);
    }
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 60_000);

  it("passes axe on the session screen in dark", async () => {
    const page = await newThemedPage(browser, "dark");
    await openTokens(page, PLANTED);
    expect(await dataTheme(page)).toBe("dark");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 60_000);

  it("keeps every label clear of its own line at desktop width", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openTokens(page, PLANTED);
    await expectLabelsClear(page);
    await page.close();
  }, 60_000);

  it("keeps the limit's label off its line at both widths", async () => {
    await atBothWidths(ROOMY, async (page) => {
      // The roomy session's limit stands on the plot, so its
      // label and line are both there to be measured.
      await expect
        .poll(() => page.locator(".tokens-limit-line").count())
        .toBe(1);
      await expectLabelsClear(page);
    });
  }, 60_000);

  it("keeps every label clear of its own line at both widths when the line climbs again after a compaction", async () => {
    await atBothWidths(CLIMB, expectLabelsClear);
  }, 60_000);

  it("keeps the base label inside the plot's right edge when the peak is the last point, at both widths", async () => {
    await atBothWidths(RISING, expectBaseLabelInsidePlot);
  }, 60_000);

  it("keeps the base label inside the plot's right edge when the font is wider than the one measured first", async () => {
    await atBothWidths(RISING, async (page) => {
      // A web font swapping in after the first measure widens
      // the label the same way.
      await page.addStyleTag({
        content: `.tokens-curve-labels > span {
          font-family: monospace;
          letter-spacing: 0.2em;
        }`,
      });
      await expectBaseLabelInsidePlot(page);
    });
  }, 60_000);

  it("keeps the compaction label inside the plot when a drop lands near the top of the scale", async () => {
    await atBothWidths(CLIMB, async (page) => {
      const labels = page.locator(".tokens-compaction-label");
      await expect.poll(() => labels.count()).toBe(2);
      const svg = await svgFrame(page);
      expect(svg).not.toBeNull();
      if (svg === null) return;
      // The plot's top edge, read from the drawing: the top
      // grid line stands at the plot's top, and its own place
      // in the viewBox maps to the screen through the frame.
      const topUnit = await page.evaluate(() => {
        let top = Number.POSITIVE_INFINITY;
        for (const line of document.querySelectorAll(".tokens-grid-line")) {
          top = Math.min(top, Number(line.getAttribute("y1")));
        }
        return top;
      });
      const plotTop = toScreen(svg, 0, topUnit).y;
      for (let index = 0; index < 2; index++) {
        const box = await labels.nth(index).boundingBox();
        expect(box).not.toBeNull();
        if (box === null) return;
        expect(box.y).toBeGreaterThanOrEqual(plotTop - 1);
      }
    });
  }, 60_000);

  it("keeps the time labels apart after a long idle, at both widths", async () => {
    const check = async (page: Page): Promise<void> => {
      const labels = await timeLabels(page);
      expect(labels.length).toBeGreaterThanOrEqual(2);
      expectNoOverlaps(labels, "time labels");
    };
    for (const width of [390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
      });
      await openTokens(page, IDLE);
      await check(page);
      await page.close();
    }
    const dark = await newThemedPage(browser, "dark");
    await openTokens(dark, IDLE);
    expect(await dataTheme(dark)).toBe("dark");
    await check(dark);
    await dark.setViewportSize({ width: 390, height: 900 });
    await expect
      .poll(async () => (await timeLabels(dark)).length)
      .toBeGreaterThanOrEqual(2);
    await check(dark);
    await dark.close();
  }, 90_000);

  it("keeps the last point's tooltip at its width at the right edge", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openTokens(page, IDLE);
    const points = await drawnPoints(page);
    const last = points[points.length - 1];
    if (last === undefined) throw new Error("no points drawn");
    const svg = await svgFrame(page);
    if (svg === null) throw new Error("no curve frame");
    const at = toScreen(svg, last[0], last[1]);
    await page.mouse.move(at.x, at.y);
    await expect.poll(() => page.locator(".tokens-tooltip").count()).toBe(1);
    const tip = await page.locator(".tokens-tooltip").boundingBox();
    const card = await page.locator(".tokens-card").first().boundingBox();
    expect(tip).not.toBeNull();
    expect(card).not.toBeNull();
    if (tip === null || card === null) return;
    expect(tip.width).toBeGreaterThanOrEqual(200);
    expect(tip.x).toBeGreaterThanOrEqual(card.x - 1);
    expect(tip.x + tip.width).toBeLessThanOrEqual(card.x + card.width + 1);
    await page.close();
  }, 60_000);

  it("starts the tokens and snapshot lenses the same distance under the tabs", async () => {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
      });
      await openTokens(page, PLANTED);
      const tokens = await firstCardGap(page, ".tokens-lens");
      await page.goto(
        `${started.base}/#session/${PLANTED}/snapshot?token=${started.token}`,
      );
      await page.waitForSelector(".snapshot-lens");
      const snapshot = await firstCardGap(page, ".snapshot-lens");
      expect(tokens).toBeGreaterThan(0);
      expect(Math.abs(tokens - snapshot)).toBeLessThanOrEqual(1);
      await page.close();
    }
  }, 90_000);

  it("draws a new point when the stream brings a request, with no reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openTokens(page, LIVE);
    await expect.poll(() => drawnPoints(page)).toHaveLength(2);
    await page.evaluate(() => {
      // The reload witness: a full page load would clear it.
      window.fpTokensMarker = "still-here";
    });
    const sentAt = Date.now();
    const response = await fetch(`${started.base}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flightpath-token": started.token,
      },
      body: JSON.stringify(
        telemetryExport([
          telemetryRecord(
            "claude_code.api_request",
            {
              "session.id": LIVE,
              "prompt.id": "p-live-1",
              request_id: "req-live-3",
              model: "claude-sonnet",
              query_source: "repl_main_thread",
              input_tokens: 5_000,
              output_tokens: 200,
              cache_read_tokens: 40_000,
              duration_ms: 900,
            },
            sentAt,
            1,
          ),
        ]),
      ),
    });
    expect(response.ok).toBe(true);
    await expect
      .poll(() => drawnPoints(page), { timeout: 2_000, interval: 100 })
      .toHaveLength(3);
    expect(Date.now() - sentAt).toBeLessThan(2_000);
    const marker = await page.evaluate(() => window.fpTokensMarker);
    expect(marker).toBe("still-here");
    await page.close();
  }, 60_000);

  it("selects the spawning step when a subagent's lane is clicked", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openTokens(page, LANES);
    // One lane for the user subagent, named by its type,
    // with the Claude Code helper counted apart beneath it.
    await expect.poll(() => page.locator(".tokens-lane").count()).toBe(1);
    await expect
      .poll(() => page.locator(".tokens-lane-type").innerText())
      .toBe("Explore");
    await expect
      .poll(() => page.locator(".tokens-lane-figures").innerText())
      .toContain("returned: not recorded");
    await expect
      .poll(() => page.locator(".tokens-background").innerText())
      .toBe("Claude Code helpers: 1 agent, 3.1K tokens");
    await expectAxeCleanOnPage(page);
    // The lane is its spawning step's button: clicking it
    // selects the step, and the address carries it.
    await page.locator(".tokens-lane").click();
    await expect.poll(() => new URL(page.url()).hash).toContain("step=91");
    await page.close();
  }, 60_000);

  it("keeps the lane's line on its own row, clear of its words", async () => {
    for (const width of [390, 1440]) {
      const page = await openLanesAtWidth(width);
      await expectLaneLineClear(page);
      await page.close();
    }
  }, 60_000);

  it("stands the lane's points under the curve's moments", async () => {
    for (const width of [390, 1440]) {
      const page = await openLanesAtWidth(width);
      const drift = await lanePointDrift(page);
      expect(drift.length).toBeGreaterThan(0);
      for (const off of drift) {
        expect(off).toBeLessThanOrEqual(1);
      }
      await page.close();
    }
  }, 60_000);

  it("links the rises to the curve in both directions", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
    });
    await openTokens(page, PLANTED);
    await expect.poll(() => page.locator(".tokens-rise").count()).toBe(8);
    // Expanding the biggest rise marks its two points.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator(".tokens-rise-head").first().click();
    await expect.poll(() => page.locator(".tokens-rise-point").count()).toBe(2);
    // Clicking the last point — the smallest rise's end —
    // selects that rise and brings its row into view.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const lastRise = page.locator('[data-rise-id="rise-14"]');
    const before = await lastRise.boundingBox();
    expect(before === null || before.y >= 700).toBe(true);
    const points = await drawnPoints(page);
    const target = points[points.length - 1];
    if (target === undefined) throw new Error("no last point drawn");
    await clickPoint(page, target);
    await expect
      .poll(async () => {
        const riseBox = await lastRise.boundingBox();
        return (
          riseBox !== null &&
          riseBox.y >= 0 &&
          riseBox.y + riseBox.height <= 700
        );
      })
      .toBe(true);
    expect(
      await lastRise.evaluate((el) =>
        el.classList.contains("tokens-rise-selected"),
      ),
    ).toBe(true);
    await page.close();
  }, 60_000);

  it.each([390, 1440])(
    "centres each rise's ? on its link pill at %i px",
    async (width) => {
      const page = await newThemedPage(browser, "light", {
        viewport: { width, height: 844 },
      });
      await openTokens(page, PLANTED);
      await expect.poll(() => page.locator(".tokens-rise").count()).toBe(8);
      const offsets = await page
        .locator(".tokens-rise-side")
        .evaluateAll((sides) =>
          sides.map((side) => {
            const pill = side
              .querySelector(".tokens-rise-link")!
              .getBoundingClientRect();
            const button = side
              .querySelector(".explain-button")!
              .getBoundingClientRect();
            return (
              button.top + button.height / 2 - (pill.top + pill.height / 2)
            );
          }),
        );
      expect(offsets).toHaveLength(8);
      for (const offset of offsets) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(1);
      }
      await page.close();
    },
    60_000,
  );

  it.each([
    { theme: "light", width: 1440 },
    { theme: "light", width: 390 },
    { theme: "dark", width: 1440 },
    { theme: "dark", width: 390 },
  ] as const)(
    "opens the rises' link note in $theme at $width px",
    async ({ theme, width }) => {
      const page = await newThemedPage(browser, theme, {
        viewport: { width, height: 844 },
      });
      await openTokens(page, PLANTED);
      await expect.poll(() => page.locator(".tokens-rise").count()).toBe(8);
      if (width === 390) {
        const rise = page.locator(".tokens-rise").first();
        const headBox = await rise.locator(".tokens-rise-head").boundingBox();
        const linkBox = await rise.locator(".tokens-rise-link").boundingBox();
        const headlineBox = await rise
          .locator(".tokens-rise-main > span")
          .first()
          .boundingBox();
        expect(linkBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height);
        expect(headlineBox!.width).toBeGreaterThan(120);
      }
      const button = page
        .getByRole("button", { name: "What is a rise's link?" })
        .first();
      const note = await openExplainNote(button);
      await expect
        .poll(() => note.textContent())
        .toBe(
          "Steps linked: Claude Code's transcript says which step's " +
            "result went into this request. Found by time: the steps " +
            "that finished between the two requests.",
        );
      await expectAxeCleanOnPage(page);
      const shots = makeTempRoot("flightpath-tokens-shots-");
      await page.screenshot({
        path: join(shots, `link-note-${theme}-${width}.png`),
      });
      await page.close();
    },
    120_000,
  );
});
