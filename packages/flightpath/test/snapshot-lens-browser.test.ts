import { join } from "node:path";

import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSync } from "../src/storage/sqlite.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser, type SeededBrowser } from "./support/browser.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { closeExplainNote, openExplainNote } from "./support/explain.js";
import { newThemedPage, resolvedTokens } from "./support/theme-page.js";
import {
  seedConditions,
  seedLoad,
  seedMoment,
  seedPromptAttachment,
  seedRequestExact,
  seedRequestShape,
  seedSample,
  seedBranch,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";

// The snapshot lens in a real browser: a step chosen in the
// steps lens is the step the snapshot lens shows; the lens
// is axe-clean at desktop and phone widths, and screenshots
// of the lens panel itself — a normal step and a step after
// a compaction, at desktop and phone widths — are taken to
// a temporary folder. The lens scrolls inside its own panel,
// so the screenshots take the panel, never the window. Times
// sit just behind the clock, as in the other lens suites:
// the daemon's retention pass would delete a session whose
// last activity is older than the kept-days setting.
const T0 = Date.now() - 900_000;
const SESSION = "snapshot-session";
const COMPACTED = "snapshot-compacted";
const REPLIED = "snapshot-replied";
const PASTED = "snapshot-pasted";
const SUBAGENT = "snapshot-subagent";

let seeded: SeededBrowser;
let browser: Browser;

function seedSnapshotSession(db: DatabaseSync): void {
  seedSession(db, {
    id: SESSION,
    projectPath: "/home/user/app",
    firstSeenAt: T0,
    lastSeenAt: T0 + 60_000,
  });
  seedConditions(db, SESSION, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 1,
    sessionId: SESSION,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 60_000,
    promptChars: 40,
    promptText: "Add a remove command",
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: 1,
    kind: "prompt",
    occurredAt: T0,
    detail: "Add a remove command",
  });
  seedRequestExact(db, {
    id: 1,
    sessionId: SESSION,
    turnId: 1,
    startedAt: T0 + 1_000,
    input: 20_000,
    output: 300,
  });
  seedSample(db, {
    sessionId: SESSION,
    requestId: 1,
    sampledAt: T0 + 1_000,
    contextTokens: 20_000,
  });
  seedRequestExact(db, {
    id: 2,
    sessionId: SESSION,
    turnId: 1,
    startedAt: T0 + 6_000,
    input: 2_000,
    cacheRead: 50_000,
    cacheWrite5m: 3_000,
    output: 400,
  });
  seedSample(db, {
    sessionId: SESSION,
    requestId: 2,
    sampledAt: T0 + 6_000,
    contextTokens: 55_000,
  });
  seedRequestExact(db, {
    id: 3,
    sessionId: SESSION,
    turnId: 1,
    startedAt: T0 + 10_000,
    input: 3_000,
    cacheRead: 70_000,
    output: 500,
  });
  seedSample(db, {
    sessionId: SESSION,
    requestId: 3,
    sampledAt: T0 + 10_000,
    contextTokens: 73_000,
  });
  // The steps come after the requests, which their result
  // links name.
  seedStep(db, {
    id: 1,
    sessionId: SESSION,
    turnId: 1,
    toolName: "Read",
    input: { file_path: "/home/user/app/src/app.ts" },
    startedAt: T0 + 2_000,
    endedAt: T0 + 5_000,
    resultSize: 140_000,
    resultRequestId: 2,
  });
  seedStep(db, {
    id: 2,
    sessionId: SESSION,
    turnId: 1,
    toolName: "Bash",
    input: { command: "npm test" },
    startedAt: T0 + 7_000,
    endedAt: T0 + 9_000,
    resultSize: 8_000,
    resultRequestId: 3,
  });
}

/** A session with a recorded request shape — so its fixed
 * load splits — cut by a compaction: a read and a skill
 * before it, one step after it. The read file and the skill
 * are what the compaction view names as restored. After the
 * compaction the session's startup entries arrive again and
 * a `/context` report is taken. */
function seedCompactedSession(db: DatabaseSync): void {
  seedSession(db, {
    id: COMPACTED,
    projectPath: "/home/user/app",
    firstSeenAt: T0,
    lastSeenAt: T0 + 90_000,
  });
  seedConditions(db, COMPACTED, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 2,
    sessionId: COMPACTED,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 90_000,
    promptChars: 40,
    promptText: "Add a remove command",
  });
  seedMoment(db, {
    sessionId: COMPACTED,
    turnId: 2,
    kind: "prompt",
    occurredAt: T0,
    detail: "Add a remove command",
  });
  seedRequestShape(db, {
    hash: "shape-snap",
    systemBytes: 34_000,
    tools: [
      { name: "Task", bytes: 36_700, mcp: false },
      { name: "Bash", bytes: 4_000, mcp: false },
      { name: "Read", bytes: 2_000, mcp: false },
      { name: "Edit", bytes: 1_600, mcp: false },
      { name: "Grep", bytes: 1_200, mcp: false },
      { name: "Glob", bytes: 800, mcp: false },
      { name: "Write", bytes: 400, mcp: false },
      { name: "mcp__notes__save", bytes: 1_200, mcp: true },
      { name: "mcp__notes__load", bytes: 800, mcp: true },
    ],
  });
  seedLoad(db, {
    id: 11,
    sessionId: COMPACTED,
    kind: "instructions",
    filePath: "CLAUDE.md",
    occurredAt: T0 + 500,
    sizeBytes: 2_400,
  });
  seedLoad(db, {
    id: 12,
    sessionId: COMPACTED,
    kind: "skill",
    name: "add-unit",
    occurredAt: T0 + 3_000,
  });
  seedRequestExact(db, {
    id: 11,
    sessionId: COMPACTED,
    turnId: 2,
    startedAt: T0 + 1_000,
    input: 20_000,
    output: 300,
    shapeHash: "shape-snap",
  });
  seedSample(db, {
    sessionId: COMPACTED,
    requestId: 11,
    sampledAt: T0 + 1_000,
    contextTokens: 20_000,
  });
  seedRequestExact(db, {
    id: 12,
    sessionId: COMPACTED,
    turnId: 2,
    startedAt: T0 + 6_000,
    input: 2_000,
    cacheRead: 50_000,
    cacheWrite5m: 3_000,
    output: 400,
  });
  seedSample(db, {
    sessionId: COMPACTED,
    requestId: 12,
    sampledAt: T0 + 6_000,
    contextTokens: 55_000,
  });
  seedSegment(db, {
    id: 19,
    sessionId: COMPACTED,
    kind: "compact",
    startedAt: T0 + 50_000,
    contextTokens: 25_000,
  });
  // The transcript recorded one file for this compaction,
  // read in again after it: the restored row with a size.
  db.prepare(
    "INSERT INTO compaction_files (session_id, at, name, size_bytes, reread) VALUES (?, ?, ?, ?, ?)",
  ).run(COMPACTED, T0 + 50_400, "src/app.ts", 40_600, 1);
  seedLoad(db, {
    id: 13,
    sessionId: COMPACTED,
    kind: "skill-listing",
    occurredAt: T0 + 50_200,
    source: "transcript",
    sizeBytes: 20_000,
    itemCount: 40,
  });
  seedLoad(db, {
    id: 14,
    sessionId: COMPACTED,
    kind: "agent-listing",
    occurredAt: T0 + 50_300,
    source: "transcript",
    sizeBytes: 2_500,
  });
  db.prepare(
    "INSERT INTO context_reports (session_id, model, window, system_prompt, skills, reported_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(COMPACTED, "claude-sonnet", 1_000_000, 2_800, 8_300, T0 + 51_500);
  seedRequestExact(db, {
    id: 13,
    sessionId: COMPACTED,
    turnId: 2,
    startedAt: T0 + 50_500,
    input: 5_000,
    output: 100,
    shapeHash: "shape-snap",
  });
  seedSample(db, {
    sessionId: COMPACTED,
    requestId: 13,
    sampledAt: T0 + 50_500,
    contextTokens: 25_000,
  });
  seedStep(db, {
    id: 11,
    sessionId: COMPACTED,
    turnId: 2,
    toolName: "Read",
    input: { file_path: "/home/user/app/src/app.ts" },
    startedAt: T0 + 2_000,
    endedAt: T0 + 5_000,
    resultSize: 140_000,
    resultRequestId: 12,
  });
  seedStep(db, {
    id: 12,
    sessionId: COMPACTED,
    turnId: 2,
    toolName: "Bash",
    input: { command: "npm test" },
    startedAt: T0 + 51_000,
    endedAt: T0 + 52_000,
    resultSize: 400,
    resultRequestId: 13,
  });
}

/** A session whose turn after the compaction only replied in
 * text: it ran no step, so its one request is all the
 * snapshot has to open on. A read before the compaction is
 * what the compaction view names as restored. */
function seedRepliedSession(db: DatabaseSync): void {
  seedSession(db, {
    id: REPLIED,
    projectPath: "/home/user/app",
    firstSeenAt: T0,
    lastSeenAt: T0 + 90_000,
  });
  seedConditions(db, REPLIED, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 3,
    sessionId: REPLIED,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 40_000,
    promptChars: 40,
    promptText: "Add a remove command",
  });
  seedRequestExact(db, {
    id: 21,
    sessionId: REPLIED,
    turnId: 3,
    startedAt: T0 + 1_000,
    input: 20_000,
    output: 300,
  });
  seedRequestExact(db, {
    id: 22,
    sessionId: REPLIED,
    turnId: 3,
    startedAt: T0 + 6_000,
    input: 2_000,
    cacheRead: 50_000,
    cacheWrite5m: 3_000,
    output: 400,
  });
  seedStep(db, {
    id: 21,
    sessionId: REPLIED,
    turnId: 3,
    toolName: "Read",
    input: { file_path: "/home/user/app/src/app.ts" },
    startedAt: T0 + 2_000,
    endedAt: T0 + 5_000,
    resultSize: 140_000,
    resultRequestId: 22,
  });
  seedSegment(db, {
    id: 29,
    sessionId: REPLIED,
    kind: "compact",
    startedAt: T0 + 50_000,
    contextTokens: 25_000,
  });
  seedTurn(db, {
    id: 4,
    sessionId: REPLIED,
    sequence: 2,
    startedAt: T0 + 50_200,
    endedAt: T0 + 52_000,
    promptChars: 20,
    promptText: "Recap the work here.",
  });
  seedRequestExact(db, {
    id: 23,
    sessionId: REPLIED,
    turnId: 4,
    startedAt: T0 + 50_500,
    input: 25_000,
    output: 200,
  });
}

/** A session of one prompt that carried an image and one
 * text reply: it ran no step at all. */
function seedPastedImageSession(db: DatabaseSync): void {
  seedSession(db, {
    id: PASTED,
    projectPath: "/home/user/app",
    firstSeenAt: T0,
    lastSeenAt: T0 + 20_000,
  });
  seedConditions(db, PASTED, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 5,
    sessionId: PASTED,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 10_000,
    promptChars: 30,
    promptText: "[Image #1] describe the picture",
    imageCount: 1,
  });
  seedPromptAttachment(db, {
    sessionId: PASTED,
    turnId: 5,
    kind: "image",
    name: "image/png",
    sizeBytes: 218_732,
  });
  seedRequestExact(db, {
    id: 31,
    sessionId: PASTED,
    turnId: 5,
    startedAt: T0 + 1_000,
    input: 51_300,
    output: 200,
  });
}

/** A session whose Explore subagent started with a task, two
 * preloaded skills, two instruction files and the listings, and read
 * one file; the subagent's own request shape is recorded. */
function seedSubagentSession(db: DatabaseSync): void {
  seedSession(db, {
    id: SUBAGENT,
    projectPath: "/home/user/app",
    firstSeenAt: T0,
    lastSeenAt: T0 + 60_000,
  });
  seedConditions(db, SUBAGENT, { sources: ["hook", "telemetry"] });
  seedTurn(db, {
    id: 6,
    sessionId: SUBAGENT,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 60_000,
    promptChars: 40,
    promptText: "Find where the remove command belongs",
  });
  seedRequestShape(db, {
    hash: "shape-explore",
    systemBytes: 12_000,
    tools: [
      { name: "Read", bytes: 2_000, mcp: false },
      { name: "Grep", bytes: 1_200, mcp: false },
    ],
  });
  seedRequestExact(db, {
    id: 41,
    sessionId: SUBAGENT,
    turnId: 6,
    startedAt: T0 + 1_000,
    input: 20_000,
    output: 300,
  });
  seedStep(db, {
    id: 41,
    sessionId: SUBAGENT,
    turnId: 6,
    toolName: "Agent",
    startedAt: T0 + 2_000,
    endedAt: T0 + 40_000,
    resultSize: 3_000,
  });
  const branchId = seedBranch(db, {
    id: 4,
    sessionId: SUBAGENT,
    agentId: "agent-explore",
    agentType: "Explore",
    spawningStepId: 41,
    startedAt: T0 + 3_000,
  });
  seedRequestExact(db, {
    id: 42,
    sessionId: SUBAGENT,
    turnId: 6,
    branchId,
    querySource: "subagent",
    startedAt: T0 + 4_000,
    input: 3_000,
    cacheRead: 9_000,
    output: 200,
    shapeHash: "shape-explore",
  });
  seedRequestExact(db, {
    id: 43,
    sessionId: SUBAGENT,
    turnId: 6,
    branchId,
    querySource: "subagent",
    startedAt: T0 + 9_000,
    input: 2_000,
    cacheRead: 18_000,
    output: 300,
    shapeHash: "shape-explore",
  });
  seedStep(db, {
    id: 42,
    sessionId: SUBAGENT,
    turnId: 6,
    branchId,
    toolName: "Read",
    input: { file_path: "/home/user/app/src/commands.ts" },
    startedAt: T0 + 5_000,
    endedAt: T0 + 8_000,
    resultSize: 6_000,
    resultRequestId: 43,
  });
  const start = [
    { kind: "task-prompt", sizeBytes: 2_000 },
    { kind: "preloaded-skill", name: "house-style", sizeBytes: 8_000 },
    { kind: "preloaded-skill", name: "release-notes", sizeBytes: 3_000 },
    { kind: "instructions", filePath: "CLAUDE.md", sizeBytes: 2_400 },
    { kind: "instructions", filePath: "src/CLAUDE.md", sizeBytes: 1_300 },
    { kind: "skill-listing", sizeBytes: 4_000, itemCount: 8 },
  ];
  start.forEach((load, index) => {
    seedLoad(db, {
      sessionId: SUBAGENT,
      occurredAt: T0 + 3_100 + index,
      source: "transcript",
      branchId,
      ...load,
    });
  });
}

function seedAllSessions(db: DatabaseSync): void {
  seedSnapshotSession(db);
  seedCompactedSession(db);
  seedRepliedSession(db);
  seedPastedImageSession(db);
  seedSubagentSession(db);
}

beforeAll(async () => {
  seeded = await startSeededBrowser(
    "flightpath-snapshot-lens-",
    seedAllSessions,
  );
  browser = seeded.browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

/** Open the session on the given page and switch to the
 * snapshot lens, waiting until the panel shows the given
 * measured line. With a step key, choose that step in the
 * steps lens first: the round trip the shared selection
 * promises. With none, no step is chosen anywhere, so the
 * lens shows the latest step. The session is the snapshot
 * session unless another is named. */
async function openSnapshot(
  page: Page,
  measured: string,
  stepKey?: string,
  session: string = SESSION,
): Promise<void> {
  await page.goto(
    seeded.base + "/#session/" + session + "&token=" + seeded.token,
  );
  await page.waitForSelector(".summary");
  if (stepKey !== undefined) {
    await page.waitForSelector(".trow");
    await page.locator(`[data-row-key="${stepKey}"]`).click();
  }
  await page.locator("#lens-tab-snapshot").click();
  await page.waitForSelector(".snapshot-lens");
  await expect
    .poll(() => page.locator("#lens-panel").textContent())
    .toContain(measured);
}

/** The session whose last turn ran no step, opened in the steps lens. */
async function openRepliedSession(width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(
    seeded.base + "/#session/" + REPLIED + "&token=" + seeded.token,
  );
  return page;
}

const THEME_AGAINST_SYSTEM = [
  { chosen: "light", system: "dark", width: 1440 },
  { chosen: "light", system: "dark", width: 390 },
  { chosen: "dark", system: "light", width: 1440 },
  { chosen: "dark", system: "light", width: 390 },
] as const;

describe("the snapshot lens", () => {
  it("shows the step chosen in the steps lens", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSnapshot(page, "of 55,000 measured", "step-1");
    await page
      .locator(".snapshot-group-head", { hasText: "Files read" })
      .click();
    const panel = await page.locator("#lens-panel").textContent();
    // Step 1's own ground truth: the file it read, at the
    // size its rise measured, and the step named at the top.
    expect(panel).toContain("/home/user/app/src/app.ts");
    expect(panel).toContain("34.7K tokensmeasured");
    expect(panel).toContain("What the agent had been given");
    expect(new URL(page.url()).hash).toContain("step=1");
    await expectAxeCleanOnPage(page);
    const shots = makeTempRoot("flightpath-snapshot-shots-");
    await page.locator(".snapshot-lens").screenshot({
      path: join(shots, "snapshot-step-1440.png"),
    });
    await page.close();
  }, 120_000);

  it("picks a step in the picker with the keyboard alone", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSnapshot(page, "of 73,000 measured");
    const expectActive = async (key: string): Promise<void> => {
      await page.waitForFunction(
        (wanted) =>
          document.activeElement?.getAttribute("data-row-key") === wanted,
        key,
      );
    };
    // Open the picker from its toggle and tab into the
    // list: the one tab stop sits on the shown step.
    await page.locator(".snapshot-picker-toggle").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".snapshot-picker-list");
    await page.keyboard.press("Tab");
    await expectActive("step-2");
    // The tree's keys walk the rows: up to step 1, and
    // Enter picks it — the panel shows step 1's snapshot
    // and the list folds away.
    await page.keyboard.press("ArrowUp");
    await expectActive("step-1");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.locator("#lens-panel").textContent())
      .toContain("of 55,000 measured");
    expect(await page.locator(".snapshot-picker-list").count()).toBe(0);
    await page.close();
  }, 120_000);

  it("shows the fixed load split and the compaction's restored items", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSnapshot(page, "After the compaction at", undefined, COMPACTED);
    const panel = await page.locator("#lens-panel").textContent();
    // The recorded shape splits the fixed load: the system
    // prompt, the largest tools with the rest behind the
    // button, the MCP server with its count, the file.
    expect(panel).toContain("Sent on every request");
    expect(panel).toContain("System prompt");
    expect(panel).toContain("Show all 7 tools");
    expect(panel).toContain("MCP · notes · 2 tools");
    expect(panel).toContain("CLAUDE.md");
    // The report taken after the compaction sizes the system
    // prompt and the skills listing; the subagent listing,
    // which it does not size, stays an estimate.
    const rows = await page
      .locator(".snapshot-fixed .snapshot-row")
      .allTextContents();
    const sizeOf = (name: string): string | undefined =>
      rows.find((row) => row.includes(name));
    expect(sizeOf("System prompt")).toContain("2.8K tokensfrom /context");
    expect(sizeOf("Skills listing")).toContain("8.3K tokensfrom /context");
    expect(sizeOf("Subagent types")).toContain("about 863 tokensest.");
    // Before the compaction: folded, with its count. The
    // read file and the skill stand restored, with the note.
    expect(panel).toContain("Before the compaction");
    expect(panel).toContain("restored by Claude Code (per its docs)");
    expect(panel).toContain("add-unit (skill)");
    expect(panel).toContain("How compaction works");
    // Both restored notes share their name's row box: the
    // re-read file's, beside its size, as the skill's does.
    // The rows measured are counted as they are checked: a
    // row missing its name or its note is passed over, so
    // without the count the check could pass having
    // measured none of them.
    const noteCheck = await page.evaluate(() => {
      const problems: string[] = [];
      let measured = 0;
      for (const row of document.querySelectorAll(".snapshot-restored-row")) {
        const name = row.querySelector(".snapshot-path");
        const note = row.querySelector(".snapshot-restored-note");
        if (name === null || note === null) continue;
        measured += 1;
        const nameBox = name.getBoundingClientRect();
        const noteBox = note.getBoundingClientRect();
        if (noteBox.top >= nameBox.bottom || noteBox.bottom <= nameBox.top) {
          problems.push(
            `a restored note leaves its name's line: ${name.textContent}`,
          );
        }
      }
      return { problems, measured };
    });
    expect(noteCheck.problems).toEqual([]);
    expect(noteCheck.measured).toBe(2);
    // The capture shows the before stretch opened: the
    // grouped list the fold was hiding.
    await page.locator(".snapshot-before .snapshot-group-head").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".snapshot-before .snapshot-group-title")
          .length > 1,
    );
    await expectAxeCleanOnPage(page);
    const shots = makeTempRoot("flightpath-snapshot-shots-");
    await page.locator(".snapshot-compaction").screenshot({
      path: join(shots, "snapshot-compaction-1440.png"),
    });
    await page.close();
  }, 120_000);

  it("reads the compaction cleanly at phone width, with a screenshot", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSnapshot(page, "After the compaction at", undefined, COMPACTED);
    const panel = await page.locator("#lens-panel").textContent();
    expect(panel).toContain("Sent on every request");
    expect(panel).toContain("Before the compaction");
    // Open the before stretch, so its group heads stand
    // under the same check as the step's own list.
    await page.locator(".snapshot-before .snapshot-group-head").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".snapshot-before .snapshot-group-title")
          .length > 1,
    );
    // At phone width the panel heads stack instead of
    // squeezing: every group title on the page stands on a
    // single line, and a restored row's note stands under
    // its name, so the name keeps the row's whole width
    // and none is cut. The count guards both seeded rows.
    const layoutCheck = await page.evaluate(() => {
      const problems: string[] = [];
      let restoredMeasured = 0;
      const linesOf = (el: Element): number => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      };
      const fixedTitle = document.querySelector(".snapshot-fixed h2");
      if (fixedTitle === null || linesOf(fixedTitle) !== 1) {
        problems.push("the fixed load's head title wraps");
      }
      for (const title of document.querySelectorAll(".snapshot-group-title")) {
        if (linesOf(title) !== 1) {
          problems.push(`a group title wraps: ${title.textContent}`);
        }
      }
      for (const row of document.querySelectorAll(".snapshot-restored-row")) {
        const name = row.querySelector(".snapshot-path");
        const note = row.querySelector(".snapshot-restored-note");
        if (name === null || note === null) continue;
        restoredMeasured += 1;
        if (name.scrollWidth > name.clientWidth + 1) {
          problems.push(`the restored name is cut: ${name.textContent}`);
        }
        const nameBox = name.getBoundingClientRect();
        const noteBox = note.getBoundingClientRect();
        if (noteBox.top < nameBox.bottom - 1) {
          problems.push(`the note stands beside the name: ${name.textContent}`);
        }
      }
      return { problems, restoredMeasured };
    });
    expect(layoutCheck.problems).toEqual([]);
    expect(layoutCheck.restoredMeasured).toBe(2);
    await expectAxeCleanOnPage(page);
    const shots = makeTempRoot("flightpath-snapshot-shots-");
    await page.locator(".snapshot-compaction").screenshot({
      path: join(shots, "snapshot-compaction-390.png"),
    });
    await page.close();
  }, 120_000);

  it("reads cleanly at phone width, axe-clean", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSnapshot(page, "of 55,000 measured", "step-1");
    const panel = await page.locator("#lens-panel").textContent();
    expect(panel).toContain("In context at this step");
    expect(panel).toContain("55K");
    await expectAxeCleanOnPage(page);
    const shots = makeTempRoot("flightpath-snapshot-shots-");
    await page.locator(".snapshot-lens").screenshot({
      path: join(shots, "snapshot-step-390.png"),
    });
    await page.close();
  }, 120_000);

  it("opens at the request after a compaction when no step followed it", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(
      seeded.base + "/#session/" + REPLIED + "&token=" + seeded.token,
    );
    await page.waitForSelector('[data-row-key="event-segment:29"]');
    await page.locator('[data-row-key="event-segment:29"]').click();
    await page.waitForSelector(".snapshot-lens");
    await expect
      .poll(() => page.locator(".snapshot-picker-name").textContent())
      .toBe("Turn 2 · Claude replied");
    const panel = await page.locator("#lens-panel").textContent();
    expect(panel).toContain("of 25,000 measured");
    expect(panel).toContain("Before the compaction");
    expect(panel).toContain("Restored after it");
    expect(panel).toContain("/home/user/app/src/app.ts");
    expect(new URL(page.url()).hash).toContain("/snapshot?request=23");
    // The address alone reopens the same place.
    await page.reload();
    await page.waitForSelector(".snapshot-lens");
    await expect
      .poll(() => page.locator(".snapshot-picker-name").textContent())
      .toBe("Turn 2 · Claude replied");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 120_000);

  it.each([
    { width: 1440, open: "click" },
    { width: 1440, open: "Enter" },
    { width: 390, open: "click" },
    { width: 390, open: "Enter" },
  ] as const)(
    "opens at a turn's request from the turn row that ran no step, by $open at $width px",
    async ({ width, open }) => {
      const page = await openRepliedSession(width);
      const row = page.locator('[data-row-key="turn-4"]');
      await row.waitFor();
      if (open === "click") {
        await row.click();
      } else {
        // The tree's keys act on its active row: End makes the
        // last row the keyboard can use, this turn's, active.
        await page.locator('[data-row-key][tabindex="0"]').focus();
        await page.keyboard.press("End");
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute("data-row-key") === "turn-4",
        );
        await page.keyboard.press("Enter");
      }
      await page.waitForSelector(".snapshot-lens");
      await expect
        .poll(() => page.locator(".snapshot-picker-name").textContent())
        .toBe("Turn 2 · Claude replied");
      expect(new URL(page.url()).hash).toContain("/snapshot?request=23");
      await page.close();
    },
    120_000,
  );

  it("gives the turn row that ran no step no fold state and no fold chevron", async () => {
    const page = await openRepliedSession(1440);
    const row = page.locator('[data-row-key="turn-4"]');
    await row.waitFor();
    expect(await row.getAttribute("aria-expanded")).toBeNull();
    expect(await row.locator(".trow-toggle svg").count()).toBe(0);
    const folding = page.locator('[data-row-key="turn-3"]');
    expect(await folding.getAttribute("aria-expanded")).toBe("true");
    expect(await folding.locator(".trow-toggle svg").count()).toBe(1);
    await page.close();
  }, 120_000);

  it("opens the snapshot from the left edge of the turn row that ran no step", async () => {
    const page = await openRepliedSession(1440);
    await page.locator('[data-row-key="turn-4"] .trow-toggle').click();
    await page.waitForSelector(".snapshot-lens");
    expect(new URL(page.url()).hash).toContain("/snapshot?request=23");
    await page.close();
  }, 120_000);

  it("still folds a turn that ran steps when its row is pressed", async () => {
    const page = await openRepliedSession(1440);
    await page.locator('[data-row-key="step-21"]').waitFor();
    await page.locator('[data-row-key="turn-3"]').click();
    await expect
      .poll(() => page.locator('[data-row-key="step-21"]').count())
      .toBe(0);
    expect(new URL(page.url()).hash).not.toMatch(/\/snapshot(\?|$)/);
    await page.close();
  }, 120_000);

  it("lists the turn that ran no step as its request in the picker", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSnapshot(page, "of 55,000 measured", "step-21", REPLIED);
    await page.locator(".snapshot-picker-toggle").click();
    const row = page.locator('.snapshot-picker-list [data-row-key="turn-4"]');
    await expect.poll(() => row.textContent()).toContain("Claude replied");
    await row.click();
    await expect
      .poll(() => page.locator(".snapshot-picker-name").textContent())
      .toBe("Turn 2 · Claude replied");
    expect(await page.locator(".snapshot-picker-list").count()).toBe(0);
    expect(new URL(page.url()).hash).toContain("request=23");
    await page.close();
  }, 120_000);

  it("keeps a tab stop in the picker when the shown step's turn folds", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSnapshot(page, "of 73,000 measured");
    await page.locator(".snapshot-picker-toggle").click();
    await page.waitForSelector(".snapshot-picker-list");
    // Fold the shown step's turn: its step rows leave the
    // list, and the tab stop falls to the turn row itself.
    await page.locator('[data-row-key="turn-1"]').click();
    expect(await page.locator('[data-row-key="step-2"]').count()).toBe(0);
    await page.locator(".snapshot-picker-toggle").focus();
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-row-key") === "turn-1",
    );
    await page.close();
  }, 120_000);

  it.each(THEME_AGAINST_SYSTEM)(
    "draws its buttons in $chosen on a $system computer at $width px",
    async ({ chosen, system, width }) => {
      const page = await newThemedPage(browser, chosen, {
        colorScheme: system,
        viewport: { width, height: 844 },
      });
      await openSnapshot(page, "After the compaction at", undefined, COMPACTED);
      const tokens = await resolvedTokens(page);
      const buttons = [
        page.getByRole("button", { name: "Pick another step" }),
        page.getByRole("button", { name: /^Show all \d+ tools$/ }),
      ];
      for (const button of buttons) {
        const drawn = await button.evaluate((element) => {
          const style = getComputedStyle(element);
          return { text: style.color, ground: style.backgroundColor };
        });
        expect(drawn).toEqual({
          text: tokens["--ink"],
          ground: tokens["--paper"],
        });
      }
      await expectAxeCleanOnPage(page);
      const shots = makeTempRoot("flightpath-snapshot-shots-");
      await page.locator(".snapshot-lens").screenshot({
        path: join(shots, `snapshot-${chosen}-on-${system}-${width}.png`),
      });
      if (width === 390) {
        // The lens shot stops above the restored group at
        // phone width, so the group gets a capture of its
        // own, in this theme. The phone layout the capture
        // shows is guarded by the compaction check above.
        const restored = page.locator(".snapshot-group", {
          has: page.locator(".snapshot-group-title", {
            hasText: "Restored after it",
          }),
        });
        await restored.scrollIntoViewIfNeeded();
        await restored.screenshot({
          path: join(shots, `snapshot-restored-${chosen}-on-${system}-390.png`),
        });
      }
      await page.close();
    },
    120_000,
  );

  it.each(THEME_AGAINST_SYSTEM)(
    "opens each term's note in $chosen on a $system computer at $width px",
    async ({ chosen, system, width }) => {
      const page = await newThemedPage(browser, chosen, {
        colorScheme: system,
        viewport: { width, height: 844 },
      });
      await openSnapshot(page, "of 55,000 measured", "step-1");
      const shots = makeTempRoot("flightpath-snapshot-shots-");
      const notes: [string, string][] = [
        [
          "What is Named?",
          "How much of the context Flightpath can put a name to. " +
            "The rest is listed as Other.",
        ],
        [
          "What is measured?",
          "This result arrived on its own, so its size is exact: " +
            "how much the context grew, minus Claude's reply.",
        ],
        [
          "What is Other?",
          "The part of the context Flightpath can't name, " +
            "mostly earlier conversation.",
        ],
        [
          "What is est.?",
          "Worked out from the number of characters, at about 2.9 " +
            "per token. Close, not exact.",
        ],
        [
          "What is sent on every request?",
          "What Claude Code sends with every request before any work: " +
            "its instructions, tool descriptions, CLAUDE.md and the " +
            "skills list.",
        ],
      ];
      for (const [name, text] of notes) {
        const button = page.getByRole("button", { name });
        await expect.poll(() => button.count()).toBe(1);
        const note = await openExplainNote(button);
        await expect.poll(() => note.textContent()).toBe(text);
        await page.locator(".snapshot-lens").screenshot({
          path: join(
            shots,
            `note-${name.replace(/[^a-z]+/gi, "-")}-${chosen}-${width}.png`,
          ),
        });
        await closeExplainNote(button);
      }
      await expectAxeCleanOnPage(page);
      await page.close();
    },
    240_000,
  );
});

describe("the snapshot lens in a session that ran no step", () => {
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])(
    "opens on the last reply and lists the pasted image at $width px",
    async (viewport) => {
      const page = await browser.newPage({ viewport });
      await page.goto(
        seeded.base + "/#session/" + PASTED + "&token=" + seeded.token,
      );
      await page.waitForSelector(".summary");
      await page.locator("#lens-tab-snapshot").click();
      await expect
        .poll(() => page.locator(".snapshot-picker-name").textContent())
        .toBe("Turn 1 · Claude replied");
      expect(await page.locator(".snapshot-picker-label").textContent()).toBe(
        "At request",
      );
      const group = page.locator(".snapshot-group", {
        has: page.locator(".snapshot-group-title", {
          hasText: "Images and files",
        }),
      });
      await expect.poll(() => group.count()).toBe(1);
      const head = group.locator(".snapshot-group-head");
      if ((await head.getAttribute("aria-expanded")) === "false") {
        await head.click();
      }
      await expect
        .poll(() => group.locator(".snapshot-row").allTextContents())
        .toEqual([expect.stringContaining("image/png")]);
      expect(await page.locator("#lens-panel").textContent()).not.toContain(
        "No steps recorded",
      );
      await expectAxeCleanOnPage(page);
      await page.close();
    },
    120_000,
  );
});

// Set to keep the screenshots; otherwise they go to a temporary folder.
const shotsDir =
  process.env["FLIGHTPATH_CAPTURES"] ??
  makeTempRoot("flightpath-snapshot-shots-");

describe("a subagent's Snapshot", () => {
  it.each(THEME_AGAINST_SYSTEM)(
    "names the subagent's start in $chosen on a $system computer at $width px",
    async ({ chosen, system, width }) => {
      const page = await newThemedPage(browser, chosen, {
        colorScheme: system,
        viewport: { width, height: 1300 },
      });
      await page.goto(
        seeded.base +
          "/#session/" +
          SUBAGENT +
          "/snapshot?step=42&token=" +
          seeded.token,
      );
      await page.waitForSelector(".snapshot-fixed");
      const rows = page.locator(".snapshot-fixed .snapshot-row");
      await expect
        .poll(() => rows.allTextContents())
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining("Skill loaded at start · house-style"),
            expect.stringContaining("Skill loaded at start · release-notes"),
            expect.stringContaining("Task from your conversation"),
            expect.stringContaining("CLAUDE.md"),
            expect.stringContaining("src/CLAUDE.md"),
            expect.stringContaining("Skills listing · 8 skills"),
          ]),
        );
      const overflow = await page.evaluate(() => ({
        page:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        lens: Math.max(
          ...[
            ...document.querySelectorAll(".snapshot-lens, .snapshot-fixed"),
          ].map((el) => el.scrollWidth - el.clientWidth),
        ),
      }));
      expect(overflow).toEqual({ page: 0, lens: 0 });
      await expectAxeCleanOnPage(page);
      await page.locator(".snapshot-lens").screenshot({
        path: join(
          shotsDir,
          `snapshot-subagent-${chosen}-on-${system}-${width}.png`,
        ),
      });
      await page.close();
    },
    120_000,
  );
});
