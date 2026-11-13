import { join } from "node:path";

import { expect } from "vitest";

import { openStorage, type Storage } from "../../src/storage/index.js";
import { MIGRATIONS } from "../../src/storage/schema.js";
import { DatabaseSync } from "../../src/storage/sqlite.js";
import { makeTempRoot, registerCleanup } from "./cleanup.js";
import { firstRow } from "./rows.js";

const trackedUnregisters = new Map<Storage, () => void>();

/** Open storage on a data dir, asserting it lands on the latest migration's version. */
export function openAtLatestVersion(dataDir: string): Storage {
  const storage = openStorage({ dataDir });
  expect(storage.userVersion()).toBe(
    MIGRATIONS[MIGRATIONS.length - 1]?.version,
  );
  return storage;
}

/**
 * Seed a database as an older build left it: the migrations up
 * to `version`, stamped with that version, plus the rows the
 * seed callback writes. Everything lands in one transaction.
 * A historical database's contents are what a case is about,
 * not how many file syncs writing them takes — written
 * statement by statement, each statement is its own
 * transaction with its own journal write and sync, and on a
 * slow file system that cost, not the upgrade under test, is
 * what a case spends its time on.
 */
export function seedVersionedDatabase(
  dataDir: string,
  version: number,
  seed: (db: DatabaseSync) => void,
): void {
  const db = new DatabaseSync(join(dataDir, "flightpath.db"));
  try {
    db.exec("BEGIN");
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) {
        db.exec(migration.sql);
      }
    }
    db.exec(`PRAGMA user_version = ${version}`);
    seed(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function trackStorage<T extends Storage>(storage: T): T {
  trackedUnregisters.set(
    storage,
    registerCleanup(() => storage.close()),
  );
  return storage;
}

export function untrackStorage(storage: Storage): void {
  const unregister = trackedUnregisters.get(storage);
  if (unregister) {
    unregister();
    trackedUnregisters.delete(storage);
  }
}

export function queryRows(
  dbPath: string,
  sql: string,
  ...params: unknown[]
): Record<string, unknown>[] {
  // The busy timeout lets a read wait out the daemon's write
  // lock instead of failing with "database is locked".
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all(...(params as never[])) as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

export function countWhere(dataDir: string, sql: string): number {
  const row = firstRow(
    queryRows(join(dataDir, "flightpath.db"), sql),
    "a count row",
  );
  return Number(row.n);
}

export function countSessionRows(
  db: DatabaseSync,
  table: string,
  sessionId: string,
): number {
  const column = table === "sessions" ? "id" : "session_id";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .get(sessionId) as { n: number };
  return row.n;
}

export function allStoredText(storage: Storage): string {
  const db = new DatabaseSync(storage.dbPath);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    const chunks: string[] = [];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM ${name}`).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) chunks.push(JSON.stringify(row));
    }
    return chunks.join("\n");
  } finally {
    db.close();
  }
}

export interface StorageWorld {
  root: string;
  dataDir: string;
  storage: Storage;
  read: DatabaseSync;
}

export function makeStorageWorld(root: string, dataDir = root): StorageWorld {
  const storage = openStorage({ dataDir });
  const read = new DatabaseSync(storage.dbPath, { readOnly: true });
  registerCleanup(() => storage.close());
  registerCleanup(() => read.close());
  return { root, dataDir, storage, read };
}

/** A fresh storage and a second connection to seed its rows through. */
export function makeSeedWorld(prefix: string): {
  storage: Storage;
  db: DatabaseSync;
} {
  const storage = openStorage({ dataDir: makeTempRoot(prefix) });
  const db = new DatabaseSync(storage.dbPath);
  registerCleanup(() => {
    db.close();
    storage.close();
  });
  return { storage, db };
}
