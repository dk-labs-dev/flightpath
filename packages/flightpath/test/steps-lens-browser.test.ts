import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseSync } from "../src/storage/sqlite.js";
import { writeBufferEvent } from "./support/buffer.js";
import { runCleanups } from "./support/cleanup.js";
import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser } from "./support/browser.js";
import { waitForConnection } from "./support/connection.js";
import { callDaemon } from "./support/daemon.js";
import {
  hookEvent,
  sequencedHookEnvelope,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";
import { requiredValue } from "./support/rows.js";
import {
  seedBranch,
  seedConditions,
  seedMoment,
  seedPause,
  seedRequest,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";
import { frameBudgetHolds, percentileOf } from "./support/time.js";

// The steps lens in a real browser, over a recorded session the
// read API describes: the tree, the curve, the filters, the
// detail panel, the phone sheet, and the cost of opening a
// 5,000-step session. Times sit just behind the clock: the
// daemon's retention pass would delete a session whose last
// activity is older than the kept-days setting.
const T0 = Date.now() - 900_000;
const SESSION = "lens-session";
const BIG = "lens-big";
const TICKS = "lens-ticks";
const AGENTS = "lens-agents";
const tickSteps: Record<string, number> = {};

let base: string;
let port: number;
let token: string;
let dataDir: string;
let browser: Browser;
let snapshot: {
  summary: { title: string; failures: number; steppedIn: number };
  turns: {
    id: number;
    steps: { id: number; sentence: string; outcome: string | null }[];
    humanMoments: { id: number; kind: string }[];
  }[];
  branches: { id: number; spawningStepId: number | null }[];
  sessionEvents: { id: number; kind: string }[];
};

function seedLensSession(db: DatabaseSync): void {
  seedSession(db, {
    id: SESSION,
    projectPath: "/home/user/tip-calc",
    firstSeenAt: T0,
    lastSeenAt: T0 + 900_000,
  });
  seedConditions(db, SESSION, {});
  seedSegment(db, { sessionId: SESSION, startedAt: T0, contextTokens: 9000 });
  const turn1 = seedTurn(db, {
    sessionId: SESSION,
    sequence: 1,
    startedAt: T0 + 10_000,
    endedAt: T0 + 200_000,
    promptText: "Build a tip calculator",
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: turn1,
    kind: "prompt",
    occurredAt: T0 + 10_000,
    detail: "Build a tip calculator",
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn1,
    toolName: "Bash",
    input: { command: "npm test" },
    outcome: "succeeded",
    startedAt: T0 + 20_000,
    durationMs: 400,
    resultSize: 900,
  });
  seedRequest(db, {
    sessionId: SESSION,
    turnId: turn1,
    startedAt: T0 + 19_000,
    durationMs: 900,
    inputTokens: 100,
    outputTokens: 50,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn1,
    toolName: "Read",
    input: { file_path: "/home/user/tip-calc/src/app.ts" },
    outcome: "succeeded",
    startedAt: T0 + 40_000,
    durationMs: 100,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn1,
    toolName: "Edit",
    input: {
      file_path: "/home/user/tip-calc/src/app.ts",
      old_string: "a",
      new_string: "b",
    },
    outcome: "failed",
    startedAt: T0 + 60_000,
    durationMs: 300,
  });
  const write = seedStep(db, {
    sessionId: SESSION,
    turnId: turn1,
    toolName: "Write",
    input: { file_path: "/home/user/tip-calc/src/tip.ts", content: "tip" },
    outcome: "succeeded",
    startedAt: T0 + 80_000,
    durationMs: 100,
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: turn1,
    stepId: write,
    kind: "permission_decision",
    occurredAt: T0 + 79_000,
    decision: "allow",
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn1,
    toolName: "Grep",
    input: { pattern: "tip" },
    outcome: "succeeded",
    startedAt: T0 + 100_000,
    durationMs: 100,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 20_000,
    contextTokens: 9000,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 60_000,
    contextTokens: 20000,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 100_000,
    contextTokens: 24000,
  });
  seedSegment(db, {
    sessionId: SESSION,
    kind: "compact",
    startedAt: T0 + 300_000,
    contextTokens: 9100,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 300_000,
    contextTokens: 9100,
  });
  const turn2 = seedTurn(db, {
    sessionId: SESSION,
    sequence: 2,
    startedAt: T0 + 400_000,
    endedAt: T0 + 800_000,
    promptText: "Add tests for the tip math",
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: turn2,
    kind: "prompt",
    occurredAt: T0 + 400_000,
    detail: "Add tests for the tip math",
  });
  const agent = seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    toolName: "Agent",
    input: { description: "review", subagent_type: "Explore", prompt: "look" },
    outcome: "succeeded",
    startedAt: T0 + 410_000,
    durationMs: 120_000,
  });
  const branch = seedBranch(db, {
    sessionId: SESSION,
    agentId: "agent-1",
    agentType: "Explore",
    spawningStepId: agent,
    startedAt: T0 + 415_000,
    endedAt: T0 + 520_000,
    totalTokens: 5400,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    branchId: branch,
    toolName: "Grep",
    input: { pattern: "total" },
    outcome: "succeeded",
    startedAt: T0 + 420_000,
    durationMs: 100,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    branchId: branch,
    toolName: "Read",
    input: { file_path: "/home/user/tip-calc/src/tip.ts" },
    outcome: "succeeded",
    startedAt: T0 + 430_000,
    durationMs: 100,
  });
  const ask = seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    toolName: "AskUserQuestion",
    input: { questions: [{ question: "Which file?" }] },
    outcome: "succeeded",
    startedAt: T0 + 600_000,
    durationMs: 100,
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: turn2,
    stepId: ask,
    kind: "question_answered",
    occurredAt: T0 + 605_000,
    detail: "Which file?",
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    toolName: "WebFetch",
    input: { url: "https://example.com/docs", prompt: "summarise" },
    outcome: "succeeded",
    startedAt: T0 + 650_000,
    durationMs: 100,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    toolName: "mcp__github__create_issue",
    input: { title: "Tip rounding" },
    outcome: "succeeded",
    startedAt: T0 + 700_000,
    durationMs: 100,
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn2,
    toolName: "Skill",
    input: { skill: "commit" },
    outcome: "succeeded",
    startedAt: T0 + 750_000,
    durationMs: 100,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 500_000,
    contextTokens: 15000,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 800_000,
    contextTokens: 20000,
  });
  seedPause(db, {
    sessionId: SESSION,
    pausedAt: T0 + 850_000,
    resumedAt: T0 + 880_000,
  });
}

function seedTicksSession(db: DatabaseSync): void {
  seedSession(db, {
    id: TICKS,
    projectPath: "/home/user/ticks",
    firstSeenAt: T0,
    lastSeenAt: T0 + 900_000,
  });
  seedConditions(db, TICKS, {});
  seedSegment(db, { sessionId: TICKS, startedAt: T0, contextTokens: 9000 });
  const turn = seedTurn(db, {
    sessionId: TICKS,
    sequence: 1,
    startedAt: T0,
    endedAt: T0 + 900_000,
    promptText: "Watch the ticks",
  });
  seedMoment(db, {
    sessionId: TICKS,
    turnId: turn,
    kind: "prompt",
    occurredAt: T0,
    detail: "Watch the ticks",
  });
  const failedAt = (name: string, at: number): void => {
    tickSteps[name] = seedStep(db, {
      sessionId: TICKS,
      turnId: turn,
      toolName: "Edit",
      input: { file_path: `/home/user/ticks/${name}.ts` },
      outcome: "failed",
      startedAt: at,
      durationMs: 100,
    });
  };
  failedAt("first", T0 + 2_000);
  failedAt("clusterA", T0 + 450_000);
  failedAt("clusterB", T0 + 454_000);
  failedAt("clusterC", T0 + 458_000);
  failedAt("last", T0 + 898_000);
  tickSteps["running"] = seedStep(db, {
    sessionId: TICKS,
    turnId: turn,
    toolName: "Bash",
    input: { command: "npm run dev" },
    outcome: "open",
    startedAt: T0 + 700_000,
  });
  const plainAt = (name: string, at: number): void => {
    tickSteps[name] = seedStep(db, {
      sessionId: TICKS,
      turnId: turn,
      toolName: "Read",
      input: { file_path: `/home/user/ticks/${name}.ts` },
      outcome: "succeeded",
      startedAt: at,
      durationMs: 100,
    });
  };
  // A human moment with a step on each side of it and neither
  // at its own moment: the step nearest the moment is the one
  // before it, so a click just past the moment's tick picks a
  // different step unless the tick itself is the target.
  plainAt("nearHuman", T0 + 240_000);
  plainAt("pastHuman", T0 + 262_000);
  seedMoment(db, {
    sessionId: TICKS,
    turnId: turn,
    kind: "permission_decision",
    occurredAt: T0 + 250_000,
    decision: "allow",
  });
  // A compaction whose nearest step started just before the
  // drop and whose next step started further past it: same
  // shape as the moment, on the line's own tick.
  plainAt("beforeCompact", T0 + 392_000);
  plainAt("afterCompact", T0 + 404_000);
  // A step between the clustered failure ticks, nearer in
  // time to a click between them than either tick's own step.
  plainAt("between", T0 + 453_000);
  seedSample(db, {
    sessionId: TICKS,
    sampledAt: T0,
    contextTokens: 9000,
  });
  seedSample(db, {
    sessionId: TICKS,
    sampledAt: T0 + 390_000,
    contextTokens: 20000,
  });
  seedSample(db, {
    sessionId: TICKS,
    sampledAt: T0 + 395_000,
    contextTokens: 5000,
  });
  seedSample(db, {
    sessionId: TICKS,
    sampledAt: T0 + 900_000,
    contextTokens: 20000,
  });
  // The drop the samples show is this compaction, recorded as
  // a segment of its own where it landed: the strip's tick
  // stands at the recording, not at the fall.
  seedSegment(db, {
    sessionId: TICKS,
    kind: "compact",
    startedAt: T0 + 395_000,
    contextTokens: 5000,
  });
}

function seedAgentsSession(db: DatabaseSync): void {
  seedSession(db, {
    id: AGENTS,
    projectPath: "/home/user/agents",
    firstSeenAt: T0,
    lastSeenAt: T0 + 900_000,
  });
  seedConditions(db, AGENTS, {});
  const turn = seedTurn(db, {
    sessionId: AGENTS,
    sequence: 1,
    startedAt: T0 + 10_000,
    endedAt: T0 + 800_000,
    promptText: "Delegate the review",
  });
  seedMoment(db, {
    sessionId: AGENTS,
    turnId: turn,
    kind: "prompt",
    occurredAt: T0 + 10_000,
    detail: "Delegate the review",
  });
  const agent = seedStep(db, {
    sessionId: AGENTS,
    turnId: turn,
    toolName: "Agent",
    input: { description: "review", subagent_type: "Explore", prompt: "look" },
    outcome: "succeeded",
    startedAt: T0 + 20_000,
    durationMs: 100_000,
  });
  seedBranch(db, {
    sessionId: AGENTS,
    agentId: "agent-1",
    agentType: "Explore",
    spawningStepId: agent,
    startedAt: T0 + 25_000,
    endedAt: T0 + 120_000,
    totalTokens: 5400,
  });
  seedBranch(db, {
    sessionId: AGENTS,
    agentId: null,
    agentType: null,
    kind: "internal",
    startedAt: T0 + 30_000,
    endedAt: T0 + 60_000,
    totalTokens: 900,
  });
  seedBranch(db, {
    sessionId: AGENTS,
    agentId: null,
    agentType: null,
    kind: "internal",
    startedAt: T0 + 200_000,
    endedAt: T0 + 260_000,
    totalTokens: 700,
  });
}

function seedBigSession(db: DatabaseSync): void {
  seedSession(db, {
    id: BIG,
    projectPath: "/home/user/big",
    firstSeenAt: T0,
    lastSeenAt: T0 + 5_000_000,
  });
  seedConditions(db, BIG, {});
  db.exec("BEGIN");
  try {
    for (let turnIndex = 0; turnIndex < 500; turnIndex += 1) {
      const start = T0 + turnIndex * 10_000;
      const turn = seedTurn(db, {
        sessionId: BIG,
        sequence: turnIndex + 1,
        startedAt: start,
        endedAt: start + 9_000,
        promptText: `Turn ${turnIndex + 1}`,
      });
      for (let stepIndex = 0; stepIndex < 10; stepIndex += 1) {
        seedStep(db, {
          sessionId: BIG,
          turnId: turn,
          toolName: ["Bash", "Read", "Edit"][stepIndex % 3] ?? "Bash",
          input: { command: `step ${stepIndex}` },
          outcome: "succeeded",
          startedAt: start + stepIndex * 800,
          durationMs: 100,
        });
      }
      if (turnIndex % 10 === 0) {
        seedSample(db, {
          sessionId: BIG,
          sampledAt: start,
          contextTokens: 9000 + turnIndex * 100,
        });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  const started = await startSeededBrowser("flightpath-steps-lens-", (db) => {
    seedLensSession(db);
    seedTicksSession(db);
    seedAgentsSession(db);
    seedBigSession(db);
  });
  dataDir = started.dataDir;
  port = started.port;
  token = started.token;
  base = started.base;
  browser = started.browser;
  const response = await fetch(`${base}/api/sessions/${SESSION}/snapshot`, {
    headers: { "x-flightpath-token": token },
  });
  snapshot = (await response.json()) as typeof snapshot;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${base}/#session/${id}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector(".trow");
}

async function collectRowKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const scroller = document.querySelector(".tree-scroll");
    if (scroller === null) return [];
    const keys = new Set<string>();
    const collect = (): void => {
      for (const row of document.querySelectorAll("[data-row-key]")) {
        const key = row.getAttribute("data-row-key");
        if (key !== null) keys.add(key);
      }
    };
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 30));
    collect();
    const height = scroller.scrollHeight;
    for (let top = 0; top <= height; top += 300) {
      scroller.scrollTop = top;
      await new Promise((r) => setTimeout(r, 30));
      collect();
    }
    scroller.scrollTop = 0;
    return [...keys];
  });
}

/** A page at the desktop size, opened on a session. */
async function openLensPage(id: string): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await openSession(page, id);
  return page;
}

/** The lens session's human moment row key: its one moment that is not the prompt. */
function humanRowKey(): string {
  const human = snapshot.turns[0]?.humanMoments.find(
    (moment) => moment.kind !== "prompt",
  );
  return `human-${requiredValue(human, "a human moment").id}`;
}

async function widthOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((wanted) => {
    const element = document.querySelector(wanted);
    return element instanceof HTMLElement ? element.offsetWidth : 0;
  }, selector);
}

async function scrollToKey(page: Page, key: string): Promise<void> {
  const found = await page.evaluate(async (wanted) => {
    const scroller = document.querySelector(".tree-scroll");
    if (scroller === null) return false;
    for (let top = 0; top <= scroller.scrollHeight; top += 300) {
      scroller.scrollTop = top;
      await new Promise((r) => setTimeout(r, 30));
      if (document.querySelector(`[data-row-key="${wanted}"]`) !== null) {
        return true;
      }
    }
    return false;
  }, key);
  expect(found).toBe(true);
}

describe("the steps lens in a browser", () => {
  it("renders every row the snapshot describes", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    const expected = new Set<string>();
    for (const turn of snapshot.turns) {
      expected.add(`turn-${turn.id}`);
      for (const step of turn.steps) expected.add(`step-${step.id}`);
      for (const human of turn.humanMoments) {
        if (human.kind !== "prompt") expected.add(`human-${human.id}`);
      }
    }
    // A subagent's row stands for the step that started it, so
    // only a branch with no such step has a key of its own.
    for (const branch of snapshot.branches) {
      if (branch.spawningStepId === null) expected.add(`branch-${branch.id}`);
    }
    for (const event of snapshot.sessionEvents) {
      expected.add(`event-${event.kind}:${event.id}`);
    }
    const keys = await collectRowKeys(page);
    expect(new Set(keys)).toEqual(expected);
    expect(await page.locator(".summary-title").textContent()).toBe(
      snapshot.summary.title,
    );
    await page.close();
  }, 60_000);

  it("spaces a meta line's parts apart in the layout, not in the text", async () => {
    const page = await openLensPage(SESSION);
    // Both joins of a meta line's first unit, measured on the
    // rendered boxes: part to separator, and separator to the
    // next part. textContent keeps spaces the screen collapses,
    // so only the layout can prove them. Each join is measured
    // on its own: the separator's width alone would fill an
    // end-to-end gap.
    const joins = await page.evaluate(() => {
      for (const meta of document.querySelectorAll(".trow-meta")) {
        const unit = meta.querySelector(".trow-meta-unit");
        const part = unit?.querySelector(".trow-meta-part");
        const sep = unit?.querySelector(".trow-meta-sep");
        const next = meta.querySelectorAll(".trow-meta-part")[1];
        if (!part || !sep || !next) continue;
        const partBox = part.getBoundingClientRect();
        const sepBox = sep.getBoundingClientRect();
        const nextBox = next.getBoundingClientRect();
        return {
          partToSep: sepBox.left - partBox.right,
          sepToNext: nextBox.left - sepBox.right,
        };
      }
      return null;
    });
    expect(joins).not.toBeNull();
    expect(joins?.partToSep ?? 0).toBeGreaterThan(0);
    expect(joins?.sepToNext ?? 0).toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it("opens a step's detail from the tree", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    const failed = snapshot.turns[0]?.steps.find((s) => s.outcome === "failed");
    const failedStep = requiredValue(failed, "the failed step");
    await scrollToKey(page, `step-${failedStep.id}`);
    await page.locator(`[data-row-key="step-${failedStep.id}"]`).click();
    await page.waitForSelector(".detail .detail-title");
    expect(await page.locator(".detail-title").textContent()).toBe(
      failedStep.sentence,
    );
    await expect
      .poll(async () => page.locator(".detail").textContent(), {
        timeout: 10_000,
      })
      .toContain("File contents and tool output stay in Claude Code");
    await page.close();
  }, 60_000);

  it("walks the tree by keyboard and collapses with the arrow keys", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    const turnKey = `turn-${snapshot.turns[0]?.id}`;
    const firstStepKey = `step-${snapshot.turns[0]?.steps[0]?.id}`;
    const expectActive = async (key: string): Promise<void> => {
      await page.waitForFunction(
        (wanted) =>
          document.activeElement?.getAttribute("data-row-key") === wanted,
        key,
      );
    };
    // The first row is the session's opening event; clicking it
    // gives the tree keyboard focus without toggling anything.
    const firstRow = page.locator(".trow").first();
    const firstRowKey = requiredValue(
      await firstRow.getAttribute("data-row-key"),
      "the first row's key",
    );
    await firstRow.click();
    await expectActive(firstRowKey);
    await page.keyboard.press("ArrowDown");
    await expectActive(turnKey);
    await page.keyboard.press("ArrowDown");
    await expectActive(firstStepKey);
    await page.keyboard.press("ArrowUp");
    await expectActive(turnKey);
    await page.keyboard.press("ArrowLeft");
    const turn = page.locator(`[data-row-key="${turnKey}"]`);
    expect(await turn.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(`[data-row-key="${firstStepKey}"]`).count()).toBe(
      0,
    );
    await page.keyboard.press("ArrowRight");
    expect(await turn.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("End");
    await page.waitForFunction((first) => {
      const key = document.activeElement?.getAttribute("data-row-key");
      return key !== null && key !== first;
    }, turnKey);
    // Enter on a step opens its detail. Home lands on the
    // first row the keyboard can use — the opening event
    // opens nothing, and step navigation passes over it.
    await page.keyboard.press("Home");
    await expectActive(turnKey);
    await page.keyboard.press("ArrowDown");
    await expectActive(firstStepKey);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".detail .detail-title");
    await page.close();
  }, 60_000);

  it("selects a step from the curve and steps through with arrows", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    expect(await page.locator(".curve svg title").count()).toBeGreaterThan(0);
    const box = requiredValue(
      await page.locator(".curve svg").boundingBox(),
      "the curve's bounding box",
    );
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForSelector('.trow[aria-selected="true"]');
    expect(await page.locator(".curve").textContent()).toContain(
      "selected step:",
    );
    await page.locator(".curve svg").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('.trow[aria-selected="true"]');
    await page.close();
  }, 60_000);

  it("filters to failures and to the moments the person stepped in", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    await page
      .getByRole("button", { name: `Failures · ${snapshot.summary.failures}` })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".trow").length === 2,
    );
    const failed = snapshot.turns[0]?.steps.find((s) => s.outcome === "failed");
    expect(
      await page.locator(`[data-row-key="step-${failed?.id}"]`).count(),
    ).toBe(1);
    await page
      .getByRole("button", { name: `Failures · ${snapshot.summary.failures}` })
      .click();
    await page
      .getByRole("button", {
        name: `You stepped in · ${snapshot.summary.steppedIn}`,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".trow").length === 4,
    );
    await page.close();
  }, 60_000);

  it("focuses the search with / and narrows the tree", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    await page.locator(".trow").first().click();
    await page.keyboard.press("/");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      "step-search",
    );
    await page.keyboard.type("npm");
    await page.waitForFunction(
      () => document.querySelectorAll(".trow").length === 2,
    );
    await page.close();
  }, 60_000);

  it("restores its place across a reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    const turn1 = snapshot.turns[0];
    const deep = snapshot.turns[1]?.steps.at(-1);
    const deepStep = requiredValue(deep, "the last step");
    await page.locator(`[data-row-key="turn-${turn1?.id}"]`).click();
    await scrollToKey(page, `step-${deepStep.id}`);
    await page.locator(`[data-row-key="step-${deepStep.id}"]`).click();
    await page.waitForSelector(".detail .detail-title");
    await page.waitForTimeout(1_200);
    await page.reload();
    await page.waitForSelector(".summary");
    const turnRow = page.locator(`[data-row-key="turn-${turn1?.id}"]`);
    expect(await turnRow.getAttribute("aria-expanded")).toBe("false");
    await scrollToKey(page, `step-${deepStep.id}`);
    const selected = page.locator(`[data-row-key="step-${deepStep.id}"]`);
    expect(await selected.getAttribute("aria-selected")).toBe("true");
    await page.close();
  }, 60_000);

  it("restores a saved empty collapse list as every turn open", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, BIG);
    // A long session's first visit opens with every turn but
    // the last collapsed: at the top of the tree there are
    // turn rows and no step rows.
    await expect.poll(async () => page.locator(".trow-step").count()).toBe(0);
    // The saved place says no turn was collapsed. A reload
    // must restore it as it stands — the first turn's steps
    // show at the top — not fall back to the default.
    await page.evaluate((sessionId) => {
      sessionStorage.setItem(
        `flightpath-view:${sessionId}`,
        JSON.stringify({
          selectedStepId: null,
          collapsedTurnIds: [],
          scrollTop: 0,
        }),
      );
    }, BIG);
    await page.reload();
    await page.waitForSelector(".summary");
    await expect
      .poll(async () => page.locator(".trow-step").count())
      .toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it("retries a failed load and says it is retrying", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    let failed = false;
    await page.route("**/api/sessions/*/snapshot", async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: "{}",
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${base}/#session/${SESSION}&token=${token}`);
    await expect
      .poll(async () => page.locator(".session-screen").innerText())
      .toContain("Retrying…");
    await page.waitForSelector(".summary", { timeout: 15_000 });
    await page.close();
  }, 60_000);

  it("is clean to a screen reader's checks at desktop and phone widths", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    await expectAxeCleanOnPage(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForSelector(".summary");
    await page.waitForSelector(".trow");
    await expectAxeCleanOnPage(page);
    await page.close();
  }, 60_000);

  it("opens the detail as a sheet on a phone and returns focus", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page, SESSION);
    const step = requiredValue(snapshot.turns[0]?.steps[0], "the first step");
    await scrollToKey(page, `step-${step.id}`);
    const row = page.locator(`[data-row-key="step-${step.id}"]`);
    await row.click();
    await page.waitForSelector(".detail .detail-title");
    expect(
      await page.evaluate(() => document.activeElement?.className),
    ).toContain("detail-close");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".detail-empty", { state: "attached" });
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-row-key"),
      ),
    ).toBe(`step-${step.id}`);
    await page.close();
  }, 60_000);

  it("opens a 5,000-step session inside the budget", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    // Both bounds in this test are the product's budgets.
    const started = Date.now();
    await openSession(page, BIG);
    const openMs = Date.now() - started;
    console.log(`steps lens: 5,000-step session opened in ${openMs} ms`);
    expect(openMs).toBeLessThan(1_500);
    const frames = await page.evaluate(async () => {
      const scroller = document.querySelector(".tree-scroll");
      if (scroller === null) return null;
      const deltas: number[] = [];
      let last = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          scroller.scrollTop += 240;
          if (scroller.scrollTop < scroller.scrollHeight - 1_000) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
      return deltas;
    });
    if (frames === null) {
      throw new Error("the steps tree's scroller never appeared");
    }
    const p95 = percentileOf(frames, 0.95);
    console.log(
      `steps lens: scroll frames p95 ${p95.toFixed(1)} ms over ${frames.length} frames`,
    );
    if (frameBudgetHolds) expect(p95).toBeLessThan(50);
    await page.close();
  }, 120_000);

  it("shows the dropped-events banner on a session screen", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    await expect
      .poll(async () => page.locator(".health-dropped").count())
      .toBe(0);
    // The trouble the hook leaves behind: the dropped count,
    // plus buffered events rewritten on a short loop — a
    // drain pass that finds files re-sends the health, and
    // only a pass that leaves the buffer empty resets the
    // counter, so the seeding has to outpace the drains
    // until the page shows it. The banner's health reaches a
    // session screen through the shell's one stream, like
    // any other route's.
    const droppedFile = join(dataDir, "buffer-dropped");
    let held = 0;
    const keepSeeded = (): void => {
      held += 1;
      writeFileSync(droppedFile, "4\n");
      writeBufferEvent(dataDir, Date.now() * 100 + held, `held-${held}`);
    };
    keepSeeded();
    const seeding = setInterval(keepSeeded, 25);
    try {
      await expect
        .poll(async () => page.locator(".health-dropped").textContent(), {
          timeout: 15_000,
        })
        .toContain("events dropped");
    } finally {
      clearInterval(seeding);
      rmSync(droppedFile, { force: true });
      rmSync(join(dataDir, "buffer"), { recursive: true, force: true });
    }
    await page.close();
  }, 60_000);

  it("opens and closes the '?' explanations with a tap at phone width", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await openSession(page, SESSION);
    const question = page.getByRole("button", {
      name: "What is context?",
    });
    await question.click();
    await expect
      .poll(async () => page.locator(".explain-note").textContent())
      .toContain("Everything Claude is holding in mind");
    await question.click();
    await expect
      .poll(async () => page.locator(".explain-note").count())
      .toBe(0);
    await page.close();
  }, 60_000);
});

/** Record one hook event with the daemon the suite is serving. */
async function postHook(event: Record<string, unknown>): Promise<void> {
  const reply = await callDaemon(port, {
    method: "POST",
    path: "/events/hook",
    token,
    headers: { "content-type": "application/json" },
    body: sequencedHookEnvelope("lens", event),
  });
  expect(reply.status).toBe(204);
}

describe("the steps lens, live", () => {
  const LIVE = "lens-live";

  it("puts a step on screen within a second of its being recorded", async () => {
    await postHook(sessionStartEvent("startup", LIVE));
    await postHook(userPromptEvent(LIVE, "watch the live steps"));
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(`${base}/#session/${LIVE}&token=${token}`);
    await page.waitForSelector(".summary");
    // The page's stream is live before anything is recorded,
    // so the step's arrival is the stream's work, not a load.
    await waitForConnection(page, "Live");
    const marker = "lens-live-marker";
    await postHook(
      hookEvent("PreToolUse", {
        session_id: LIVE,
        tool_name: "Bash",
        tool_use_id: "live-1",
        tool_input: { command: `echo ${marker}` },
      }),
    );
    const sentAt = Date.now();
    await postHook(
      hookEvent("PostToolUse", {
        session_id: LIVE,
        tool_name: "Bash",
        tool_use_id: "live-1",
        tool_response: { ok: true },
      }),
    );
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll(".trow")].some((row) =>
          row.textContent?.includes(text),
        ),
      marker,
      { timeout: 10_000 },
    );
    expect(Date.now() - sentAt).toBeLessThan(1_000);
    await page.close();
  }, 60_000);

  it("restores the selection and the scroll position across a reload", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, SESSION);
    const deep = requiredValue(
      snapshot.turns[1]?.steps.at(-1),
      "the last step",
    );
    await scrollToKey(page, `step-${deep.id}`);
    await page.locator(`[data-row-key="step-${deep.id}"]`).click();
    await page.waitForSelector(".detail .detail-title");
    // The saved place is what a reload reads: poll for the
    // save itself rather than giving it a fixed amount of time.
    await page.waitForFunction((id) => {
      const raw = sessionStorage.getItem(`flightpath-view:${id}`);
      if (raw === null) return false;
      const saved = JSON.parse(raw) as {
        selectedStepId: number | null;
        scrollTop: number;
      };
      return saved.selectedStepId !== null && saved.scrollTop > 0;
    }, SESSION);
    const saved = await page.evaluate((id) => {
      const raw = sessionStorage.getItem(`flightpath-view:${id}`);
      return raw === null
        ? null
        : (JSON.parse(raw) as { selectedStepId: number; scrollTop: number });
    }, SESSION);
    const place = requiredValue(saved, "the saved place");
    expect(place.selectedStepId).toBe(deep.id);
    await page.reload();
    await page.waitForSelector(".summary");
    try {
      await page.waitForFunction(
        (wanted: { id: number; top: number }) => {
          const row = document.querySelector(
            `[data-row-key="step-${wanted.id}"]`,
          );
          const scroller = document.querySelector(".tree-scroll");
          if (row === null || scroller === null) return false;
          return (
            row.getAttribute("aria-selected") === "true" &&
            Math.abs(scroller.scrollTop - wanted.top) <= 4
          );
        },
        { id: deep.id, top: place.scrollTop },
        { timeout: 15_000 },
      );
    } catch (error) {
      // The place the page actually came back to is the first
      // clue: the saved value, where the scroll sits, and
      // whether the selected row is on screen at all.
      const state = await page.evaluate((id) => {
        const scroller = document.querySelector(".tree-scroll");
        const row = document.querySelector(`[data-row-key="step-${id}"]`);
        return {
          saved: sessionStorage.getItem(`flightpath-view:${id}`),
          scrollTop: scroller?.scrollTop ?? null,
          scrollHeight: scroller?.scrollHeight ?? null,
          rowRendered: row !== null,
          ariaSelected: row?.getAttribute("aria-selected") ?? null,
        };
      }, SESSION);
      console.log(
        `after reload, wanted scroll ${place.scrollTop}: ${JSON.stringify(state)}`,
      );
      throw error;
    }
    await page.close();
  }, 60_000);

  it("follows a new step into view, and stops after the person scrolls up", async () => {
    const FOLLOW = "lens-follow";
    await postHook(sessionStartEvent("startup", FOLLOW));
    await postHook(userPromptEvent(FOLLOW, "follow the newest step"));
    // Enough steps to overflow the tree at this viewport, so
    // following is a scroll and not a fit.
    for (let index = 1; index <= 24; index += 1) {
      await postStep(FOLLOW, `follow-${index}`, `step-${index}`);
    }
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, FOLLOW);
    await waitForConnection(page, "Live");
    const gapToBottom = async (): Promise<number> =>
      page.evaluate(() => {
        const scroller = document.querySelector(".tree-scroll");
        if (scroller === null) return -1;
        return (
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        );
      });
    // A step arrives with Follow live on: it scrolls into
    // view, and the view sits at the newest row.
    await postStep(FOLLOW, "follow-25", "step-25");
    await expect
      .poll(
        async () =>
          page
            .locator(".trow", { hasText: "step-25" })
            .first()
            .isVisible()
            .catch(() => false),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect.poll(gapToBottom, { timeout: 10_000 }).toBeLessThan(120);
    // The person scrolls up: the next step lands — the tree
    // grows by a row — but the view stays where it was left.
    const heightBefore = await page.evaluate(() => {
      const inner = document.querySelector(".tree-inner");
      return inner instanceof HTMLElement ? inner.offsetHeight : 0;
    });
    await page.evaluate(() => {
      const scroller = document.querySelector(".tree-scroll");
      if (scroller !== null) scroller.scrollTop = 0;
    });
    await postStep(FOLLOW, "follow-26", "step-26");
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const inner = document.querySelector(".tree-inner");
            return inner instanceof HTMLElement ? inner.offsetHeight : 0;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(heightBefore);
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector(".tree-scroll")?.scrollTop ?? -1,
          ),
        { timeout: 10_000 },
      )
      .toBeLessThan(120);
    await page.close();
  }, 120_000);

  it("shows 'Waiting for you' when the session waits on the person", async () => {
    const WAITING = "lens-waiting";
    await postHook(sessionStartEvent("startup", WAITING));
    await postHook(userPromptEvent(WAITING, "a question for the person"));
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, WAITING);
    await waitForConnection(page, "Live");
    // Nothing waits yet, and the last step is fresh: no line.
    await expect
      .poll(async () => page.locator(".trow-waiting").count())
      .toBe(0);
    await postHook(
      hookEvent("Notification", {
        session_id: WAITING,
        notification_type: "permission_prompt",
        message: "Claude needs your permission to run a command",
      }),
    );
    await expect
      .poll(async () => page.locator(".trow-waiting").textContent(), {
        timeout: 10_000,
      })
      .toContain("Waiting for you");
    await page.close();
  }, 60_000);

  it("updates the failure count when a failure arrives on the stream", async () => {
    const COUNTS = "lens-counts";
    await postHook(sessionStartEvent("startup", COUNTS));
    await postHook(userPromptEvent(COUNTS, "count the failures"));
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSession(page, COUNTS);
    await waitForConnection(page, "Live");
    const failures = page.getByRole("button", { name: /Failures/ });
    await expect
      .poll(async () => failures.textContent(), { timeout: 10_000 })
      .toContain("Failures · 0");
    await postHook(
      hookEvent("PreToolUse", {
        session_id: COUNTS,
        tool_name: "Bash",
        tool_use_id: "counts-1",
        tool_input: { command: "make it fail" },
      }),
    );
    await postHook(
      hookEvent("PostToolUseFailure", {
        session_id: COUNTS,
        tool_name: "Bash",
        tool_use_id: "counts-1",
        tool_response: { ok: false },
      }),
    );
    await expect
      .poll(async () => failures.textContent(), { timeout: 10_000 })
      .toContain("Failures · 1");
    await page.close();
  }, 60_000);
});

/** Record one step the way the hook reports it: a tool
 * opens, then its result lands. */
async function postStep(
  sessionId: string,
  toolUseId: string,
  marker: string,
): Promise<void> {
  await postHook(
    hookEvent("PreToolUse", {
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: `echo ${marker}` },
    }),
  );
  await postHook(
    hookEvent("PostToolUse", {
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_response: { ok: true },
    }),
  );
}

async function resizerCenter(page: Page): Promise<{ x: number; y: number }> {
  const grip = await page.locator(".panel-resizer").boundingBox();
  if (grip === null) throw new Error("the resizer has no box");
  return { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
}

/** Drags the panel resizer's grip to `toX`, in one mouse run. */
async function dragResizerTo(page: Page, toX: number): Promise<void> {
  const start = await resizerCenter(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(toX, start.y, { steps: 8 });
  await page.mouse.up();
}

describe("the steps lens clarity fixes", () => {
  it("selects the tick's step from clicks near a tick, not only on it", async () => {
    const page = await openLensPage(TICKS);
    const box = await page.locator(".curve-svg").boundingBox();
    if (box === null) throw new Error("the curve has no box");
    // Each click lands about 10 px off its tick — or, for the
    // cluster's middle, between two ticks — where the step
    // nearest in time is a different one, so the click only
    // lands right if the tick within reach is the target.
    // The cluster's outer ticks are clicked from outside the
    // cluster, away from their neighbours: each must still
    // pick its own step, not the middle one's.
    const targets: { at: number; offsetPx: number; name: string }[] = [
      { at: T0 + 2_000, offsetPx: 10, name: "first" },
      { at: T0 + 250_000, offsetPx: 10, name: "nearHuman" },
      { at: T0 + 395_000, offsetPx: 10, name: "beforeCompact" },
      { at: T0 + 450_000, offsetPx: -10, name: "clusterA" },
      { at: T0 + 452_500, offsetPx: 0, name: "clusterB" },
      { at: T0 + 458_000, offsetPx: 10, name: "clusterC" },
      { at: T0 + 898_000, offsetPx: -10, name: "last" },
    ];
    for (const target of targets) {
      const fraction = (target.at - T0) / 900_000;
      await page.mouse.click(
        box.x + fraction * box.width + target.offsetPx,
        box.y + box.height / 2,
      );
      const key = `step-${tickSteps[target.name]}`;
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              document
                .querySelector(".trow-selected")
                ?.getAttribute("data-row-key") ?? null,
          ),
        )
        .toBe(key);
    }
    await page.close();
  }, 60_000);

  it("shows the running step's plane in motion, steady under reduced motion", async () => {
    const page = await openLensPage(TICKS);
    const running = page.locator(
      `[data-row-key="step-${tickSteps["running"]}"]`,
    );
    await scrollToKey(page, `step-${tickSteps["running"]}`);
    const animation = async (): Promise<string> =>
      running.evaluate((row) => {
        const svg = row.querySelector(".trow-tile svg");
        return svg === null ? "" : getComputedStyle(svg).animationName;
      });
    await expect.poll(animation).not.toBe("none");
    expect(await running.textContent()).toContain("Running");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(animation).toBe("none");
    await page.close();
  }, 60_000);

  it("gives the turn's toggle a 24px target that Enter and Space work", async () => {
    const page = await openLensPage(SESSION);
    const turn = page.locator(".trow-turn").first();
    const toggleBox = await turn.locator(".trow-toggle").boundingBox();
    if (toggleBox === null) throw new Error("the toggle has no box");
    expect(toggleBox.width).toBeGreaterThanOrEqual(24);
    expect(toggleBox.height).toBeGreaterThanOrEqual(24);
    expect(await turn.getAttribute("aria-expanded")).toBe("true");
    // Clicking the row makes it the tree's active row; from
    // there Enter and Space toggle it, and aria-expanded follows.
    await turn.click();
    await expect
      .poll(async () => turn.getAttribute("aria-expanded"))
      .toBe("false");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => turn.getAttribute("aria-expanded"))
      .toBe("true");
    await page.keyboard.press(" ");
    await expect
      .poll(async () => turn.getAttribute("aria-expanded"))
      .toBe("false");
    await page.close();
  }, 60_000);

  it("marks which rows open details and which do not, across row kinds", async () => {
    const page = await openLensPage(SESSION);
    const cues = async (key: string) =>
      page.evaluate((wanted) => {
        const row = document.querySelector(`[data-row-key="${wanted}"]`);
        if (row === null) return null;
        return {
          cursor: getComputedStyle(row).cursor,
          open: row.querySelector(".trow-open svg") !== null,
          toggle: row.querySelector(".trow-toggle svg") !== null,
        };
      }, key);
    const stepKey = `step-${snapshot.turns[0]?.steps[0]?.id}`;
    await scrollToKey(page, stepKey);
    expect(await cues(stepKey)).toEqual({
      cursor: "pointer",
      open: true,
      toggle: false,
    });
    const turnKey = `turn-${snapshot.turns[0]?.id}`;
    await scrollToKey(page, turnKey);
    expect(await cues(turnKey)).toEqual({
      cursor: "pointer",
      open: false,
      toggle: true,
    });
    const branchKey = `step-${snapshot.branches[0]?.spawningStepId}`;
    await scrollToKey(page, branchKey);
    expect(await cues(branchKey)).toEqual({
      cursor: "pointer",
      open: true,
      toggle: true,
    });
    const humanKey = humanRowKey();
    await scrollToKey(page, humanKey);
    expect(await cues(humanKey)).toEqual({
      cursor: "default",
      open: false,
      toggle: false,
    });
    const eventKey = `event-${snapshot.sessionEvents[0]?.kind}:${snapshot.sessionEvents[0]?.id}`;
    await scrollToKey(page, eventKey);
    expect(await cues(eventKey)).toEqual({
      cursor: "default",
      open: false,
      toggle: false,
    });
    await page.close();
  }, 60_000);

  it("highlights a row that opens on hover and leaves a static row plain", async () => {
    const page = await openLensPage(SESSION);
    const background = async (key: string) =>
      page.evaluate((wanted) => {
        const row = document.querySelector(`[data-row-key="${wanted}"]`);
        return row === null ? null : getComputedStyle(row).backgroundColor;
      }, key);
    const stepKey = `step-${snapshot.turns[0]?.steps[0]?.id}`;
    await scrollToKey(page, stepKey);
    const stepPlain = await background(stepKey);
    await page.locator(`[data-row-key="${stepKey}"]`).hover();
    await expect.poll(async () => background(stepKey)).not.toBe(stepPlain);
    const humanKey = humanRowKey();
    await scrollToKey(page, humanKey);
    const humanPlain = await background(humanKey);
    await page.locator(`[data-row-key="${humanKey}"]`).hover();
    expect(await background(humanKey)).toBe(humanPlain);
    await page.close();
  }, 60_000);

  it("leaves the detail panel on the picked step when other rows are clicked", async () => {
    const page = await openLensPage(SESSION);
    const firstStep = requiredValue(
      snapshot.turns[0]?.steps[0],
      "the first step",
    );
    await scrollToKey(page, `step-${firstStep.id}`);
    await page.locator(`[data-row-key="step-${firstStep.id}"]`).click();
    await expect
      .poll(async () => page.locator(".detail-title").textContent())
      .toBe(firstStep.sentence);
    const humanKey = humanRowKey();
    await scrollToKey(page, humanKey);
    await page.locator(`[data-row-key="${humanKey}"]`).click();
    expect(await page.locator(".detail-title").textContent()).toBe(
      firstStep.sentence,
    );
    const turn = page.locator(".trow-turn").first();
    await turn.click();
    await expect
      .poll(async () => turn.getAttribute("aria-expanded"))
      .toBe("false");
    expect(await page.locator(".detail-title").textContent()).toBe(
      firstStep.sentence,
    );
    await page.close();
  }, 60_000);

  it("resizes the tree and the panel by drag and by keyboard, and keeps the width", async () => {
    const page = await openLensPage(SESSION);
    const before = await widthOf(page, ".steps-panel");
    await dragResizerTo(page, (await resizerCenter(page)).x + 140);
    await expect
      .poll(() => widthOf(page, ".steps-panel"))
      .toBeGreaterThan(before + 80);
    const grown = await widthOf(page, ".steps-panel");
    await page.locator(".panel-resizer").focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => widthOf(page, ".steps-panel"))
      .toBeLessThan(grown - 16);
    const chosen = await widthOf(page, ".steps-panel");
    // A real reload, proved by a marker on the document that
    // only a fresh page loses: the kept width must come back
    // from storage, not from state the navigation carried.
    await page.evaluate(() => {
      document.documentElement.dataset["reloadMark"] = "1";
    });
    await page.reload();
    await page.waitForSelector(".trow");
    expect(
      await page.evaluate(
        () => document.documentElement.dataset["reloadMark"] ?? null,
      ),
    ).toBeNull();
    await expect
      .poll(() => widthOf(page, ".steps-panel"))
      .toBeGreaterThan(chosen - 6);
    expect(await widthOf(page, ".steps-panel")).toBeLessThan(chosen + 6);
    const main = await page.locator(".session-main").boundingBox();
    if (main === null) throw new Error("the session main has no box");
    await dragResizerTo(page, main.x + 4);
    await expect
      .poll(() => widthOf(page, ".steps-panel"))
      .toBeLessThanOrEqual(326);
    expect(await widthOf(page, ".steps-panel")).toBeGreaterThanOrEqual(314);
    await dragResizerTo(page, main.x + main.width - 4);
    await expect
      .poll(() => widthOf(page, ".detail"))
      .toBeGreaterThanOrEqual(274);
    await page.close();
  }, 60_000);

  it("moves the split on the first arrow press past a width saved wider than the window", async () => {
    const page = await openLensPage(SESSION);
    // A width saved on a wider window than this one: what is
    // stored is wider than what this window lets the split
    // draw, so the split stands at the window's most.
    await page.evaluate(() => {
      localStorage.setItem("flightpath-steps-width", "1300");
    });
    await page.reload();
    await page.waitForSelector(".trow");
    const drawn = await widthOf(page, ".steps-panel");
    expect(drawn).toBeLessThan(1300);
    await page.locator(".panel-resizer").focus();
    await page.keyboard.press("ArrowLeft");
    // The first press moves the split one step in from where
    // it is drawn — a press spent catching up to the stored
    // width would leave it standing — and the width it lands
    // on is the one that gets kept.
    await expect.poll(() => widthOf(page, ".steps-panel")).toBe(drawn - 16);
    expect(
      await page.evaluate(() => localStorage.getItem("flightpath-steps-width")),
    ).toBe(String(drawn - 16));
    await page.close();
  }, 60_000);

  it("keeps both minimums when the window narrows past a saved width", async () => {
    const page = await openLensPage(SESSION);
    // The separator reports the measured width and the most
    // the split allows in this window.
    const separator = page.locator(".panel-resizer");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBe(await widthOf(page, ".steps-panel"));
    const maxAtWide = Number(await separator.getAttribute("aria-valuemax"));
    expect(maxAtWide).toBe((await widthOf(page, ".session-main")) - 326);
    const main = await page.locator(".session-main").boundingBox();
    if (main === null) throw new Error("the session main has no box");
    await dragResizerTo(page, main.x + main.width - 4);
    await expect
      .poll(() => widthOf(page, ".detail"))
      .toBeGreaterThanOrEqual(274);
    const wide = await widthOf(page, ".steps-panel");
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => widthOf(page, ".steps-panel")).toBeLessThan(wide);
    expect(await widthOf(page, ".detail")).toBeGreaterThanOrEqual(274);
    const stepsBox = await page.locator(".steps-panel").boundingBox();
    const detailBox = await page.locator(".detail").boundingBox();
    if (stepsBox === null || detailBox === null) {
      throw new Error("a panel has no box");
    }
    expect(Math.abs(stepsBox.y - detailBox.y)).toBeLessThan(2);
    await page.close();
  }, 60_000);

  it("puts the tab stop on a usable row and keeps it off rows that open nothing", async () => {
    const page = await openLensPage(SESSION);
    const tabStopKey = async (): Promise<string | null> =>
      page.evaluate(
        () =>
          document
            .querySelector('.tree-scroll [tabindex="0"]')
            ?.getAttribute("data-row-key") ?? null,
      );
    // The first row is the opening event, which opens
    // nothing: the stop rests on the first turn instead.
    const turnKey = `turn-${snapshot.turns[0]?.id}`;
    await expect.poll(tabStopKey).toBe(turnKey);
    await page.getByRole("button", { name: /Failures/ }).focus();
    await page.keyboard.press("Tab");
    await expect
      .poll(async () =>
        page.evaluate(
          () => document.activeElement?.getAttribute("data-row-key") ?? null,
        ),
      )
      .toBe(turnKey);
    // Clicking a human moment moves neither the panel nor
    // the tab stop onto it.
    const humanKey = humanRowKey();
    await scrollToKey(page, humanKey);
    await page.locator(`[data-row-key="${humanKey}"]`).click();
    await expect.poll(tabStopKey).toBe(turnKey);
    await page.close();
  }, 60_000);

  it("counts only the person's subagents in the header", async () => {
    const page = await openLensPage(AGENTS);
    const counts = await page.locator(".summary-counts").textContent();
    expect(counts).toContain("1 subagent");
    expect(counts).toContain("2 Claude Code helpers");
    expect(counts).not.toContain("background work");
    expect(counts).not.toContain("3 subagents");
    await page.close();
  }, 60_000);
});
