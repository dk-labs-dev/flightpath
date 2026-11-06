// The read API's routes: the session list, one session's
// snapshot, one step's detail, and the storage summary — the
// view's read surface, behind the router's token check — and
// the one write beside them, dismissing a finding. The shaping
// itself lives in the api module; these handlers only take the
// ids out of the path and write the answer.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  dismissFinding,
  listSessions,
  sessionContext,
  sessionFindings,
  sessionSnapshot,
  sessionTerminalLine,
  sessionTokens,
  stepDetail,
  storageSummary,
} from "../../api/index.js";
import type { ContextAsk, SessionsPayload } from "../../api/payloads.js";
import {
  readAutoCompactWindow,
  resolveClaudeConfigDir,
} from "../../transcripts/index.js";
import { sendJson, type RouteContext } from "./context.js";

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404).end();
}

/** The payload, or a 404 when the session it describes is unknown. */
function sendFound(response: ServerResponse, payload: unknown): void {
  if (payload === undefined) sendNotFound(response);
  else sendJson(response, 200, payload);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function askFor(kind: "step" | "request", raw: string): ContextAsk | null {
  const id = raw === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(id)) return null;
  return kind === "step" ? { step: id } : { request: id };
}

function contextAsk(params: URLSearchParams): ContextAsk | null {
  const step = params.get("step");
  const request = params.get("request");
  if (step !== null && request === null) return askFor("step", step);
  if (request !== null && step === null) return askFor("request", request);
  return null;
}

export function getSessions(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const payload: SessionsPayload = listSessions(
    ctx.storage,
    ctx.settings,
    url.searchParams.get("q"),
  );
  sendJson(response, 200, payload);
}

/** One session's own routes: its snapshot, its token history,
 * its findings, the line its terminal prints when a turn ends
 * and the context at one step or one request. */
export function getSession(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): void {
  const rest = path.slice("/api/sessions/".length);
  const slash = rest.lastIndexOf("/");
  const segment = slash === -1 ? "" : rest.slice(0, slash);
  const leaf = slash === -1 ? "" : rest.slice(slash + 1);
  const sessionId =
    segment !== "" && !segment.includes("/") ? decodeSegment(segment) : null;
  if (
    sessionId === null ||
    (leaf !== "snapshot" &&
      leaf !== "tokens" &&
      leaf !== "context" &&
      leaf !== "findings" &&
      leaf !== "terminal-line")
  ) {
    sendNotFound(response);
    return;
  }
  if (leaf === "snapshot") {
    sendFound(response, sessionSnapshot(ctx.storage, ctx.settings, sessionId));
    return;
  }
  const { searchParams } = new URL(request.url ?? "", "http://127.0.0.1");
  if (leaf === "context") {
    const ask = contextAsk(searchParams);
    if (ask === null) {
      response.writeHead(400).end();
      return;
    }
    sendFound(response, sessionContext(ctx.storage, sessionId, ask));
    return;
  }
  if (leaf === "findings") {
    sendFound(response, sessionFindings(ctx.storage, sessionId));
    return;
  }
  if (leaf === "terminal-line") {
    const promptId = searchParams.get("prompt") ?? "";
    sendFound(response, sessionTerminalLine(ctx.storage, sessionId, promptId));
    return;
  }
  const history = sessionTokens(ctx.storage, sessionId, {
    autoCompactWindow: readAutoCompactWindow(resolveClaudeConfigDir()),
    storePromptText: ctx.settings.storePromptText,
  });
  sendFound(response, history);
}

const DISMISS_PATH = /^\/api\/sessions\/([^/]+)\/findings\/([^/]+)\/dismiss$/;

function dismissTarget(
  path: string,
): { sessionId: string; findingId: string } | null {
  const match = DISMISS_PATH.exec(path);
  if (match === null) return null;
  const sessionId = decodeSegment(match[1] ?? "");
  const findingId = decodeSegment(match[2] ?? "");
  return sessionId === null || findingId === null
    ? null
    : { sessionId, findingId };
}

/** POST /api/sessions/:id/findings/:findingId/dismiss */
export function postDismissFinding(
  ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
  path: string,
): void {
  const target = dismissTarget(path);
  if (
    target === null ||
    !dismissFinding(ctx.storage, target.sessionId, target.findingId)
  ) {
    sendNotFound(response);
    return;
  }
  response.writeHead(200).end();
}

export function getStep(
  ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
  path: string,
): void {
  const segment = path.slice("/api/steps/".length);
  const stepId = Number(segment);
  const detail =
    segment !== "" &&
    !segment.includes("/") &&
    Number.isInteger(stepId) &&
    stepId > 0
      ? stepDetail(ctx.storage, stepId)
      : undefined;
  if (detail === undefined) {
    sendNotFound(response);
    return;
  }
  sendJson(response, 200, detail);
}

export function getStorageSummary(
  ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  sendJson(response, 200, storageSummary(ctx.storage));
}
