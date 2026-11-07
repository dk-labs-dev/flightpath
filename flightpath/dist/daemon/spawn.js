// Starting the daemon, shared by the recording hook and the
// command hook. The start lock marks a start in progress; the
// daemon removes it once it is listening.
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLive, startLockPath } from "./lock.js";
const START_LOCK_WINDOW_MS = 10_000;
// The daemon entry lives in dist/ beside the bundled entry
// points (hook.js, command.js) that inline this module, and one
// level up from this file's own per-file build output
// (dist/daemon/spawn.js). Take whichever is actually there.
function daemonEntry() {
    const here = dirname(fileURLToPath(import.meta.url));
    const beside = join(here, "daemon.js");
    return existsSync(beside) ? beside : join(here, "..", "daemon.js");
}
export async function ensureDaemon(dataDir) {
    // A live daemon needs no start, whatever the start lock says:
    // it may be mid-port-move or slow to answer, and a second
    // daemon would only find its lock held and exit.
    if (daemonLive(dataDir)) {
        return;
    }
    const lockPath = startLockPath(dataDir);
    let fd;
    try {
        fd = openSync(lockPath, "wx");
    }
    catch {
        try {
            if (Date.now() - statSync(lockPath).mtimeMs < START_LOCK_WINDOW_MS) {
                return;
            }
            unlinkSync(lockPath);
            fd = openSync(lockPath, "wx");
        }
        catch {
            return;
        }
    }
    closeSync(fd);
    // child_process is loaded here, on the start path only: it is
    // dead weight on every run that doesn't start anything.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [daemonEntry()], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    // Spawn failures arrive asynchronously; without a listener they
    // would throw, and a hook must never take itself down.
    child.on("error", () => { });
    child.unref();
}
