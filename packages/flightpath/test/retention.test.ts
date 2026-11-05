import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createRetention } from "../src/daemon/retention.js";
import { defaultSettings, type Settings } from "../src/settings/index.js";
import { openStorage, type Storage } from "../src/storage/index.js";
import { MIGRATIONS } from "../src/storage/schema.js";
import { runCleanups } from "./support/cleanup.js";
import {
  callDaemon,
  dataDirFor,
  makeRoot,
  measureAcks,
  startDaemon,
  startTestDaemon,
  waitFor,
} from "./support/daemon.js";
import { sequencedHookEnvelope } from "./support/events.js";
import { countFor } from "./support/rows.js";
import {
  countWhere,
  queryRows,
  trackStorage,
  untrackStorage,
} from "./support/storage.js";

// Retention (ADR-0025): recordings are deleted by age and by a
// size cap, deletes give the disk back, purged sessions stay
// purged, and none of it holds up a hook event. Sessions are
// generated in the tests, never committed fixtures.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

/** Wait until the sessions table holds exactly `count` rows. */
async function waitForSessionCount(
  dataDir: string,
  count: number,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    () => countWhere(dataDir, "SELECT COUNT(*) AS n FROM sessions") === count,
    timeoutMs,
  );
}

afterEach(async () => {
  await runCleanups();
});

function makeStorage(big = false): { root: string; storage: Storage } {
  const { root } = makeRoot("flightpath-retention-", { big });
  const storage = trackStorage(openStorage({ dataDir: root }));
  return { root, storage };
}

function direct(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

function seedSession(
  db: DatabaseSync,
  id: string,
  status: string,
  lastSeenAt: number,
): void {
  db.prepare(
    "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES (?, ?, ?, ?, 0)",
  ).run(id, status, lastSeenAt - 1000, lastSeenAt);
}

/** One row in every table a session's deletion must clear, except
 * the ones a later migration added. */
function seedRows(db: DatabaseSync, id: string): void {
  const at = 1000;
  db.prepare(
    "INSERT INTO segments (session_id, kind, started_at) VALUES (?, 'startup', ?)",
  ).run(id, at);
  db.prepare(
    "INSERT INTO turns (session_id, sequence, started_at) VALUES (?, 1, ?)",
  ).run(id, at);
  db.prepare(
    "INSERT INTO session_conditions (session_id, updated_at) VALUES (?, ?)",
  ).run(id, at);
  db.prepare("INSERT INTO pauses (session_id, paused_at) VALUES (?, ?)").run(
    id,
    at,
  );
  const branch = db
    .prepare("INSERT INTO branches (session_id, started_at) VALUES (?, ?)")
    .run(id, at);
  const step = db
    .prepare(
      "INSERT INTO steps (session_id, branch_id, tool_name) VALUES (?, ?, 'Read')",
    )
    .run(id, Number(branch.lastInsertRowid));
  db.prepare(
    "UPDATE branches SET spawning_step_id = ? WHERE session_id = ?",
  ).run(Number(step.lastInsertRowid), id);
  db.prepare("INSERT INTO requests (session_id) VALUES (?)").run(id);
  db.prepare(
    "INSERT INTO human_events (session_id, kind, occurred_at) VALUES (?, 'prompt', ?)",
  ).run(id, at);
  db.prepare(
    "INSERT INTO context_samples (session_id, sampled_at, context_tokens, source) VALUES (?, ?, 10, 'transcript')",
  ).run(id, at);
  db.prepare(
    "INSERT INTO loads (session_id, kind, occurred_at, source) VALUES (?, 'skill', ?, 'hook')",
  ).run(id, at);
  db.prepare(
    "INSERT INTO raw_events (source, session_id, received_at, redaction_version, body) VALUES ('hook', ?, ?, 1, '{}')",
  ).run(id, at);
}

/** seedRows, and a dismissed finding, in a database at the current schema. */
function seedCurrentRows(db: DatabaseSync, id: string): void {
  seedRows(db, id);
  db.prepare(
    "INSERT INTO finding_dismissals (session_id, finding_id, dismissed_at) VALUES (?, 'rebuild-1', 1000)",
  ).run(id);
}

function tableCounts(dbPath: string): Record<string, number> {
  const db = direct(dbPath);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      counts[name] = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }
      ).n;
    }
    return counts;
  } finally {
    db.close();
  }
}

function settingsWith(overrides: Partial<Settings>): () => Settings {
  return () => ({ ...defaultSettings(), ...overrides });
}

describe("retention", () => {
  it("purges by age at the boundary; a live session is protected only while it is active", async () => {
    const { storage } = makeStorage();
    const db = direct(storage.dbPath);
    seedSession(db, "sess-16d", "ended", NOW - 16 * DAY);
    seedSession(db, "sess-14d", "ended", NOW - 14 * DAY);
    seedSession(db, "sess-paused-16d", "paused", NOW - 16 * DAY);
    seedSession(db, "sess-live-fresh", "live", NOW);
    // A session whose end never arrived — the process was
    // killed — stays "live" in the table. Quiet for a hundred
    // days, it is retention's business all the same.
    seedSession(db, "sess-live-100d", "live", NOW - 100 * DAY);
    db.close();

    // The same judgement the settings screen's counts are made
    // with, and the size cap's first candidate.
    const staleBefore = NOW - DAY;
    expect(storage.countSessionsOlderThan(NOW - 15 * DAY, staleBefore)).toBe(3);
    expect(storage.oldestNonLiveSession(staleBefore)?.id).toBe(
      "sess-live-100d",
    );

    const retention = createRetention({
      storage,
      settings: settingsWith({ retentionDays: 15 }),
      now: () => NOW,
    });
    const run = await retention.runOnce();
    expect(run.aged).toBe(3);
    expect(storage.allSessionIds().sort()).toEqual([
      "sess-14d",
      "sess-live-fresh",
    ]);
    expect(storage.isPurged("sess-16d")).toBe(true);
    expect(storage.isPurged("sess-paused-16d")).toBe(true);
    expect(storage.isPurged("sess-live-100d")).toBe(true);
    expect(storage.isPurged("sess-14d")).toBe(false);
    expect(storage.isPurged("sess-live-fresh")).toBe(false);
  });

  it("a purge removes exactly the rows a forget removes", async () => {
    const { storage } = makeStorage();
    const db = direct(storage.dbPath);
    for (const id of ["sess-forgotten", "sess-purged"]) {
      seedSession(db, id, "ended", NOW - 30 * DAY);
      seedCurrentRows(db, id);
    }
    db.close();
    const before = tableCounts(storage.dbPath);

    storage.forgetSession("sess-forgotten", NOW);
    const afterForget = tableCounts(storage.dbPath);

    const retention = createRetention({
      storage,
      settings: settingsWith({ retentionDays: 15 }),
      now: () => NOW,
    });
    await retention.runOnce();
    const afterPurge = tableCounts(storage.dbPath);

    // Every table lost the same number of rows to the purge as
    // to the forget — except the two marker tables, which each
    // gained their own row.
    for (const table of Object.keys(before)) {
      const forgotDelta =
        countFor(before, table) - countFor(afterForget, table);
      const purgedDelta =
        countFor(afterForget, table) - countFor(afterPurge, table);
      if (table === "forgotten") {
        expect(forgotDelta).toBe(-1);
        expect(purgedDelta).toBe(0);
      } else if (table === "purged") {
        expect(forgotDelta).toBe(0);
        expect(purgedDelta).toBe(-1);
      } else {
        expect(purgedDelta).toBe(forgotDelta);
      }
    }
    expect(storage.isForgotten("sess-forgotten")).toBe(true);
    expect(storage.isPurged("sess-purged")).toBe(true);
  });

  it("purging a session of at least 50 MB gives at least 90% of its pages back", async () => {
    const { storage } = makeStorage(true);
    storage.checkpointWal();
    const baseline = storage.databaseBytes();
    const body = "x".repeat(100 * 1024);
    const db = direct(storage.dbPath);
    seedSession(db, "sess-big", "ended", NOW - 30 * DAY);
    db.close();
    for (let i = 0; i < 550; i += 1) {
      storage.insertRawEvent({
        source: "hook",
        sessionId: "sess-big",
        receivedAt: NOW - 30 * DAY + i,
        redactionVersion: 1,
        body,
      });
    }
    storage.checkpointWal();
    const withSession = storage.databaseBytes();
    expect(withSession - baseline).toBeGreaterThan(50 * 1024 * 1024);

    const retention = createRetention({
      storage,
      settings: settingsWith({ retentionDays: 15 }),
      now: () => NOW,
    });
    await retention.runOnce();
    const after = storage.databaseBytes();
    console.log(
      `50 MB purge: ${withSession} bytes with the session, ${after} after, baseline ${baseline}`,
    );
    expect(withSession - after).toBeGreaterThanOrEqual(
      0.9 * (withSession - baseline),
    );
  }, 300_000);

  it("the size cap deletes oldest first and keeps the live session", async () => {
    const { storage } = makeStorage(true);
    const body = "y".repeat(256 * 1024);
    const db = direct(storage.dbPath);
    // All inside the retention window, so only the cap acts.
    // The newest session carries the most data: a cap that
    // deleted newest-first would stop after it alone.
    const ages: [string, string, number, number][] = [
      ["sess-oldest", "ended", NOW - 4 * DAY, 2],
      ["sess-middle", "ended", NOW - 3 * DAY, 2],
      ["sess-newest", "ended", NOW - 2 * DAY, 12],
      // Active an hour ago: protected. A live session quiet for
      // a day would count as not live (the age test covers it).
      ["sess-live", "live", NOW - 60 * 60 * 1000, 2],
    ];
    for (const [id, status, lastSeen] of ages)
      seedSession(db, id, status, lastSeen);
    db.close();
    for (const [id, , , copies] of ages) {
      for (let i = 0; i < copies; i += 1) {
        storage.insertRawEvent({
          source: "hook",
          sessionId: id,
          receivedAt: NOW + i,
          redactionVersion: 1,
          body,
        });
      }
    }
    storage.checkpointWal();
    const total = storage.databaseBytes();

    const retention = createRetention({
      storage,
      settings: settingsWith({ retentionDays: 90 }),
      now: () => NOW,
      // Room for the newest and the live session, not the two
      // oldest ended ones (each about half a megabyte): the cap
      // sits three quarters of a megabyte under the total, so
      // exactly the two oldest deletions land under it.
      sizeCapBytes: total - 768 * 1024,
    });
    const run = await retention.runOnce();
    expect(run.aged).toBe(0);
    expect(run.capped).toBe(2);
    expect(storage.isPurged("sess-oldest")).toBe(true);
    expect(storage.isPurged("sess-middle")).toBe(true);
    expect(storage.allSessionIds()).toContain("sess-live");
    expect(storage.allSessionIds()).toContain("sess-newest");
    expect(storage.databaseBytes()).toBeLessThanOrEqual(total - 768 * 1024);
  }, 120_000);

  it("delete-all removes every session and marks each one purged", async () => {
    const { storage } = makeStorage();
    const db = direct(storage.dbPath);
    seedSession(db, "sess-a", "ended", NOW - DAY);
    seedCurrentRows(db, "sess-a");
    seedSession(db, "sess-live", "live", NOW);
    seedCurrentRows(db, "sess-live");
    db.close();

    const retention = createRetention({
      storage,
      settings: settingsWith({}),
      now: () => NOW,
    });
    expect(await retention.deleteAllData()).toBe(2);
    expect(storage.allSessionIds()).toEqual([]);
    const counts = tableCounts(storage.dbPath);
    expect(countFor(counts, "sessions")).toBe(0);
    expect(countFor(counts, "raw_events")).toBe(0);
    expect(countFor(counts, "forgotten")).toBe(0);
    // The markers are what stop the start-up import from
    // bringing the deleted sessions back from their
    // transcripts; the daemon test below runs that restart.
    expect(countFor(counts, "purged")).toBe(2);
    expect(storage.isPurged("sess-a")).toBe(true);
    expect(storage.isPurged("sess-live")).toBe(true);

    // A session that was live records again as a new recording:
    // the marker gates the import, never the recording itself.
    storage.insertRawEvent({
      source: "hook",
      sessionId: "sess-live",
      receivedAt: NOW + 1000,
      redactionVersion: 1,
      body: "{}",
    });
    expect(countFor(tableCounts(storage.dbPath), "raw_events")).toBe(1);
  });

  it("upgrading a version 4 database runs the one-time vacuum once, keeping every row", () => {
    const { root } = makeRoot("flightpath-retention-");
    const dbPath = join(root, "flightpath.db");
    const db = new DatabaseSync(dbPath);
    for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
    db.exec("PRAGMA user_version = 4");
    seedSession(db, "sess-v4", "ended", 200);
    seedRows(db, "sess-v4");
    const autoVacuumBefore = (
      db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
    ).auto_vacuum;
    db.close();
    expect(autoVacuumBefore).toBe(0);

    const storage = trackStorage(openStorage({ dataDir: root }));
    expect(storage.userVersion()).toBe(
      MIGRATIONS[MIGRATIONS.length - 1]?.version,
    );
    const check = direct(dbPath);
    expect(
      (check.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
        .auto_vacuum,
    ).toBe(2);
    expect(
      (
        check
          .prepare("SELECT value FROM meta WHERE key = 'auto_vacuum'")
          .get() as { value: string }
      ).value,
    ).toBe("incremental");
    check.close();
    const counts = tableCounts(dbPath);
    expect(countFor(counts, "sessions")).toBe(1);
    expect(countFor(counts, "steps")).toBe(1);
    expect(countFor(counts, "raw_events")).toBe(1);
    storage.close();
    untrackStorage(storage);

    // A second open does not run it again: the marker stands.
    trackStorage(openStorage({ dataDir: root }));
    const check2 = direct(dbPath);
    expect(
      (
        check2.prepare("SELECT COUNT(*) AS n FROM meta").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    check2.close();
  });
});

// The daemon-level checks: retention running at start must not
// hold up events, and the settings API carries the retention
// state and the delete-all route.

describe("retention in the daemon", () => {
  it("acknowledges a hook event within 250 ms while a purge of 500 sessions runs", async () => {
    const { root } = makeRoot("flightpath-retention-", { big: true });
    const dataDir = dataDirFor(root);
    mkdirSync(dataDir, { recursive: true });
    const storage = openStorage({ dataDir });
    const db = direct(storage.dbPath);
    const at = Date.now() - 30 * DAY;
    db.exec("BEGIN");
    for (let i = 0; i < 500; i += 1) {
      const id = `sess-bulk-${i}`;
      seedSession(db, id, "ended", at);
      for (let j = 0; j < 3; j += 1) {
        db.prepare(
          "INSERT INTO raw_events (source, session_id, received_at, redaction_version, body) VALUES ('hook', ?, ?, 1, '{}')",
        ).run(id, at + j);
        db.prepare(
          "INSERT INTO steps (session_id, tool_name) VALUES (?, 'Read')",
        ).run(id);
      }
    }
    db.exec("COMMIT");
    db.close();
    storage.close();

    const { child, port, token } = await startTestDaemon(root, {
      startOptions: { withTimingDefaults: false },
      timeoutMs: 30_000,
    });

    // The purge starts with the daemon; these events race
    // it and are acknowledged within 250 ms, with the purge
    // still running when they return.
    const ackBodies = [1, 2, 3, 4, 5].map((i) =>
      sequencedHookEnvelope("retention", {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-fresh",
        cwd: "/work/app",
        prompt_id: `p-${i}`,
        prompt: "hello",
      }),
    );
    const ackSamples = await measureAcks(
      port,
      { method: "POST", path: "/events/hook", token },
      ackBodies,
      "ack while a 500-session purge runs",
    );
    expect(Math.max(...ackSamples)).toBeLessThan(250);
    expect(
      countWhere(dataDir, "SELECT COUNT(*) AS n FROM sessions"),
    ).toBeGreaterThan(1);

    // And the purge does finish: only the fresh session remains.
    await waitForSessionCount(dataDir, 1, 120_000);
    child.kill("SIGTERM");
  }, 300_000);

  it("reports retention in the settings payload, and delete-all-data clears the store", async () => {
    const { root } = makeRoot("flightpath-retention-");
    const dataDir = dataDirFor(root);
    mkdirSync(dataDir, { recursive: true });
    const storage = openStorage({ dataDir });
    const db = direct(storage.dbPath);
    seedSession(db, "sess-old", "ended", Date.now() - 30 * DAY);
    seedSession(db, "sess-live", "live", Date.now());
    db.close();
    storage.close();

    const { child, port, token } = await startTestDaemon(root, {
      startOptions: { withTimingDefaults: false },
      timeoutMs: 30_000,
    });

    const payload = await callDaemon(port, {
      method: "GET",
      path: "/api/settings",
      token,
    });
    expect(payload.status).toBe(200);
    const parsed = JSON.parse(payload.body) as {
      retention: { databaseBytes: number; purgeCounts: Record<string, number> };
    };
    expect(parsed.retention.databaseBytes).toBeGreaterThan(0);
    // The old session is counted at every offered period; the
    // daemon's own start-up purge may already have taken it, so
    // the settings payload is checked for shape, and the
    // delete below for effect.
    expect(Object.keys(parsed.retention.purgeCounts).sort()).toEqual([
      "15",
      "30",
      "60",
      "7",
      "90",
    ]);

    const deleted = await callDaemon(port, {
      method: "POST",
      path: "/api/delete-all-data",
      token,
    });
    expect(deleted.status).toBe(200);
    const outcome = JSON.parse(deleted.body) as { deletedSessions: number };
    expect(outcome.deletedSessions).toBeGreaterThanOrEqual(1);
    await waitForSessionCount(dataDir, 0, 30_000);
    child.kill("SIGTERM");
  }, 120_000);

  it("delete-all stays deleted across a restart: the import does not bring a session back", async () => {
    const { root } = makeRoot("flightpath-retention-");
    const dataDir = dataDirFor(root);
    mkdirSync(dataDir, { recursive: true });
    // One home for both daemon runs: the transcripts under it,
    // the data folder under its xdg directory.
    const home = join(root, "home");
    const projectDir = join(home, ".claude", "projects", "-work-app");
    mkdirSync(projectDir, { recursive: true });
    const goneId = "11111111-2222-3333-4444-555555555555";
    const stamp = new Date().toISOString();
    const transcriptPath = join(projectDir, `${goneId}.jsonl`);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId: goneId,
          cwd: "/work/app",
          timestamp: stamp,
          message: { content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: goneId,
          cwd: "/work/app",
          timestamp: stamp,
          message: { content: [] },
        }),
      ].join("\n") + "\n",
    );
    const sessionIds = (): string[] => {
      const rows = queryRows(
        join(dataDir, "flightpath.db"),
        "SELECT id FROM sessions ORDER BY id",
      ) as { id: string }[];
      return rows.map((row) => row.id);
    };
    const stopAndWait = async (child: ChildProcess): Promise<void> => {
      const exited = new Promise((resolvePromise) =>
        child.once("exit", () => resolvePromise("exited")),
      );
      child.kill("SIGTERM");
      await exited;
    };

    const {
      child: first,
      port,
      token,
    } = await startTestDaemon(root, {
      extra: { HOME: home },
      startOptions: { withTimingDefaults: false },
      timeoutMs: 30_000,
    });
    const post = (
      event: Record<string, unknown>,
    ): Promise<{ status: number }> =>
      callDaemon(port, {
        method: "POST",
        path: "/events/hook",
        token,
        body: sequencedHookEnvelope("retention", event),
      });

    // The session is recorded for real, through the hook path.
    expect(
      (
        await post({
          hook_event_name: "SessionStart",
          session_id: goneId,
          source: "startup",
          cwd: "/work/app",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post({
          hook_event_name: "UserPromptSubmit",
          session_id: goneId,
          cwd: "/work/app",
          prompt_id: "p-1",
          prompt: "hello",
        })
      ).status,
    ).toBe(204);
    await waitFor(() => sessionIds().includes(goneId), 30_000);

    const deleted = await callDaemon(port, {
      method: "POST",
      path: "/api/delete-all-data",
      token,
    });
    expect(deleted.status).toBe(200);
    await waitFor(() => sessionIds().length === 0, 30_000);

    // The project stays recorded — a new session in it — so
    // the next start's import scans this project's transcripts,
    // the deleted session's among them.
    const keeperId = "99999999-8888-7777-6666-555555555555";
    expect(
      (
        await post({
          hook_event_name: "SessionStart",
          session_id: keeperId,
          source: "startup",
          cwd: "/work/app",
        })
      ).status,
    ).toBe(204);
    await waitFor(() => sessionIds().includes(keeperId), 30_000);
    // The deleted session's transcript is still on disk, with
    // the mtime of a session that ran after install.
    const now = new Date();
    utimesSync(transcriptPath, now, now);
    await stopAndWait(first);

    const second = startDaemon(
      root,
      { HOME: home },
      { withTimingDefaults: false },
    );
    await waitFor(() => existsSync(join(dataDir, "port")), 30_000);
    // The start-up import gets its chance, and keeps getting
    // it: the deleted session must not reappear.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      expect(sessionIds()).not.toContain(goneId);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sessionIds()).toEqual([keeperId]);
    await stopAndWait(second);
  }, 120_000);
});
