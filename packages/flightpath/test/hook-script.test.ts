import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  makeTempRoot,
  registerCleanup,
  runCleanups,
} from "./support/cleanup.js";
import { distDir, distPath } from "./support/daemon.js";
import { runDist, runDistAsync, scratchHome } from "./support/process.js";

// Integration tests for the built hook script, run as a child
// process the way Claude Code runs it: against a test server, a
// dead port, a read-only data folder, and under concurrency.

const distHook = distPath("hook.js");

afterEach(async () => {
  await runCleanups();
});

interface Received {
  body: string;
  token: string | undefined;
  url: string | undefined;
}

/** Listen on a loopback port; resolve with it and a closer. */
function listen(server: Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ port, close: () => server.close() });
    });
  });
}

async function startServer(): Promise<{
  port: number;
  received: Received[];
  close: () => void;
}> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.push({
        body,
        token: request.headers["x-flightpath-token"] as string | undefined,
        url: request.url,
      });
      response.writeHead(200);
      response.end();
    });
  });
  const { port, close } = await listen(server);
  return { port, received, close };
}

function startAnsweringServer(
  status: number,
): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(status);
      response.end();
    });
  });
  return listen(server);
}

function startClosingServer(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request) => {
    request.socket.destroy();
  });
  return listen(server);
}

interface HookHome {
  env: NodeJS.ProcessEnv;
  dataDir: string;
}

/** A scratch home whose daemon files point at a test server. */
function hookHomeFor(server: { port: number; close: () => void }): HookHome {
  const { env, dataDir } = scratchHome("flightpath-hook-", {
    idleMs: "1200",
    stopDaemon: true,
  });
  registerCleanup(server.close);
  writeDaemonFiles(dataDir, server.port);
  return { env, dataDir };
}

/** Run the hook against a server that cannot take the event:
 *  the hook exits quietly and the event lands in the buffer. */
async function expectHookBuffers(server: {
  port: number;
  close: () => void;
}): Promise<void> {
  const { env, dataDir } = hookHomeFor(server);
  const result = await runDistAsync(distHook, JSON.stringify(promptEvent), env);
  expect(result.status).toBe(0);
  expect(bufferFiles(dataDir)).toHaveLength(1);
}

/** A scratch home whose daemon counts its own starts. The
 *  stub never takes the daemon lock or clears the start
 *  lock, so there is no daemon to stop: a stop would wait
 *  out the start lock's ten-second window, the whole of
 *  vitest's hook timeout. */
function hookHomeWithCountingDaemon(): HookHome & {
  marker: string;
  hook: string;
} {
  const { env, dataDir } = scratchHome("flightpath-hook-");
  const marker = join(dataDir, "starts.log");
  env.FP_STUB_MARKER = marker;
  const hook = distWithCountingDaemon();
  return { env, dataDir, marker, hook };
}

function writeDaemonFiles(dataDir: string, port: number): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "port"), String(port));
  writeFileSync(join(dataDir, "token"), "test-token");
}

function bufferFiles(dataDir: string): string[] {
  const buffer = join(dataDir, "buffer");
  return existsSync(buffer) ? readdirSync(buffer) : [];
}

/**
 * A copy of dist/ whose daemon.js counts its own starts (in the
 * file FP_STUB_MARKER names), so tests can see how many times the
 * hook started the daemon.
 */
function distWithCountingDaemon(): string {
  const copy = makeTempRoot("flightpath-dist-");
  cpSync(distDir, copy, { recursive: true });
  writeFileSync(
    join(copy, "daemon.js"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.FP_STUB_MARKER, "start\\n");\n`,
  );
  return join(copy, "hook.js");
}

async function waitForMarker(marker: string, lines: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const count = readFileSync(marker, "utf8").trim().split("\n").length;
      if (count >= lines) {
        return;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

const promptEvent = {
  session_id: "sess-1",
  hook_event_name: "UserPromptSubmit",
  prompt: `deploy with ghp_${"a".repeat(36)} please`,
  cwd: "/work/project",
  permission_mode: "default",
};

describe("the hook script", () => {
  it("delivers a redacted, enveloped event to the daemon", async () => {
    const server = await startServer();
    const { env, dataDir } = hookHomeFor(server);

    // Async spawn: a synchronous one would block this process's
    // event loop, and the test server with it.
    const { status, stdout } = await runDistAsync(
      distHook,
      JSON.stringify(promptEvent),
      env,
    );
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.token).toBe("test-token");
    expect(server.received[0]?.url).toBe("/events/hook");
    const envelope = JSON.parse(server.received[0]?.body ?? "{}") as {
      id: string;
      received_at: number;
      redaction_version: number;
      plugin_version: string;
      event: Record<string, unknown>;
    };
    expect(envelope.id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof envelope.received_at).toBe("number");
    expect(envelope.redaction_version).toBe(1);
    expect(envelope.plugin_version).toBe("0.0.0");
    expect(envelope.event.prompt).toBe(
      "deploy with [redacted:github-token] please",
    );
    expect(bufferFiles(dataDir)).toHaveLength(0);
  });

  it("buffers and starts the daemon when delivery is impossible", async () => {
    const { env, dataDir, marker, hook } = hookHomeWithCountingDaemon();

    const { status, stdout } = runDist(hook, JSON.stringify(promptEvent), env, {
      timeout: 20_000,
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(bufferFiles(dataDir)).toHaveLength(1);
    await waitForMarker(marker, 1);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("gives 50 concurrent hooks 50 buffer files and one daemon start", async () => {
    const { env, dataDir, marker, hook } = hookHomeWithCountingDaemon();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runDistAsync(
          hook,
          JSON.stringify({ ...promptEvent, session_id: `sess-${i}` }),
          env,
        ),
      ),
    );
    expect(results.every((r) => r.status === 0 && r.stdout === "")).toBe(true);
    expect(bufferFiles(dataDir)).toHaveLength(50);
    await waitForMarker(marker, 1);
    // Give any duplicate starts a moment to show themselves.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  }, 60_000);

  it("drops a paused session's events and delivers another session's", async () => {
    const server = await startServer();
    const { env, dataDir } = hookHomeFor(server);
    mkdirSync(join(dataDir, "pause"), { recursive: true });
    writeFileSync(join(dataDir, "pause", "sess-a"), "");

    await runDistAsync(
      distHook,
      JSON.stringify({ ...promptEvent, session_id: "sess-a" }),
      env,
    );
    await runDistAsync(
      distHook,
      JSON.stringify({ ...promptEvent, session_id: "sess-b" }),
      env,
    );
    expect(server.received).toHaveLength(1);
    const delivered = JSON.parse(server.received[0]?.body ?? "{}") as {
      event: Record<string, unknown>;
    };
    expect(delivered.event.session_id).toBe("sess-b");
    expect(bufferFiles(dataDir)).toHaveLength(0);
  });

  it("records nothing while the global off flag exists", async () => {
    const server = await startServer();
    const { env, dataDir } = hookHomeFor(server);
    writeFileSync(join(dataDir, "off"), "");

    const { status } = await runDistAsync(
      distHook,
      JSON.stringify(promptEvent),
      env,
    );
    expect(status).toBe(0);
    expect(server.received).toHaveLength(0);
    expect(bufferFiles(dataDir)).toHaveLength(0);
  });

  it.each([
    ["empty input", ""],
    ["whitespace", "  \n"],
    ["invalid JSON", "{nope"],
    ["a JSON array", "[]"],
  ])("exits 0 and prints nothing on %s", (_name, input) => {
    const { env } = scratchHome("flightpath-hook-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    const { status, stdout } = runDist(distHook, input, env, {
      timeout: 20_000,
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("stays silent when the data folder cannot be written", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // Root ignores the permission bits this test relies on.
    }
    if (process.platform === "win32") {
      return; // chmod does not make a directory unwritable on Windows.
    }
    const { env, dataDir } = scratchHome("flightpath-hook-", {
      idleMs: "1200",
      stopDaemon: true,
    });
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o500);
    try {
      const { status, stdout } = runDist(
        distHook,
        JSON.stringify(promptEvent),
        env,
        { timeout: 20_000 },
      );
      expect(status).toBe(0);
      expect(stdout).toBe("");
    } finally {
      // Restore inside the test: the shared cleanup deletes the
      // tree, and it runs before any cleanup registered after it.
      chmodSync(dataDir, 0o700);
    }
  });

  it("buffers the event when the daemon answers a non-2xx status", async () => {
    await expectHookBuffers(await startAnsweringServer(500));
  });

  it("buffers the event when the daemon closes without replying", async () => {
    await expectHookBuffers(await startClosingServer());
  });

  it("runs fast against a live daemon", async () => {
    const server = await startServer();
    const { env } = hookHomeFor(server);

    // The criterion is overhead, not absolute time: what the hook
    // adds over a bare Node start. Each round measures both back
    // to back, so a slow patch on a loaded machine lands on the
    // pair, not on the hook alone. Absolute times mostly measure
    // the machine.
    const durations: number[] = [];
    const overhead: number[] = [];
    for (let i = 0; i < 30; i++) {
      const bareStarted = performance.now();
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["-e", ""], { env });
        child.on("error", reject);
        child.on("close", () => resolvePromise());
        child.stdin.end();
      });
      const bareMs = performance.now() - bareStarted;
      const started = performance.now();
      await runDistAsync(distHook, JSON.stringify(promptEvent), env);
      const hookMs = performance.now() - started;
      durations.push(hookMs);
      overhead.push(hookMs - bareMs);
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] ?? 0;
    const p90 = durations[Math.floor(durations.length * 0.9)] ?? 0;
    overhead.sort((a, b) => a - b);
    const overheadP90 = overhead[Math.floor(overhead.length * 0.9)] ?? 0;
    console.log(
      `hook timing on ${process.platform}: median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms over ${durations.length} runs; overhead p90 ${overheadP90.toFixed(1)} ms`,
    );
    expect(server.received.length).toBe(durations.length);
    // Asserted only in the dedicated timing job (see ci.yml),
    // where nothing else runs: in the full suite the neighbouring
    // tests move this number more than the hook does. Windows
    // gets a higher limit — process creation and file scanning
    // set a floor there that we don't control.
    if (process.env.FLIGHTPATH_TIMING_GATE) {
      expect(overheadP90).toBeLessThan(process.platform === "win32" ? 80 : 40);
    }
  }, 60_000);
});
