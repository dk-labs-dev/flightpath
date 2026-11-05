// Starts a seeded browser for the suite, and closes it and runs the cleanups after.

import { afterAll, beforeAll } from "vitest";

import type { DatabaseSync } from "../../src/storage/sqlite.js";
import { startSeededBrowser, type SeededBrowser } from "./browser.js";
import { runCleanups } from "./cleanup.js";

export function useSeededBrowser(
  prefix: string,
  seed: (db: DatabaseSync) => void,
): () => SeededBrowser {
  let started: SeededBrowser | undefined;
  beforeAll(async () => {
    started = await startSeededBrowser(prefix, seed);
  }, 120_000);
  afterAll(async () => {
    await started?.browser.close();
    await runCleanups();
  });
  return () => {
    if (started === undefined) {
      throw new Error("the seeded browser has not started");
    }
    return started;
  };
}
