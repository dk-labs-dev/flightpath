import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
// The daemon's log: one line per thing worth knowing (starts,
// drains, rejections, errors), never an event body. Capped by
// rotating the file once at 256 KB, so the folder holds at most
// two logs.
const MAX_LOG_BYTES = 256 * 1024;
export function daemonLog(dataDir, message) {
    try {
        const dir = join(dataDir, "logs");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "daemon.log");
        try {
            if (statSync(path).size >= MAX_LOG_BYTES) {
                renameSync(path, `${path}.1`);
            }
        }
        catch {
            // No log yet; nothing to rotate.
        }
        appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // A daemon that can't log still has to run.
    }
}
