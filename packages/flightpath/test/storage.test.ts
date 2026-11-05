import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
// Tests open the database file directly to seed rows and to verify
// what the module wrote — the "test reader" the schema is designed
// to coexist with. Product code imports node:sqlite only through
// src/storage/sqlite.ts.
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NO_CATEGORIES } from "./support/context-report.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { seedWarmPair } from "./support/rebuild-pair.js";
import {
  allStoredText,
  countSessionRows,
  makeSeedWorld,
} from "./support/storage.js";

import { dismissFinding } from "../src/api/index.js";
import { openStorage } from "../src/storage/index.js";
import { FORGET_ORDER } from "../src/storage/schema.js";

afterEach(async () => {
  await runCleanups();
});

function directDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Every table that holds per-session rows, derived from the schema
 * itself — not from a list in the code — so a table added later is
 * checked here automatically.
 */
function tablesWithSessionId(db: DatabaseSync): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return tables
    .map((row) => row.name)
    .filter((name) => {
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info('${name}')`)
        .all() as { name: string }[];
      return columns.some((column) => column.name === "session_id");
    });
}

describe("openStorage", () => {
  it("creates flightpath.db in the data folder, in WAL mode, at the current schema", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const storage = openStorage({ dataDir: dir });
    expect(storage.dbPath).toBe(join(dir, "flightpath.db"));
    expect(storage.userVersion()).toBe(24);
    storage.close();

    const db = directDb(storage.dbPath);
    const mode = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(mode.journal_mode).toBe("wal");
    db.close();
  });

  it("is idempotent across restarts and keeps stored events", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const first = openStorage({ dataDir: dir });
    first.insertRawEvent({
      source: "hook",
      sessionId: "sess-1",
      redactionVersion: 1,
      body: "{}",
    });
    first.close();

    const second = openStorage({ dataDir: dir });
    expect(second.userVersion()).toBe(24);
    expect(second.countRawEvents()).toBe(1);
    expect(second.countRawEvents("sess-1")).toBe(1);
    expect(second.countRawEvents("sess-2")).toBe(0);
    second.close();
  });

  it("refuses a database from a newer version and leaves it untouched", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const storage = openStorage({ dataDir: dir });
    const dbPath = storage.dbPath;
    storage.close();

    const db = directDb(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();

    expect(() => openStorage({ dataDir: dir })).toThrow(/newer version/);

    const after = directDb(dbPath);
    const version = after.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(99);
    const sessions = after
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sessions'",
      )
      .get() as { n: number };
    expect(sessions.n).toBe(1);
    after.close();
  });
});

/** Seed two sessions with a row in every per-session table. */
function seedTwoSessions(): {
  storage: ReturnType<typeof openStorage>;
  db: DatabaseSync;
} {
  const dir = makeTempRoot("flightpath-storage-");
  const storage = openStorage({ dataDir: dir });
  storage.insertRawEvent({
    source: "hook",
    sessionId: "sess-1",
    redactionVersion: 1,
    body: "{}",
  });
  storage.insertRawEvent({
    source: "hook",
    sessionId: "sess-2",
    redactionVersion: 1,
    body: "{}",
  });

  // Seed one row per table for both sessions.
  const db = directDb(storage.dbPath);
  // The shape both sessions name in their session_shapes
  // rows below: its row exists before the namings point at it.
  db.exec(
    "INSERT INTO request_shapes (hash, tools) VALUES ('shape-seed', '[]')",
  );
  const seed: [string, string][] = [
    ["sessions", "(id, first_seen_at, last_seen_at) VALUES (?, 1, 1)"],
    ["segments", "(session_id, kind, started_at) VALUES (?, 'startup', 1)"],
    ["turns", "(session_id, sequence) VALUES (?, 1)"],
    ["session_conditions", "(session_id, updated_at) VALUES (?, 1)"],
    ["pauses", "(session_id, paused_at) VALUES (?, 1)"],
    ["branches", "(session_id) VALUES (?)"],
    ["steps", "(session_id, tool_name) VALUES (?, 'Read')"],
    ["requests", "(session_id) VALUES (?)"],
    ["session_shapes", "(session_id, hash) VALUES (?, 'shape-seed')"],
    ["human_events", "(session_id, kind, occurred_at) VALUES (?, 'prompt', 1)"],
    [
      "context_samples",
      "(session_id, sampled_at, context_tokens, source) VALUES (?, 1, 10, 'telemetry')",
    ],
    [
      "context_reports",
      "(session_id, model, window, reported_at) VALUES (?, 'claude-sonnet-5-5', 1000000, 1)",
    ],
    [
      "compaction_files",
      "(session_id, at, name, reread) VALUES (?, 1, 'notes.md', 1)",
    ],
    [
      "loads",
      "(session_id, kind, occurred_at, source) VALUES (?, 'skill', 1, 'hook')",
    ],
    [
      "finding_dismissals",
      "(session_id, finding_id, dismissed_at) VALUES (?, 'rebuild-1', 1)",
    ],
  ];
  for (const sessionId of ["sess-1", "sess-2"]) {
    for (const [table, clause] of seed) {
      db.prepare(`INSERT INTO ${table} ${clause}`).run(sessionId);
    }
  }
  // Prompt attachments hang off a turn, so they seed from the
  // turns just inserted: one per session.
  db.exec(`
    INSERT INTO prompt_attachments (session_id, turn_id, kind)
    SELECT session_id, id, 'image' FROM turns WHERE sequence = 1;
  `);
  // Linked rows for sess-1: a step tied to a turn and a branch, the
  // branch pointing back at its spawning step, and rows hanging off
  // the step. This is the shape that decides whether the deletion
  // order respects the foreign keys.
  db.exec(`
    INSERT INTO turns (id, session_id, sequence) VALUES (101, 'sess-1', 101);
    INSERT INTO branches (id, session_id, agent_id) VALUES (101, 'sess-1', 'agent-1');
    INSERT INTO steps (id, session_id, turn_id, branch_id, tool_name) VALUES (101, 'sess-1', 101, 101, 'Read');
    UPDATE branches SET spawning_step_id = 101 WHERE id = 101;
    INSERT INTO requests (id, session_id, turn_id, branch_id) VALUES (101, 'sess-1', 101, 101);
    INSERT INTO context_samples (session_id, request_id, sampled_at, context_tokens, source) VALUES ('sess-1', 101, 1, 10, 'telemetry');
    INSERT INTO human_events (session_id, turn_id, step_id, kind, occurred_at) VALUES ('sess-1', 101, 101, 'prompt', 1);
  `);
  return { storage, db };
}

/** Every session table's rows: none of the gone session's,
 * some of the kept one's, in the sessions table itself too. */
function expectSessionRowsGone(
  db: DatabaseSync,
  goneId: string,
  keptId: string,
): string[] {
  const sessionTables = tablesWithSessionId(db).filter(
    (table) => table !== "forgotten" && table !== "purged",
  );
  expect(sessionTables.length).toBeGreaterThan(0);
  for (const table of [...sessionTables, "sessions"]) {
    expect(countSessionRows(db, table, goneId), table).toBe(0);
    expect(countSessionRows(db, table, keptId), table).toBeGreaterThan(0);
  }
  return sessionTables;
}

describe("forgetSession", () => {
  it("removes the session from every table and leaves only its marker", () => {
    const { storage, db } = seedTwoSessions();
    expect(storage.isForgotten("sess-1")).toBe(false);
    storage.forgetSession("sess-1", 1234);

    expectSessionRowsGone(db, "sess-1", "sess-2");
    db.close();
    storage.close();
  });

  it("deletes the shapes only the forgotten session referenced", () => {
    const { storage, db } = seedTwoSessions();
    // shape-shared is referenced by both sessions: sess-2's
    // request below and sess-1's linked request (id 101, from
    // the seed). shape-seed is named by both sessions in
    // session_shapes and referenced by no request at all.
    db.exec(`
      INSERT INTO request_shapes (hash, tools) VALUES ('shape-solo', '[]');
      INSERT INTO request_shapes (hash, tools) VALUES ('shape-shared', '[]');
      UPDATE requests SET shape_hash = 'shape-solo'
        WHERE id = (SELECT MIN(id) FROM requests WHERE session_id = 'sess-1');
      UPDATE requests SET shape_hash = 'shape-shared'
        WHERE id = (SELECT MIN(id) FROM requests WHERE session_id = 'sess-2');
      UPDATE requests SET shape_hash = 'shape-shared' WHERE id = 101;
    `);
    storage.forgetSession("sess-1", 1234);
    const remaining = db
      .prepare("SELECT hash FROM request_shapes ORDER BY hash")
      .all() as { hash: string }[];
    // shape-solo goes with sess-1. The other two stay: one is
    // still referenced by sess-2's request, the other is
    // still named by sess-2.
    expect(remaining.map((row) => row.hash)).toEqual([
      "shape-seed",
      "shape-shared",
    ]);
    db.close();
    storage.close();
  });

  it("stamps the forgotten marker with the forget time", () => {
    const { storage, db } = seedTwoSessions();
    storage.forgetSession("sess-1", 1234);
    const marker = db
      .prepare("SELECT forgotten_at FROM forgotten WHERE session_id = ?")
      .get("sess-1") as { forgotten_at: number } | undefined;
    expect(marker?.forgotten_at).toBe(1234);
    expect(storage.isForgotten("sess-1")).toBe(true);
    expect(storage.isForgotten("sess-2")).toBe(false);
    db.close();
    storage.close();
  });
});

describe("the forget order", () => {
  it("names every table that holds a session's rows", () => {
    const { storage, db } = seedTwoSessions();
    const held = tablesWithSessionId(db).filter(
      (table) => table !== "forgotten" && table !== "purged",
    );
    db.close();
    storage.close();
    expect([...FORGET_ORDER].sort()).toEqual(held.sort());
  });
});

describe("dismissed findings", () => {
  it("are deleted with their session by forget and by purge", () => {
    const { storage, db } = seedTwoSessions();
    expect(storage.listDismissals("sess-1")).toEqual(["rebuild-1"]);
    storage.forgetSession("sess-1", 1);
    storage.purgeSession("sess-2", 2);
    expect(storage.listDismissals("sess-1")).toEqual([]);
    expect(storage.listDismissals("sess-2")).toEqual([]);
    db.close();
    storage.close();
  });

  it("are the only trace of findings: no finding sentence reaches any table", () => {
    const world = makeSeedWorld("flightpath-storage-");
    seedWarmPair(world.db, "sess-1", {}, { model: "claude-opus" });
    expect(dismissFinding(world.storage, "sess-1", "rebuild-2")).toBe(true);
    const columns = world.db
      .prepare("SELECT name FROM pragma_table_info('finding_dismissals')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      "session_id",
      "finding_id",
      "dismissed_at",
    ]);
    const stored = allStoredText(world.storage);
    expect(stored).toContain("rebuild-2");
    expect(stored).not.toContain("written again");
    expect(stored).not.toContain("Pick your model");
  });
});

describe("purgeSession", () => {
  it("removes the session's change rows with the rest of its rows", () => {
    const { storage, db } = seedTwoSessions();
    // The seed's writes leave change entries for both
    // sessions; a purge through the same deletion path as a
    // forget takes the purged session's entries with it.
    expect(countSessionRows(db, "row_changes", "sess-1")).toBeGreaterThan(0);
    expect(storage.isPurged("sess-1")).toBe(false);
    storage.purgeSession("sess-1", 1234);

    const sessionTables = expectSessionRowsGone(db, "sess-1", "sess-2");
    expect(sessionTables).toContain("row_changes");
    expect(storage.isPurged("sess-1")).toBe(true);
    expect(storage.isPurged("sess-2")).toBe(false);
    db.close();
    storage.close();
  });
});

describe("context reports", () => {
  it("are deleted with their session by forget and by purge", () => {
    const { storage, db } = seedTwoSessions();
    storage.recordContextReport(
      "sess-1",
      {
        model: "claude-opus-5-5",
        window: 1_000_000,
        autocompactBuffer: 33_000,
        ...NO_CATEGORIES,
      },
      10,
    );
    // The seeded row for the other model stands beside it.
    expect(storage.contextReportsFor("sess-1")).toHaveLength(2);

    storage.forgetSession("sess-1", 1234);
    expect(storage.contextReportsFor("sess-1")).toEqual([]);
    expect(storage.contextReportsFor("sess-2")).toHaveLength(1);

    storage.purgeSession("sess-2", 1234);
    expect(storage.contextReportsFor("sess-2")).toEqual([]);
    db.close();
    storage.close();
  });
});

describe("a context report's memory files", () => {
  it("are stored, and replaced by a later report for the same model", () => {
    const { storage, db } = seedTwoSessions();
    const report = (memoryFiles: number | null) => ({
      model: "claude-opus-5-5",
      window: 1_000_000,
      autocompactBuffer: 33_000,
      ...NO_CATEGORIES,
      memoryFiles,
    });
    const memoryFilesStored = () =>
      storage
        .contextReportsFor("sess-1")
        .find((row) => row.model === "claude-opus-5-5")?.memoryFiles;

    storage.recordContextReport("sess-1", report(2_300), 10);
    expect(memoryFilesStored()).toBe(2_300);
    storage.recordContextReport("sess-1", report(null), 20);
    expect(memoryFilesStored()).toBeNull();
    db.close();
    storage.close();
  });
});

describe("concurrent access", () => {
  it("two open handles write without lock errors", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const a = openStorage({ dataDir: dir });
    const b = openStorage({ dataDir: dir });
    for (let i = 0; i < 50; i++) {
      a.insertRawEvent({
        source: "hook",
        sessionId: "a",
        redactionVersion: 1,
        body: "{}",
      });
      b.insertRawEvent({
        source: "hook",
        sessionId: "b",
        redactionVersion: 1,
        body: "{}",
      });
    }
    expect(a.countRawEvents()).toBe(100);
    a.close();
    b.close();
  });

  it("a second process writes at the same time as this one", async () => {
    const dir = makeTempRoot("flightpath-storage-");
    const storage = openStorage({ dataDir: dir });
    const child = join(dir, "writer.mjs");
    writeFileSync(
      child,
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.argv[2]);
       db.exec("PRAGMA busy_timeout = 5000");
       const stmt = db.prepare("INSERT INTO raw_events (source, session_id, received_at, redaction_version, body) VALUES ('hook', 'child', 1, 1, '{}')");
       // Batched transactions: 500 single-row commits are mostly
       // fsync time on Windows and would dominate the test.
       for (let batch = 0; batch < 10; batch++) {
         db.exec("BEGIN");
         for (let i = 0; i < 50; i++) stmt.run();
         db.exec("COMMIT");
       }
       db.close();`,
    );
    // Start the child without waiting, then write from this process
    // while it runs. The busy timeout is what lets both sides land
    // their writes instead of failing with lock errors.
    const childDone = new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [child, storage.dbPath], (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    for (let i = 0; i < 50; i++) {
      storage.insertRawEvent({
        source: "telemetry",
        sessionId: "parent",
        redactionVersion: 1,
        body: "{}",
      });
    }
    await childDone;
    expect(storage.countRawEvents()).toBe(550);
    storage.close();
    // Cross-process work on a Windows runner is far slower than the
    // 5s default allows; the timeout is headroom, not the assertion.
  }, 30_000);
});

describe("liveSessions and countSessions", () => {
  it("counts every stored session and lists the live ones with their first prompt text, oldest first", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const first = openStorage({ dataDir: dir });
    const dbPath = first.dbPath;
    first.close();

    const db = directDb(dbPath);
    const addSession = db.prepare(
      "INSERT INTO sessions (id, project_path, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    );
    addSession.run("live-1", "/work/tip-calc", "live", 1000, 2000);
    addSession.run("live-2", "/work/other-app", "live", 500, 900);
    addSession.run("ended-1", "/work/old", "ended", 100, 200);
    const addTurn = db.prepare(
      "INSERT INTO turns (session_id, sequence, prompt_text) VALUES (?, ?, ?)",
    );
    addTurn.run("live-1", 1, "  Build a tip calculator\nwith tests");
    addTurn.run("live-1", 2, "A later prompt does not rename it");
    addTurn.run("ended-1", 1, "An ended session is not recording");
    db.close();

    const storage = openStorage({ dataDir: dir });
    expect(storage.countSessions()).toBe(3);
    expect(storage.liveSessions()).toEqual([
      { id: "live-2", firstPromptText: null },
      { id: "live-1", firstPromptText: "  Build a tip calculator\nwith tests" },
    ]);
    storage.close();
  });

  it("reports no live sessions and a zero count on a fresh database", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const storage = openStorage({ dataDir: dir });
    expect(storage.countSessions()).toBe(0);
    expect(storage.liveSessions()).toEqual([]);
    storage.close();
  });
});

describe("envelope dedupe", () => {
  it("stores an envelope once, by its envelope id", () => {
    const dir = makeTempRoot("flightpath-storage-");
    const storage = openStorage({ dataDir: dir });
    const event = {
      source: "hook" as const,
      sessionId: "s1",
      redactionVersion: 1,
      envelopeId: "env-1",
      body: JSON.stringify({ id: "env-1" }),
    };
    expect(storage.insertRawEvent(event)).toBe(true);
    expect(storage.insertRawEvent(event)).toBe(false);
    expect(storage.countRawEvents()).toBe(1);
    storage.close();
  });
});
