import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { resolveDataDir } from "../../src/data-dir.js";
import { makeTempRoot, registerCleanup } from "./cleanup.js";
import { requiredValue } from "./rows.js";
import { medianOf, onHostedRunner } from "./time.js";

/** Listen on a port the OS picks, and answer that port. */
export async function listenOnFreePort(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", () => resolvePromise()),
  );
  return (server.address() as AddressInfo).port;
}

/** A port the OS says is free right now: take one, read it,
 *  and let it go again for whoever asked. */
export async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listenOnFreePort(server);
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  return port;
}

/** Hold `count` consecutive ports until the test's cleanups
 *  run, and answer the first of them: a daemon configured for
 *  the first finds every port it would try taken. The run is
 *  found, not fixed — start from a port the OS calls free and
 *  move past any run that turns out taken, so two suites doing
 *  this at once never hold the same ports. */
export async function holdPorts(count: number): Promise<number> {
  const closeAll = async (servers: Server[]): Promise<void> => {
    for (const server of servers) {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  };
  for (;;) {
    const first = await freePort();
    const servers: Server[] = [];
    let heldAll = true;
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      try {
        await new Promise<void>((resolvePromise, reject) => {
          server.once("error", reject);
          server.listen(first + i, "127.0.0.1", () => resolvePromise());
        });
      } catch {
        heldAll = false;
        break;
      }
    }
    if (!heldAll) {
      await closeAll(servers);
      continue;
    }
    registerCleanup(() => closeAll(servers));
    return first;
  }
}

/** The options a daemon-starting suite hands its describe: a
 *  cold daemon start under the parallel browser suites can
 *  pass vitest's 5 s default timeout. */
export const DAEMON_SUITE = { timeout: 30_000 };

export const distDir = fileURLToPath(new URL("../../dist", import.meta.url));

export function distPath(name: string): string {
  return join(distDir, name);
}

const distDaemon = distPath("daemon.js");

let daemonSurvived = false;

function registerDaemonChild(child: ChildProcess): void {
  registerCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      daemonSurvived = true;
      child.kill("SIGKILL");
      // Windows refuses to remove a folder while a file in it is
      // open, and a killed process holds its files until it has
      // exited.
      await waitForChildExit(child, 5_000);
    }
  });
}

/** Whether a daemon a test started was still running when its
 *  cleanup ran. Reading it clears it, so a file that asserts on
 *  it sees only its own daemons. */
export function takeDaemonSurvived(): boolean {
  const survived = daemonSurvived;
  daemonSurvived = false;
  return survived;
}

export function envForDataRoot(
  root: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.XDG_DATA_HOME;
  if (process.platform === "win32") {
    env.LOCALAPPDATA = root;
    env.APPDATA = join(root, "roaming");
  } else if (process.platform === "darwin") {
    env.HOME = root;
  } else {
    env.XDG_DATA_HOME = join(root, "xdg");
  }
  return env;
}

export function dataDirFor(root: string): string {
  return resolveDataDir(envForDataRoot(root), process.platform, root);
}

export function makeRoot(
  prefix = "flightpath-test-",
  options: { big?: boolean } = {},
): { root: string; dataDir: string } {
  const base =
    options.big && process.env.FLIGHTPATH_BIG_TEST_DIR !== undefined
      ? process.env.FLIGHTPATH_BIG_TEST_DIR
      : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = makeTempRoot(prefix, base);
  return { root, dataDir: dataDirFor(root) };
}

export interface StartDaemonOptions {
  idleMs?: string;
  withTimingDefaults?: boolean;
}

export function startDaemon(
  root: string,
  extra: NodeJS.ProcessEnv = {},
  options: StartDaemonOptions = {},
): ChildProcess {
  const timing =
    options.withTimingDefaults === false
      ? {}
      : {
          FLIGHTPATH_DRAIN_MS: "150",
          FLIGHTPATH_IDLE_MS: options.idleMs ?? "60000",
        };
  return startDaemonProcess(
    distDaemon,
    envForDataRoot(root, { ...timing, ...extra }),
  );
}

function startDaemonProcess(
  entry: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerDaemonChild(child);
  return child;
}

export interface StartedDaemon {
  root: string;
  dataDir: string;
  child: ChildProcess;
  port: number;
  token: string;
}

export interface StartTestDaemonOptions {
  extra?: NodeJS.ProcessEnv;
  startOptions?: StartDaemonOptions;
  timeoutMs?: number;
}

/** Start a daemon on a root a test made, and wait until it
 *  serves: the child, and the port and token it published. */
export async function startTestDaemon(
  root: string,
  options: StartTestDaemonOptions = {},
): Promise<StartedDaemon> {
  const dataDir = dataDirFor(root);
  const child = startDaemon(
    root,
    options.extra ?? {},
    options.startOptions ?? {},
  );
  await waitForDaemonReady(child, dataDir, options.timeoutMs ?? 15_000);
  return {
    root,
    dataDir,
    child,
    port: readPort(dataDir),
    token: readToken(dataDir),
  };
}

function spawnSleeper(): ChildProcess {
  const sleeper = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 30000)"],
    { stdio: "ignore" },
  );
  registerCleanup(async () => {
    sleeper.kill("SIGKILL");
    await waitForChildExit(sleeper, 5_000);
  });
  return sleeper;
}

/** The pid of a live process standing in for a daemon, for
 *  tests that only need the lock to name something alive. */
export function sleeperPid(): number {
  return requiredPid(spawnSleeper());
}

/** A fake live daemon: a real process whose pid the lock
 *  names, with its port and token files published. */
export function fakeDaemon(dataDir: string): ChildProcess {
  mkdirSync(dataDir, { recursive: true });
  const sleeper = spawnSleeper();
  writeFileSync(join(dataDir, "daemon.lock"), String(requiredPid(sleeper)));
  writeFileSync(join(dataDir, "port"), "4799");
  writeFileSync(join(dataDir, "token"), "test-token");
  return sleeper;
}

/** Kill a sleeper and reap it here, so it does not linger as
 *  a zombie the cleanup reads as alive. */
export async function stopSleeper(sleeper: ChildProcess): Promise<void> {
  sleeper.kill("SIGKILL");
  await waitForChildExit(sleeper);
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function waitForChildExit(
  child: ChildProcess,
  timeoutMs?: number,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => finish(new Error("Timed out waiting for exit.")),
            timeoutMs,
          );
    const finish = (error?: Error, code?: number | null) => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(code ?? null);
    };
    const onExit = (code: number | null) => finish(undefined, code);
    const onError = (error: Error) => finish(error);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** Ask a daemon to shut down cleanly: SIGTERM runs its handler on
 *  POSIX, but Windows ends a process on SIGTERM without running
 *  one, so there the stop route is asked instead. */
export async function requestCleanStop(
  pid: number,
  dataDir: string,
): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
    return;
  }
  await callDaemon(readPort(dataDir), {
    method: "POST",
    path: "/api/stop",
    token: readToken(dataDir),
  });
}

/** Stop a daemon child cleanly and answer its exit code. */
export async function stopCleanly(
  child: ChildProcess,
  dataDir: string,
): Promise<number | null> {
  await requestCleanStop(requiredPid(child), dataDir);
  return waitForChildExit(child);
}

export async function stopDaemon(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child, timeoutMs).catch(async () => {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  });
  child.kill("SIGTERM");
  await exited;
}

export function waitForDaemonReady(
  child: ChildProcess,
  dataDir: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const watched = new Map<string, FSWatcher>();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      child.off("exit", onExit);
      for (const watcher of watched.values()) watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(`Daemon exited before it was ready (${code ?? signal}).`),
      );
    const check = () => {
      if (
        existsSync(join(dataDir, "port")) &&
        existsSync(join(dataDir, "token"))
      ) {
        finish();
      }
    };
    const addWatcher = (path: string) => {
      if (watched.has(path) || !existsSync(path)) return;
      const watcher = watch(path, { persistent: false }, () => {
        addWatchers();
        check();
      });
      // A watched folder can be removed by cleanup while a wait is
      // still armed; that is the wait ending, not a failure to hide.
      watcher.on("error", () => undefined);
      watched.set(path, watcher);
    };
    const addWatchers = () => {
      // The data folder and its parents may not exist yet: watch
      // every ancestor that does, so creating the next level down
      // wakes the check at once.
      let current = dataDir;
      for (let depth = 0; depth < 4; depth += 1) {
        addWatcher(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the daemon to be ready.")),
      timeoutMs,
    );
    // The watchers wake the check at once; the timer covers an
    // event the watchers miss, so a lost event cannot stall it.
    const interval = setInterval(check, 250);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", onExit);
    addWatchers();
    check();
  });
}

export function readPort(dataDir: string): number {
  return Number.parseInt(readFileSync(join(dataDir, "port"), "utf8"), 10);
}

export function readToken(dataDir: string): string {
  return readFileSync(join(dataDir, "token"), "utf8").trim();
}

export interface DaemonCallOptions {
  method: string;
  path: string;
  token?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DaemonReply {
  status: number;
  body: string;
  buffer: Buffer;
  headers: IncomingHttpHeaders;
  ms: number;
}

export function callDaemon(
  port: number,
  options: DaemonCallOptions,
): Promise<DaemonReply> {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined)
      headers["x-flightpath-token"] = options.token;
    if (options.host !== undefined) headers.host = options.host;
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers,
        setHost: options.host === undefined,
        // Every call is its own client, as the daemon's real
        // clients are (one short-lived process per hook event).
        // The default agent pools keep-alive sockets by port,
        // and a pooled socket outlives the daemon it belonged
        // to: when the next daemon binds the same port, the
        // first request is written into the dead socket and
        // fails with "socket hang up" (deterministic on Node
        // 24.21; the pooled socket is not evicted in time).
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buffer.toString("utf8"),
            buffer,
            ms: performance.now() - started,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Post each body in turn while the caller's background
 *  work runs, print the round trips under its label, and
 *  return them: every reply must be a 204. The callers
 *  hold the 250 ms bound on the slowest of the samples —
 *  the promise is every acknowledgment, not the typical
 *  one. */
export async function measureAcks(
  port: number,
  options: Omit<DaemonCallOptions, "body">,
  bodies: string[],
  label: string,
): Promise<number[]> {
  const samples: number[] = [];
  for (const body of bodies) {
    const reply = await callDaemon(port, { ...options, body });
    if (reply.status !== 204) {
      throw new Error(
        `${label}: expected a 204 acknowledgment, got ${reply.status}`,
      );
    }
    samples.push(reply.ms);
  }
  console.log(
    `${label}: ${samples.map((ms) => ms.toFixed(0)).join(", ")} ms (median ${medianOf(samples).toFixed(0)} ms)`,
  );
  return samples;
}

/** Hold the 250 ms acknowledgment bound on the slowest
 *  sample; on a hosted runner only log it (see time.ts). */
export function expectAcksWithinBudget(samples: number[], label: string): void {
  const slowest = Math.max(...samples);
  if (onHostedRunner) {
    console.log(
      `${label}: max ${slowest.toFixed(0)} ms (budget 250 ms, logged on hosted runners)`,
    );
    return;
  }
  expect(slowest).toBeLessThan(250);
}

export async function callDaemonJson(
  port: number,
  method: string,
  path: string,
  token: string | null,
  body?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const options: DaemonCallOptions = {
    method,
    path,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-flightpath-token": token }),
    },
  };
  if (body !== undefined) options.body = body;
  const reply = await callDaemon(port, options);
  return {
    status: reply.status,
    json: (reply.body.length > 0 ? JSON.parse(reply.body) : {}) as Record<
      string,
      unknown
    >,
  };
}

export function requiredPid(child: ChildProcess): number {
  return requiredValue(child.pid, "the daemon process id");
}
