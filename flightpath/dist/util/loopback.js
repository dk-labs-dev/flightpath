// One request to the daemon over a raw socket, for the hooks. node:http
// loads a whole client and server stack (about 26 ms) into a process that
// sends one request in its life, and node:net loads in about 1; hook
// start-up time is part of the product. Node builtins only.
import { connect } from "node:net";
const REPLY = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/;
function requestText(address, { method, path, body }) {
    const head = `${method} ${path} HTTP/1.0\r\n` +
        `Host: 127.0.0.1:${address.port}\r\n` +
        `x-flightpath-token: ${address.token}\r\n`;
    if (body === undefined)
        return `${head}\r\n`;
    return (`${head}Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function parseReply(raw) {
    const head = REPLY.exec(raw);
    if (head === null)
        return null;
    return { status: Number(head[1]), body: raw.slice(head[0].length) };
}
/**
 * The daemon's whole reply, read until it closes the connection; null
 * when the request fails, the reply isn't HTTP, or `timeoutMs` passes
 * before the reply is complete. The request is HTTP/1.0 so that the
 * daemon neither chunks the body nor keeps the connection open: the
 * reply ends where the connection does.
 */
export function loopbackRequest(address, request, timeoutMs) {
    return new Promise((resolvePromise) => {
        const socket = connect(address.port, "127.0.0.1");
        const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
        let raw = "";
        socket.setEncoding("utf8");
        // Not end(): a half-closed connection makes the server drop a reply it
        // has not sent yet, and the request already says where it stops.
        socket.on("connect", () => socket.write(requestText(address, request)));
        socket.on("data", (chunk) => {
            raw += chunk;
        });
        // A failed socket is reported by the close event that follows.
        socket.on("error", () => { });
        socket.on("close", (failed) => {
            clearTimeout(timer);
            resolvePromise(failed ? null : parseReply(raw));
        });
    });
}
