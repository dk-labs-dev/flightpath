// The settings API: read and replace the settings, delete all
// data, and drive the telemetry setup — the settings screen's
// whole surface.
import { sessionTitle } from "../../api/sessions.js";
import { SETTING_SPECS, validateSettingsInput, } from "../../settings/index.js";
import { applyTelemetrySetup, detectTelemetrySetup, setupPaths, syncTelemetryEndpoint, undoTelemetrySetup, } from "../../setup/index.js";
import { resolveClaudeConfigDir } from "../../transcripts/index.js";
import { errorMessage } from "../../util/errors.js";
import { isPlainObject } from "../../util/json.js";
import { daemonLog } from "../log.js";
import { staleBefore } from "../retention.js";
import { handleJsonBody, sendJson } from "./context.js";
/**
 * What the settings screen is told: the settings themselves,
 * the folder they live in, which sessions are recording now
 * (a port change warns about them), and retention's stakes —
 * the database's size, how many sessions are kept, and how
 * many a purge at each offered period would delete right now.
 */
function settingsPayload(ctx) {
    const days = SETTING_SPECS.find((spec) => spec.name === "retentionDays")
        ?.values ?? [ctx.settings.retentionDays];
    const purgeCounts = {};
    const staleCutoff = staleBefore(Date.now());
    for (const value of days) {
        purgeCounts[String(value)] = ctx.storage.countSessionsOlderThan(Date.now() - value * 24 * 60 * 60 * 1000, staleCutoff);
    }
    return {
        settings: ctx.settings,
        boundPort: ctx.boundPort,
        fields: SETTING_SPECS,
        dataDir: ctx.dataDir,
        liveSessions: ctx.storage.liveSessions().map((row) => ({
            id: row.id,
            title: sessionTitle(row.firstPromptText, ctx.settings),
        })),
        retention: {
            databaseBytes: ctx.storage.databaseBytes(),
            sessionCount: ctx.storage.countSessions(),
            purgeCounts,
        },
    };
}
export function getSettings(ctx, _request, response) {
    sendJson(response, 200, settingsPayload(ctx));
}
export function deleteAllData(ctx, _request, response) {
    void ctx.retention
        .deleteAllData()
        .then((deleted) => {
        daemonLog(ctx.dataDir, `delete-all removed ${deleted} session(s)`);
        // The stream says the sessions are gone (ADR-0009).
        ctx.stream.noteAllSessions();
        sendJson(response, 200, { ok: true, deletedSessions: deleted });
    })
        .catch((error) => {
        daemonLog(ctx.dataDir, `delete-all failed (${errorMessage(error)})`);
        response.writeHead(500).end();
    });
}
/** A port change moves the telemetry endpoint setup wrote (ADR-0023). */
function syncEndpointForPortChange(ctx) {
    try {
        if (syncTelemetryEndpoint({
            paths: setupPaths({
                dataDir: ctx.dataDir,
                configDir: resolveClaudeConfigDir(),
            }),
            port: ctx.settings.port,
            token: ctx.token,
        })) {
            daemonLog(ctx.dataDir, "telemetry endpoint moved to the new port");
        }
    }
    catch (error) {
        daemonLog(ctx.dataDir, `telemetry endpoint could not be updated (${errorMessage(error)})`);
    }
}
function updateSettings(ctx, values, response) {
    const previousPort = ctx.settings.port;
    try {
        ctx.applySettings(values);
    }
    catch (error) {
        daemonLog(ctx.dataDir, `settings could not be saved (${errorMessage(error)})`);
        response.writeHead(500).end();
        return;
    }
    daemonLog(ctx.dataDir, "settings saved");
    if (ctx.settings.port !== previousPort) {
        syncEndpointForPortChange(ctx);
    }
    sendJson(response, 200, settingsPayload(ctx));
    if (ctx.settings.port !== previousPort) {
        // Restart on the new port once this answer has finished
        // going out; the page reloads itself at the new address.
        response.once("finish", () => void ctx.restart());
    }
}
export function putSettings(ctx, request, response) {
    handleJsonBody(ctx, request, response, (res) => sendJson(res, 400, { errors: { settings: "must be JSON" } }), (parsed) => {
        const result = validateSettingsInput(parsed);
        if (!result.ok) {
            sendJson(response, 400, { errors: result.errors });
            return;
        }
        updateSettings(ctx, result.values, response);
    });
}
function setupOptions(ctx) {
    return {
        paths: setupPaths({
            dataDir: ctx.dataDir,
            configDir: resolveClaudeConfigDir(),
        }),
        env: process.env,
        port: ctx.settings.port,
        token: ctx.token,
    };
}
function setupStatusPayload(ctx) {
    const state = detectTelemetrySetup(setupOptions(ctx));
    return {
        ...state,
        boundPort: ctx.boundPort,
        configuredPort: ctx.settings.port,
    };
}
export function getTelemetrySetup(ctx, _request, response) {
    sendJson(response, 200, setupStatusPayload(ctx));
}
/** The settings file mirrors the setup state, so the rest of
 *  Flightpath reads one answer. */
function mirrorSetupState(ctx, action) {
    try {
        ctx.applySettings({ telemetry: action === "on" });
    }
    catch (error) {
        daemonLog(ctx.dataDir, `settings mirror could not be saved (${errorMessage(error)})`);
    }
    daemonLog(ctx.dataDir, `telemetry setup ${action}`);
}
export function postTelemetrySetup(ctx, request, response) {
    handleJsonBody(ctx, request, response, (res) => sendJson(res, 400, { ok: false, message: "action must be on or off" }), (parsed) => {
        const action = isPlainObject(parsed) ? parsed.action : undefined;
        if (action !== "on" && action !== "off") {
            sendJson(response, 400, {
                ok: false,
                message: "action must be on or off",
            });
            return;
        }
        const outcome = action === "on"
            ? applyTelemetrySetup(setupOptions(ctx))
            : undoTelemetrySetup({ paths: setupOptions(ctx).paths });
        if (outcome.ok) {
            mirrorSetupState(ctx, action);
        }
        sendJson(response, outcome.ok ? 200 : 400, {
            ok: outcome.ok,
            message: outcome.message,
            status: setupStatusPayload(ctx),
        });
    });
}
