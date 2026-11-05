import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

import { makeTempRoot, registerCleanup } from "./cleanup.js";
import { sequencedHookEnvelope, userPromptEvent } from "./events.js";
import { seedRealisticSession } from "./seed.js";

import type { SessionData } from "../../src/api/index.js";
import { startDaemon, type RunningDaemon } from "../../src/daemon/server.js";
import { captureSession, newCapture } from "../../src/daemon/stream-capture.js";
import { newHubState, type StreamHubState } from "../../src/daemon/stream.js";
import { defaultSettings } from "../../src/settings/index.js";
import { openStorage, type Storage } from "../../src/storage/index.js";
import { DatabaseSync } from "../../src/storage/sqlite.js";

// The stream tests' shared pieces: a booted daemon, the
// stream client, and the hand-driven capture the budgets
// and the live-stream tests both run against.

export function makeDataDir(): string {
  return makeTempRoot("flightpath-stream-test-");
}

export async function bootDaemon(seededDir?: string): Promise<{
  daemon: RunningDaemon;
  dataDir: string;
}> {
  const dataDir = seededDir ?? makeDataDir();
  const daemon = await startDaemon({
    dataDir,
    version: "0.0.0",
    idleMs: 600_000,
    drainMs: 150,
  });
  if (daemon === null) throw new Error("daemon did not start");
  registerCleanup(async () => {
    await daemon.shutdown("signal");
  });
  return { daemon, dataDir };
}

export function readToken(dataDir: string): string {
  return readFileSync(join(dataDir, "token"), "utf8").trim();
}

export function envelope(event: Record<string, unknown>): string {
  return sequencedHookEnvelope("stream", event);
}

export function postHook(
  port: number,
  token: string,
  event: Record<string, unknown>,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const body = envelope(event);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/events/hook",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "x-flightpath-token": token,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePromise(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export interface StreamMessage {
  id: string | null;
  event: string;
  data: Record<string, unknown>;
}

export interface StreamClient {
  messages: StreamMessage[];
  raw: string;
  close: () => void;
  closed: Promise<void>;
  waitFor: (
    check: (messages: StreamMessage[]) => boolean,
    timeoutMs?: number,
  ) => Promise<void>;
}

export function openStream(
  port: number,
  token: string,
  path: string,
  lastEventId?: string,
): Promise<StreamClient> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = { "x-flightpath-token": token };
    if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", agent: false, headers },
      (res) => {
        res.setEncoding("utf8");
        let markClosed: () => void = () => {};
        const closed = new Promise<void>((resolveClosed) => {
          markClosed = resolveClosed;
        });
        res.on("close", markClosed);
        const client: StreamClient = {
          messages: [],
          raw: "",
          close: () => req.destroy(),
          closed,
          waitFor: async (check, timeoutMs = 10_000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              if (check(client.messages)) return;
              if (Date.now() > deadline) {
                throw new Error(
                  `stream wait timed out; saw ${JSON.stringify(client.messages.map((m) => m.event))}`,
                );
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          },
        };
        let pending = "";
        res.on("data", (chunk: string) => {
          client.raw += chunk;
          pending += chunk;
          let split = pending.indexOf("\n\n");
          while (split !== -1) {
            const block = pending.slice(0, split);
            pending = pending.slice(split + 2);
            const message = parseBlock(block);
            if (message !== null) client.messages.push(message);
            split = pending.indexOf("\n\n");
          }
        });
        resolvePromise(client);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Open a stream and wait for its sync: the client and its position. */
export async function openSyncedStream(
  port: number,
  token: string,
  path: string,
): Promise<{ client: StreamClient; syncId: string | undefined }> {
  const client = await openStream(port, token, path);
  await client.waitFor((m) => m.some((x) => x.event === "sync"));
  return {
    client,
    syncId: client.messages.find((x) => x.event === "sync")?.id ?? undefined,
  };
}

/** Reconnect from a saved position and wait for the sync. */
export async function reconnectStream(
  port: number,
  token: string,
  path: string,
  syncId: string | undefined,
): Promise<{ client: StreamClient; sync: StreamMessage | undefined }> {
  const client = await openStream(port, token, path, syncId);
  await client.waitFor((m) => m.some((x) => x.event === "sync"));
  return {
    client,
    sync: client.messages.find((x) => x.event === "sync"),
  };
}

export const SESSION = "stream-session";

export async function postPrompt(
  port: number,
  token: string,
  text: string,
): Promise<number> {
  return postHook(port, token, userPromptEvent(SESSION, text));
}

// A hub state driven by hand: the capture functions are
// synchronous, so a pass is one call and its cost is the
// call's own time.
export function captureState(
  storage: Storage,
  dataDir: string,
): StreamHubState {
  const state = newHubState({
    storage,
    settings: () => defaultSettings(),
    dataDir,
  });
  state.epoch = "test";
  state.activated = true;
  return state;
}

export function startCapture(state: StreamHubState, sessionId: string): void {
  state.captures.set(sessionId, newCapture());
  captureSession(state, sessionId, "record");
}

export function held(state: StreamHubState, sessionId: string): SessionData {
  const data = state.captures.get(sessionId)?.data;
  if (data === null || data === undefined) {
    throw new Error("the capture holds no data");
  }
  return data;
}

export interface LateUpdatePass {
  fullMs: number;
  passMs: number;
  changesBefore: number;
  changesAfter: number;
  requestOutput: number | null | undefined;
  turnImageCount: number | null | undefined;
  stepOutcome: string | null | undefined;
}

/** Seed a 5,000-request session, load it whole, land three
 *  late updates, and run one capture pass over them: the
 *  pass's cost, and what it picked up. */
export function runLateUpdatePass(dataDir: string): LateUpdatePass {
  const storage = openStorage({ dataDir });
  const db = new DatabaseSync(storage.dbPath);
  try {
    db.exec("BEGIN");
    seedRealisticSession(db, { base: Date.now() - 30_600_000 });
    db.exec("COMMIT");
    const state = captureState(storage, dataDir);
    const fullStarted = performance.now();
    startCapture(state, "sess-big");
    const fullMs = performance.now() - fullStarted;

    const request = db
      .prepare(
        "SELECT id FROM requests WHERE session_id = 'sess-big' ORDER BY id LIMIT 1",
      )
      .get() as { id: number };
    const turn = db
      .prepare(
        "SELECT id FROM turns WHERE session_id = 'sess-big' ORDER BY id LIMIT 1",
      )
      .get() as { id: number };
    const step = db
      .prepare(
        "SELECT id FROM steps WHERE session_id = 'sess-big' ORDER BY id LIMIT 1",
      )
      .get() as { id: number };
    db.prepare("UPDATE requests SET output_tokens = 424242 WHERE id = ?").run(
      request.id,
    );
    db.prepare("UPDATE turns SET image_count = 3 WHERE id = ?").run(turn.id);
    db.prepare("UPDATE steps SET outcome = 'late-outcome' WHERE id = ?").run(
      step.id,
    );
    const countChanges = (): number =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM row_changes WHERE session_id = 'sess-big'",
          )
          .get() as { n: number }
      ).n;
    const changesBefore = countChanges();

    const started = performance.now();
    captureSession(state, "sess-big", "emit");
    const passMs = performance.now() - started;
    const data = held(state, "sess-big");
    return {
      fullMs,
      passMs,
      changesBefore,
      changesAfter: countChanges(),
      requestOutput: data.requests.find((row) => row.id === request.id)
        ?.outputTokens,
      turnImageCount: data.turns.find((row) => row.id === turn.id)?.imageCount,
      stepOutcome: data.steps.find((row) => row.id === step.id)?.outcome,
    };
  } finally {
    db.close();
    storage.close();
  }
}

function parseBlock(block: string): StreamMessage | null {
  if (block.startsWith(":")) return null;
  let id: string | null = null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return {
    id,
    event,
    data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
  };
}
