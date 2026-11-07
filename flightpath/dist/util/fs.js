// File helpers shared by the hook, the daemon and the commands; node builtins only (the hook loads this).
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Everything on standard input, or "" when it cannot be read. */
export function readStdin() {
    try {
        return readFileSync(0, "utf8");
    }
    catch {
        return "";
    }
}
/** Write whole, then rename into place; the temp name carries the pid. */
export function writeFileAtomically(path, contents) {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
}
/** Remove a file that may already be gone. */
export function unlinkIfPresent(path) {
    try {
        unlinkSync(path);
    }
    catch {
        // Already gone: not an error.
    }
}
/** The daemon's pid, from its lock file; null when no lock reads. */
export function readDaemonPid(dataDir) {
    try {
        const pid = Number(readFileSync(join(dataDir, "daemon.lock"), "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
/** The daemon's address, from its port and token files; null when either is missing. */
export function readDaemonAddress(dataDir) {
    try {
        const port = Number(readFileSync(join(dataDir, "port"), "utf8").trim());
        const token = readFileSync(join(dataDir, "token"), "utf8").trim();
        if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
            return null;
        }
        return { port, token };
    }
    catch {
        return null;
    }
}
