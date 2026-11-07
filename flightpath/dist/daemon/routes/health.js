import { currentHealth } from "../health.js";
import { sendJson } from "./context.js";
export function getHealth(ctx, _request, response) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        version: ctx.version,
        uptime_seconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
    }));
}
/** The recorder's health for the view: the same reading the
 * stream's health message carries, plus the daemon's state. */
export function getApiHealth(ctx, _request, response) {
    sendJson(response, 200, {
        state: "running",
        ...currentHealth(ctx.dataDir, ctx.settings.autostart),
    });
}
