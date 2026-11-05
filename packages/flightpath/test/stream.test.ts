import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { registerCleanup, runCleanups } from "./support/cleanup.js";
import { NO_CATEGORIES } from "./support/context-report.js";
import {
  callDaemon,
  listenOnFreePort,
  makeRoot,
  waitFor,
} from "./support/daemon.js";
import {
  apiRequestLine,
  compactBoundaryLine,
  compactFileReferenceLine,
  fileAttachmentLine,
  apiRequestShapeLine,
  CACHE_CONTROL_1H,
  type EventFields,
  hookEvent,
  recordHookEvent,
  sessionStartEvent,
  transcriptAssistantLine,
  transcriptUserLine,
  userPromptEvent,
} from "./support/events.js";
import {
  seedBranch,
  seedPromptAttachment,
  seedRequest,
  seedSample,
  seedSession,
} from "./support/seed.js";
import {
  bootDaemon,
  captureState,
  envelope,
  held,
  makeDataDir,
  openStream,
  openSyncedStream,
  postHook,
  postPrompt,
  readToken,
  reconnectStream,
  runLateUpdatePass,
  SESSION,
  startCapture,
  type StreamClient,
} from "./support/stream.js";
import { iso } from "./support/time.js";
import { followLines, makeTranscriptWorld } from "./support/worlds.js";

import { sessionSnapshot, tokenHistory } from "../src/api/index.js";
import type { SessionSnapshot, SnapshotSummary } from "../src/api/payloads.js";
import { ingestEnvelope, isEnvelope } from "../src/daemon/ingest.js";
import type { RunningDaemon } from "../src/daemon/server.js";
import { captureSession } from "../src/daemon/stream-capture.js";
import { createStreamHub, type StreamHubState } from "../src/daemon/stream.js";
import type {
  StreamHealth,
  StreamMessage as DaemonMessage,
} from "../src/daemon/stream-messages.js";
import { defaultSettings } from "../src/settings/index.js";
import {
  ATTACHMENT_ROWS_SINCE_SQL,
  ATTACHMENTS_FOR_TURN_SQL,
  BRANCH_BY_ID_SQL,
  BRANCH_ROWS_SINCE_SQL,
  HUMAN_ROWS_SINCE_SQL,
  LOAD_ROWS_SINCE_SQL,
  PAUSE_BY_ID_SQL,
  CHANGE_MAX_SEQ_SQL,
  PAUSE_ROWS_SINCE_SQL,
  REQUEST_BY_ID_SQL,
  REQUEST_ROWS_FOR_BRANCH_SQL,
  REQUEST_ROWS_SINCE_SQL,
  ROW_CHANGES_SINCE_SQL,
  SAMPLE_BY_ID_SQL,
  SAMPLE_ROWS_SINCE_SQL,
  SEGMENT_ROWS_SINCE_SQL,
  SESSION_SCAN_SQL,
  STEP_ROWS_SINCE_SQL,
  STREAM_PROBE_SQL,
  TURN_BY_ID_SQL,
  TURN_ROWS_SINCE_SQL,
  openStorage,
  type Storage,
} from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";

import {
  LiveStream,
  type SnapshotLoad,
  type StreamSink,
  type StreamStatus,
} from "../../view/src/stream.js";

// The live stream (ADR-0009), exercised against an in-process
// daemon and, for the leak check, a hub on its own listener:
// framing, replay, reset and the connection count are the
// contract's testable edges. The stream's wall-clock bounds
// live in stream-budget.test.ts.
afterEach(async () => {
  await runCleanups();
});

/** A booted daemon with a session stream open on it. */
async function bootWithSessionStream(): Promise<{
  daemon: RunningDaemon;
  token: string;
  path: string;
  first: StreamClient;
  syncId: string | undefined;
}> {
  const { daemon, dataDir } = await bootDaemon();
  const token = readToken(dataDir);
  const path = `/api/stream?session=${SESSION}`;
  const { client: first, syncId } = await openSyncedStream(
    daemon.port,
    token,
    path,
  );
  return { daemon, token, path, first, syncId };
}

/** A booted daemon and its picker stream, open and synced. */
async function bootWithPickerStream(): Promise<{
  daemon: RunningDaemon;
  token: string;
  picker: StreamClient;
}> {
  const { daemon, dataDir } = await bootDaemon();
  const token = readToken(dataDir);
  const picker = await openStream(daemon.port, token, "/api/stream");
  await picker.waitFor((m) => m.some((x) => x.event === "sync"));
  return { daemon, token, picker };
}

/** Wait until the picker stream shows the session's row. */
async function pickerSawSessionRow(picker: StreamClient): Promise<void> {
  await picker.waitFor((m) =>
    m.some(
      (x) =>
        x.event === "session" &&
        (x.data.session as Record<string, unknown> | undefined)?.id === SESSION,
    ),
  );
}

function toolPair(toolUseId: string): Record<string, unknown>[] {
  return [
    hookEvent("PreToolUse", {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: `echo ${toolUseId}` },
    }),
    hookEvent("PostToolUse", {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_response: { ok: true },
    }),
  ];
}

function sessionEvents(stepCount: number): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    sessionStartEvent("startup", SESSION),
    userPromptEvent(SESSION, "stream test prompt"),
  ];
  for (let i = 1; i <= stepCount; i += 1) {
    events.push(...toolPair(`tu-${i}`));
  }
  return events;
}

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
type World = ReturnType<typeof makeTranscriptWorld>;

function seedLive(world: World): void {
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "SessionStart",
      session_id: "sess-live",
      source: "startup",
      cwd: "/home/user/proj-a",
      version: "2.0.0",
    },
    T0,
  );
  recordHookEvent(
    world.storage,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-live",
      prompt_id: "p-1",
      prompt: "write the report",
    },
    T0 + 1000,
  );
}

describe("the live stream", () => {
  it("opens with the health state, then sync, under one epoch", async () => {
    const { daemon, dataDir } = await bootDaemon();
    const client = await openStream(
      daemon.port,
      readToken(dataDir),
      "/api/stream",
    );
    await client.waitFor((messages) => messages.length >= 2);
    const [health, sync] = client.messages;
    expect(health?.event).toBe("health");
    expect(health?.data).toMatchObject({ buffered: 0, dropped: 0 });
    expect(sync?.event).toBe("sync");
    expect(sync?.data).toEqual({ replayed: 0, reset: false });
    expect(health?.id).toMatch(/^[0-9a-f]+:\d+$/);
    expect(sync?.id?.split(":")[0]).toBe(health?.id?.split(":")[0]);
    client.close();
  });

  it("refuses the stream without the token", async () => {
    const { daemon } = await bootDaemon();
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: "/api/stream",
    });
    expect(reply.status).toBe(401);
  });

  it("streams a session's changes as they are stored, sentence included", async () => {
    const { daemon, token, picker } = await bootWithPickerStream();
    for (const event of sessionEvents(1)) {
      await postHook(daemon.port, token, event);
    }
    await pickerSawSessionRow(picker);
    const client = await openStream(
      daemon.port,
      token,
      `/api/stream?session=${SESSION}`,
    );
    await client.waitFor((m) => m.some((x) => x.event === "sync"));
    await postPrompt(daemon.port, token, "a second question");
    await postHook(daemon.port, token, {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Read",
      tool_use_id: "tu-later",
      tool_input: { file_path: "/work/app/notes.md" },
    });
    await client.waitFor((m) =>
      m.some(
        (x) =>
          x.event === "step" &&
          (x.data.step as Record<string, unknown>).toolName === "Read",
      ),
    );
    const stepMessage = client.messages.find((x) => x.event === "step");
    const step = stepMessage?.data.step as Record<string, unknown>;
    expect(typeof step.sentence).toBe("string");
    expect((step.sentence as string).length).toBeGreaterThan(0);
    expect(typeof stepMessage?.data.turnId).toBe("number");
    expect(client.messages.some((x) => x.event === "turn")).toBe(true);
    expect(client.messages.some((x) => x.event === "human")).toBe(true);
    expect(client.messages.some((x) => x.event === "session")).toBe(true);
    client.close();
    picker.close();
  }, 60_000);

  it("takes a session that ends empty out of the picker, counted", async () => {
    const { daemon, token, picker } = await bootWithPickerStream();
    // A session starts and, while the list is open, ends
    // with nothing in it: no prompt, no request.
    await postHook(daemon.port, token, sessionStartEvent("startup", SESSION));
    await pickerSawSessionRow(picker);
    await postHook(
      daemon.port,
      token,
      hookEvent("SessionEnd", { session_id: SESSION }),
    );
    await picker.waitFor((m) =>
      m.some(
        (x) =>
          x.event === "session" &&
          x.data.sessionId === SESSION &&
          x.data.hidden === true,
      ),
    );
    const hidden = picker.messages.find(
      (x) => x.event === "session" && x.data.hidden === true,
    );
    expect(hidden?.data.emptyHidden).toBe(1);
    // The only row the picker ever saw for it was the live
    // one: the ended, empty row never reached the list.
    const rows = picker.messages.filter(
      (x) => x.event === "session" && x.data.session !== undefined,
    );
    expect(
      rows.every(
        (x) => (x.data.session as Record<string, unknown>).status === "live",
      ),
    ).toBe(true);
    picker.close();
  }, 60_000);

  it("replays what a reconnect missed, in order, without repeats", async () => {
    const { daemon, token, path, first, syncId } =
      await bootWithSessionStream();
    for (const event of sessionEvents(2)) {
      await postHook(daemon.port, token, event);
    }
    await first.waitFor(
      (m) =>
        m.filter((x) => x.event === "step").length >= 2 &&
        m.some((x) => x.event === "session"),
    );
    first.close();
    // Work happens while the page is away.
    for (const event of toolPair("tu-away")) {
      await postHook(daemon.port, token, event);
    }
    const { client: second, sync } = await reconnectStream(
      daemon.port,
      token,
      path,
      syncId,
    );
    expect((sync?.data.replayed as number) ?? 0).toBeGreaterThanOrEqual(3);
    expect(sync?.data.reset).toBe(false);
    // The away step's own capture lands within the hub's
    // debounce; whether it replays or follows live, it arrives
    // exactly once.
    await second.waitFor((m) =>
      m.some(
        (x) =>
          x.event === "step" &&
          (x.data.step as Record<string, unknown>).id === 3,
      ),
    );
    const replayed = second.messages.filter(
      (m) => m.event !== "health" && m.event !== "sync",
    );
    const replayedIds = replayed.map((m) => m.id);
    expect(new Set(replayedIds).size).toBe(replayedIds.length);
    const syncSeq = Number((syncId ?? ":0").split(":")[1]);
    const seqs = replayedIds.map((id) => Number((id ?? ":0").split(":")[1]));
    for (const seq of seqs) {
      expect(seq).toBeGreaterThan(syncSeq);
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const stepIds = second.messages
      .filter((m) => m.event === "step")
      .map((m) => (m.data.step as Record<string, unknown>).id);
    expect(stepIds).toContain(3);
    second.close();
  }, 60_000);

  it("answers a foreign epoch with reset, then sync", async () => {
    const { daemon, dataDir } = await bootDaemon();
    const token = readToken(dataDir);
    const client = await openStream(
      daemon.port,
      token,
      `/api/stream?session=${SESSION}`,
      "deadbeef:1",
    );
    await client.waitFor((m) => m.some((x) => x.event === "sync"));
    const events = client.messages.map((m) => m.event);
    expect(events.indexOf("reset")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("reset")).toBeLessThan(events.indexOf("sync"));
    const sync = client.messages.find((x) => x.event === "sync");
    expect(sync?.data).toEqual({ replayed: 0, reset: true });
    client.close();
  });

  it("answers an evicted position with reset", async () => {
    const { daemon, token, path, first, syncId } =
      await bootWithSessionStream();
    first.close();
    // The ring holds the last 2,000 changes; each prompt is
    // worth several (its turn, its moment, the turn it
    // closed, the summaries), so fifteen hundred prompts
    // push the sync position well out of it.
    for (let i = 0; i < 1500; i += 1) {
      await postPrompt(daemon.port, token, `prompt ${i}`);
    }
    const { client: second, sync } = await reconnectStream(
      daemon.port,
      token,
      path,
      syncId,
    );
    expect(sync?.data.reset).toBe(true);
    expect(second.messages.some((x) => x.event === "reset")).toBe(true);
    second.close();
  }, 120_000);

  it("sends a comment heartbeat while a page sits idle", async () => {
    const { daemon, dataDir } = await bootDaemon();
    const client = await openStream(
      daemon.port,
      readToken(dataDir),
      "/api/stream",
    );
    await client.waitFor((m) => m.some((x) => x.event === "sync"));
    const deadline = Date.now() + 25_000;
    while (!client.raw.includes(": hb")) {
      if (Date.now() > deadline) {
        throw new Error("no heartbeat within 25 s");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    client.close();
  }, 40_000);
});

type LiveHub = ReturnType<typeof createStreamHub>;

/** Run against a hub served on a real port, then close both. */
async function withLiveHub(
  storage: Storage,
  dataDir: string,
  run: (hub: LiveHub, port: number) => Promise<void>,
): Promise<void> {
  const hub = createStreamHub({
    storage,
    settings: () => defaultSettings(),
    dataDir,
  });
  const server: Server = createServer((_req, res) => {
    hub.serve(res, null, null);
  });
  const port = await listenOnFreePort(server);
  hub.start();
  try {
    await run(hub, port);
  } finally {
    hub.stop({ event: "stopping", data: { reason: "signal" } });
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    );
  }
}

describe("the stream hub's connections", () => {
  it("leaves none behind after a hundred open-close cycles", async () => {
    const dataDir = makeDataDir();
    const storage = openStorage({ dataDir });
    await withLiveHub(storage, dataDir, async (hub, port) => {
      for (let i = 0; i < 100; i += 1) {
        await cycleOnce(port);
      }
      const deadline = Date.now() + 10_000;
      while (hub.connectionCount() !== 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `connections leaked: ${hub.connectionCount()} still open`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(hub.connectionCount()).toBe(0);
    });
    storage.close();
  }, 60_000);
});

function cycleOnce(port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/stream",
        method: "GET",
        agent: false,
      },
      (res: IncomingMessage) => {
        res.once("data", () => {
          req.destroy();
          resolvePromise();
        });
        res.on("error", () => resolvePromise());
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A sink that keeps what the client hands it, in order, and
 * answers its step count from what it holds: a snapshot
 * replaces the rows, a deletion clears them. */
class HubSink implements StreamSink {
  readonly statuses: StreamStatus[] = [];
  readonly snapshots: SessionSnapshot[] = [];
  readonly summaries: SnapshotSummary[] = [];
  readonly healthReadings: StreamHealth[] = [];
  private readonly stepIds = new Set<number>();

  change(message: DaemonMessage): void {
    if (message.event === "step") this.stepIds.add(message.data.step.id);
  }

  summary(summary: SnapshotSummary): void {
    this.summaries.push(summary);
  }

  health(health: StreamHealth): void {
    this.healthReadings.push(health);
  }

  snapshot(snapshot: SessionSnapshot): void {
    this.snapshots.push(snapshot);
    this.stepIds.clear();
    for (const turn of snapshot.turns) {
      for (const step of turn.steps) this.stepIds.add(step.id);
    }
  }

  deleted(): void {
    this.stepIds.clear();
  }

  status(status: StreamStatus): void {
    this.statuses.push(status);
  }

  stepCount(): number {
    return this.stepIds.size;
  }
}

describe("the stream client against the real hub", () => {
  it("retries a reset's failed snapshot load in the client, and reports caught up only once a load lands", async () => {
    const dataDir = makeDataDir();
    const storage = openStorage({ dataDir });
    const ingest = (event: Record<string, unknown>): void => {
      const parsed: unknown = JSON.parse(envelope(event));
      if (!isEnvelope(parsed)) throw new Error("bad envelope");
      ingestEnvelope(storage, parsed);
    };
    for (const event of sessionEvents(1)) ingest(event);
    let hub = createStreamHub({
      storage,
      settings: () => defaultSettings(),
      dataDir,
    });
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      if (url.pathname === "/api/stream") {
        const lastEventId = req.headers["last-event-id"];
        hub.serve(
          res,
          url.searchParams.get("session"),
          typeof lastEventId === "string" ? lastEventId : null,
        );
        return;
      }
      res.writeHead(404).end();
    });
    const port = await listenOnFreePort(server);
    hub.start();
    const sink = new HubSink();
    let loads = 0;
    const stream = new LiveStream({
      sessionId: SESSION,
      token: "test-token",
      baseUrl: `http://127.0.0.1:${port}`,
      loadSnapshot: (sessionId): Promise<SnapshotLoad> => {
        loads += 1;
        if (loads === 1) {
          // The gap gains a step while the load is being
          // retried; the snapshot that finally lands must
          // already contain it.
          for (const event of toolPair("tu-gap")) ingest(event);
          hub.noteSession(SESSION);
          return Promise.resolve({ kind: "failed" });
        }
        const snapshot = sessionSnapshot(storage, defaultSettings(), sessionId);
        return Promise.resolve(
          snapshot === undefined
            ? { kind: "gone" }
            : { kind: "loaded", snapshot },
        );
      },
      sink,
    });
    registerCleanup(async () => {
      stream.stop();
      hub.stop({ event: "stopping", data: { reason: "signal" } });
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      storage.close();
    });
    // The screen's opening load, before the stream starts:
    // the sink holds the session's first step.
    const opening = sessionSnapshot(storage, defaultSettings(), SESSION);
    if (opening === undefined) throw new Error("session did not seed");
    sink.snapshot(opening);
    stream.start();
    await waitFor(() => sink.statuses.some((s) => s.kind === "live"));
    for (const event of toolPair("tu-live")) ingest(event);
    hub.noteSession(SESSION);
    await waitFor(() => sink.stepCount() === 2);
    // The daemon restarts: a new hub, a new epoch. The
    // client's reconnect carries the old epoch, so the hub
    // answers reset — and the first reload fails.
    hub.stop({ event: "stopping", data: { reason: "signal" } });
    hub = createStreamHub({
      storage,
      settings: () => defaultSettings(),
      dataDir,
    });
    hub.start();
    await waitFor(
      () => sink.statuses.some((s) => s.kind === "caught-up"),
      30_000,
    );
    expect(loads).toBe(2);
    const caughtUps = sink.statuses.filter((s) => s.kind === "caught-up");
    expect(caughtUps).toEqual([{ kind: "caught-up", steps: 1, away: null }]);
    // The failed load was reported, not hidden: a down stands
    // between the reconnect and the catch-up.
    const caughtUpAt = sink.statuses.findIndex((s) => s.kind === "caught-up");
    expect(sink.statuses[caughtUpAt - 1]?.kind).toBe("down");
    expect(sink.snapshots).toHaveLength(2);
    const landed = sink.snapshots[sink.snapshots.length - 1];
    expect(
      landed?.turns.flatMap((turn) => turn.steps.map((step) => step.id)),
    ).toContain(3);
    expect(sink.stepCount()).toBe(3);
  }, 60_000);
});

describe("the change table's bound", () => {
  // One step, updated 10,000 times: every update records a
  // change entry. Returns the counter for the entries left.
  function seedUnwatchedChanges(storage: Storage): () => number {
    const db = new DatabaseSync(storage.dbPath);
    db.exec(`
      INSERT INTO sessions (id, first_seen_at, last_seen_at)
        VALUES ('sess-unwatched', 1, 1);
      INSERT INTO steps (id, session_id, tool_name)
        VALUES (1, 'sess-unwatched', 'Read');
    `);
    const update = db.prepare("UPDATE steps SET outcome = ? WHERE id = 1");
    db.exec("BEGIN");
    for (let i = 0; i < 10_000; i += 1) update.run(`run-${i}`);
    db.exec("COMMIT");
    db.close();
    return () => {
      const check = new DatabaseSync(storage.dbPath);
      try {
        const row = check
          .prepare(
            "SELECT COUNT(*) AS n FROM row_changes WHERE session_id = 'sess-unwatched'",
          )
          .get() as { n: number };
        return row.n;
      } finally {
        check.close();
      }
    };
  }

  it("leaves no change rows for a session nobody watches, however much its writers write", async () => {
    const dataDir = makeDataDir();
    const storage = openStorage({ dataDir });
    const countChanges = seedUnwatchedChanges(storage);
    expect(countChanges()).toBe(10_000);

    // A hub pass with the hub live and no capture for the
    // session drops its entries: a capture that ever starts
    // loads in full, so nothing it needs goes with them.
    await withLiveHub(storage, dataDir, async (_hub, port) => {
      await cycleOnce(port);
      await waitFor(() => countChanges() === 0, 10_000);
      expect(countChanges()).toBe(0);
    });
    storage.close();
  }, 60_000);

  it("leaves no change rows before the first page ever opens", async () => {
    const dataDir = makeDataDir();
    const storage = openStorage({ dataDir });
    const countChanges = seedUnwatchedChanges(storage);
    expect(countChanges()).toBe(10_000);

    // No connection ever arrives, so the hub never activates:
    // one flush still clears the entries, because no capture
    // will ever consume them.
    const hub = createStreamHub({
      storage,
      settings: () => defaultSettings(),
      dataDir,
    });
    hub.noteAllSessions();
    await waitFor(() => countChanges() === 0, 10_000);
    expect(countChanges()).toBe(0);
    storage.close();
  }, 60_000);
});

describe("the token history on live data", () => {
  /** Follow one main request's lines, then hold the session.
   * The lines come back so a test can append and follow again. */
  async function followOneRequest(
    world: World,
    usage: EventFields,
  ): Promise<{
    state: StreamHubState;
    context: { autoCompactWindow: null; storePromptText: boolean };
    lines: string[];
  }> {
    const lines = [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      transcriptAssistantLine(T0 + 4000, "req-1", usage),
    ];
    await followLines(world, lines);
    const state = captureState(world.storage, world.dataDir);
    startCapture(state, "sess-live");
    return {
      state,
      context: { autoCompactWindow: null, storePromptText: true },
      lines,
    };
  }

  /** Seed the live session and follow its one request, a
   * 5,000-token point, then hold the session. */
  async function followLiveRequest(world: World): Promise<{
    state: StreamHubState;
    context: { autoCompactWindow: null; storePromptText: boolean };
    lines: string[];
  }> {
    seedLive(world);
    return followOneRequest(world, {
      input_tokens: 1000,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
    });
  }

  it("includes a new request in a live session's history after one pass", async () => {
    const world = makeTranscriptWorld();
    const { state, context, lines } = await followLiveRequest(world);
    expect(
      tokenHistory(held(state, "sess-live"), context).main.map(
        (point) => point.tokens,
      ),
    ).toEqual([5_000]);

    lines.push(
      transcriptAssistantLine(T0 + 6000, "req-2", {
        input_tokens: 2000,
        output_tokens: 20,
        cache_read_input_tokens: 9000,
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    expect(
      tokenHistory(held(state, "sess-live"), context).main.map(
        (point) => point.tokens,
      ),
    ).toEqual([5_000, 11_000]);

    // A load recorded after the capture started reaches the
    // held rows on the next pass, through the same delta.
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "sess-live",
        file_path: "/home/user/proj-a/CLAUDE.md",
        memory_type: "Project",
      },
      T0 + 7000,
    );
    captureSession(state, "sess-live", "emit");
    expect(
      held(state, "sess-live").loads.some(
        (load) => load.filePath === "/home/user/proj-a/CLAUDE.md",
      ),
    ).toBe(true);
  });

  it("fills a held instruction load's size through the delta when its entry is followed", async () => {
    const world = makeTranscriptWorld();
    const { state, lines } = await followLiveRequest(world);

    // The hook records the load with no size: the file was
    // already gone when the daemon tried to stat it.
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "sess-live",
        file_path: "/home/user/proj-a/CLAUDE.md",
        memory_type: "Project",
      },
      T0 + 7000,
    );
    captureSession(state, "sess-live", "emit");
    const sizeless = held(state, "sess-live").loads.find(
      (load) => load.filePath === "/home/user/proj-a/CLAUDE.md",
    );
    expect(sizeless?.sizeBytes).toBeNull();

    // The transcript's instructions entry carries the file's
    // text, and following it fills the held row's size in
    // place: the next pass brings the filled row through the
    // change feed, as a delta on the row already held.
    lines.push(
      JSON.stringify({
        type: "attachment",
        timestamp: iso(T0 + 8000),
        attachment: {
          type: "instructions",
          files: [
            {
              type: "Project",
              path: "/home/user/proj-a/CLAUDE.md",
              content: "x".repeat(1_619),
            },
          ],
        },
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    const filled = held(state, "sess-live").loads.find(
      (load) => load.filePath === "/home/user/proj-a/CLAUDE.md",
    );
    expect(filled?.id).toBe(sizeless?.id);
    expect(filled?.sizeBytes).toBe(1_619);
  });

  it("fills a held skill load's size and brings its files through the delta", async () => {
    const world = makeTranscriptWorld();
    const { state, lines } = await followLiveRequest(world);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        tool_name: "Skill",
        tool_use_id: "toolu_skill",
        tool_input: { skill: "code-style" },
      },
      T0 + 7000,
    );
    captureSession(state, "sess-live", "emit");
    const skill = held(state, "sess-live").loads.find(
      (load) => load.kind === "skill",
    );
    expect(skill?.sizeBytes).toBeNull();

    lines.push(
      transcriptUserLine(T0 + 8000, {
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /skills/code-style\n".padEnd(
              3_000,
              "x",
            ),
          },
        ],
        extra: { isMeta: true },
      }),
      fileAttachmentLine(T0 + 8000, {
        displayPath: "docs/a.md",
        filename: "/home/user/proj-a/docs/a.md",
        content: "x".repeat(800),
        lines: 20,
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    const data = held(state, "sess-live");
    expect(data.loads.find((load) => load.id === skill?.id)?.sizeBytes).toBe(
      3_000,
    );
    expect(
      data.skillFilesByLoad
        .get(skill?.id ?? -1)
        ?.map(({ filePath, sizeBytes, lineCount }) => ({
          filePath,
          sizeBytes,
          lineCount,
        })),
    ).toEqual([{ filePath: "docs/a.md", sizeBytes: 800, lineCount: 20 }]);
  });

  it("brings the trigger a hook gives a held transcript-recorded skill load through the delta", async () => {
    const world = makeTranscriptWorld();
    const { state, lines } = await followLiveRequest(world);
    lines.push(
      transcriptUserLine(T0 + 8000, {
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /skills/code-style\n".padEnd(
              3_000,
              "x",
            ),
          },
        ],
        extra: { isMeta: true },
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    const skill = held(state, "sess-live").loads.find(
      (load) => load.kind === "skill",
    );
    expect(skill).toMatchObject({ sizeBytes: 3_000, trigger: null });

    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        tool_name: "Skill",
        tool_use_id: "toolu_skill",
        tool_input: { skill: "code-style" },
      },
      T0 + 8640,
    );
    captureSession(state, "sess-live", "emit");
    const loads = held(state, "sess-live").loads.filter(
      (load) => load.kind === "skill",
    );
    expect(loads).toMatchObject([{ id: skill?.id, trigger: "agent" }]);
  });

  it("shows a report written during a live session in the next pass's room", async () => {
    const world = makeTranscriptWorld();
    const { state, context, lines } = await followLiveRequest(world);
    // The followed requests ran on a model the list does not
    // name, so the room's window is unknown until a report
    // speaks for that model.
    expect(tokenHistory(held(state, "sess-live"), context).room.window).toEqual(
      { tokens: null, source: "unknown", reportedAt: null },
    );

    // The user runs /context mid-session: its report lands
    // in the transcript as a meta entry and is followed.
    lines.push(
      transcriptUserLine(T0 + 8000, {
        content: [
          "## Context Usage",
          "",
          "**Model:** claude-sonnet",
          "**Tokens:** 5k / 300k (2%)",
          "",
          "| Skills | 8.3k | 2.8% |",
          "| Autocompact buffer | 33k | 11% |",
        ].join("\n"),
        extra: { isMeta: true },
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    expect(held(state, "sess-live").contextReports).toEqual([
      {
        model: "claude-sonnet",
        window: 300_000,
        autocompactBuffer: 33_000,
        ...NO_CATEGORIES,
        skills: 8_300,
        reportedAt: T0 + 8000,
      },
    ]);
    expect(tokenHistory(held(state, "sess-live"), context).room.window).toEqual(
      { tokens: 300_000, source: "context-command", reportedAt: T0 + 8000 },
    );
  });

  it("shows the files put back after a compaction in the next pass", async () => {
    const world = makeTranscriptWorld();
    const { state, lines } = await followLiveRequest(world);
    expect(held(state, "sess-live").compactionFiles).toEqual([]);

    lines.push(
      compactBoundaryLine(T0 + 7000),
      compactFileReferenceLine(T0 + 7100, "data\\orders.csv"),
      fileAttachmentLine(T0 + 7100, {
        displayPath: "src\\totals.js",
        filename: "C:\\work\\app\\src\\totals.js",
        content: "x".repeat(694),
      }),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    expect(
      held(state, "sess-live").compactionFiles.map((file) => ({
        name: file.name,
        sizeBytes: file.sizeBytes,
        reread: file.reread,
      })),
    ).toEqual([
      { name: "data\\orders.csv", sizeBytes: null, reread: false },
      { name: "src\\totals.js", sizeBytes: 694, reread: true },
    ]);
  });

  it("shows a request completed by a later entry in live data after one pass", async () => {
    const world = makeTranscriptWorld();
    seedLive(world);
    const { state, context, lines } = await followOneRequest(world, {
      input_tokens: 1000,
      output_tokens: 10,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    });
    const before = held(state, "sess-live").requests[0];
    expect(before?.outputTokens).toBe(10);
    expect(before?.cacheLifetimes).toBeNull();
    expect(
      tokenHistory(held(state, "sess-live"), context).main[0]?.tokens,
    ).toBe(8_000);

    // The completing entry: the same request id with its
    // final counts, and its request entry carrying the cache
    // facts the first sight of it did not have.
    lines.push(
      apiRequestShapeLine(T0 + 4900, {
        system: [{ type: "text", text: "the system prompt" }],
        tools: [],
      }),
      apiRequestLine(T0 + 5000, "client-1", { cacheControl: CACHE_CONTROL_1H }),
      transcriptAssistantLine(
        T0 + 6000,
        "req-1",
        {
          input_tokens: 3000,
          output_tokens: 900,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 2000,
        },
        { extra: { requestRef: "client-1" } },
      ),
    );
    await followLines(world, lines);
    captureSession(state, "sess-live", "emit");
    const after = held(state, "sess-live").requests[0];
    expect(after?.outputTokens).toBe(900);
    expect(after?.cacheLifetimes).toEqual(["1h"]);
    expect(after?.shapeHash).toBe("a".repeat(64));
    // The shape the entry named reaches the held rows too.
    expect(
      held(state, "sess-live").requestShapes.map((shape) => shape.hash),
    ).toEqual(["a".repeat(64)]);
    expect(
      tokenHistory(held(state, "sess-live"), context).main[0]?.tokens,
    ).toBe(10_000);
  });

  it("shows a closed turn's late images in live data after one pass", async () => {
    const world = makeTranscriptWorld();
    seedLive(world);
    recordHookEvent(
      world.storage,
      { hook_event_name: "Stop", session_id: "sess-live" },
      T0 + 2000,
    );
    const stored = world.storage.turnRows("sess-live");
    expect(stored[0]?.endedAt).not.toBeNull();
    expect(stored[0]?.imageCount).toBeNull();
    const state = captureState(world.storage, world.dataDir);
    startCapture(state, "sess-live");
    expect(held(state, "sess-live").turns[0]?.imageCount).toBeNull();

    // The transcript entry carrying the prompt's image is
    // read only now, after the turn already closed: its
    // counts land on the closed turn's row.
    const image = "iVBORw0KGgo" + "A".repeat(90);
    await followLines(world, [
      transcriptUserLine(T0 + 3000, {
        promptId: "p-1",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image },
          },
        ],
      }),
      transcriptAssistantLine(T0 + 4000, "req-1", {
        input_tokens: 100,
        output_tokens: 20,
      }),
    ]);
    captureSession(state, "sess-live", "emit");
    const turn = held(state, "sess-live").turns[0];
    expect(turn?.imageCount).toBe(1);
    expect(turn?.imageBytes).toBe(image.length);
    // The attachment rows the same entry recorded reach the
    // held rows too, as new rows past the capture's mark.
    const attachments = held(state, "sess-live").promptAttachments;
    expect(attachments.find((row) => row.kind === "image")?.sizeBytes).toBe(
      image.length,
    );
  });

  it("shows a closed step's result size as sent in live data after one pass", async () => {
    const world = makeTranscriptWorld();
    seedLive(world);
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-live",
        prompt_id: "p-1",
        tool_name: "Read",
        tool_use_id: "toolu_a",
        tool_input: {},
      },
      T0 + 2000,
    );
    recordHookEvent(
      world.storage,
      {
        hook_event_name: "PostToolUse",
        session_id: "sess-live",
        tool_use_id: "toolu_a",
        tool_response: "done",
      },
      T0 + 2500,
    );
    // The step is closed before its result's size is read:
    // the size lands on the closed row through the link.
    const stored = world.storage.stepRows("sess-live");
    expect(stored[0]?.endedAt).not.toBeNull();
    expect(stored[0]?.contextChars).toBeNull();
    const lines = [
      transcriptUserLine(T0 + 3000, { promptId: "p-1" }),
      transcriptAssistantLine(
        T0 + 4000,
        "req-1",
        { input_tokens: 100, output_tokens: 20 },
        {
          content: [
            { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
          ],
        },
      ),
    ];
    await followLines(world, lines);
    const state = captureState(world.storage, world.dataDir);
    startCapture(state, "sess-live");
    expect(held(state, "sess-live").steps[0]?.contextChars).toBeNull();

    lines.push(
      transcriptUserLine(T0 + 5000, {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_a",
            content: "s".repeat(42),
          },
        ],
      }),
      transcriptAssistantLine(T0 + 6000, "req-2", {
        input_tokens: 200,
        output_tokens: 20,
      }),
    );
    await followLines(world, lines);
    expect(world.storage.stepRows("sess-live")[0]?.contextChars).toBe(42);
    expect(held(state, "sess-live").steps[0]?.contextChars).toBeNull();
    captureSession(state, "sess-live", "emit");
    const step = held(state, "sess-live").steps[0];
    expect(step?.contextChars).toBe(42);
    expect(step?.contextImages).toBe(0);
    expect(step?.asyncLaunch).toBe(0);
  });

  it("runs one pass over a 5,000-request session with three late updates, reading only the changed rows", () => {
    const pass = runLateUpdatePass(makeDataDir());
    expect(pass.changesBefore).toBe(3);
    expect(pass.requestOutput).toBe(424242);
    expect(pass.turnImageCount).toBe(3);
    expect(pass.stepOutcome).toBe("late-outcome");
    expect(pass.changesAfter).toBe(0);
  });
});

describe("a turn's head on live data", () => {
  /** A held session with one closed turn and its capture's
   * baseline taken, so only what changes after reaches the
   * buffer. A closed turn is read again only for a change of
   * its own. */
  function holdOneTurn(): { state: StreamHubState; db: DatabaseSync } {
    const world = makeTranscriptWorld();
    seedLive(world);
    recordHookEvent(
      world.storage,
      { hook_event_name: "Stop", session_id: "sess-live" },
      T0 + 2000,
    );
    const state = captureState(world.storage, world.dataDir);
    startCapture(state, "sess-live");
    const db = new DatabaseSync(world.storage.dbPath);
    registerCleanup(() => db.close());
    return { state, db };
  }

  function emittedTurnHeads(state: StreamHubState): unknown[] {
    return state.buffer.flatMap(({ message }) =>
      message.event === "turn" ? [message.data.turn] : [],
    );
  }

  it("reports a file attached after the turn was first read", () => {
    const { state, db } = holdOneTurn();
    seedPromptAttachment(db, {
      sessionId: "sess-live",
      turnId: 1,
      kind: "file",
      name: "notes.md",
      sizeBytes: 10,
    });
    captureSession(state, "sess-live", "emit");
    expect(emittedTurnHeads(state)).toEqual([
      expect.objectContaining({ id: 1, images: 0, files: 1 }),
    ]);
  });

  it("reports an image counted after the turn was first read", () => {
    const { state, db } = holdOneTurn();
    db.prepare("UPDATE turns SET image_count = 1 WHERE id = 1").run();
    captureSession(state, "sess-live", "emit");
    expect(emittedTurnHeads(state)).toEqual([
      expect.objectContaining({ id: 1, images: 1, files: 0 }),
    ]);
  });
});

describe("the stream's storage statements", () => {
  it("reach their rows on an index, never a child-table scan", () => {
    const { dataDir } = makeRoot("flightpath-stream-plan-");
    const storage = openStorage({ dataDir });
    const db = new DatabaseSync(storage.dbPath);
    try {
      const planFor = (sql: string, params: (string | number)[]): string =>
        (
          db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
            detail: string;
          }[]
        )
          .map((row) => row.detail)
          .join("\n");
      for (const sql of [
        TURN_BY_ID_SQL,
        BRANCH_BY_ID_SQL,
        PAUSE_BY_ID_SQL,
        SAMPLE_BY_ID_SQL,
        REQUEST_BY_ID_SQL,
      ]) {
        const plan = planFor(sql, [1]);
        expect(plan).toContain("SEARCH");
        expect(plan).not.toContain("SCAN");
      }
      // The capture's delta reads: rows past a mark, by
      // session and id, and one branch's requests — each on
      // an index, none a child-table scan.
      for (const sql of [
        TURN_ROWS_SINCE_SQL,
        STEP_ROWS_SINCE_SQL,
        HUMAN_ROWS_SINCE_SQL,
        BRANCH_ROWS_SINCE_SQL,
        SEGMENT_ROWS_SINCE_SQL,
        PAUSE_ROWS_SINCE_SQL,
        REQUEST_ROWS_SINCE_SQL,
        SAMPLE_ROWS_SINCE_SQL,
        LOAD_ROWS_SINCE_SQL,
        ATTACHMENT_ROWS_SINCE_SQL,
        ROW_CHANGES_SINCE_SQL,
      ]) {
        const plan = planFor(sql, [SESSION, 0]);
        expect(plan).toContain("SEARCH");
        expect(plan).not.toMatch(
          /SCAN (turns|steps|human_events|branches|segments|pauses|requests|context_samples|loads|prompt_attachments|row_changes)\b/,
        );
      }
      const branchRequests = planFor(REQUEST_ROWS_FOR_BRANCH_SQL, [SESSION, 1]);
      expect(branchRequests).toContain("SEARCH");
      expect(branchRequests).not.toMatch(/SCAN requests\b/);
      const changeMax = planFor(CHANGE_MAX_SEQ_SQL, [SESSION]);
      expect(changeMax).toContain("SEARCH");
      expect(changeMax).not.toMatch(/SCAN row_changes\b/);
      const turnAttachments = planFor(ATTACHMENTS_FOR_TURN_SQL, [SESSION, 1]);
      expect(turnAttachments).toContain("SEARCH");
      expect(turnAttachments).not.toMatch(/SCAN prompt_attachments\b/);
      const probe = planFor(STREAM_PROBE_SQL, [
        SESSION,
        SESSION,
        SESSION,
        SESSION,
        SESSION,
        SESSION,
        SESSION,
        SESSION,
        SESSION,
      ]);
      expect(probe).not.toMatch(
        /SCAN (turns|steps|human_events|branches|segments|pauses|context_samples)\b/,
      );
      // The scan reads the sessions table itself, by design:
      // every session, lightly — and nothing else.
      const scan = planFor(SESSION_SCAN_SQL, []);
      expect(scan).toContain("SCAN sessions");
      expect(scan).not.toMatch(/SCAN (turns|steps|human_events|branches)\b/);
    } finally {
      db.close();
      storage.close();
    }
  });
});

describe("the streamed context samples", () => {
  const AT = 1_700_000_000_000;

  /** A held capture over a session with one main sample
   * already in: what a test then writes, and the context
   * points the stream sends for it. */
  function heldCapture(): {
    storage: Storage;
    write: (write: (db: DatabaseSync) => void) => void;
    points: () => unknown[];
    pass: () => void;
  } {
    const { dataDir } = makeRoot("flightpath-stream-test-");
    const storage = openStorage({ dataDir });
    const write = (seedRows: (db: DatabaseSync) => void): void => {
      const db = new DatabaseSync(storage.dbPath);
      try {
        seedRows(db);
      } finally {
        db.close();
      }
    };
    write((db) => {
      seedSession(db, {
        id: "sess-stream",
        firstSeenAt: AT,
        lastSeenAt: AT + 600_000,
      });
      seedBranch(db, { id: 21, sessionId: "sess-stream" });
      seedRequest(db, {
        id: 31,
        sessionId: "sess-stream",
        startedAt: AT + 1_000,
      });
      seedRequest(db, {
        id: 33,
        sessionId: "sess-stream",
        branchId: 21,
        querySource: "subagent",
        startedAt: AT + 2_000,
      });
      seedSample(db, {
        id: 1,
        sessionId: "sess-stream",
        requestId: 31,
        sampledAt: AT + 1_000,
        contextTokens: 80_000,
      });
    });
    const state = captureState(storage, dataDir);
    startCapture(state, "sess-stream");
    const seen = state.buffer.length;
    return {
      storage,
      write,
      points: () =>
        state.buffer
          .slice(seen)
          .filter((entry) => entry.message.event === "context")
          .map((entry) => (entry.message.data as { point: unknown }).point),
      pass: () => captureSession(state, "sess-stream", "emit"),
    };
  }

  it("holds a subagent's new sample off the stream", () => {
    const held = heldCapture();
    try {
      held.write((db) => {
        seedSample(db, {
          id: 2,
          sessionId: "sess-stream",
          requestId: 33,
          sampledAt: AT + 2_000,
          contextTokens: 30_000,
        });
      });
      held.pass();
      expect(held.points()).toEqual([]);
    } finally {
      held.storage.close();
    }
  });

  it("sends a main thread's new sample on the stream", () => {
    const held = heldCapture();
    try {
      held.write((db) => {
        seedSample(db, {
          id: 2,
          sessionId: "sess-stream",
          requestId: 31,
          sampledAt: AT + 3_000,
          contextTokens: 82_000,
        });
      });
      held.pass();
      expect(held.points()).toEqual([
        { id: 2, at: AT + 3_000, contextTokens: 82_000 },
      ]);
    } finally {
      held.storage.close();
    }
  });
});
