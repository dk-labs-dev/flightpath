// Opening the live view for /flightpath:open (ADR-0026): the
// address comes only from the daemon's own files and the
// session id, and the opener is spawned detached.
import { spawn } from "node:child_process";
import { daemonLive } from "./daemon/lock.js";
import { readDaemonAddress } from "./util/fs.js";
const spawnDetached = (file, args, options) => spawn(file, args, options);
/** The live view's address for one session, or null while the
 *  daemon has not published its port and token files. */
function liveViewUrl(dataDir, sessionId) {
    const address = readDaemonAddress(dataDir);
    if (address === null)
        return null;
    // Encoded: on Windows a raw &, | or ^ in a value would read as a command to cmd.
    const session = encodeURIComponent(sessionId);
    const token = encodeURIComponent(address.token);
    return `http://127.0.0.1:${address.port}/#session/${session}&token=${token}`;
}
/** The platform's opener and the arguments before the address. */
function openerFor(platform) {
    switch (platform) {
        case "win32":
            // `start` is a cmd builtin, not a program: it runs
            // through cmd with the arguments verbatim — nothing
            // quotes them on the way — so the title is written as
            // the "" cmd must see, and the address is quoted: it
            // carries &token=…, a command separator unless quoted.
            return { file: "cmd", args: ["/c", "start", '""'], quoteAddress: true };
        case "darwin":
            return { file: "open", args: [], quoteAddress: false };
        case "linux":
            return { file: "xdg-open", args: [], quoteAddress: false };
        default:
            return null;
    }
}
/** A Linux session with no display has nothing to open on. */
function hasDisplay(platform, env) {
    if (platform !== "linux")
        return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
/** Open the address with the platform's opener, detached;
 *  false when nothing on this machine can open it (ADR-0026). */
export function openLiveView(url, platform = process.platform, env = process.env, spawnOpener = spawnDetached) {
    const opener = openerFor(platform);
    if (opener === null || !hasDisplay(platform, env))
        return false;
    const address = opener.quoteAddress ? `"${url}"` : url;
    let child;
    try {
        child = spawnOpener(opener.file, [...opener.args, address], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: opener.quoteAddress,
        });
    }
    catch {
        // The opener could not be started at all.
        return false;
    }
    // A missing opener reports through the error event; without
    // a listener it would throw, and a hook must never fall.
    child.on("error", () => { });
    child.unref();
    // A spawn that found no program leaves the pid unset.
    return child.pid !== undefined;
}
function sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
/** The live view's address once the daemon is up — only an
 *  address its live pid vouches for, so a stopped daemon's
 *  port file is never handed out. */
export async function waitForLiveViewUrl(dataDir, sessionId, waitMs = 2000) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        if (daemonLive(dataDir)) {
            const url = liveViewUrl(dataDir, sessionId);
            if (url !== null)
                return url;
        }
        if (Date.now() >= deadline)
            return null;
        await sleep(50);
    }
}
