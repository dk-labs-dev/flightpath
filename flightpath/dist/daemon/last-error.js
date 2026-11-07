// The daemon's last start failure, kept in the data folder so
// the notice and /flightpath:status can say what went wrong long
// after the daemon process is gone. Written when a start fails,
// deleted by the next start that succeeds.
//
// The file may carry the error's own words only when the error
// can be named: a bind failure (EADDRINUSE or EACCES), a SQLite
// error, or the failure to open the database. Anything else is
// stored as one fixed line, because an arbitrary error can
// quote whatever it was working on — prompt text included —
// and this file is read back to the user. The full message
// always lands in daemon.log either way.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../util/errors.js";
import { unlinkIfPresent } from "../util/fs.js";
const LAST_ERROR_FILE = "last-error";
const MESSAGE_CAP = 300;
const UNEXPECTED = "unexpected error (details in daemon.log)";
function errorCode(error) {
    if (typeof error !== "object" || error === null)
        return null;
    const code = error.code;
    return typeof code === "string" ? code : null;
}
/** Whether the error's own message may be kept (see the header). */
function nameable(error, code) {
    if (code === "EADDRINUSE" || code === "EACCES")
        return true;
    if (code !== null && code.startsWith("ERR_SQLITE"))
        return true;
    if (typeof error !== "object" || error === null)
        return false;
    // node:sqlite errors also carry a numeric result code, and the
    // daemon tags the error it rethrows from opening the database.
    if (typeof error.errcode === "number") {
        return true;
    }
    return error.databaseOpen === true;
}
export function writeLastError(dataDir, error) {
    const code = errorCode(error);
    let message = UNEXPECTED;
    if (nameable(error, code)) {
        const raw = errorMessage(error);
        message = raw.split(/\r?\n/, 1)[0]?.slice(0, MESSAGE_CAP) ?? "";
    }
    const entry = {
        at: Date.now(),
        message,
        ...(code !== null ? { code } : {}),
    };
    writeFileSync(join(dataDir, LAST_ERROR_FILE), `${JSON.stringify(entry)}\n`);
}
export function readLastError(dataDir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dataDir, LAST_ERROR_FILE), "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return null;
        const entry = parsed;
        if (typeof entry.at !== "number" || typeof entry.message !== "string") {
            return null;
        }
        return {
            at: entry.at,
            message: entry.message,
            ...(typeof entry.code === "string" ? { code: entry.code } : {}),
        };
    }
    catch {
        return null;
    }
}
export function clearLastError(dataDir) {
    unlinkIfPresent(join(dataDir, LAST_ERROR_FILE));
}
/** The one classification of a start failure: a bind failure,
 * a database that would not open, or anything else. Every
 * reader — the health payload, the view, /flightpath:status —
 * takes its words from this, so the tests live in one place. */
export function startProblem(lastError, dataDir) {
    const { message, code } = lastError;
    // The bind failure is matched by its code or its name, never
    // by the word "port" — half the error messages in the world
    // contain it inside another word.
    if (code === "EADDRINUSE" ||
        code === "EACCES" ||
        /EADDRINUSE|address already in use/.test(message)) {
        const port = /:(\d+)$/.exec(message.trim())?.[1];
        // EACCES means the port isn't allowed, not that it's in use.
        const reason = code === "EACCES" || /EACCES/.test(message) ? "not-allowed" : "in-use";
        return {
            kind: "port",
            port: port === undefined ? null : Number(port),
            reason,
        };
    }
    if (/database|sqlite|malformed/i.test(message)) {
        return { kind: "database", path: join(dataDir, "flightpath.db") };
    }
    return { kind: "other" };
}
/** The one next step for the common start failures, in the
 * words /flightpath:status speaks — from the same classification. */
export function nextStepFor(lastError, dataDir) {
    const problem = startProblem(lastError, dataDir);
    if (problem.kind === "port") {
        return "change the daemon's port in settings";
    }
    if (problem.kind === "database") {
        return `the database file is ${problem.path} — check it isn't damaged or held by another program`;
    }
    return null;
}
