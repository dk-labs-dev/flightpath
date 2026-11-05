// The daemon's routes share one runtime: everything a handler
// needs from the daemon that hosts it — storage, settings, the
// intake and follower, and the lifecycle verbs — in one object
// the server builds and owns. The routes receive it read-only
// (RouteContext below) and change it only through its verbs.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Settings } from "../../settings/index.js";
import type { Storage } from "../../storage/index.js";
import type { TelemetryIntake } from "../../telemetry/index.js";
import type { TranscriptFollower } from "../../transcripts/index.js";
import { errorMessage } from "../../util/errors.js";
import type { Envelope } from "../ingest.js";
import { daemonLog } from "../log.js";
import type { Retention } from "../retention.js";
import type { SessionWatch } from "../session-watch.js";
import type { StreamHub } from "../stream.js";
import type { ShutdownReason } from "../stream-messages.js";

interface DaemonTimers {
  drain?: ReturnType<typeof setInterval>;
  idle?: ReturnType<typeof setInterval>;
  refollow?: ReturnType<typeof setInterval>;
  retention?: ReturnType<typeof setInterval>;
  sessionWatch?: ReturnType<typeof setInterval>;
}

export interface DaemonRuntime {
  dataDir: string;
  version: string;
  /** The caller's idle override, when a test set one. */
  idleOptionMs: number | undefined;
  storage: Storage;
  transcripts: TranscriptFollower;
  telemetry: TelemetryIntake;
  retention: Retention;
  /** Ends live sessions whose Claude Code session is gone. */
  sessionWatch: SessionWatch;
  /** The live stream's hub (ADR-0009). */
  stream: StreamHub;
  token: string;
  startedAt: number;
  settings: Settings;
  idleMs: number;
  boundPort: number;
  lastActivity: number;
  handoverVersion: string | null;
  closed: boolean;
  inFlight: Set<Promise<unknown>>;
  loggedBadFiles: Set<string>;
  timers: DaemonTimers;
  /** Note a newer build's arrival; the daemon hands over. */
  noteVersion(envelope: Envelope): void;
  /** Follow an admitted session's transcript, in the background. */
  followTranscripts(envelope: Envelope): void;
  /** Stop the daemon, telling its pages the reason first. */
  shutdown(reason: ShutdownReason): Promise<void>;
  /** Stop because a signal or the stop route asked. */
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Note activity: the idle clock starts over. */
  touch(): void;
  /**
   * Merge values into the settings and save them, keeping
   * the idle limit in step. Throws when the save fails.
   */
  applySettings(values: Partial<Settings>): void;
}

/** What a route handler receives: the runtime, read-only. */
export type RouteContext = Readonly<DaemonRuntime>;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The request's whole body, or null past the size limit. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolvePromise(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolvePromise(Buffer.concat(chunks).toString("utf8")),
    );
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
export function guardRequest(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  run: () => void,
): void {
  try {
    run();
  } catch (error) {
    daemonLog(
      ctx.dataDir,
      `${request.method ?? ""} ${request.url ?? ""} failed (${errorMessage(error)}); answered 500`,
    );
    if (!response.headersSent) {
      response.writeHead(500).end();
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

/**
 * Read a JSON request body and hand the parsed value over:
 * past the size limit the answer is 413, and a body that is
 * not JSON gets the route's own bad-JSON answer.
 */
export function handleJsonBody(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  badJson: (response: ServerResponse) => void,
  handle: (parsed: unknown) => void,
): void {
  void readBody(request).then((body) => {
    if (body === null) {
      response.writeHead(413).end();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      badJson(response);
      return;
    }
    guardRequest(ctx, request, response, () => handle(parsed));
  });
}

/** Write a value as the route's JSON answer. */
export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
}

export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}
