import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import { callDaemon, waitFor } from "./support/daemon.js";
import {
  hookEvent,
  sequencedHookEnvelope,
  sessionStartEvent,
  userPromptEvent,
} from "./support/events.js";

import type { SessionSnapshot, SnapshotSummary } from "../src/api/payloads.js";
import { startDaemon } from "../src/daemon/server.js";
import type {
  StreamHealth,
  StreamMessage,
} from "../src/daemon/stream-messages.js";
import { awayLine } from "../../view/src/away-line.js";
import {
  LiveStream,
  type LiveStreamOptions,
  type SnapshotLoad,
  type StreamSink,
  type StreamStatus,
} from "../../view/src/stream.js";
import { SseParser } from "../../view/src/stream-parser.js";
import { loadViewState, saveViewState } from "../../view/src/view-state.js";

// The stream's client, tested three ways: its parser and away
// line as pure functions, its connection behavior against a
// stub server that speaks the wire protocol (ADR-0009), and
// what it forwards to a sink against a real in-process daemon.

describe("the SSE parser", () => {
  it("reads frames split across chunks, comments and all", () => {
    const parser = new SseParser();
    const first = parser.push("id: ep:1\nevent: heal");
    expect(first).toEqual([]);
    const second = parser.push(
      'th\ndata: {"buffered":0}\n\n: hb\n\nid: ep:2\nevent: sync\ndata: {"replayed":0}\n\n',
    );
    expect(second).toEqual([
      { id: "ep:1", event: "health", data: '{"buffered":0}' },
      { id: "ep:2", event: "sync", data: '{"replayed":0}' },
    ]);
  });

  it("joins multi-line data and tolerates CRLF", () => {
    const parser = new SseParser();
    const messages = parser.push(
      'id: ep:3\r\nevent: step\r\ndata: {"a":\r\ndata: 1}\r\n\r\n',
    );
    expect(messages).toEqual([
      { id: "ep:3", event: "step", data: '{"a":\n1}' },
    ]);
  });
});

describe("the away line", () => {
  function stepMessage(
    id: number,
    outcome: string | null,
    toolName: string,
  ): StreamMessage {
    return {
      event: "step",
      data: {
        sessionId: "s1",
        turnId: 1,
        step: {
          id,
          toolName,
          outcome,
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          branchId: null,
          resultRequestId: null,
          sentence: "did a thing",
        },
      },
    };
  }

  function segmentMessage(id: number, segmentKind: string): StreamMessage {
    return {
      event: "segment",
      data: {
        sessionId: "s1",
        event: {
          kind: "segment",
          id,
          at: 1,
          sentence: "the session moved on",
          segmentKind,
        },
      },
    };
  }

  function humanMessage(id: number, kind: string): StreamMessage {
    return {
      event: "human",
      data: {
        sessionId: "s1",
        turnId: 1,
        human: { id, kind, occurredAt: 1, sentence: "a human moment" },
      },
    };
  }

  it("names a failure, a compaction and a question, in order", () => {
    const line = awayLine([
      stepMessage(5, "failed", "Bash"),
      segmentMessage(2, "compact"),
      humanMessage(7, "question_answered"),
    ]);
    expect(line).toBe("1 failure, 1 compaction, you were asked a question");
  });

  it("counts plurals, deduplicates rows, and counts interrupts", () => {
    const failed = stepMessage(5, "failed", "Bash");
    const line = awayLine([
      failed,
      failed,
      stepMessage(6, "failed", "Read"),
      humanMessage(8, "interrupt"),
      humanMessage(9, "interrupt"),
    ]);
    expect(line).toBe("2 failures, 2 interrupts");
  });

  it("hears a question asked by a step, too", () => {
    const line = awayLine([stepMessage(3, "succeeded", "AskUserQuestion")]);
    expect(line).toBe("you were asked a question");
  });

  it("is null for an ordinary replay", () => {
    const line = awayLine([
      stepMessage(1, "succeeded", "Bash"),
      {
        event: "turn",
        data: {
          sessionId: "s1",
          turn: {
            id: 1,
            sequence: 1,
            startedAt: 1,
            endedAt: null,
            failures: 0,
            steppedIn: 0,
            images: 0,
            files: 0,
          },
        },
      },
      {
        event: "segment",
        data: {
          sessionId: "s1",
          event: { kind: "pause", id: 1, at: 1, sentence: "paused" },
        },
      },
    ]);
    expect(line).toBeNull();
  });
});

describe("the view state", () => {
  function memoryStorage(): {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  } {
    const map = new Map<string, string>();
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it("round-trips a session's place", () => {
    const storage = memoryStorage();
    saveViewState(
      "s1",
      {
        selectedStepId: 42,
        collapsedTurnIds: [1, 2],
        scrollTop: 320,
        anchorKey: "step-42",
        anchorOffset: 24,
      },
      storage,
    );
    expect(loadViewState("s1", storage)).toEqual({
      selectedStepId: 42,
      collapsedTurnIds: [1, 2],
      scrollTop: 320,
      anchorKey: "step-42",
      anchorOffset: 24,
    });
    // Nothing saved is its own answer, not an empty place:
    // the screen restores a saved place as it stands — an
    // empty collapsed list included — and defaults only
    // when there is nothing to restore.
    expect(loadViewState("other", storage)).toBeNull();
  });

  it("falls back to a first visit on unreadable state", () => {
    const storage = memoryStorage();
    storage.setItem("flightpath-view:s1", "{not json");
    expect(loadViewState("s1", storage)).toBeNull();
    storage.setItem("flightpath-view:s1", JSON.stringify({ scrollTop: "x" }));
    expect(loadViewState("s1", storage)).toEqual({
      selectedStepId: null,
      collapsedTurnIds: [],
      scrollTop: 0,
      anchorKey: null,
      anchorOffset: 0,
    });
  });
});

// --- a stub server speaking the wire protocol ----------------

function frame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const HEALTH = {
  buffered: 0,
  oldestAt: null,
  dropped: 0,
  lastError: null,
  problem: null,
  autostart: true,
};

/** A two-step snapshot of session s1, as a reset reloads it. */
const twoStepSnapshot: SessionSnapshot = {
  summary: {
    id: "s1",
    title: "A session",
    project: null,
    status: "live",
    startedAt: 1,
    endedAt: null,
    lastActivityAt: 2,
    model: null,
    permissionModes: [],
    sources: [],
    endSeen: true,
    note: "",
    counts: {
      turns: 1,
      steps: 2,
      requests: 0,
      branches: 0,
      humanMoments: 0,
    },
    failures: 0,
    steppedIn: 0,
    tokensProcessed: 0,
    contextNow: null,
    window: { tokens: 200_000, source: "model-list", reportedAt: null },
    overheadTokens: 0,
    waitingSince: null,
    lastStepAt: null,
    cache: null,
  },
  turns: [
    {
      id: 1,
      sequence: 1,
      startedAt: 1,
      endedAt: null,
      failures: 0,
      steppedIn: 0,
      images: 0,
      files: 0,
      steps: [
        {
          id: 1,
          toolName: "Bash",
          outcome: "succeeded",
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          branchId: null,
          resultRequestId: null,
          sentence: "Ran ls",
        },
        {
          id: 2,
          toolName: "Read",
          outcome: "succeeded",
          startedAt: 2,
          endedAt: 3,
          durationMs: 1,
          branchId: null,
          resultRequestId: null,
          sentence: "Read a file",
        },
      ],
      humanMoments: [],
    },
  ],
  branches: [],
  sessionEvents: [],
  contextSamples: [],
};

interface Stub {
  port: number;
  close: () => Promise<void>;
}

async function startStub(
  onConnection: (
    index: number,
    res: ServerResponse,
    req: IncomingMessage,
  ) => void,
  port = 0,
): Promise<Stub> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const index = count;
    count += 1;
    onConnection(index, res, req);
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(port, "127.0.0.1", () => resolvePromise()),
  );
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

type SinkRecord =
  | { kind: "change"; message: StreamMessage }
  | { kind: "summary"; summary: SnapshotSummary }
  | { kind: "health"; health: StreamHealth }
  | { kind: "snapshot"; snapshot: SessionSnapshot }
  | { kind: "deleted" }
  | { kind: "status"; status: StreamStatus };

/**
 * A recording sink: every call the client makes, kept in the
 * order it arrived. The tests read the records — the forwarded
 * step message and its outcome, the snapshot a reset loaded,
 * the statuses in sequence. stepCount answers from the same
 * records, the way a store would answer from its rows: a
 * snapshot replaces them, a deletion clears them.
 */
class RecordingSink implements StreamSink {
  readonly records: SinkRecord[] = [];

  change(message: StreamMessage): void {
    this.records.push({ kind: "change", message });
  }

  summary(summary: SnapshotSummary): void {
    this.records.push({ kind: "summary", summary });
  }

  health(health: StreamHealth): void {
    this.records.push({ kind: "health", health });
  }

  snapshot(snapshot: SessionSnapshot): void {
    this.records.push({ kind: "snapshot", snapshot });
  }

  deleted(): void {
    this.records.push({ kind: "deleted" });
  }

  status(status: StreamStatus): void {
    this.records.push({ kind: "status", status });
  }

  get changes(): StreamMessage[] {
    return this.records.flatMap((record) =>
      record.kind === "change" ? [record.message] : [],
    );
  }

  get summaries(): SnapshotSummary[] {
    return this.records.flatMap((record) =>
      record.kind === "summary" ? [record.summary] : [],
    );
  }

  get healthReadings(): StreamHealth[] {
    return this.records.flatMap((record) =>
      record.kind === "health" ? [record.health] : [],
    );
  }

  get snapshots(): SessionSnapshot[] {
    return this.records.flatMap((record) =>
      record.kind === "snapshot" ? [record.snapshot] : [],
    );
  }

  get statuses(): StreamStatus[] {
    return this.records.flatMap((record) =>
      record.kind === "status" ? [record.status] : [],
    );
  }

  get gone(): boolean {
    return this.records.some((record) => record.kind === "deleted");
  }

  last(): StreamStatus | undefined {
    return this.statuses[this.statuses.length - 1];
  }

  stepCount(): number {
    const ids = new Set<number>();
    for (const record of this.records) {
      if (record.kind === "snapshot") {
        ids.clear();
        const steps = record.snapshot.turns.flatMap((turn) => turn.steps);
        for (const step of steps) ids.add(step.id);
      } else if (record.kind === "deleted") {
        ids.clear();
      } else if (record.kind === "change" && record.message.event === "step") {
        ids.add(record.message.data.step.id);
      }
    }
    return ids.size;
  }
}

function openThenDrop(first: ServerResponse): void {
  first.write(frame("ep:1", "health", HEALTH));
  first.write(frame("ep:1", "sync", { replayed: 0, reset: false }));
}

/** A stub whose first connection drops, whose next replays frames. */
function dropThenReplay(
  frames: string[],
): (index: number, res: ServerResponse) => void {
  return (index, res) => {
    if (index === 0) {
      openThenDrop(res);
      setTimeout(() => res.destroy(), 50);
      return;
    }
    for (const text of frames) {
      res.write(text);
    }
  };
}

function stepFrame(id: string, step: Record<string, unknown>): string {
  return frame(id, "step", { sessionId: "s1", turnId: 1, step });
}

/** A stub whose replay is a reset and the sync that closes it. */
function dropThenReset(): (index: number, res: ServerResponse) => void {
  return dropThenReplay([
    frame("ep:9", "health", HEALTH),
    frame("ep:9", "reset", {}),
    frame("ep:9", "sync", { replayed: 0, reset: true }),
  ]);
}

/** A stub whose only news is that one session is deleted. */
function sessionDeleted(
  sessionId: string,
): (index: number, res: ServerResponse) => void {
  return (_index, res) => {
    res.write(frame("ep:1", "health", HEALTH));
    res.write(frame("ep:1", "session", { sessionId, deleted: true }));
    res.write(frame("ep:1", "sync", { replayed: 0, reset: false }));
  };
}

describe("the stream client against a stub server", () => {
  const streams: LiveStream[] = [];
  const stubs: Stub[] = [];
  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.stop();
    for (const stub of stubs.splice(0)) await stub.close();
  });

  function clientFor(
    port: number,
    sink: RecordingSink,
    loadSnapshot?: LiveStreamOptions["loadSnapshot"],
    sessionId: string | null = "s1",
  ): LiveStream {
    const stream = new LiveStream({
      sessionId,
      token: "test-token",
      baseUrl: `http://127.0.0.1:${port}`,
      loadSnapshot: loadSnapshot ?? (() => Promise.resolve({ kind: "failed" })),
      sink,
    });
    streams.push(stream);
    return stream;
  }

  /** Start a client on a stub and wait for its caught-up status. */
  async function runToCaughtUp(
    stub: Stub,
    sink: RecordingSink,
    loadSnapshot?: LiveStreamOptions["loadSnapshot"],
  ): Promise<LiveStream> {
    const stream = clientFor(stub.port, sink, loadSnapshot);
    stream.start();
    await waitFor(() => sink.last()?.kind === "caught-up");
    return stream;
  }

  it("reports the away line from a replay, exactly as worded", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(
      dropThenReplay([
        frame("ep:1", "health", HEALTH),
        stepFrame("ep:2", {
          id: 5,
          toolName: "Bash",
          outcome: "failed",
          sentence: "Ran ls",
        }),
        stepFrame("ep:3", {
          id: 6,
          toolName: "Read",
          outcome: "succeeded",
          sentence: "Read a file",
        }),
        frame("ep:4", "segment", {
          sessionId: "s1",
          event: {
            kind: "segment",
            id: 2,
            segmentKind: "compact",
            sentence: "Compacted",
          },
        }),
        frame("ep:5", "human", {
          sessionId: "s1",
          turnId: 1,
          human: { id: 7, kind: "question_answered", sentence: "You answered" },
        }),
        frame("ep:6", "sync", { replayed: 4, reset: false }),
      ]),
    );
    stubs.push(stub);
    await runToCaughtUp(stub, sink);
    expect(sink.statuses.some((s) => s.kind === "down")).toBe(true);
    expect(sink.last()).toEqual({
      kind: "caught-up",
      steps: 2,
      away: "1 failure, 1 compaction, you were asked a question",
    });
    expect(
      sink.changes.some(
        (message) =>
          message.event === "step" &&
          message.data.step.id === 5 &&
          message.data.step.outcome === "failed",
      ),
    ).toBe(true);
    expect(
      sink.changes.some(
        (message) =>
          message.event === "segment" &&
          message.data.event.id === 2 &&
          message.data.event.segmentKind === "compact",
      ),
    ).toBe(true);
  }, 30_000);

  it("shows no away line for an ordinary replay", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(
      dropThenReplay([
        frame("ep:1", "health", HEALTH),
        stepFrame("ep:2", {
          id: 1,
          toolName: "Bash",
          outcome: "succeeded",
          sentence: "Ran ls",
        }),
        frame("ep:3", "sync", { replayed: 1, reset: false }),
      ]),
    );
    stubs.push(stub);
    await runToCaughtUp(stub, sink);
    expect(sink.last()).toEqual({
      kind: "caught-up",
      steps: 1,
      away: null,
    });
  }, 30_000);

  it("reloads the snapshot on reset and counts its steps", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(dropThenReset());
    stubs.push(stub);
    await runToCaughtUp(stub, sink, () =>
      Promise.resolve({ kind: "loaded", snapshot: twoStepSnapshot }),
    );
    expect(sink.last()).toEqual({
      kind: "caught-up",
      steps: 2,
      away: null,
    });
    expect(sink.snapshots).toHaveLength(1);
    expect(
      sink.snapshots[0]?.turns.map((turn) => ({
        id: turn.id,
        steps: turn.steps.map((step) => step.id),
      })),
    ).toEqual([{ id: 1, steps: [1, 2] }]);
    expect(sink.snapshots[0]?.summary.id).toBe("s1");
  }, 30_000);

  it("reports a catch-up of zero steps when the replay brings nothing new", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(
      dropThenReplay([
        frame("ep:1", "health", HEALTH),
        frame("ep:2", "sync", { replayed: 0, reset: false }),
      ]),
    );
    stubs.push(stub);
    await runToCaughtUp(stub, sink);
    expect(sink.last()).toEqual({ kind: "caught-up", steps: 0, away: null });
  }, 30_000);

  it("retries a failed reset reload on the reset's own connection, and never reports the unloaded gap as caught up", async () => {
    const sink = new RecordingSink();
    const connections: number[] = [];
    let loads = 0;
    const stub = await startStub((index, res) => {
      connections.push(index);
      if (index === 0) {
        openThenDrop(res);
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.write(frame("ep:9", "health", HEALTH));
      res.write(frame("ep:9", "reset", {}));
      res.write(frame("ep:9", "sync", { replayed: 0, reset: true }));
    });
    stubs.push(stub);
    const stream = clientFor(stub.port, sink, (): Promise<SnapshotLoad> => {
      loads += 1;
      return Promise.resolve(
        loads === 1
          ? { kind: "failed" }
          : { kind: "loaded", snapshot: twoStepSnapshot },
      );
    });
    stream.start();
    await waitFor(() => sink.last()?.kind === "caught-up");
    expect(loads).toBe(2);
    // The retry never opened another connection: the daemon
    // answers an id-less reconnect with a plain sync and no
    // second reset, so the load has to be retried on the
    // connection that brought the reset.
    expect(connections).toEqual([0, 1]);
    expect(sink.snapshots).toHaveLength(1);
    expect(sink.statuses.filter((s) => s.kind === "caught-up")).toEqual([
      { kind: "caught-up", steps: 2, away: null },
    ]);
    expect(sink.statuses.some((s) => s.kind === "down")).toBe(true);
  }, 30_000);

  it("calls deleted when a reset's reload finds the session gone", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(dropThenReset());
    stubs.push(stub);
    await runToCaughtUp(stub, sink, () => Promise.resolve({ kind: "gone" }));
    expect(sink.gone).toBe(true);
    expect(sink.snapshots).toHaveLength(0);
  }, 30_000);

  it("reports its own session's end as deleted, not as a change", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(sessionDeleted("s1"));
    stubs.push(stub);
    const stream = clientFor(stub.port, sink);
    stream.start();
    await waitFor(() => sink.gone);
    expect(sink.changes.some((message) => message.event === "session")).toBe(
      false,
    );
  }, 30_000);

  it("forwards another session's end on the picker stream as a change", async () => {
    const sink = new RecordingSink();
    const stub = await startStub(sessionDeleted("s2"));
    stubs.push(stub);
    const stream = clientFor(stub.port, sink, undefined, null);
    stream.start();
    await waitFor(() => sink.changes.length > 0);
    expect(sink.gone).toBe(false);
    expect(
      sink.changes.some(
        (message) =>
          message.event === "session" &&
          "deleted" in message.data &&
          message.data.sessionId === "s2",
      ),
    ).toBe(true);
  }, 30_000);

  it("backs off before reconnecting to a daemon that is down", async () => {
    // Reserve a port, then let it go: the first connects refuse.
    const probe = await startStub(() => undefined);
    const port = probe.port;
    await probe.close();
    const sink = new RecordingSink();
    const started = Date.now();
    const stream = clientFor(port, sink);
    stream.start();
    await new Promise((r) => setTimeout(r, 400));
    const stub = await startStub((_index, res) => {
      res.write(frame("ep:1", "health", HEALTH));
      res.write(frame("ep:1", "sync", { replayed: 0, reset: false }));
    }, port);
    stubs.push(stub);
    await waitFor(() => sink.last()?.kind === "live");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(sink.statuses.some((s) => s.kind === "down")).toBe(true);
  }, 30_000);

  /** An SSE response carrying `frames`: a connection that
   * served, then ended — or, with `close` false, one that
   * stays open. The fake-clock tests below answer the
   * client's fetches with these, and with refusals. */
  function sseResponse(frames: string[], close = true): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of frames) {
          controller.enqueue(encoder.encode(text));
        }
        if (close) controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  /** A fetch stub whose first call serves `first` as one
   * connection; every later call goes to `then`. Returns a
   * reader for the call count so far. */
  function stubFetch(
    first: string[],
    then: () => Promise<Response>,
  ): () => number {
    let calls = 0;
    vi.stubGlobal("fetch", (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(sseResponse(first));
      return then();
    });
    return () => calls;
  }

  /** A stub whose first connection serves a sync and then a
   * stopping frame before it ends; what later connections get
   * is the test's choice — a healthy sync, or refusal. */
  async function startStoppingStub(
    stopping: Record<string, unknown>,
    later: "healthy" | "refused",
  ) {
    const stub = await startStub((index, res) => {
      if (index === 0) {
        res.write(frame("ep:1", "health", HEALTH));
        res.write(frame("ep:1", "sync", { replayed: 0, reset: false }));
        res.write(frame("ep:2", "stopping", stopping));
        setTimeout(() => res.end(), 50);
        return;
      }
      if (later === "refused") {
        res.destroy();
        return;
      }
      res.write(frame("ep:3", "health", HEALTH));
      res.write(frame("ep:3", "sync", { replayed: 0, reset: false }));
    });
    stubs.push(stub);
    return stub;
  }

  /** Start a client against a stub and wait for its stopped word. */
  async function startUntilStopped(
    stub: Stub,
    sink: RecordingSink,
  ): Promise<void> {
    const stream = clientFor(stub.port, sink);
    stream.start();
    await waitFor(() => sink.last()?.kind === "stopped");
  }

  it("calls the recorder stopped at once on an idle stopping frame, and caught up again on the next connection", async () => {
    const sink = new RecordingSink();
    const stub = await startStoppingStub(
      { reason: "idle", idleMinutes: 30 },
      "healthy",
    );
    await startUntilStopped(stub, sink);
    expect(sink.last()).toEqual({
      kind: "stopped",
      reason: "idle",
      idleMinutes: 30,
    });
    // The retries run in the background: no down word follows
    // the stopped one before a connection lands and replaces it.
    const stoppedAt = sink.statuses.length;
    await waitFor(() => sink.last()?.kind === "caught-up");
    expect(sink.statuses.slice(stoppedAt).some((s) => s.kind === "down")).toBe(
      false,
    );
  }, 30_000);

  it("calls the recorder stopped at once on an off stopping frame", async () => {
    const sink = new RecordingSink();
    const stub = await startStoppingStub({ reason: "off" }, "healthy");
    await startUntilStopped(stub, sink);
    expect(sink.last()).toEqual({
      kind: "stopped",
      reason: "off",
    });
  }, 30_000);

  it("treats a signal stopping frame as an ordinary drop", async () => {
    vi.useFakeTimers();
    try {
      const sink = new RecordingSink();
      stubFetch(
        [
          frame("ep:1", "health", HEALTH),
          frame("ep:1", "sync", { replayed: 0, reset: false }),
          frame("ep:2", "stopping", { reason: "signal" }),
        ],
        () => Promise.reject(new Error("connection refused")),
      );
      const stream = clientFor(9_999, sink);
      stream.start();
      // The frame lands and the connection ends: an ordinary
      // drop — down, and no stopped word, even as the retries
      // tick behind it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sink.last()).toEqual({ kind: "down" });
      expect(sink.statuses.some((s) => s.kind === "stopped")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("calls a long-unanswered drop stopped at thirty seconds, measured from the connection's end", async () => {
    vi.useFakeTimers();
    try {
      const sink = new RecordingSink();
      let serving = false;
      const calls = stubFetch(
        [
          frame("ep:1", "health", HEALTH),
          frame("ep:1", "sync", { replayed: 0, reset: false }),
        ],
        () => {
          if (!serving) {
            return Promise.reject(new Error("connection refused"));
          }
          return Promise.resolve(
            sseResponse(
              [
                frame("ep:2", "health", HEALTH),
                frame("ep:2", "sync", { replayed: 0, reset: false }),
              ],
              false,
            ),
          );
        },
      );
      const stream = clientFor(9_999, sink);
      stream.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.last()).toEqual({ kind: "down" });
      // The retries tick — one, two, four, eight seconds
      // apart — and none of them restarts the spell: at 29
      // seconds the word is still down…
      await vi.advanceTimersByTimeAsync(29_000);
      expect(sink.last()).toEqual({ kind: "down" });
      expect(calls()).toBeGreaterThan(4);
      // …and at thirty seconds from the connection's end it
      // is stopped-unanswered.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sink.last()).toEqual({
        kind: "stopped",
        reason: "unanswered",
      });
      // When the recorder answers again, the next connection
      // catches up as usual.
      serving = true;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sink.last()).toEqual({
        kind: "caught-up",
        steps: 0,
        away: null,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// --- against a real daemon ------------------------------------

const DAEMON_TIMING = { idleMs: 600_000, drainMs: 150 };

describe("the stream client against a real daemon", () => {
  afterEach(async () => {
    await runCleanups();
  });

  it("fills its sink from the daemon's stream", async () => {
    const dataDir = makeTempRoot("flightpath-client-test-");
    const daemon = await startDaemon({
      dataDir,
      version: "0.0.0",
      ...DAEMON_TIMING,
    });
    if (daemon === null) throw new Error("daemon did not start");
    registerCleanup(() => daemon.shutdown("signal"));
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    const post = async (event: Record<string, unknown>): Promise<void> => {
      const reply = await callDaemon(daemon.port, {
        method: "POST",
        path: "/events/hook",
        token,
        headers: { "content-type": "application/json" },
        body: sequencedHookEnvelope("client", event),
      });
      expect(reply.status).toBe(204);
    };
    const sessionId = "client-session";
    await post(sessionStartEvent("startup", sessionId));
    await post(userPromptEvent(sessionId, "client test"));
    const sink = new RecordingSink();
    const stream = new LiveStream({
      sessionId,
      token,
      baseUrl: `http://127.0.0.1:${daemon.port}`,
      loadSnapshot: () => Promise.resolve({ kind: "failed" }),
      sink,
    });
    registerCleanup(() => {
      stream.stop();
    });
    stream.start();
    await waitFor(() => sink.last()?.kind === "live");
    await post(
      hookEvent("PreToolUse", {
        session_id: sessionId,
        tool_name: "Bash",
        tool_use_id: "ct-1",
        tool_input: { command: "echo hi" },
      }),
    );
    await post(
      hookEvent("PostToolUse", {
        session_id: sessionId,
        tool_name: "Bash",
        tool_use_id: "ct-1",
        tool_response: { ok: true },
      }),
    );
    await waitFor(() =>
      sink.changes.some(
        (message) =>
          message.event === "step" &&
          message.data.step.id === 1 &&
          message.data.step.outcome === "succeeded",
      ),
    );
    const stepOne = sink.changes.find(
      (message) => message.event === "step" && message.data.step.id === 1,
    );
    if (stepOne?.event !== "step") {
      throw new Error("the daemon's first step never reached the sink");
    }
    expect(typeof stepOne.data.step.sentence).toBe("string");
    expect(sink.summaries[sink.summaries.length - 1]?.id).toBe(sessionId);
    expect(sink.healthReadings.length).toBeGreaterThan(0);
  }, 60_000);
});
