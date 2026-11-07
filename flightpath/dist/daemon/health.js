// The recorder's health, read from the data folder's files:
// the one reading the stream's health message and
// GET /api/health both report, so the page never hears two
// versions of it.
import { bufferStats, droppedCount } from "../buffer.js";
import { readLastError, startProblem } from "./last-error.js";
export function currentHealth(dataDir, autostart) {
    const stats = bufferStats(dataDir);
    const lastError = readLastError(dataDir);
    return {
        buffered: stats.count,
        oldestAt: stats.oldestAt,
        dropped: droppedCount(dataDir),
        lastError,
        problem: lastError === null ? null : startProblem(lastError, dataDir),
        autostart,
    };
}
