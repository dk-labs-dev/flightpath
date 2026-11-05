// The hook event endpoint: store the envelope, follow its
// transcript, answer 204 — and hand over when the event came
// from a newer build.

import type { IncomingMessage, ServerResponse } from "node:http";

import { errorMessage } from "../../util/errors.js";
import { ingestEnvelope, isEnvelope } from "../ingest.js";
import { daemonLog } from "../log.js";
import { handleJsonBody, type RouteContext } from "./context.js";

export function postHookEvent(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  handleJsonBody(
    ctx,
    request,
    response,
    (res) => res.writeHead(400).end(),
    (parsed) => {
      if (!isEnvelope(parsed)) {
        response.writeHead(400).end();
        return;
      }
      try {
        ctx.noteVersion(parsed);
        if (ingestEnvelope(ctx.storage, parsed) !== "forgotten") {
          ctx.followTranscripts(parsed);
        }
      } catch (error) {
        // A storage failure must not kill the daemon: the hook
        // buffers on a non-2xx answer, so the event survives
        // and the daemon keeps serving.
        daemonLog(
          ctx.dataDir,
          `ingest failed (${errorMessage(error)}); answered 500`,
        );
        response.writeHead(500).end();
        return;
      }
      ctx.touch();
      response.writeHead(204).end();
      // The acknowledgment is out; the stream may look now
      // (ADR-0009). A session nothing watches costs the hub
      // nothing.
      const sessionId =
        typeof parsed.event.session_id === "string"
          ? parsed.event.session_id
          : undefined;
      if (sessionId !== undefined) {
        ctx.stream.noteSession(sessionId);
      }
      if (ctx.handoverVersion !== null) {
        // The event is stored and answered; stepping aside
        // now hands the next event to a daemon of the new
        // build. The short delay lets the 204 reach the hook.
        setTimeout(() => void ctx.shutdown("handover"), 25);
      }
    },
  );
}
