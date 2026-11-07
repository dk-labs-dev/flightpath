// The daemon's routes share one runtime: everything a handler
// needs from the daemon that hosts it — storage, settings, the
// intake and follower, and the lifecycle verbs — in one object
// the server builds and owns. The routes receive it read-only
// (RouteContext below) and change it only through its verbs.
import { errorMessage } from "../../util/errors.js";
import { daemonLog } from "../log.js";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The request's whole body, or null past the size limit. */
function readBody(request) {
    return new Promise((resolvePromise) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                resolvePromise(null);
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
        request.on("error", () => resolvePromise(null));
    });
}
/**
 * Run one piece of request handling with the daemon's
 * failure answer. A throw is logged with the method and
 * URL; the request is answered 500 when nothing has been
 * sent yet, and closed when it has. A throw that escaped
 * the request listener would end the process, and with it
 * the recording.
 */
export function guardRequest(ctx, request, response, run) {
    try {
        run();
    }
    catch (error) {
        daemonLog(ctx.dataDir, `${request.method ?? ""} ${request.url ?? ""} failed (${errorMessage(error)}); answered 500`);
        if (!response.headersSent) {
            response.writeHead(500).end();
        }
        else if (!response.writableEnded) {
            response.end();
        }
    }
}
/**
 * Read a JSON request body and hand the parsed value over:
 * past the size limit the answer is 413, and a body that is
 * not JSON gets the route's own bad-JSON answer.
 */
export function handleJsonBody(ctx, request, response, badJson, handle) {
    void readBody(request).then((body) => {
        if (body === null) {
            response.writeHead(413).end();
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            badJson(response);
            return;
        }
        guardRequest(ctx, request, response, () => handle(parsed));
    });
}
/** Write a value as the route's JSON answer. */
export function sendJson(response, status, value) {
    response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
}
export function hostIsLoopback(host) {
    if (host === undefined)
        return false;
    const name = host.startsWith("[")
        ? host.slice(1, host.indexOf("]"))
        : (host.split(":")[0] ?? "");
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
}
