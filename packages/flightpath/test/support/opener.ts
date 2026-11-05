import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerCleanup } from "./cleanup.js";
import { requiredValue } from "./rows.js";

export interface OpenerCall {
  file: string;
  args: string[];
}

export interface FakeOpener {
  openEnv: NodeJS.ProcessEnv;
  /** Every opener the command process tried to start, in order. */
  calls(): OpenerCall[];
}

const preload = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "opener-preload.mjs"),
).href;

/** `env` for a command process whose browser opener is replaced
 *  by a stand-in (opener-preload.mjs). It runs for `runsMs`, or is
 *  not found at all when `missing`. */
export function fakeOpener(
  env: NodeJS.ProcessEnv,
  options: { runsMs?: number; missing?: boolean } = {},
): FakeOpener {
  const home = requiredValue(env.HOME, "the scratch home");
  const logPath = join(home, "opener-calls.jsonl");
  const openEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_OPTIONS: `--import ${preload}`,
    FLIGHTPATH_TEST_OPENER_LOG: logPath,
    FLIGHTPATH_TEST_OPENER_MS: String(options.runsMs ?? 0),
  };
  if (options.missing) openEnv.FLIGHTPATH_TEST_OPENER = "missing";
  registerCleanup(() => {
    for (const { pid } of readLog(logPath)) stopStandIn(pid);
  });
  return {
    openEnv,
    calls: () => readLog(logPath).map(({ file, args }) => ({ file, args })),
  };
}

function readLog(logPath: string): (OpenerCall & { pid?: number })[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as OpenerCall & { pid?: number });
  } catch {
    // The command never reached an opener, so nothing was logged.
    return [];
  }
}

function stopStandIn(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    // The stand-in has already finished.
  }
}

/** The one call the machine's own opener receives for `url`. */
export function platformOpenerCall(url: string): OpenerCall {
  switch (process.platform) {
    case "win32":
      return { file: "cmd", args: ["/c", "start", '""', `"${url}"`] };
    case "darwin":
      return { file: "open", args: [url] };
    default:
      return { file: "xdg-open", args: [url] };
  }
}
