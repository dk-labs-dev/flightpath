import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerCleanup, runCleanups } from "./support/cleanup.js";
import {
  distPath,
  envForDataRoot,
  fakeDaemon,
  listenOnFreePort,
  makeRoot,
  startTestDaemon,
  waitForChildExit,
} from "./support/daemon.js";
import { expansion } from "./support/events.js";
import { runDistAsync, scratchHome } from "./support/process.js";
import { openStream } from "./support/stream.js";

// /flightpath:off writes the off flag and stops the daemon. A
// signal cannot do that on Windows, where it ends the process
// without a handler, so the command asks over HTTP and signals
// only a daemon that cannot be asked.

const distCommand = distPath("command.js");

afterEach(async () => {
  await runCleanups();
});

async function runOff(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runDistAsync(
    distCommand,
    JSON.stringify(expansion("s1", "flightpath:off")),
    env,
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

interface StopRequest {
  method: string | undefined;
  url: string | undefined;
  token: string | string[] | undefined;
}

/** A live process the lock names, with a server on the port
 *  file's port that answers every request with `status` and
 *  records what it was asked. */
async function daemonAnswering(dataDir: string, status: number) {
  const requests: StopRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      token: request.headers["x-flightpath-token"],
    });
    response.writeHead(status).end();
  });
  const port = await listenOnFreePort(server);
  registerCleanup(
    () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      }),
  );
  const sleeper = fakeDaemon(dataDir);
  writeFileSync(join(dataDir, "port"), String(port));
  return { requests, sleeper };
}

describe("/flightpath:off", () => {
  it("asks the daemon to stop with its token and leaves it unsignalled", async () => {
    const { env, dataDir } = scratchHome("flightpath-off-");
    const { requests, sleeper } = await daemonAnswering(dataDir, 204);

    expect(await runOff(env)).toContain("off in all sessions");

    expect(requests).toEqual([
      { method: "POST", url: "/api/stop", token: "test-token" },
    ]);
    // A signal sent after the request would end a Windows daemon
    // before it could tell its pages why; the wait is the bound
    // on proving nothing was sent.
    await expect(waitForChildExit(sleeper, 500)).rejects.toThrow(
      "Timed out waiting for exit.",
    );
  });

  it("signals a daemon that answers the stop request with an error", async () => {
    const { env, dataDir } = scratchHome("flightpath-off-");
    const { requests, sleeper } = await daemonAnswering(dataDir, 404);

    expect(await runOff(env)).toContain("off in all sessions");

    expect(requests).toHaveLength(1);
    await waitForChildExit(sleeper, 10_000);
  });

  it("tells open pages it is off and stops a real daemon cleanly", async () => {
    const { root, dataDir } = makeRoot("flightpath-off-");
    const { child, port, token } = await startTestDaemon(root);
    const client = await openStream(port, token, "/api/stream");
    await client.waitFor((m) => m.some((x) => x.event === "sync"));

    expect(await runOff(envForDataRoot(root))).toContain("off in all sessions");

    await client.closed;
    expect(client.messages.find((m) => m.event === "stopping")?.data).toEqual({
      reason: "off",
    });
    await expect(waitForChildExit(child, 10_000)).resolves.toBe(0);
    expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
    client.close();
  }, 60_000);
});
