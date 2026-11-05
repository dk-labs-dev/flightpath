// POST /api/stop: the stop that works on Windows, where a signal
// ends the daemon without running its handler.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./context.js";

export function postStop(
  ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  // Stop only once the 204 is out, so the caller gets its answer.
  response.writeHead(204).end(() => void ctx.stop());
}
