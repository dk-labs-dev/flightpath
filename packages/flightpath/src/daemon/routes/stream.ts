// GET /api/stream — the live stream (ADR-0009). The hub owns
// the connections and the replay; this handler only takes the
// session and the reconnect position out of the request and
// hands over the response.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./context.js";

export function getStream(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const sessionId = url.searchParams.get("session");
  const lastEventId = request.headers["last-event-id"];
  ctx.stream.serve(
    response,
    sessionId === null || sessionId === "" ? null : sessionId,
    typeof lastEventId === "string" ? lastEventId : null,
  );
}
