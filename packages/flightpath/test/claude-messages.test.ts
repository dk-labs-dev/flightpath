import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import { transcriptUserLine } from "./support/events.js";
import { onlyRow, requiredValue } from "./support/rows.js";
import { seedBranch } from "./support/seed.js";
import { allStoredText, queryRows } from "./support/storage.js";
import {
  importTranscriptLines,
  type TranscriptWorld,
} from "./support/worlds.js";

import { loadSessionData, tokenHistory } from "../src/api/index.js";
import { describeHuman } from "../src/describe/index.js";
import { estimatedTokens, formatTokens } from "../src/format.js";
import { defaultSettings } from "../src/settings/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import {
  createTranscriptFollower,
  encodeProjectPath,
} from "../src/transcripts/index.js";
import { INSERT_CLAUDE_MESSAGE_SQL } from "../src/transcripts/ingest.js";

// What Claude Code says in a session beside the person's own
// prompts: a command's name, a subagent's hand-back, a notice.
// Entries as Claude Code writes them, with every text body
// replaced by filler; the sizes, counts and times are made up.

const SESSION = "sess-said";
const T0 = Date.parse("2026-10-27T09:00:00.000Z");

afterEach(async () => {
  await runCleanups();
});

function captureLines(): string[] {
  const path = fileURLToPath(
    new URL("./fixtures/claude-code-entries.jsonl", import.meta.url),
  );
  return readFileSync(path, "utf8").trim().split("\n");
}

/** The messages stored, in time order, with the turn each sits on. */
function storedMessages(
  world: TranscriptWorld,
): { kind: string; turn: number; detail: unknown }[] {
  const rows = queryRows(
    world.storage.dbPath,
    `SELECT human_events.kind AS kind, turns.sequence AS turn, human_events.detail AS detail
     FROM human_events JOIN turns ON turns.id = human_events.turn_id
     WHERE human_events.kind IN ('command', 'handback', 'notice')
     ORDER BY human_events.occurred_at, human_events.id`,
  );
  return rows.map((row) => ({
    kind: String(row.kind),
    turn: Number(row.turn),
    detail: JSON.parse(String(row.detail)),
  }));
}

function prompt(at: number, text: string): string {
  return transcriptUserLine(at, {
    content: text,
    extra: { origin: { kind: "human" } },
  });
}

describe("recording what Claude Code said", () => {
  it("puts a command, a hand-back and a notice on the open turn as names and sizes", async () => {
    const world = await importTranscriptLines(SESSION, captureLines());
    expect(storedMessages(world)).toEqual([
      {
        kind: "handback",
        turn: 4,
        detail: {
          agent_type: "Explore",
          agent_id: "a0000000000000000",
          chars: 497,
        },
      },
      { kind: "notice", turn: 4, detail: { chars: 867 } },
      { kind: "command", turn: 4, detail: { name: "/context" } },
      { kind: "command", turn: 5, detail: { name: "/compact" } },
    ]);
  });

  it("stores no argument, report or notice text", async () => {
    const world = await importTranscriptLines(SESSION, [
      prompt(T0, "Look at the files."),
      transcriptUserLine(T0 + 1000, {
        content:
          "<command-name>/model</command-name>\n<command-args>PLANTED-ARGUMENTS</command-args>",
      }),
      transcriptUserLine(T0 + 2000, {
        content: "<agent-message>PLANTED-REPORT</agent-message>",
        extra: {
          isMeta: true,
          origin: { kind: "peer", name: "Explore", handback: true },
        },
      }),
      transcriptUserLine(T0 + 3000, {
        content: "<task-notification>PLANTED-NOTICE</task-notification>",
        extra: { origin: { kind: "task-notification" } },
      }),
    ]);
    expect(storedMessages(world)).toHaveLength(3);
    expect(allStoredText(world.storage)).not.toMatch(/PLANTED/);
  });

  it("gives a subagent's lane the size its hand-back row states", async () => {
    const agentId = "a0000000000000001";
    const body = "x".repeat(4_447);
    const text = `Another Claude session sent a message:\n<agent-message from="${agentId}">\n[Subagent hand-back] ${body}\n</agent-message>`;
    const world = await importTranscriptLines(SESSION, [
      prompt(T0, "Look at the files."),
      transcriptUserLine(T0 + 2000, {
        content: text,
        extra: {
          isMeta: true,
          origin: {
            kind: "peer",
            from: agentId,
            senderTaskId: agentId,
            name: "general-purpose",
            body,
            handback: true,
            handbackReportText: body,
          },
        },
      }),
    ]);
    const db = new DatabaseSync(world.storage.dbPath);
    seedBranch(db, {
      sessionId: SESSION,
      agentId,
      agentType: "general-purpose",
    });
    db.close();
    const data = requiredValue(
      loadSessionData(world.storage, SESSION),
      "the imported session",
    );
    const lane = onlyRow(
      tokenHistory(data, { autoCompactWindow: null, storePromptText: false })
        .branches,
      "a lane",
    );
    const row = onlyRow(
      data.humans.filter((event) => event.kind === "handback"),
      "a hand-back",
    );
    expect(lane.returnedChars).toBe(text.length);
    expect(describeHuman(row).sentence).toBe(
      `general-purpose reported back · about ${formatTokens(estimatedTokens(text.length))} est.`,
    );
  });

  it("leaves out a message that comes before the first typed prompt", async () => {
    const world = await importTranscriptLines(SESSION, [
      transcriptUserLine(T0, {
        content: "<command-name>/model</command-name>",
      }),
      prompt(T0 + 1000, "Look at the files."),
    ]);
    expect(storedMessages(world)).toEqual([]);
  });

  it("does not take a typed prompt for a command, whatever it opens with", async () => {
    const world = await importTranscriptLines(SESSION, [
      prompt(T0, "<command-name>/model</command-name>"),
    ]);
    expect(storedMessages(world)).toEqual([]);
  });

  it("restates the messages when a fresh follower reads the transcript again", async () => {
    const world = await importTranscriptLines(SESSION, captureLines());
    const path = join(
      world.configDir,
      "projects",
      encodeProjectPath("/home/user/proj-a"),
      `${SESSION}.jsonl`,
    );
    // A daemon that lost its offsets starts again from the top.
    rmSync(join(world.dataDir, "transcript-offsets.json"), { force: true });
    const restarted = createTranscriptFollower(world.storage, {
      dataDir: world.dataDir,
      configDir: world.configDir,
      settings: () => defaultSettings(),
    });
    const second = await restarted.follow(SESSION, path);
    expect(second.entries).toBe(captureLines().length);
    expect(storedMessages(world)).toHaveLength(4);
  });

  it("checks for a repeat on the session's time index, never a scan", async () => {
    const world = await importTranscriptLines(SESSION, captureLines());
    const db = new DatabaseSync(world.storage.dbPath);
    try {
      const plan = (
        db
          .prepare(`EXPLAIN QUERY PLAN ${INSERT_CLAUDE_MESSAGE_SQL}`)
          .all(SESSION, 1, "notice", 1, "{}", SESSION, 1, "notice", "{}") as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain(
        "SEARCH human_events USING INDEX human_events_session",
      );
      expect(plan).not.toContain("SCAN human_events");
    } finally {
      db.close();
    }
  });
});
