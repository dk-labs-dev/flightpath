// The live stream's connection (ADR-0009): a fetch-based
// reader for /api/stream — fetch, not EventSource, because
// the token travels in a header (ADR-0022). It reconnects
// with a growing delay when the connection drops, replays
// what it missed from the daemon's ring buffer, and reloads
// the snapshot when the daemon says the gap is too old (a
// `reset`). While the tab is hidden the stream pauses;
// showing the tab resumes it.
//
// The client owns the connection, never the rows: everything
// the stream says lands in a sink — the screen's store — which
// holds the session's one copy of them, and which answers how
// many steps it holds when a catch-up needs sizing. What the
// stream says is the daemon's StreamMessage union; the one
// cast where a frame becomes that type is the boundary — the
// daemon is the wire's only writer.

import type {
  SessionSnapshot,
  SnapshotSummary,
} from "@flightpath/flightpath/api/payloads";
import type {
  StreamHealth,
  StreamMessage,
} from "@flightpath/flightpath/daemon/stream-messages";

import { awayLine } from "./away-line.js";
import { SseParser, type SseMessage } from "./stream-parser.js";

export type StreamStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "down" }
  | { kind: "caught-up"; steps: number; away: string | null }
  | { kind: "stopped"; reason: "idle"; idleMinutes: number }
  | { kind: "stopped"; reason: "off" }
  | { kind: "stopped"; reason: "unanswered" };

/**
 * Where the stream's news lands. A change is a whole typed
 * message; a session's summary, the recorder's health, a
 * reset's reloaded snapshot and word that the session is gone
 * each get their own call, and so does the connection's state.
 * The sink also answers how many steps it holds, so the
 * client never keeps a second copy of the count.
 */
export interface StreamSink {
  change(message: StreamMessage): void;
  summary(summary: SnapshotSummary): void;
  health(health: StreamHealth): void;
  snapshot(snapshot: SessionSnapshot): void;
  deleted(): void;
  status(status: StreamStatus): void;
  stepCount(): number;
}

/**
 * What a reset's snapshot reload came back with: the snapshot
 * itself, word that the session is gone, or a failure the
 * client keeps retrying on the same connection, with a
 * growing delay, until a load lands.
 */
export type SnapshotLoad =
  | { kind: "loaded"; snapshot: SessionSnapshot }
  | { kind: "gone" }
  | { kind: "failed" };

export interface LiveStreamOptions {
  sessionId: string | null;
  token: string;
  /** Origin prefix for the stream's address; empty in the page. */
  baseUrl?: string;
  /** The snapshot a reset reloads, and how that reload went. */
  loadSnapshot: (sessionId: string) => Promise<SnapshotLoad>;
  sink: StreamSink;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/** How long a dropped connection may go unanswered before
 * the client calls the recorder stopped. */
const UNANSWERED_AFTER_MS = 30_000;

/** The reconnect delay after `attempts` failures: a second,
 * doubling each time, never more than fifteen seconds. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** attempts, BACKOFF_MAX_MS);
}

export class LiveStream {
  private readonly options: LiveStreamOptions;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId: string | null = null;
  private attempts = 0;
  private snapshotAttempts = 0;
  private snapshot: "settled" | "loading" | "owed" = "settled";
  private generation = 0;
  private everConnected = false;
  private stopped = false;
  private unansweredTimer: ReturnType<typeof setTimeout> | null = null;
  /** The recorder is stopped: retries continue behind it. */
  private knownStopped = false;
  private paused = false;
  private collecting = false;
  private replay: StreamMessage[] = [];
  private stepsBeforeGap = 0;
  private readonly onVisibility = (): void => {
    if (typeof document === "undefined") return;
    if (document.hidden) {
      this.pause();
    } else {
      this.resume();
    }
  };

  constructor(options: LiveStreamOptions) {
    this.options = options;
  }

  start(): void {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      if (document.hidden) {
        this.paused = true;
        return;
      }
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.disconnect();
  }

  private pause(): void {
    this.paused = true;
    this.disconnect();
  }

  private resume(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.beginGap();
    void this.connect();
  }

  private disconnect(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A pause or a stop is the page's own doing, not the
    // recorder going unanswered: the spell's clock goes too.
    this.clearUnanswered();
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    // A load in flight or a retry scheduled belonged to the
    // connection going away; the load stays owed to the next.
    if (this.snapshot === "loading") this.snapshot = "owed";
    this.abort?.abort();
    this.abort = null;
  }

  /** A gap opens: what replays into it is the away line's raw material. */
  private beginGap(): void {
    if (!this.everConnected) return;
    this.collecting = true;
    this.replay = [];
    this.stepsBeforeGap = this.options.sink.stepCount();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.paused) return;
    this.generation += 1;
    if (!this.knownStopped) {
      this.options.sink.status(
        this.everConnected ? { kind: "down" } : { kind: "connecting" },
      );
    }
    const controller = new AbortController();
    this.abort = controller;
    try {
      const response = await fetch(this.streamUrl(), {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`stream answered ${response.status}`);
      }
      this.attempts = 0;
      await this.read(response.body, controller.signal);
    } catch {
      // A dropped or refused connection is the reconnect
      // path's whole job; nothing here is exceptional.
    }
    this.abort = null;
    if (this.stopped || this.paused) return;
    // A snapshot retry belonged to the connection that just
    // ended; the load stays owed, and the next connection's
    // reset — or its replay — drives the recovery from here.
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.snapshot === "loading") this.snapshot = "owed";
    this.beginGap();
    this.noteDown();
    this.scheduleReconnect();
  }

  /** A connection has ended: the unanswered spell starts,
   * measured from its end, not from any retry. */
  private noteDown(): void {
    if (this.knownStopped) return;
    this.options.sink.status({ kind: "down" });
    if (this.unansweredTimer !== null) return;
    this.unansweredTimer = setTimeout(() => {
      this.unansweredTimer = null;
      if (this.stopped || this.paused) return;
      this.knownStopped = true;
      this.options.sink.status({
        kind: "stopped",
        reason: "unanswered",
      });
    }, UNANSWERED_AFTER_MS);
  }

  private clearUnanswered(): void {
    if (this.unansweredTimer !== null) {
      clearTimeout(this.unansweredTimer);
      this.unansweredTimer = null;
    }
  }

  /** The daemon's last frame, saying why it is stopping.
   * Only the chosen stops — idle and off — name the state at
   * once; the rest read as an ordinary drop. */
  private handleStopping(
    data: Extract<StreamMessage, { event: "stopping" }>["data"],
  ): void {
    if (data.reason === "idle") {
      this.clearUnanswered();
      this.knownStopped = true;
      this.options.sink.status({
        kind: "stopped",
        reason: "idle",
        idleMinutes: data.idleMinutes,
      });
      return;
    }
    if (data.reason !== "off") return;
    this.clearUnanswered();
    this.knownStopped = true;
    this.options.sink.status({ kind: "stopped", reason: "off" });
  }

  private streamUrl(): string {
    const sessionId = this.options.sessionId;
    const base = this.options.baseUrl ?? "";
    return sessionId === null
      ? `${base}/api/stream`
      : `${base}/api/stream?session=${encodeURIComponent(sessionId)}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "x-flightpath-token": this.options.token,
    };
    if (this.lastEventId !== null) {
      headers["last-event-id"] = this.lastEventId;
    }
    return headers;
  }

  private scheduleReconnect(): void {
    const delay = backoffMs(this.attempts);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private async read(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      for (const message of parser.push(text)) {
        await this.handle(message);
        // A pause or a stop can land while a frame is being
        // handled; the rest of this connection's frames no
        // longer describe the view's state.
        if (signal.aborted) return;
      }
    }
  }

  private async handle(message: SseMessage): Promise<void> {
    if (message.id !== null) this.lastEventId = message.id;
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      // A frame that is not JSON carries nothing to apply.
      return;
    }
    // The one place a frame becomes the wire's type: the
    // daemon constructs every message, so its union is the
    // shape on the wire by construction.
    // eslint-disable-next-line no-restricted-syntax -- the daemon is the wire's only writer, so a frame's shape is its union by construction; nothing narrower can be typed at the boundary
    const parsed = { event: message.event, data } as unknown as StreamMessage;
    if (parsed.event === "reset") {
      await this.handleReset();
      return;
    }
    if (parsed.event === "sync") {
      this.handleSync(parsed.data);
      return;
    }
    if (parsed.event === "health") {
      this.options.sink.health(parsed.data);
      return;
    }
    if (parsed.event === "stopping") {
      this.handleStopping(parsed.data);
      return;
    }
    if (parsed.event === "session") {
      this.handleSession(parsed);
    } else {
      this.options.sink.change(parsed);
    }
    if (this.collecting) {
      this.replay.push(parsed);
    }
  }

  private handleSession(
    message: Extract<StreamMessage, { event: "session" }>,
  ): void {
    const data = message.data;
    if ("deleted" in data) {
      if (data.sessionId === this.options.sessionId) {
        this.options.sink.deleted();
        return;
      }
      // Another session's end is a row change on the picker's
      // stream, not this sink's own session going away.
      this.options.sink.change(message);
      return;
    }
    if ("summary" in data) {
      this.options.sink.summary(data.summary);
      return;
    }
    this.options.sink.change(message);
  }

  private handleSync(data: { replayed: number; reset: boolean }): void {
    const wasCollecting = this.collecting;
    this.collecting = false;
    this.everConnected = true;
    // A connection landed: any stopped state and any
    // unanswered spell end here.
    this.knownStopped = false;
    this.clearUnanswered();
    if (this.snapshot === "loading") {
      // A retry on this connection is still to come: the
      // catch-up is reported when a load lands, not here —
      // reporting it now would call the view current over
      // rows it never received.
      this.replay = [];
      return;
    }
    if (this.snapshot === "owed" && !data.reset) {
      // This connection only replayed what the ring still
      // holds, which is not the gap the reset spoke for:
      // try the load now, and let its outcome report the
      // catch-up.
      this.replay = [];
      void this.retrySnapshot(this.generation);
      return;
    }
    this.snapshot = "settled";
    if (!wasCollecting) {
      this.options.sink.status({ kind: "live" });
      return;
    }
    const replayedSteps = new Set<number>();
    for (const entry of this.replay) {
      if (entry.event === "step") replayedSteps.add(entry.data.step.id);
    }
    const steps = data.reset
      ? Math.max(0, this.options.sink.stepCount() - this.stepsBeforeGap)
      : replayedSteps.size;
    const away = data.reset ? null : awayLine(this.replay);
    this.replay = [];
    this.options.sink.status({ kind: "caught-up", steps, away });
  }

  private async handleReset(): Promise<void> {
    const sessionId = this.options.sessionId;
    if (sessionId === null) return;
    this.snapshot = "loading";
    const generation = this.generation;
    const load = await this.options.loadSnapshot(sessionId);
    // A pause, a stop or a newer connection while the load
    // was out hands the recovery to that connection instead.
    if (this.stopped || this.paused || generation !== this.generation) {
      return;
    }
    this.applyLoad(load, false);
  }

  /**
   * A snapshot load's outcome, whichever load it was: the
   * snapshot lands or the session is gone, and a failure
   * schedules the next try. A retry's load reports the
   * catch-up itself — no sync follows it to do the
   * reporting — where a reset's own load leaves that to
   * the sync behind it.
   */
  private applyLoad(load: SnapshotLoad, reportsCatchUp: boolean): void {
    if (load.kind === "loaded") {
      this.snapshot = "settled";
      this.snapshotAttempts = 0;
      this.options.sink.snapshot(load.snapshot);
      if (reportsCatchUp) {
        // The load replaces the gap's rows wholesale, so the
        // catch-up is sized the way a reset's sync sizes it:
        // what the sink holds now, over what it held when the
        // gap opened. Frames that arrived while the load was
        // retried applied as usual and are inside that count.
        const steps = Math.max(
          0,
          this.options.sink.stepCount() - this.stepsBeforeGap,
        );
        this.collecting = false;
        this.replay = [];
        this.options.sink.status({ kind: "caught-up", steps, away: null });
      }
      return;
    }
    if (load.kind === "gone") {
      this.snapshot = "settled";
      this.snapshotAttempts = 0;
      this.options.sink.deleted();
      return;
    }
    this.retryFailedLoad();
  }

  /**
   * A reset's snapshot failed to load. The connection stays
   * up — reconnecting without the last event id would only
   * earn a plain sync from the daemon, never another reset —
   * and the load is retried on it with a growing delay until
   * one lands. The sync that followed the reset is not
   * reported as a catch-up in the meantime.
   */
  private retryFailedLoad(): void {
    this.snapshot = "loading";
    if (!this.knownStopped) this.options.sink.status({ kind: "down" });
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    const delay = backoffMs(this.snapshotAttempts);
    this.snapshotAttempts += 1;
    const generation = this.generation;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.retrySnapshot(generation);
    }, delay);
  }

  /** Whether a load that went out under `generation` still
   * has its outcome to answer for: the stream is running, no
   * newer connection has taken over, and no other load has
   * settled the reset in the meantime. */
  private loadIsCurrent(generation: number): boolean {
    return (
      !this.stopped &&
      !this.paused &&
      generation === this.generation &&
      this.snapshot !== "settled"
    );
  }

  private async retrySnapshot(generation: number): Promise<void> {
    if (!this.loadIsCurrent(generation)) return;
    const sessionId = this.options.sessionId;
    if (sessionId === null) return;
    this.snapshot = "loading";
    const load = await this.options.loadSnapshot(sessionId);
    if (!this.loadIsCurrent(generation)) return;
    this.applyLoad(load, true);
  }
}
