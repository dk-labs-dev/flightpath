import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveDataDir } from "../../src/data-dir.js";
import { startLockPath } from "../../src/daemon/lock.js";
import { registerCleanup, makeTempRoot } from "./cleanup.js";

export interface DistResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runDist(
  entry: string,
  input: string,
  env: NodeJS.ProcessEnv,
  options: { timeout?: number } = {},
): DistResult {
  const result = spawnSync(process.execPath, [entry], {
    input,
    env,
    encoding: "utf8",
    timeout: options.timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runDistJson(
  entry: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: { timeout?: number } = {},
): DistResult {
  return runDist(entry, JSON.stringify(payload), env, options);
}

export function runDistAsync(
  entry: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<DistResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function daemonPid(dataDir: string): number {
  try {
    return Number.parseInt(
      readFileSync(join(dataDir, "daemon.lock"), "utf8").trim(),
      10,
    );
  } catch {
    return Number.NaN;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForDaemonPid(dataDir: string): Promise<number> {
  const lockPath = startLockPath(dataDir);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const pid = daemonPid(dataDir);
    if (Number.isFinite(pid)) return pid;
    let starting = false;
    try {
      starting = Date.now() - statSync(lockPath).mtimeMs < 10_000;
    } catch {
      starting = false;
    }
    if (!starting || Date.now() >= deadline) return Number.NaN;
    await pause(25);
  }
}

// Waits without blocking the event loop: a daemon this process
// started stays a zombie, which still answers kill(pid, 0),
// until the loop reaps it.
async function waitForProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await pause(25);
  return !processAlive(pid);
}

async function stopDaemonAndWait(dataDir: string): Promise<void> {
  const pid = await waitForDaemonPid(dataDir);
  if (!Number.isFinite(pid) || pid === process.pid || !processAlive(pid))
    return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForProcessGone(pid, 3_000)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  if (!(await waitForProcessGone(pid, 2_000))) {
    throw new Error(
      `the daemon (pid ${pid}) survived cleanup; it would outlive its test`,
    );
  }
}

export interface ScratchHome {
  home: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
}

export function scratchHome(
  prefix: string,
  options: { idleMs?: string; stopDaemon?: boolean } = {},
): ScratchHome {
  const home = makeTempRoot(prefix);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
  delete env.XDG_DATA_HOME;
  if (options.idleMs !== undefined) env.FLIGHTPATH_IDLE_MS = options.idleMs;
  const dataDir = resolveDataDir(env, process.platform, home);
  if (options.stopDaemon) registerCleanup(() => stopDaemonAndWait(dataDir));
  return { home, env, dataDir };
}
