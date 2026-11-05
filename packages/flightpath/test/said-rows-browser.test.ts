import { type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectAxeCleanOnPage } from "./support/axe.js";
import { startSeededBrowser } from "./support/browser.js";
import { runCleanups } from "./support/cleanup.js";
import {
  seedBranch,
  seedConditions,
  seedMoment,
  seedRequest,
  seedSample,
  seedSegment,
  seedSession,
  seedStep,
  seedTurn,
} from "./support/seed.js";
import { newThemedPage } from "./support/theme-page.js";

import { DatabaseSync } from "../src/storage/sqlite.js";

// A turn where Claude Code and a subagent spoke, in a real
// browser: the three kinds of message with their tags, and the
// subagent as one row that opens the step which started it.
// Times sit just behind the clock so retention keeps the session.
const T0 = Date.now() - 900_000;
const SESSION = "said-session";

let base: string;
let token: string;
let browser: Browser;
let ids: {
  agentStep: number;
  command: number;
  handback: number;
  notice: number;
};

function seedSaidSession(db: DatabaseSync): void {
  seedSession(db, {
    id: SESSION,
    projectPath: "/home/user/tip-calc",
    firstSeenAt: T0,
    lastSeenAt: T0 + 600_000,
  });
  seedConditions(db, SESSION, {});
  seedSegment(db, { sessionId: SESSION, startedAt: T0, contextTokens: 9000 });
  const turn = seedTurn(db, {
    sessionId: SESSION,
    sequence: 1,
    startedAt: T0 + 10_000,
    endedAt: T0 + 300_000,
    promptText: "Check the tip maths",
  });
  seedMoment(db, {
    sessionId: SESSION,
    turnId: turn,
    kind: "prompt",
    occurredAt: T0 + 10_000,
    detail: "Check the tip maths",
  });
  seedStep(db, {
    sessionId: SESSION,
    turnId: turn,
    toolName: "Bash",
    input: { command: "npm test" },
    outcome: "succeeded",
    startedAt: T0 + 20_000,
    durationMs: 400,
  });
  const agentStep = seedStep(db, {
    sessionId: SESSION,
    turnId: turn,
    toolName: "Agent",
    input: { description: "review", subagent_type: "Explore", prompt: "look" },
    outcome: "succeeded",
    startedAt: T0 + 40_000,
    durationMs: 90_000,
  });
  const branch = seedBranch(db, {
    sessionId: SESSION,
    agentId: "agent-1",
    agentType: "Explore",
    spawningStepId: agentStep,
    startedAt: T0 + 45_000,
    endedAt: T0 + 125_000,
    totalTokens: 5400,
  });
  for (const [index, toolName] of ["Grep", "Read"].entries()) {
    seedStep(db, {
      sessionId: SESSION,
      turnId: turn,
      branchId: branch,
      toolName,
      input: { pattern: "tip", file_path: "/home/user/tip-calc/src/tip.ts" },
      outcome: "succeeded",
      startedAt: T0 + 50_000 + index * 10_000,
      durationMs: 100,
    });
  }
  seedRequest(db, {
    sessionId: SESSION,
    turnId: turn,
    startedAt: T0 + 19_000,
    durationMs: 900,
    inputTokens: 100,
    outputTokens: 50,
  });
  seedSample(db, {
    sessionId: SESSION,
    sampledAt: T0 + 20_000,
    contextTokens: 9000,
  });
  const moment = (kind: string, at: number, detail: object): number =>
    seedMoment(db, {
      sessionId: SESSION,
      turnId: turn,
      kind,
      occurredAt: T0 + at,
      detail: JSON.stringify(detail),
    });
  ids = {
    agentStep,
    command: moment("command", 30_000, { name: "/context" }),
    handback: moment("handback", 130_000, {
      agent_type: "Explore",
      chars: 7619,
    }),
    notice: moment("notice", 140_000, { chars: 866 }),
  };
}

beforeAll(async () => {
  const started = await startSeededBrowser("flightpath-said-rows-", (db) => {
    seedSaidSession(db);
  });
  token = started.token;
  base = started.base;
  browser = started.browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function openSaidSession(page: Page): Promise<void> {
  await page.goto(`${base}/#session/${SESSION}&token=${token}`);
  await page.waitForSelector(".summary");
  await page.waitForSelector('[data-row-key="turn-1"], .trow');
}

function row(page: Page, key: string) {
  return page.locator(`[data-row-key="${key}"]`);
}

describe("what Claude Code and a subagent said, in the steps list", () => {
  it("shows each message in its words with its tag, and none opens details", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSaidSession(page);
    const expected = [
      [ids.command, "You ran `/context`", "You"],
      [
        ids.handback,
        "Explore reported back · about 2.6K tokens est.",
        "From a subagent",
      ],
      [
        ids.notice,
        "Claude Code added a notice · 866 characters",
        "From Claude Code",
      ],
    ] as const;
    for (const [id, words, tag] of expected) {
      const message = row(page, `human-${id}`);
      await message.waitFor();
      expect(await message.locator(".trow-name").textContent()).toBe(words);
      expect(await message.locator(".pill").textContent()).toBe(tag);
      await message.click();
    }
    expect(await page.locator(".detail-empty").count()).toBe(1);
    await page.close();
  });

  it("shows a subagent once, as a row that opens the step which started it", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSaidSession(page);
    await row(page, `step-${ids.agentStep}`).waitFor();
    const subagentRows = page.locator(".trow-name", {
      hasText: "Started a subagent",
    });
    expect(await subagentRows.count()).toBe(1);
    // The segment marker, the turn, its step, the command, the
    // subagent and its two steps, the hand-back and the notice.
    expect(await page.locator("[data-row-key]").count()).toBe(9);
    await row(page, `step-${ids.agentStep}`).click();
    await expect
      .poll(() => page.locator("aside.detail").getAttribute("data-detail-for"))
      .toBe(String(ids.agentStep));
    await page.close();
  });

  it("folds the subagent's steps from its chevron without opening the step", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await openSaidSession(page);
    const subagent = row(page, `step-${ids.agentStep}`);
    await subagent.waitFor();
    const before = await page.locator("[data-row-key]").count();
    await subagent.locator(".trow-toggle").click();
    await expect
      .poll(() => page.locator("[data-row-key]").count())
      .toBe(before - 2);
    expect(await page.locator(".detail-empty").count()).toBe(1);
    await page.close();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`is clean to a screen reader's checks in the ${theme} theme at both widths`, async () => {
      const page = await newThemedPage(browser, theme);
      await openSaidSession(page);
      await expectAxeCleanOnPage(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await expectAxeCleanOnPage(page);
      await page.close();
    });
  }
});
