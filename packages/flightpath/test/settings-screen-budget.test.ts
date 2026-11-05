import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { freePort, makeRoot, startTestDaemon } from "./support/daemon.js";
import { movePortOnScreen } from "./support/settings-screen.js";

// The port move's timing promise, held in the budgets
// project with the other wall-clock bounds: from the click
// that confirms the move to the settings screen answering
// on the new port, under two seconds. The
// move's functional half — it lands on the new port and
// the page works — sits with the settings-screen tests and
// carries no timing bound.

let browser: Browser;
let home: string;
let token: string;

beforeAll(async () => {
  const made = makeRoot("flightpath-settings-move-budget-");
  mkdirSync(join(made.root, "claude"), { recursive: true });
  const started = await startTestDaemon(made.root, {
    extra: { CLAUDE_CONFIG_DIR: join(made.root, "claude") },
  });
  home = `http://127.0.0.1:${started.port}`;
  token = started.token;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await runCleanups();
});

describe("the settings port move, timed", () => {
  it("restarts and reloads on the new port inside two seconds", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const target = await freePort();
    const startedAt = await movePortOnScreen(
      page,
      `${home}/#settings&token=${token}`,
      target,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await page.close();
  }, 120_000);
});
