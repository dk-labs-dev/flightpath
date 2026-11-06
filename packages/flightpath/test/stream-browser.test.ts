import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { connectionWords, waitForConnection } from "./support/connection.js";
import {
  callDaemon,
  freePort,
  makeRoot,
  readPort,
  readToken,
  startDaemon,
  stopDaemon,
  waitFor,
  waitForDaemonReady,
} from "./support/daemon.js";
import {
  hookEvent,
  sequencedHookEnvelope,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";
import { writeSettings } from "./support/settings.js";

// The live stream in a real browser against the built daemon
// (ADR-0009): the catch-up after the daemon stops and restarts
// over a full buffer, and the catch-up after the tab sleeps.
// The page side is read through the app bar's connection
// status and the banner under it — they are what the page
// promises. What the model holds is covered at the client
// seam and against the hub.
const SESSION = "browser-stream-session";

interface World {
  root: string;
  dataDir: string;
  child: ChildProcess;
  port: number;
  base: string;
  token: string;
}

let browser: Browser;
let current: World | null = null;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

async function startWorld(): Promise<World> {
  // The restart test's page keeps its origin, so its daemon
  // must come back on the port it left: start on a port the
  // OS just handed out, which is this test's own for the few
  // seconds it needs it.
  const port = await freePort();
  const made = makeRoot("flightpath-stream-browser-");
  writeSettings(made.dataDir, { port });
  const child = startDaemon(made.root);
  await waitForDaemonReady(child, made.dataDir);
  const bound = readPort(made.dataDir);
  expect(bound).toBe(port);
  const world: World = {
    root: made.root,
    dataDir: made.dataDir,
    child,
    port: bound,
    base: `http://127.0.0.1:${bound}`,
    token: readToken(made.dataDir),
  };
  current = world;
  return world;
}

async function postEvent(
  world: World,
  event: Record<string, unknown>,
): Promise<void> {
  const reply = await callDaemon(world.port, {
    method: "POST",
    path: "/events/hook",
    token: world.token,
    headers: { "content-type": "application/json" },
    body: sequencedHookEnvelope("browser", event),
  });
  expect(reply.status).toBe(204);
}

function toolPair(id: string): Record<string, unknown>[] {
  return [
    hookEvent("PreToolUse", {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: `echo ${id}` },
    }),
    hookEvent("PostToolUse", {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: id,
      tool_response: { ok: true },
    }),
  ];
}

async function seedSession(world: World): Promise<void> {
  await postEvent(world, sessionStartEvent("startup", SESSION));
  await postEvent(world, userPromptEvent(SESSION, "browser stream test"));
}

/** Take a page to the session's route and wait until its
 * stream is live. */
async function gotoSessionPage(page: Page, world: World): Promise<void> {
  await page.goto(
    world.base + "/#session/" + SESSION + "&token=" + world.token,
  );
  await page.waitForSelector("#screen .empty");
  await waitForConnection(page, "Live");
}

async function openSessionPage(world: World): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await gotoSessionPage(page, world);
  return page;
}

/** Open the session page with its stream requests tracked
 * from the first one, for the tests that must know when the
 * page's stream is truly down. */
async function openTrackedSessionPage(
  world: World,
): Promise<{ page: Page; streamInFlight: () => number }> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const streamInFlight = trackStreamRequests(page);
  await gotoSessionPage(page, world);
  return { page, streamInFlight };
}

/** Poll the connection's words for one of the given texts;
 * when the wait runs out, log what the page actually says
 * before failing — the banner's own words are the first clue. */
async function waitForSlotText(
  page: Page,
  texts: string[],
  timeout: number,
): Promise<void> {
  try {
    await waitFor(
      async () => {
        const words = await connectionWords(page);
        return texts.some((text) => words.includes(text));
      },
      timeout,
      100,
    );
  } catch (error) {
    console.log(
      `connection status after waiting for ${texts
        .map((text) => `"${text}"`)
        .join(" or ")}: "${await connectionWords(page)}"`,
    );
    throw error;
  }
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** Count the page's stream requests still in flight, so a
 * test can wait until a paused stream is truly down before
 * it relies on the page being disconnected. */
function trackStreamRequests(page: Page): () => number {
  let inFlight = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/stream")) inFlight += 1;
  });
  const done = (request: { url: () => string }): void => {
    if (request.url().includes("/api/stream")) inFlight -= 1;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return () => inFlight;
}

/** How many steps the daemon's snapshot holds for the session. */
async function snapshotSteps(world: World): Promise<number> {
  const reply = await callDaemon(world.port, {
    method: "GET",
    path: `/api/sessions/${SESSION}/snapshot`,
    token: world.token,
  });
  const snapshot = JSON.parse(reply.body) as {
    turns: { steps: unknown[] }[];
  };
  return snapshot.turns.reduce((sum, turn) => sum + turn.steps.length, 0);
}

describe("the live stream in a browser", () => {
  afterEach(async () => {
    if (current !== null) {
      await stopDaemon(current.child);
      current = null;
    }
  });

  it("catches up every buffered step after the daemon restarts", async () => {
    const world = await startWorld();
    await seedSession(world);
    const page = await openSessionPage(world);
    expect(await connectionWords(page)).toContain("Live");
    await stopDaemon(world.child);
    await waitForSlotText(page, ["Reconnecting"], 20_000);
    // Fifty steps' worth of events land in the buffer while
    // the daemon is down: a Pre and a Post per step.
    const bufferDir = join(world.dataDir, "buffer");
    mkdirSync(bufferDir, { recursive: true });
    const at = Date.now();
    for (let i = 1; i <= 50; i += 1) {
      const [pre, post] = toolPair(`away-${i}`);
      writeFileSync(
        join(bufferDir, `${at + i * 2}-away-${i}-pre.json`),
        sequencedHookEnvelope("away", pre ?? {}),
      );
      writeFileSync(
        join(bufferDir, `${at + i * 2 + 1}-away-${i}-post.json`),
        sequencedHookEnvelope("away", post ?? {}),
      );
    }
    rmSync(join(world.dataDir, "port"), { force: true });
    world.child = startDaemon(world.root);
    await waitForDaemonReady(world.child, world.dataDir);
    expect(readPort(world.dataDir)).toBe(world.port);
    await waitForSlotText(page, ["caught up 50 steps"], 30_000);
    expect(await connectionWords(page)).toContain("Reconnected");
    await page.close();
  }, 180_000);

  it("catches up by replay after the tab sleeps, without duplicates", async () => {
    const world = await startWorld();
    await seedSession(world);
    const { page, streamInFlight } = await openTrackedSessionPage(world);
    for (const event of toolPair("before-1")) {
      await postEvent(world, event);
    }
    await waitFor(async () => (await snapshotSteps(world)) === 1);
    // The daemon's snapshot says the step is stored; it cannot
    // say the page has it. On a fast machine this test outruns
    // the hub's capture beat, hides the tab before the step
    // reaches the page, and the step is then legitimately part
    // of the sleep's catch-up — the banner reads 3 steps, not
    // 2. So prove the page's place first: blink the tab and
    // wait for the blink's own banner — a bare "Reconnected"
    // when the step had already arrived, "caught up 1 step"
    // when the blink's replay is what delivered it. Either
    // way, the page now holds exactly that one step.
    await setHidden(page, true);
    await waitFor(() => streamInFlight() === 0);
    await setHidden(page, false);
    await waitForSlotText(page, ["Reconnected", "caught up 1 step"], 20_000);
    // The real sleep: the tab hides — a laptop asleep, from
    // the page's side — its stream goes down, and work
    // continues without it.
    await setHidden(page, true);
    await waitFor(() => streamInFlight() === 0);
    for (const event of toolPair("away-1")) {
      await postEvent(world, event);
    }
    for (const event of toolPair("away-2")) {
      await postEvent(world, event);
    }
    // A sleep is never twenty milliseconds: the gap gets a
    // beat, as any real one would give the hub's capture.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await setHidden(page, false);
    await waitForSlotText(page, ["caught up 2 steps"], 20_000);
    const text = await connectionWords(page);
    expect(text).not.toContain("failure");
    await page.close();
  }, 120_000);
});
