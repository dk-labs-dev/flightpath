// Loaded into the command process under test with `node --import`: the
// browser opener becomes a stand-in, so no test starts a real `open`,
// `xdg-open` or `cmd /c start`. It gets the caller's own spawn options,
// so a command that waited for it would be seen waiting.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

const openers = new Set(["open", "xdg-open", "cmd"]);
const realSpawn = childProcess.spawn;

childProcess.spawn = (file, args, options) => {
  if (!openers.has(file)) return realSpawn(file, args, options);
  // The stand-in is a real program, found or not, so the child
  // reports a missing opener the way the platform would.
  const child =
    process.env.FLIGHTPATH_TEST_OPENER === "missing"
      ? realSpawn("flightpath-missing-opener", [], options)
      : realSpawn(
          process.execPath,
          [
            "-e",
            `setTimeout(Boolean,${process.env.FLIGHTPATH_TEST_OPENER_MS})`,
          ],
          { ...options, windowsVerbatimArguments: false },
        );
  const call = JSON.stringify({ file, args, pid: child.pid });
  appendFileSync(process.env.FLIGHTPATH_TEST_OPENER_LOG, `${call}\n`);
  return child;
};
syncBuiltinESMExports();
