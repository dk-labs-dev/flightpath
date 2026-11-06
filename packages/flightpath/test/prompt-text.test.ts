import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import {
  recordHookEvent,
  transcriptAssistantLine,
  transcriptUserLine,
} from "./support/events.js";
import { onlyRow } from "./support/rows.js";
import { queryRows } from "./support/storage.js";
import {
  IMPORT_INSTALL,
  makeTranscriptWorld,
  seedImportWorld,
} from "./support/worlds.js";

import { ingestEnvelope } from "../src/daemon/ingest.js";
import type { Storage } from "../src/storage/index.js";
import { encodeProjectPath } from "../src/transcripts/index.js";

// Prompt text storage: whichever path delivers a prompt — the
// hook or the transcript — the stored text has passed intake
// redaction (ADR-0017) and is capped, with the prompt's full
// length and line count kept beside the cut text.

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const INSTALL = IMPORT_INSTALL;

afterEach(async () => {
  await runCleanups();
});

// One made-up secret per redacted family. The token-shaped
// ones are built by concatenation so a secret scanner has no
// literal to flag in this file.
const SECRETS: { marker: string; secret: string; raw: string }[] = [
  {
    marker: "[redacted:private-key]",
    secret: "MIIsecretbody",
    raw: "-----BEGIN RSA PRIVATE KEY-----\nMIIsecretbody\n-----END RSA PRIVATE KEY-----",
  },
  {
    marker: "[redacted:aws-access-key]",
    secret: "AKIA" + "1234567890ABCDEF",
    raw: "AKIA" + "1234567890ABCDEF",
  },
  {
    marker: "[redacted:github-token]",
    secret: "ghp_" + "a".repeat(36),
    raw: "ghp_" + "a".repeat(36),
  },
  {
    marker: "[redacted:anthropic-key]",
    secret: "sk-ant-" + "b".repeat(24),
    raw: "sk-ant-" + "b".repeat(24),
  },
  {
    marker: "[redacted:openai-key]",
    secret: "sk-" + "c".repeat(28),
    raw: "sk-" + "c".repeat(28),
  },
  {
    marker: "[redacted:slack-token]",
    secret: "xoxb-" + "1234567890ab",
    raw: "xoxb-" + "1234567890ab",
  },
  {
    marker: "[redacted:google-api-key]",
    secret: "AIza" + "d".repeat(35),
    raw: "AIza" + "d".repeat(35),
  },
  {
    marker: "[redacted:jwt]",
    secret:
      "eyJ" + "e".repeat(10) + "." + "f".repeat(10) + "." + "g".repeat(10),
    raw: "eyJ" + "e".repeat(10) + "." + "f".repeat(10) + "." + "g".repeat(10),
  },
  {
    marker: "[redacted:url-password]",
    secret: "hunter2",
    raw: "https://user:hunter2@example.com/r.git",
  },
  {
    marker: "[redacted:flag-value]",
    secret: "flagsecret",
    raw: "--password flagsecret",
  },
  {
    marker: "[redacted:env-secret]",
    secret: "envsecretvalue",
    raw: "API_KEY=envsecretvalue",
  },
];

function secretPrompt(): string {
  return SECRETS.map((entry) => `value: ${entry.raw}`).join("\n");
}

/** The prompt one session's only turn stored, with its size columns. */
function storedTurn(storage: Storage, sessionId: string) {
  const rows = queryRows(
    storage.dbPath,
    "SELECT prompt_text, prompt_chars, prompt_lines FROM turns WHERE session_id = ?",
    sessionId,
  ) as { prompt_text: string; prompt_chars: number; prompt_lines: number }[];
  expect(rows).toHaveLength(1);
  return onlyRow(rows, "the stored turn");
}

/** Store `prompt` through the hook path, as the daemon receives it. */
function storeHookPrompt(storage: Storage, sessionId: string, prompt: string) {
  recordHookEvent(
    storage,
    {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
      cwd: "/home/user/proj-a",
    },
    T0,
  );
  const result = ingestEnvelope(storage, {
    id: `env-${sessionId}-prompt`,
    received_at: T0 + 1000,
    redaction_version: 1,
    plugin_version: "0.0.0",
    event: {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt_id: "p-1",
      prompt,
      cwd: "/home/user/proj-a",
    },
  });
  expect(result).toBe("stored");
}

/** Store `prompt` through a transcript the hooks never delivered. */
async function storeTranscriptPrompt(
  world: ReturnType<typeof makeTranscriptWorld>,
  sessionId: string,
  prompt: string,
  usage?: Record<string, number>,
) {
  const dir = join(
    world.configDir,
    "projects",
    encodeProjectPath("/home/user/proj-a"),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [
    transcriptUserLine(T0 + 1000, {
      sessionId,
      promptId: "p-1",
      content: prompt,
    }),
  ];
  if (usage !== undefined) {
    lines.push(
      transcriptAssistantLine(T0 + 2000, "req-1", usage, { sessionId }),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
  const when = new Date(INSTALL + 60_000);
  utimesSync(path, when, when);
  await world.follower.importAll();
}

describe("prompt text storage", () => {
  it("redacts a transcript-only prompt the same as the hook path", async () => {
    const world = seedImportWorld();
    const prompt = secretPrompt();
    await storeTranscriptPrompt(world, "sess-transcript", prompt);
    storeHookPrompt(world.storage, "sess-hook", prompt);
    const fromTranscript = storedTurn(world.storage, "sess-transcript");
    const fromHook = storedTurn(world.storage, "sess-hook");
    for (const { marker, secret } of SECRETS) {
      expect(fromTranscript.prompt_text).toContain(marker);
      expect(fromTranscript.prompt_text).not.toContain(secret);
    }
    expect(fromTranscript.prompt_text).toBe(fromHook.prompt_text);
  });

  it("caps a 10,000-character transcript prompt, keeping length and lines", async () => {
    const world = seedImportWorld();
    const prompt = [
      ...Array.from({ length: 99 }, () => "x".repeat(99)),
      "x".repeat(100),
    ].join("\n");
    expect(prompt.length).toBe(10_000);
    await storeTranscriptPrompt(world, "sess-long", prompt, {
      input_tokens: 700,
      output_tokens: 70,
    });
    const turn = storedTurn(world.storage, "sess-long");
    expect(turn.prompt_text).toHaveLength(2_000);
    expect(turn.prompt_text).toBe(prompt.slice(0, 2_000));
    expect(turn.prompt_chars).toBe(10_000);
    expect(turn.prompt_lines).toBe(100);
    const requests = queryRows(
      world.storage.dbPath,
      "SELECT input_tokens, output_tokens FROM requests WHERE session_id = 'sess-long'",
    );
    expect(onlyRow(requests, "the request row").input_tokens).toBe(700);
    expect(onlyRow(requests, "the request row").output_tokens).toBe(70);
  });

  it("caps a 10,000-character hook prompt, keeping length and lines", () => {
    const world = makeTranscriptWorld();
    const prompt = "y".repeat(10_000);
    storeHookPrompt(world.storage, "sess-hook-long", prompt);
    const turn = storedTurn(world.storage, "sess-hook-long");
    expect(turn.prompt_text).toHaveLength(2_000);
    expect(turn.prompt_chars).toBe(10_000);
    expect(turn.prompt_lines).toBe(1);
  });

  it("cuts on a character boundary when an emoji straddles the cap", () => {
    const world = makeTranscriptWorld();
    const prompt = "a".repeat(1_999) + "😀" + "b".repeat(100);
    storeHookPrompt(world.storage, "sess-emoji", prompt);
    const turn = storedTurn(world.storage, "sess-emoji");
    expect(turn.prompt_text).toBe("a".repeat(1_999));
    expect(turn.prompt_text).toHaveLength(1_999);
    expect(turn.prompt_text).not.toContain("�");
    expect(turn.prompt_chars).toBe(prompt.length);
  });

  it("counts a trailing newline as a further line", () => {
    const world = makeTranscriptWorld();
    storeHookPrompt(world.storage, "sess-lines", "a\n");
    const turn = storedTurn(world.storage, "sess-lines");
    expect(turn.prompt_text).toBe("a\n");
    expect(turn.prompt_lines).toBe(2);
  });
});
