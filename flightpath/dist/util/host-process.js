// Which Claude Code process a session belongs to, found by
// walking up from the hook that runs as its descendant. The
// hook is started through a shell, so the first parent is a
// short-lived shell: the walk skips every ancestor that is not
// Claude Code itself — the native binary, or node running the
// Claude Code entry point — and records that process's id and
// start time. The start time is what tells the same process
// from a later one that reused its id.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const MAX_ANCESTORS = 8;
// Linux clock ticks per second (CLK_TCK): 100 on every
// mainstream kernel and architecture this runs on.
const TICKS_PER_SECOND = 100;
// Start times rest on a boot time derived from the wall
// clock, which can shift by a second as the clock is
// adjusted: two reads within this gap name the same process.
const START_TIME_TOLERANCE_MS = 2_000;
/** True when two start-time reads name the same process:
 * read twice from a noisy source, they are compared within
 * that source's noise, never for exact equality. */
export function sameProcessStart(a, b) {
    return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
/** True when a command line is Claude Code itself, not a shell
 * running one of its hooks: only the program and its entry
 * point count, never the arguments after them. */
export function isClaudeCommand(argv) {
    const program = (argv[0] ?? "").split(/[\\/]/).pop() ?? "";
    if (program === "claude" || program === "claude.exe") {
        return true;
    }
    if (program !== "node" && program !== "node.exe") {
        return false;
    }
    const entry = argv[1] ?? "";
    return /(^|[/\\])claude-code([/\\]|$)/.test(entry);
}
/**
 * The first Claude Code process at or above `startPid`, walking
 * parent by parent. `read` is the platform's process reader;
 * the walk stops at the top of the tree, at a repeat, or after
 * a few ancestors — a hook's chain to its host is short.
 */
export function findHostProcess(read, startPid) {
    const seen = new Set();
    let pid = startPid;
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
        if (pid <= 0 || seen.has(pid)) {
            return null;
        }
        seen.add(pid);
        const info = read(pid);
        if (info === null) {
            return null;
        }
        if (isClaudeCommand(info.argv)) {
            return { pid: info.pid, startedAt: info.startedAt };
        }
        pid = info.parentPid;
    }
    return null;
}
/** /proc/<pid>/stat after the command name: the name sits in
 * parentheses and can itself hold spaces and parentheses, so
 * the fields are counted from the last closing parenthesis.
 * Field 22 of the whole record — the start time in ticks — is
 * index 19 of what follows it. */
export function parseProcStat(text, bootTimeSeconds) {
    const close = text.lastIndexOf(")");
    if (close === -1) {
        return null;
    }
    const fields = text.slice(close + 2).split(" ");
    const parentPid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(parentPid) || !Number.isFinite(startTicks)) {
        return null;
    }
    return {
        parentPid,
        startedAt: Math.round(bootTimeSeconds * 1000 + (startTicks / TICKS_PER_SECOND) * 1000),
    };
}
function bootTimeSeconds() {
    try {
        const match = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
        return match === null ? null : Number(match[1]);
    }
    catch {
        return null;
    }
}
/** One process on Linux, from /proc, against a boot time read elsewhere. */
function readProcessLinuxAt(pid, boot) {
    if (boot === null) {
        return null;
    }
    let stat;
    let cmdline;
    try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    }
    catch {
        return null;
    }
    const parsed = parseProcStat(stat, boot);
    if (parsed === null) {
        return null;
    }
    return {
        pid,
        parentPid: parsed.parentPid,
        startedAt: parsed.startedAt,
        argv: cmdline.split("\0").filter((part) => part !== ""),
    };
}
/** One process on Linux, from /proc; null when gone or
 * unreadable. Exported for the host tests that read through it. */
export function readProcessLinux(pid) {
    return readProcessLinuxAt(pid, bootTimeSeconds());
}
/** A Linux process reader holding the boot time it read once:
 * it cannot change under a running system, so a whole walk or
 * batch pays for /proc/stat once, not once per process. */
function linuxProcessReader() {
    const boot = bootTimeSeconds();
    return (pid) => readProcessLinuxAt(pid, boot);
}
/** A Windows query's rows: its JSON is one object, or an
 * array when more than one row matches. */
function windowsRows(text) {
    let parsed;
    try {
        parsed = JSON.parse(text.trim());
    }
    catch {
        return [];
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter((raw) => typeof raw === "object" && raw !== null);
}
/** The entry point in a Windows command line: its second
 * token, with the quotes that group a path holding spaces
 * left off. The first token is the program as invoked, which
 * the row's name already gives more plainly. */
function commandLineEntry(commandLine) {
    const tokens = [];
    let token = "";
    let quoted = false;
    for (const char of commandLine) {
        if (char === '"') {
            quoted = !quoted;
        }
        else if (!quoted && (char === " " || char === "\t")) {
            if (token !== "") {
                tokens.push(token);
                token = "";
            }
        }
        else {
            token += char;
        }
    }
    if (token !== "") {
        tokens.push(token);
    }
    return tokens[1] ?? "";
}
/** The process table's rows as the Windows query emits them. */
export function parseWindowsProcessTable(text) {
    const table = new Map();
    for (const row of windowsRows(text)) {
        if (typeof row.ProcessId !== "number" ||
            typeof row.ParentProcessId !== "number" ||
            typeof row.StartedAt !== "number") {
            continue;
        }
        // The name stands in for argv[0] and the command line's
        // second token for argv[1] — the entry point — so
        // isClaudeCommand reads the same shape on every platform:
        // the arguments after the entry point never count.
        table.set(row.ProcessId, {
            pid: row.ProcessId,
            parentPid: row.ParentProcessId,
            startedAt: row.StartedAt,
            argv: [
                typeof row.Name === "string" ? row.Name : "",
                typeof row.CommandLine === "string"
                    ? commandLineEntry(row.CommandLine)
                    : "",
            ],
        });
    }
    return table;
}
/** The Windows queries' StartedAt column, written once: the
 * creation date as Unix milliseconds. ToUnixTimeMilliseconds
 * is a method — read as a property it yields null and the row
 * is dropped. Exported so the test runs the shipped expression. */
export const WINDOWS_STARTED_AT_PROPERTY = `@{n='StartedAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}`;
const WINDOWS_TABLE_SCRIPT = `Get-CimInstance Win32_Process` +
    ` | Select-Object ProcessId,ParentProcessId,${WINDOWS_STARTED_AT_PROPERTY},Name,CommandLine` +
    ` | ConvertTo-Json -Compress`;
/** The whole Windows process table from one PowerShell start,
 * so the hook's ancestor walk reads it in memory instead of
 * paying a start per ancestor. Empty when the query fails. */
function readProcessTableWindows() {
    try {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        return parseWindowsProcessTable(result.stdout ?? "");
    }
    catch {
        return new Map();
    }
}
/**
 * The Claude Code process above this one, or null when it
 * cannot be found. Platforms without a reader here record
 * nothing, and the caller's fallback governs those sessions.
 */
export function captureHostProcess() {
    if (process.platform === "linux") {
        return findHostProcess(linuxProcessReader(), process.ppid);
    }
    if (process.platform === "win32") {
        const table = readProcessTableWindows();
        return findHostProcess((pid) => table.get(pid) ?? null, process.ppid);
    }
    return null;
}
export function parseWindowsStartTimes(text) {
    const times = new Map();
    for (const row of windowsRows(text)) {
        if (typeof row.ProcessId === "number" &&
            typeof row.StartedAt === "number") {
            times.set(row.ProcessId, row.StartedAt);
        }
    }
    return times;
}
function readProcessStartTimesWindows(pids) {
    if (pids.length === 0) {
        return Promise.resolve(new Map());
    }
    const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
    const script = `Get-CimInstance Win32_Process -Filter "${filter}"` +
        ` -ErrorAction SilentlyContinue` +
        ` | Select-Object ProcessId,${WINDOWS_STARTED_AT_PROPERTY}` +
        ` | ConvertTo-Json -Compress`;
    return new Promise((resolve) => {
        // A failed start reports an error and may still close:
        // whichever arrives first settles, with what was read.
        let settled = false;
        const settle = (text) => {
            if (!settled) {
                settled = true;
                resolve(parseWindowsStartTimes(text));
            }
        };
        try {
            const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
            let out = "";
            child.stdout?.on("data", (chunk) => {
                out += chunk.toString("utf8");
            });
            const timer = setTimeout(() => child.kill(), 10_000);
            timer.unref();
            child.on("error", () => settle(""));
            child.on("close", () => settle(out));
        }
        catch {
            settle("");
        }
    });
}
/**
 * Start times for many processes at once, keyed by id; a
 * process missing from the map could not be read. For the
 * daemon's watch: on Windows one asynchronous query covers
 * every noted process, so the daemon's event loop never waits
 * on another program; on Linux each read is a /proc file read,
 * done inline. On other platforms the map is empty.
 */
export function readProcessStartTimes(pids) {
    if (process.platform === "win32") {
        return readProcessStartTimesWindows(pids);
    }
    const times = new Map();
    if (process.platform === "linux") {
        const read = linuxProcessReader();
        for (const pid of pids) {
            const startedAt = read(pid)?.startedAt ?? null;
            if (startedAt !== null) {
                times.set(pid, startedAt);
            }
        }
    }
    return Promise.resolve(times);
}
/** True when a process with this id exists. A permission error
 * still proves existence: the process is there, just not ours
 * to signal. */
export function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
