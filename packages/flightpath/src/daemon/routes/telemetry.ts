// Telemetry intake (ADR-0012): OTLP/HTTP with JSON encoding
// only. Protobuf gets a clean refusal, so a misconfigured
// exporter is a log line, not a mystery.

import type { IncomingMessage, ServerResponse } from "node:http";

import { daemonLog } from "../log.js";
import { handleJsonBody, type RouteContext } from "./context.js";

export function postLogs(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("protobuf")) {
    daemonLog(
      ctx.dataDir,
      "telemetry export refused: protobuf encoding is not supported; use OTLP/HTTP JSON",
    );
    response.writeHead(415).end();
    return;
  }
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => res.writeHead(400).end(),
    (parsed) => {
      const processed = ctx.telemetry.processExport(ctx.storage, parsed, {
        settings: ctx.settings,
        receivedAt: Date.now(),
      });
      if (processed.accepted > 0) {
        ctx.touch();
        // New request rows move the stream's summaries and
        // context points (ADR-0009).
        ctx.stream.noteAllSessions();
      }
      if (processed.dropped > 0 || processed.unknown > 0) {
        daemonLog(
          ctx.dataDir,
          `telemetry export: ${processed.accepted} accepted, ${processed.dropped} dropped, ${processed.unknown} unknown`,
        );
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  );
}
