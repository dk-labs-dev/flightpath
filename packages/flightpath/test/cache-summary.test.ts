import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSessionData, sessionSnapshot } from "../src/api/index.js";
import type { SummaryCache } from "../src/api/payloads.js";
import { newCapture } from "../src/daemon/stream-capture.js";
import {
  shapeSessionChanges,
  type CapturePlan,
} from "../src/daemon/stream-shaping.js";
import type { StreamMessage } from "../src/daemon/stream-messages.js";
import { defaultSettings } from "../src/settings/index.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import {
  seedBranch,
  seedRequestExact,
  seedSegment,
  seedSession,
} from "./support/seed.js";
import { captureState } from "./support/stream.js";

// The cache the summary carries for the cold-cache clock, over
// sessions planted request by request.

const S = "sess-cache";

afterEach(async () => {
  vi.useRealTimers();
  await runCleanups();
});

function makeWorld(): { storage: Storage; db: DatabaseSync; dir: string } {
  const dir = makeTempRoot("flightpath-cache-");
  const storage = openStorage({ dataDir: dir });
  const db = new DatabaseSync(storage.dbPath);
  registerCleanup(() => {
    db.close();
    storage.close();
  });
  seedSession(db, { id: S, status: "live" });
  return { storage, db, dir };
}

function cacheOf(storage: Storage): SummaryCache | null | undefined {
  return sessionSnapshot(storage, defaultSettings(), S)?.summary.cache;
}

function seedRequest(
  db: DatabaseSync,
  fields: Omit<Parameters<typeof seedRequestExact>[1], "sessionId">,
): void {
  seedRequestExact(db, { sessionId: S, ...fields });
}

/** A main request that wrote one hour of cache and read some. */
function seedHourWrite(db: DatabaseSync, id: number, startedAt: number): void {
  seedRequest(db, {
    id,
    startedAt,
    durationMs: 2_000,
    input: 100,
    cacheRead: 2_000,
    cacheWrite1h: 7_900,
  });
}

describe("the summary's cache", () => {
  it("comes from the last main request, not a branch request after it", () => {
    const { storage, db } = makeWorld();
    seedHourWrite(db, 1, 10_000);
    const branchId = seedBranch(db, { sessionId: S, kind: "user" });
    seedRequest(db, {
      id: 2,
      branchId,
      startedAt: 20_000,
      durationMs: 1_000,
      input: 50,
      cacheWrite5m: 400,
    });

    expect(cacheOf(storage)).toEqual({
      lifetime: "1h",
      endedAt: 12_000,
      contextTokens: 10_000,
    });
  });

  it("ignores a request Claude Code made for itself after the last main one", () => {
    const { storage, db } = makeWorld();
    seedHourWrite(db, 1, 10_000);
    seedRequest(db, {
      id: 2,
      querySource: "generate_session_title",
      startedAt: 20_000,
      durationMs: 500,
      input: 30,
      cacheWrite5m: 200,
    });

    expect(cacheOf(storage)?.endedAt).toBe(12_000);
  });

  it("is null when no cache lifetime was recorded", () => {
    const { storage, db } = makeWorld();
    seedRequest(db, {
      id: 1,
      startedAt: 10_000,
      durationMs: 2_000,
      input: 100,
      cacheRead: 2_000,
    });

    expect(cacheOf(storage)).toBeNull();
  });

  it("keeps the lifetime of an earlier write when the last request only read", () => {
    const { storage, db } = makeWorld();
    seedHourWrite(db, 1, 10_000);
    seedRequest(db, {
      id: 2,
      startedAt: 20_000,
      durationMs: 1_000,
      input: 40,
      cacheRead: 10_000,
    });

    expect(cacheOf(storage)).toEqual({
      lifetime: "1h",
      endedAt: 21_000,
      contextTokens: 10_040,
    });
  });

  it("takes the lifetime from the last request when it changes", () => {
    const { storage, db } = makeWorld();
    seedHourWrite(db, 1, 10_000);
    seedRequest(db, {
      id: 2,
      startedAt: 20_000,
      durationMs: 1_000,
      input: 40,
      cacheWrite5m: 9_000,
    });

    expect(cacheOf(storage)?.lifetime).toBe("5m");
  });

  it("ends at the request's start when its duration was not recorded", () => {
    const { storage, db } = makeWorld();
    seedRequest(db, {
      id: 1,
      startedAt: 10_000,
      input: 100,
      cacheWrite1h: 900,
    });

    expect(cacheOf(storage)?.endedAt).toBe(10_000);
  });

  it("is null when the last request had no context", () => {
    const { storage, db } = makeWorld();
    seedRequest(db, {
      id: 1,
      startedAt: 10_000,
      durationMs: 2_000,
      input: 0,
      cacheWrite1h: 0,
    });

    expect(cacheOf(storage)).toBeNull();
  });

  it("is null once a compaction came after the last main request", () => {
    const { storage, db } = makeWorld();
    seedHourWrite(db, 1, 10_000);
    seedSegment(db, { sessionId: S, kind: "compact", startedAt: 30_000 });

    expect(cacheOf(storage)).toBeNull();
  });

  it("keeps the cache of a request that came after a compaction", () => {
    const { storage, db } = makeWorld();
    seedSegment(db, { sessionId: S, kind: "compact", startedAt: 5_000 });
    seedHourWrite(db, 1, 10_000);

    expect(cacheOf(storage)?.lifetime).toBe("1h");
  });
});

describe("the summary's cache in the stream", () => {
  it("is sent once while the session idles, however much time passes", () => {
    const { storage, db, dir } = makeWorld();
    seedHourWrite(db, 1, Date.now());
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = captureState(storage, dir);
    const capture = newCapture();
    const data = loadSessionData(storage, S);
    if (data === undefined) throw new Error("session did not seed");
    const plan: CapturePlan = {
      turnIds: new Set<number>(),
      stepIds: new Set<number>(),
      humanIds: new Set<number>(),
      branchIds: new Set<number>(),
      segmentIds: new Set<number>(),
      pauseIds: new Set<number>(),
      sampleIds: new Set<number>(),
      stepTurnIds: new Map<number, number>(),
      humanTurnIds: new Map<number, number>(),
    };
    const sent: StreamMessage[] = [];
    const emit = {
      session: (m: StreamMessage) => sent.push(m),
      picker: () => {},
    };

    shapeSessionChanges(state, capture, data, plan, emit);
    vi.setSystemTime(Date.now() + 55 * 60_000);
    shapeSessionChanges(state, capture, data, plan, emit);

    expect(sent.filter((m) => m.event === "session")).toHaveLength(1);
  });
});
