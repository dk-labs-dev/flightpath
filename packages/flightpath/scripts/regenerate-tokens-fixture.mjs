// The fixture program's runner: the program seeds
// through TypeScript test support, so this file bundles
// it with esbuild and calls what it exports.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(
  here,
  "..",
  "..",
  "view",
  "test",
  "tokens-history-fixture.ts",
);
const scratch = mkdtempSync(join(tmpdir(), "flightpath-fixture-"));
try {
  const bundle = join(scratch, "regenerate.mjs");
  await build({
    entryPoints: [join(here, "regenerate-tokens-fixture.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  const program = await import(bundle);
  program.regenerateTokensFixture(target);
  const prettier = join(
    here,
    "..",
    "..",
    "..",
    "node_modules",
    ".bin",
    "prettier",
  );
  execFileSync(prettier, ["--write", target], { stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
