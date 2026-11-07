// The event buffer, shared by the recording hook (which writes
// it), the daemon (which drains it), the notice and the status
// command (which report on it). One file per event in `buffer/`,
// named for the event's arrival time, so the oldest event in the
// folder is the smallest name and no file needs opening to age
// the buffer.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unlinkIfPresent } from "./util/fs.js";
/** Past this many buffered events the hook drops new ones. */
export const BUFFER_LIMIT = 20_000;
const DROPPED_FILE = "buffer-dropped";
export function bufferStats(dataDir) {
    let names;
    try {
        names = readdirSync(join(dataDir, "buffer"));
    }
    catch {
        return { count: 0, oldestAt: null };
    }
    let oldestAt = null;
    for (const name of names) {
        const at = Number.parseInt(name, 10);
        if (Number.isFinite(at) && (oldestAt === null || at < oldestAt)) {
            oldestAt = at;
        }
    }
    return { count: names.length, oldestAt };
}
/** Events dropped because the buffer was full, since the last drain. */
export function droppedCount(dataDir) {
    try {
        const value = Number.parseInt(readFileSync(join(dataDir, DROPPED_FILE), "utf8").trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }
    catch {
        return 0;
    }
}
export function noteDropped(dataDir) {
    writeFileSync(join(dataDir, DROPPED_FILE), `${droppedCount(dataDir) + 1}\n`);
}
/** The daemon calls this once a drain leaves the buffer empty. */
export function resetDropped(dataDir) {
    unlinkIfPresent(join(dataDir, DROPPED_FILE));
}
