import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { removeTree } from "./support/remove-tree.js";
import { rowAt } from "./support/rows.js";
import { openAtLatestVersion } from "./support/storage.js";

import { openStorage } from "../src/storage/index.js";
import { MIGRATIONS } from "../src/storage/schema.js";

// The applied schema, exactly as SQLite records it. Any schema
// change — deliberate or accidental — fails this test until the
// snapshot file is updated in the same change, so migrations are
// always visible in review.
describe("schema snapshot", () => {
  it("matches test/schema.snapshot.sql", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-"));
    try {
      const storage = openStorage({ dataDir: dir });
      storage.close();
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      const rows = db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as { type: string; name: string; sql: string }[];
      db.close();
      const applied = rows
        .map((row) => `${row.sql.replace(/\s+/g, " ").trim()};`)
        .join("\n");
      const snapshot = readFileSync(
        new URL("./schema.snapshot.sql", import.meta.url),
        "utf8",
      ).trim();
      expect(applied).toBe(snapshot);
    } finally {
      removeTree(dir);
    }
  });

  it("upgrades a version 1 database in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v1-"));
    try {
      // A database written by the first build: migration 1
      // only, stamped version 1, with a session already in it.
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      db.exec(rowAt(MIGRATIONS, 0, "migration").sql);
      db.exec("PRAGMA user_version = 1");
      db.prepare(
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v1', 'ended', 100, 200, 0)",
      ).run();
      db.prepare(
        "INSERT INTO session_conditions (session_id, updated_at) VALUES ('sess-v1', 200)",
      ).run();
      db.close();

      const storage = openStorage({ dataDir: dir });
      expect(storage.userVersion()).toBe(
        MIGRATIONS[MIGRATIONS.length - 1]?.version,
      );
      // The columns the later migrations add are present and
      // usable, and the existing rows survive.
      storage.markTokensPartial("sess-v1");
      storage.noteTelemetrySeen("sess-v1", 300);
      const check = new DatabaseSync(join(dir, "flightpath.db"));
      const session = check
        .prepare("SELECT tokens_partial FROM sessions WHERE id = 'sess-v1'")
        .get() as { tokens_partial: number };
      expect(session.tokens_partial).toBe(1);
      const conditions = check
        .prepare(
          "SELECT sources_seen FROM session_conditions WHERE session_id = 'sess-v1'",
        )
        .get() as { sources_seen: string };
      expect(JSON.parse(conditions.sources_seen)).toContain("telemetry");
      check.close();
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("upgrades a version 10 database in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v10-"));
    try {
      // A database at version 10, with a session and a step
      // already in it: the new columns land on the step,
      // null, and are writable.
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 10)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 10");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v10', 'ended', 100, 200, 0)",
        "INSERT INTO steps (session_id, tool_use_id, tool_name) VALUES ('sess-v10', 'toolu_v10', 'Read')",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      const check = new DatabaseSync(join(dir, "flightpath.db"));
      const before = check
        .prepare(
          "SELECT context_chars, context_images FROM steps WHERE session_id = 'sess-v10'",
        )
        .get() as { context_chars: unknown; context_images: unknown };
      expect(before.context_chars).toBeNull();
      expect(before.context_images).toBeNull();
      check
        .prepare(
          "UPDATE steps SET context_chars = 1200, context_images = 1 WHERE session_id = 'sess-v10'",
        )
        .run();
      const after = check
        .prepare(
          "SELECT context_chars, context_images FROM steps WHERE session_id = 'sess-v10'",
        )
        .get() as { context_chars: unknown; context_images: unknown };
      expect(after.context_chars).toBe(1200);
      expect(after.context_images).toBe(1);
      check.close();
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a report stored at version 13, its category rows null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v13-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 13)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 13");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v13', 'ended', 100, 200, 0)",
        "INSERT INTO context_reports (session_id, model, window, autocompact_buffer, reported_at) VALUES ('sess-v13', 'claude-sonnet-5-5', 1000000, 33000, 150)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.contextReportsFor("sess-v13")).toEqual([
        {
          model: "claude-sonnet-5-5",
          window: 1_000_000,
          autocompactBuffer: 33_000,
          systemPrompt: null,
          systemTools: null,
          mcpInstructions: null,
          memoryFiles: null,
          skills: null,
          reportedAt: 150,
        },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a listing stored at version 19, its names null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v19-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.filter((m) => m.version <= 19)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 19");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v19', 'ended', 100, 200, 0)",
        "INSERT INTO loads (session_id, kind, occurred_at, source, size_bytes, item_count) VALUES ('sess-v19', 'skill-listing', 150, 'transcript', 20000, 40)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.loadRows("sess-v19")).toMatchObject([
        { kind: "skill-listing", itemCount: 40, names: null },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("drops the definition loads stored at version 23 and keeps the task loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v23-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.filter((m) => m.version <= 23)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 23");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v23', 'ended', 100, 200, 0)",
        "INSERT INTO loads (session_id, kind, occurred_at, source, size_bytes) VALUES ('sess-v23', 'agent-definition', 150, 'transcript', 8000)",
        "INSERT INTO loads (session_id, kind, occurred_at, source, size_bytes) VALUES ('sess-v23', 'task-prompt', 150, 'transcript', 1100)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.loadRows("sess-v23")).toMatchObject([
        { kind: "task-prompt", sizeBytes: 1100 },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a skill and a step stored at version 22, the new links null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v22-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.filter((m) => m.version <= 22)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 22");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v22', 'ended', 100, 200, 0)",
        "INSERT INTO loads (session_id, kind, name, occurred_at, source, size_bytes) VALUES ('sess-v22', 'skill', 'code-style', 150, 'hook', 4000)",
        "INSERT INTO steps (session_id, tool_use_id, tool_name, started_at) VALUES ('sess-v22', 'toolu_made_up', 'Bash', 160)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.loadRows("sess-v22")).toMatchObject([
        { kind: "skill", sizeBytes: 4000, parentLoadId: null, lineCount: null },
      ]);
      expect(storage.stepRows("sess-v22")).toMatchObject([
        { toolUseId: "toolu_made_up", savedOutputBytes: null },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a listing stored at version 21, its branch null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v21-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.filter((m) => m.version <= 21)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 21");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v21', 'ended', 100, 200, 0)",
        "INSERT INTO loads (session_id, kind, occurred_at, source, size_bytes, item_count) VALUES ('sess-v21', 'skill-listing', 150, 'transcript', 20000, 40)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.loadRows("sess-v21")).toMatchObject([
        { kind: "skill-listing", itemCount: 40, branchId: null },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a step stored at version 14, its launch mark null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v14-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 14)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 14");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v14', 'ended', 100, 200, 0)",
        "INSERT INTO steps (session_id, tool_use_id, tool_name, result_size) VALUES ('sess-v14', 'toolu_v14', 'Agent', 1132)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.stepRows("sess-v14")).toMatchObject([
        { toolName: "Agent", resultSize: 1_132, asyncLaunch: null },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("keeps a report stored at version 15, its system tools null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v15-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 15)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 15");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v15', 'ended', 100, 200, 0)",
        "INSERT INTO context_reports (session_id, model, window, autocompact_buffer, system_prompt, mcp_instructions, skills, reported_at) VALUES ('sess-v15', 'claude-sonnet-5-5', 1000000, 33000, 2800, 1300, 8300, 150)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.contextReportsFor("sess-v15")).toEqual([
        {
          model: "claude-sonnet-5-5",
          window: 1_000_000,
          autocompactBuffer: 33_000,
          systemPrompt: 2_800,
          systemTools: null,
          mcpInstructions: 1_300,
          memoryFiles: null,
          skills: 8_300,
          reportedAt: 150,
        },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("adds the compaction files table to a version 16 database and leaves its rows intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v16-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 16)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 16");
      db.prepare(
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v16', 'ended', 100, 200, 0)",
      ).run();
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.sessionRow("sess-v16")?.id).toBe("sess-v16");
      expect(storage.compactionFileRows("sess-v16")).toEqual([]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("clears the command marks a version 17 database stored, under the column's new name", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v17-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 17)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 17");
      db.prepare(
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v17', 'ended', 100, 200, 0)",
      ).run();
      // A turn the old meaning marked: another command's, so
      // the upgrade clears it instead of billing it to
      // Flightpath under the new meaning.
      db.prepare(
        "INSERT INTO turns (session_id, prompt_id, sequence, started_at, prompt_text, from_command) VALUES ('sess-v17', 'p-1', 1, 100, '/review', 1)",
      ).run();
      db.close();

      const storage = openAtLatestVersion(dir);
      storage.close();
      const check = new DatabaseSync(join(dir, "flightpath.db"));
      const row = check
        .prepare(
          "SELECT flightpath_command FROM turns WHERE session_id = 'sess-v17'",
        )
        .get() as { flightpath_command: number };
      expect(row.flightpath_command).toBe(0);
      expect(() =>
        check.prepare("SELECT from_command FROM turns").get(),
      ).toThrow();
      check.close();
    } finally {
      removeTree(dir);
    }
  });

  it("adds the memory files column to a version 19 database and leaves its reports intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v19-"));
    try {
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 19)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 19");
      for (const seed of [
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v19', 'ended', 100, 200, 0)",
        "INSERT INTO context_reports (session_id, model, window, autocompact_buffer, system_prompt, system_tools, mcp_instructions, skills, reported_at) VALUES ('sess-v19', 'claude-sonnet-5-5', 1000000, 33000, 2800, 19600, 1300, 8300, 150)",
      ]) {
        db.prepare(seed).run();
      }
      db.close();

      const storage = openAtLatestVersion(dir);
      expect(storage.contextReportsFor("sess-v19")).toEqual([
        {
          model: "claude-sonnet-5-5",
          window: 1_000_000,
          autocompactBuffer: 33_000,
          systemPrompt: 2_800,
          systemTools: 19_600,
          mcpInstructions: 1_300,
          memoryFiles: null,
          skills: 8_300,
          reportedAt: 150,
        },
      ]);
      storage.close();
    } finally {
      removeTree(dir);
    }
  });

  it("redacts and caps stored prompt text when upgrading a version 5 database", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v5-"));
    try {
      // A database at version 5, holding a prompt stored before
      // it was redacted and capped at intake: a secret in it,
      // and more than 2,000 characters in all.
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      for (const migration of MIGRATIONS.slice(0, 5)) {
        db.exec(migration.sql);
      }
      db.exec("PRAGMA user_version = 5");
      db.prepare(
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v5', 'ended', 100, 200, 0)",
      ).run();
      const stored =
        "leak: API_KEY=" + "envsecretvalue" + "\n" + "z".repeat(3000);
      db.prepare(
        "INSERT INTO turns (session_id, prompt_id, sequence, started_at, prompt_text, from_command) VALUES ('sess-v5', 'p-1', 1, 100, ?, 0)",
      ).run(stored);
      db.close();

      const readTurn = () => {
        const check = new DatabaseSync(join(dir, "flightpath.db"));
        const row = check
          .prepare(
            "SELECT prompt_text, prompt_chars, prompt_lines FROM turns WHERE session_id = 'sess-v5'",
          )
          .get() as {
          prompt_text: string;
          prompt_chars: number;
          prompt_lines: number;
        };
        check.close();
        return row;
      };

      const storage = openStorage({ dataDir: dir });
      expect(storage.userVersion()).toBe(
        MIGRATIONS[MIGRATIONS.length - 1]?.version,
      );
      const migrated = readTurn();
      storage.close();
      expect(migrated.prompt_text).not.toContain("envsecretvalue");
      expect(migrated.prompt_text.startsWith("leak: API_KEY=")).toBe(true);
      expect(migrated.prompt_text).toHaveLength(2_000);
      // The full length and line count of the redacted text,
      // taken before the cut.
      expect(migrated.prompt_chars).toBe(3_036);
      expect(migrated.prompt_lines).toBe(2);

      // Opening the database again changes nothing.
      const reopened = openStorage({ dataDir: dir });
      expect(readTurn()).toEqual(migrated);
      reopened.close();
    } finally {
      removeTree(dir);
    }
  });

  it("upgrades a version 2 database in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-schema-v2-"));
    try {
      // A database at version 2: the first two migrations,
      // with a session and its conditions already in it.
      const db = new DatabaseSync(join(dir, "flightpath.db"));
      db.exec(rowAt(MIGRATIONS, 0, "migration").sql);
      db.exec(rowAt(MIGRATIONS, 1, "migration").sql);
      db.exec("PRAGMA user_version = 2");
      db.prepare(
        "INSERT INTO sessions (id, status, first_seen_at, last_seen_at, joined_partway) VALUES ('sess-v2', 'ended', 100, 200, 0)",
      ).run();
      db.prepare(
        "INSERT INTO session_conditions (session_id, updated_at) VALUES ('sess-v2', 200)",
      ).run();
      db.close();

      const storage = openStorage({ dataDir: dir });
      expect(storage.userVersion()).toBe(
        MIGRATIONS[MIGRATIONS.length - 1]?.version,
      );
      // The column migration 3 adds is present and writable.
      const check = new DatabaseSync(join(dir, "flightpath.db"));
      check
        .prepare(
          "UPDATE session_conditions SET hook_stats = '{}' WHERE session_id = 'sess-v2'",
        )
        .run();
      const conditions = check
        .prepare(
          "SELECT hook_stats FROM session_conditions WHERE session_id = 'sess-v2'",
        )
        .get() as { hook_stats: string };
      expect(conditions.hook_stats).toBe("{}");
      check.close();
      storage.close();
    } finally {
      removeTree(dir);
    }
  });
});
