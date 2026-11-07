// The route table and the checks that run before it: the
// host must be loopback, the pages are never cached, the
// public pages go first, and everything else needs the token
// (ADR-0022).
import { daemonLog } from "../log.js";
import { guardRequest, hostIsLoopback } from "./context.js";
import { postHookEvent } from "./events.js";
import { getApiHealth, getHealth } from "./health.js";
import { serveSettingsRedirect, serveViewAsset, serveViewPage, } from "./pages.js";
import { getSession, getSessions, getStep, getStorageSummary, postDismissFinding, } from "./read-api.js";
import { deleteAllData, getSettings, getTelemetrySetup, postTelemetrySetup, putSettings, } from "./settings.js";
import { postStop } from "./stop.js";
import { getStream } from "./stream.js";
import { postLogs } from "./telemetry.js";
const PUBLIC_ROUTES = [
    { method: "GET", path: "/", handle: serveViewPage },
    { method: "GET", path: "/view", handle: serveViewPage },
    { method: "GET", prefix: "/view/", handle: serveViewAsset },
    { method: "GET", path: "/settings", handle: serveSettingsRedirect },
];
const PROTECTED_ROUTES = [
    { method: "GET", path: "/api/settings", handle: getSettings },
    { method: "POST", path: "/api/delete-all-data", handle: deleteAllData },
    { method: "POST", path: "/api/stop", handle: postStop },
    { method: "PUT", path: "/api/settings", handle: putSettings },
    { method: "GET", path: "/api/telemetry-setup", handle: getTelemetrySetup },
    { method: "POST", path: "/api/telemetry-setup", handle: postTelemetrySetup },
    { method: "GET", path: "/api/sessions", handle: getSessions },
    { method: "GET", prefix: "/api/sessions/", handle: getSession },
    { method: "POST", prefix: "/api/sessions/", handle: postDismissFinding },
    { method: "GET", prefix: "/api/steps/", handle: getStep },
    { method: "GET", path: "/api/storage", handle: getStorageSummary },
    { method: "GET", path: "/api/stream", handle: getStream },
    { method: "GET", path: "/api/health", handle: getApiHealth },
    { method: "POST", path: "/v1/logs", handle: postLogs },
    // Health and the hook endpoint match the full URL: a query
    // string makes them a different address, as it always did.
    { method: "GET", url: "/health", handle: getHealth },
    { method: "POST", url: "/events/hook", handle: postHookEvent },
];
function routeMatches(route, request, path) {
    if (route.method !== request.method)
        return false;
    if (route.url !== undefined)
        return request.url === route.url;
    if (route.prefix !== undefined)
        return path.startsWith(route.prefix);
    return path === route.path;
}
export function handleRequest(ctx, request, response) {
    if (!hostIsLoopback(request.headers.host)) {
        daemonLog(ctx.dataDir, `rejected ${request.method} ${request.url} 403`);
        response.writeHead(403).end();
        return;
    }
    const path = (request.url ?? "").split("?")[0] ?? "";
    // A stale page after an update reads as missing data: the
    // pages and their APIs are never cached.
    if (path === "/" ||
        path === "/view" ||
        path === "/settings" ||
        path.startsWith("/api/")) {
        response.setHeader("cache-control", "no-store");
    }
    for (const route of PUBLIC_ROUTES) {
        if (routeMatches(route, request, path)) {
            guardRequest(ctx, request, response, () => route.handle(ctx, request, response, path));
            return;
        }
    }
    if (request.headers["x-flightpath-token"] !== ctx.token) {
        daemonLog(ctx.dataDir, `rejected ${request.method} ${request.url} 401`);
        response.writeHead(401).end();
        return;
    }
    for (const route of PROTECTED_ROUTES) {
        if (routeMatches(route, request, path)) {
            guardRequest(ctx, request, response, () => route.handle(ctx, request, response, path));
            return;
        }
    }
    response.writeHead(404).end();
}
