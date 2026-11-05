import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readDaemonPid, unlinkIfPresent } from "../util/fs.js";

// Single instance, by a lock file in the data folder holding the
// owner's pid. A second start finds the owner alive and gives up;
// a lock left by a dead process is taken over.

export interface DaemonLock {
  release(): void;
}

// A takeover takes milliseconds. A marker older than this was
// left by a process that died mid-takeover, and it must not block
// every future start until someone deletes it by hand.
const TAKEOVER_STALE_MS = 5_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a live daemon holds the lock, from the lock alone. */
export function daemonLive(dataDir: string): boolean {
  const pid = readDaemonPid(dataDir);
  return pid !== null && pidAlive(pid);
}

/** The start lock's path: the daemon releases it and the hook
 *  creates it, so the two must agree on the one name. */
export function startLockPath(dataDir: string): string {
  return join(dataDir, "daemon-start.lock");
}

function makeLock(path: string): DaemonLock {
  return {
    release() {
      try {
        // Only remove our own lock: a takeover may have
        // replaced it after a crash misread.
        if (readFileSync(path, "utf8").trim() === String(process.pid)) {
          unlinkIfPresent(path);
        }
      } catch {
        // Already gone.
      }
    },
  };
}

function readLockOwner(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return Number.NaN;
  }
}

/** The lock names another process, and that process is alive. */
function hasLiveOwner(path: string): boolean {
  const owner = readLockOwner(path);
  return Number.isFinite(owner) && owner !== process.pid && pidAlive(owner);
}

/**
 * Claim the takeover marker; false means this starter gives up.
 */
function claimTakeoverMarker(takeoverPath: string): boolean {
  try {
    writeFileSync(takeoverPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // The marker already exists: another starter is mid-takeover
    // right now, or one died and left it behind. Only the second
    // case may be retried, and age is what tells them apart.
  }
  try {
    if (Date.now() - statSync(takeoverPath).mtimeMs < TAKEOVER_STALE_MS) {
      return false;
    }
    unlinkIfPresent(takeoverPath);
    writeFileSync(takeoverPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Null when a live daemon already holds the lock. */
export function acquireDaemonLock(dataDir: string): DaemonLock | null {
  const path = join(dataDir, "daemon.lock");
  const takeoverPath = `${path}.takeover`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return makeLock(path);
    } catch {
      // The lock exists; look at who holds it.
    }
    if (hasLiveOwner(path)) {
      return null;
    }
    // The lock is stale (or unreadable). Takeover has a single
    // winner: whoever claims the marker re-checks the lock,
    // removes it if it still holds no live owner, and retries.
    if (!claimTakeoverMarker(takeoverPath)) {
      return null;
    }
    try {
      if (hasLiveOwner(path)) {
        return null;
      }
      unlinkIfPresent(path);
    } finally {
      unlinkIfPresent(takeoverPath);
    }
  }
  return null;
}
