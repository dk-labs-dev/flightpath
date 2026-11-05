import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { removeTree } from "./support/remove-tree.js";

// Loading the built storage module in a clean process must not
// print node:sqlite's ExperimentalWarning: the warning filter has
// to be installed before the built-in loads, which is the one thing
// a test inside this process cannot observe (the module here is
// already loaded, and this Node may not warn anyway — the CI matrix
// runs this on 24.0.0, which does).
describe("storage module load", () => {
  it("prints no ExperimentalWarning in a child process", () => {
    const dir = mkdtempSync(join(tmpdir(), "flightpath-warning-"));
    try {
      const distEntry = fileURLToPath(
        new URL("../dist/storage/index.js", import.meta.url),
      );
      const script = join(dir, "load.mjs");
      writeFileSync(
        script,
        `import { openStorage } from ${JSON.stringify(pathToFileURL(distEntry).href)};
         const storage = openStorage({ dataDir: process.argv[2] });
         storage.close();
         console.log("loaded");`,
      );
      const result = spawnSync(process.execPath, [script, dir], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("loaded");
      expect(result.stderr).not.toContain("ExperimentalWarning");
    } finally {
      removeTree(dir);
    }
  });
});
