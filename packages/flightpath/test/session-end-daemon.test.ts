import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { callDaemon, waitFor, waitForChildExit } from "./support/daemon.js";

import { ingestEnvelope, type Envelope } from "../src/daemon/ingest.js";
import { startDaemon } from "../src/daemon/server.js";
import type { SessionListItem } from "../src/api/payloads.js";
import { openStorage } from "../src/storage/index.js";
import { readProcessStartTimes } from "../src/util/host-process.js";

// The daemon's session-end watch, end to end: sessions seeded
// as a previous run left them, then the daemon starts and its
// first pass ends the ones that are over — the quiet one past
// the fallback, and the one whose process is gone — and keeps
// the one whose process is this test's own, however quiet.

const MIN = 60_000;

afterEach(async () => {
  await runCleanups();
});

let envelopeCount = 0;
function seedSession(
  dataDir: string,
  sessionId: string,
  at: number,
  host: { pid: number; startedAt: number } | null,
): void {
  const storage = openStorage({ dataDir });
  try {
    const start: Record<string, unknown> = {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: "/work/app",
    };
    if (host !== null) {
      start.host_pid = host.pid;
      start.host_started_at = host.startedAt;
    }
    envelopeCount += 1;
    const envelope: Envelope = {
      id: `end-watch-${envelopeCount}`,
      received_at: at,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: start,
    };
    expect(ingestEnvelope(storage, envelope)).toBe("stored");
    // One prompt each: a session with nothing in it is left
    // out of the list the assertions below read, and the
    // watch's work is on sessions that did something.
    envelopeCount += 1;
    const prompt: Envelope = {
      id: `end-watch-${envelopeCount}`,
      received_at: at,
      redaction_version: 1,
      plugin_version: "0.0.0",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        prompt_id: `p-${sessionId}`,
        prompt: "a prompt from the previous run",
      },
    };
    expect(ingestEnvelope(storage, prompt)).toBe("stored");
  } finally {
    storage.close();
  }
}

/** A pid that has already exited: a process that ran and finished. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitForChildExit(child);
  if (child.pid === undefined) {
    throw new Error("the finished child had no pid");
  }
  return child.pid;
}

describe("the daemon's session-end watch", () => {
  it("ends the quiet and the process-gone, keeps the running", async () => {
    const root = makeTempRoot("flightpath-end-watch-");
    const dataDir = join(root, "data");
    const now = Date.now();
    seedSession(dataDir, "s-quiet", now - 11 * MIN, null);
    seedSession(dataDir, "s-gone", now - MIN, {
      pid: await exitedPid(),
      startedAt: 1,
    });
    seedSession(dataDir, "s-running", now - 30 * MIN, {
      pid: process.pid,
      startedAt:
        (await readProcessStartTimes([process.pid])).get(process.pid) ?? 1,
    });

    const daemon = await startDaemon({
      dataDir,
      version: "0.0.0",
      idleMs: 30 * MIN,
    });
    if (daemon === null) {
      throw new Error("the daemon did not start");
    }
    try {
      const token = readFileSync(join(dataDir, "token"), "utf8").trim();
      const list = async (): Promise<SessionListItem[]> => {
        const reply = await callDaemon(daemon.port, {
          method: "GET",
          path: "/api/sessions",
          token,
        });
        return (JSON.parse(reply.body) as { sessions: SessionListItem[] })
          .sessions;
      };
      await waitFor(async () => {
        const sessions = await list();
        return sessions.every(
          (session) => session.id === "s-running" || session.status === "ended",
        );
      });
      const byId = new Map((await list()).map((s) => [s.id, s]));
      expect(byId.get("s-quiet")?.endSeen).toBe(false);
      expect(byId.get("s-quiet")?.note).toContain("(no exit seen)");
      expect(byId.get("s-gone")?.status).toBe("ended");
      expect(byId.get("s-gone")?.endSeen).toBe(false);
      expect(byId.get("s-running")?.status).toBe("live");
    } finally {
      await daemon.shutdown("signal");
    }
  });
});
