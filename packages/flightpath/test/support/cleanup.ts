import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTree } from "./remove-tree.js";

export type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];

export function registerCleanup(cleanup: Cleanup): () => void {
  cleanups.push(cleanup);
  return () => {
    const index = cleanups.indexOf(cleanup);
    if (index >= 0) cleanups.splice(index, 1);
  };
}

/** Run every registered cleanup, last in first out. One that
 *  throws does not strand the rest — a tree that cannot be
 *  removed must not leave a daemon behind — so the first
 *  error is rethrown only once the list is empty. */
export async function runCleanups(): Promise<void> {
  let firstError: unknown;
  let failed = false;
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (!cleanup) continue;
    try {
      await cleanup();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}

export function makeTempRoot(prefix: string, base = tmpdir()): string {
  const root = mkdtempSync(join(base, prefix));
  registerCleanup(() => removeTree(root));
  return root;
}
