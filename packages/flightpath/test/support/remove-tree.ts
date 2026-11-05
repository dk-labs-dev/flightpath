import { rmSync } from "node:fs";

// Removing a scratch tree can race a process that is still
// writing into it (ENOTEMPTY), or on Windows one that has just
// exited and not yet let go of its files (EPERM, EBUSY). The
// retries back off, about five seconds in all, and give the
// process a moment to finish instead of failing the run.
export function removeTree(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
