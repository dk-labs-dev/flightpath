import { writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import {
  callDaemon,
  listenOnFreePort,
  makeRoot,
  readPort,
  readToken,
  startDaemon as startDaemonChild,
  waitForDaemonReady,
} from "./support/daemon.js";
import { openStream } from "./support/stream.js";

import { startDaemon } from "../src/daemon/server.js";
import { createStreamHub } from "../src/daemon/stream.js";
import type { StreamMessage } from "../src/daemon/stream-messages.js";
import { openStorage } from "../src/storage/index.js";
import { defaultSettings } from "../src/settings/index.js";

// The daemon's last word: before its stream
// connections end, the hub writes one `stopping` frame to
// every open connection saying why — idle with its minutes,
// off when the off flag file stands, signal otherwise — and
// the frame is never buffered, so a reconnect from before
// the stop never replays it.

afterEach(async () => {
  await runCleanups();
});

/** Boot the built daemon as a child and open its stream. */
async function bootChildClient(prefix: string) {
  const made = makeRoot(prefix);
  const child = startDaemonChild(made.root);
  await waitForDaemonReady(child, made.dataDir);
  const client = await openStream(
    readPort(made.dataDir),
    readToken(made.dataDir),
    "/api/stream",
  );
  await client.waitFor((m) => m.some((x) => x.event === "sync"));
  return { made, child, client };
}

/** Wait for the connection to end; its last frame must be off. */
async function expectOffAsLastFrame(
  client: Awaited<ReturnType<typeof bootChildClient>>["client"],
): Promise<void> {
  await client.closed;
  const stopping = client.messages.find((m) => m.event === "stopping");
  expect(stopping?.data).toEqual({ reason: "off" });
  expect(client.messages[client.messages.length - 1]?.event).toBe("stopping");
  client.close();
}

// Windows ends a process on SIGTERM without running its handler,
// so a signal-driven stop frame is a property only POSIX has.
const itWithSignals = it.skipIf(process.platform === "win32");

describe("the stopping frame", () => {
  it("sends idle with its minutes before the connection ends, as the last frame", async () => {
    const dataDir = makeTempRoot("flightpath-stopping-");
    const daemon = await startDaemon({
      dataDir,
      version: "0.0.0",
      idleMs: 1_500,
      drainMs: 150,
    });
    if (daemon === null) throw new Error("daemon did not start");
    registerCleanup(() => daemon.shutdown("signal"));
    const token = readToken(dataDir);
    const client = await openStream(daemon.port, token, "/api/stream");
    await client.waitFor((m) => m.some((x) => x.event === "sync"));
    await client.waitFor((m) => m.some((x) => x.event === "stopping"));
    await client.closed;
    const stopping = client.messages.find((m) => m.event === "stopping");
    expect(stopping?.data).toEqual({ reason: "idle", idleMinutes: 0 });
    // Nothing follows it: the frame is the daemon's last word.
    expect(client.messages[client.messages.length - 1]?.event).toBe("stopping");
    client.close();
  }, 60_000);

  itWithSignals(
    "sends off when the off flag file stands and the daemon is signalled",
    async () => {
      const { made, child, client } = await bootChildClient(
        "flightpath-stopping-off-",
      );
      writeFileSync(join(made.dataDir, "off"), "");
      child.kill("SIGTERM");
      await expectOffAsLastFrame(client);
    },
    60_000,
  );

  it("sends off when the off flag file stands and the daemon is asked over HTTP", async () => {
    const { made, client } = await bootChildClient("flightpath-stopping-ask-");
    writeFileSync(join(made.dataDir, "off"), "");
    await callDaemon(readPort(made.dataDir), {
      method: "POST",
      path: "/api/stop",
      token: readToken(made.dataDir),
    });
    await expectOffAsLastFrame(client);
  }, 60_000);

  itWithSignals(
    "sends signal for a plain SIGTERM with no off flag",
    async () => {
      const { child, client } = await bootChildClient(
        "flightpath-stopping-signal-",
      );
      child.kill("SIGTERM");
      await client.closed;
      const stopping = client.messages.find((m) => m.event === "stopping");
      expect(stopping?.data).toEqual({ reason: "signal" });
      client.close();
    },
    60_000,
  );

  it("never replays the stopping frame to a reconnect from before the stop", async () => {
    const dataDir = makeTempRoot("flightpath-stopping-replay-");
    const storage = openStorage({ dataDir });
    const hub = createStreamHub({
      storage,
      settings: () => defaultSettings(),
      dataDir,
    });
    const server: Server = createServer((request, res: ServerResponse) => {
      const lastEventId = request.headers["last-event-id"];
      hub.serve(
        res,
        null,
        typeof lastEventId === "string" ? lastEventId : null,
      );
    });
    const port = await listenOnFreePort(server);
    hub.start();
    const stopping: StreamMessage = {
      event: "stopping",
      data: { reason: "idle", idleMinutes: 30 },
    };
    try {
      const first = await openStream(port, "token", "/api/stream");
      await first.waitFor((m) => m.some((x) => x.event === "sync"));
      const syncId = first.messages.find((x) => x.event === "sync")?.id;
      if (syncId === undefined || syncId === null) {
        throw new Error("the first connection never synced");
      }
      hub.stop(stopping);
      await first.waitFor((m) => m.some((x) => x.event === "stopping"));
      await first.closed;
      // A reconnect from the position before the stop: the
      // greeting and the sync, and no stopping frame in the
      // replay — it was written to the connection, never to
      // the ring buffer.
      const second = await openStream(port, "token", "/api/stream", syncId);
      await second.waitFor((m) => m.some((x) => x.event === "sync"));
      expect(second.messages.some((m) => m.event === "stopping")).toBe(false);
      second.close();
      first.close();
    } finally {
      hub.stop(stopping);
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      storage.close();
    }
  }, 60_000);
});
