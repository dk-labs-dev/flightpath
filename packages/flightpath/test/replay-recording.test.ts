// Replaying recorded hook events: two sessions in the
// fixture beside this file, whose prompts, report bodies,
// tool inputs and results and home path are all made up.
// What the replay must reproduce is what the person did:
// the prompts they typed, and nothing else, as turns.

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { queryRows } from "./support/storage.js";

import { listSessions } from "../src/api/index.js";
import { defaultSettings } from "../src/settings/index.js";
import { openStorage } from "../src/storage/index.js";

const FIRST_SESSION = "91d66462-054a-4466-97a7-8d788a2dab40";
const SECOND_SESSION = "f5364c18-dc50-428b-a60c-720fc6fa0da8";

afterEach(async () => {
  await runCleanups();
});

function replayRecording(): ReturnType<typeof openStorage> {
  const fixturePath = fileURLToPath(
    new URL("./fixtures/two-session-recording.db", import.meta.url),
  );
  const rows = queryRows(
    fixturePath,
    "SELECT session_id, body FROM raw_events WHERE source = 'hook' ORDER BY id",
  ) as { session_id: string; body: string }[];
  expect(rows.length).toBeGreaterThan(0);

  const root = makeTempRoot("flightpath-replay-");
  const storage = openStorage({ dataDir: root });
  for (const row of rows) {
    const envelope = JSON.parse(row.body) as {
      id: string;
      received_at: number;
      redaction_version: number;
      event: Record<string, unknown>;
    };
    storage.insertEnvelopeJourney(
      {
        source: "hook",
        sessionId: row.session_id,
        receivedAt: envelope.received_at,
        redactionVersion: envelope.redaction_version,
        envelopeId: envelope.id,
        body: row.body,
      },
      envelope.event,
    );
  }
  return storage;
}

describe("replaying the recording's hook events", () => {
  it("gives the first session exactly its eight typed prompts as turns", () => {
    const storage = replayRecording();
    const turns = queryRows(
      storage.dbPath,
      "SELECT prompt_text FROM turns WHERE session_id = ? ORDER BY sequence",
      FIRST_SESSION,
    ) as { prompt_text: string | null }[];
    expect(turns).toHaveLength(8);
    expect(turns[0]?.prompt_text).toBe("List the checks that fail.");
    // No turn is the subagent's hand-back.
    expect(
      turns.every(
        (turn) => !(turn.prompt_text ?? "").startsWith("<agent-message"),
      ),
    ).toBe(true);
    storage.close();
  });

  it("titles the second session by its first typed prompt", () => {
    const storage = replayRecording();
    const { sessions } = listSessions(storage, defaultSettings(), null);
    const second = sessions.find((session) => session.id === SECOND_SESSION);
    // The session's first turn was a plugin command, which is
    // not a turn at all; the title falls to the first prompt
    // the person typed.
    expect(second?.title).toBe("Run the checks.");
    storage.close();
  });

  it("reads both sessions as seen from their start", () => {
    const storage = replayRecording();
    const rows = storage
      .listSessionRows()
      .filter((row) => row.id === FIRST_SESSION || row.id === SECOND_SESSION);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.joinedPartway).toBe(false);
    }
    storage.close();
  });
});
