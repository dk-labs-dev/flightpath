// Bundle size: the view's script and stylesheet, gzipped
// together, stay within the budget ADR-0027 sets. The check
// measures the built files the daemon serves — dist/view, as
// the tests exercise it — and builds the view first when no
// build exists yet, so the number is never taken from a build
// this check did not just see or find in place.

import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_BYTES = 150 * 1024;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distView = join(root, "packages", "flightpath", "dist", "view");

if (!existsSync(join(distView, "index.html"))) {
  const built = spawnSync(
    "pnpm",
    ["--filter", "@flightpath/view", "run", "build"],
    {
      cwd: root,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );
  if (built.status !== 0) {
    console.log("bundle size: the view build failed");
    process.stdout.write(built.stdout ?? "");
    process.stderr.write(built.stderr ?? "");
    process.exit(1);
  }
}

const names = readdirSync(distView);
const script = names.find((name) => /^view-.*\.js$/.test(name));
const style = names.find((name) => /^view-.*\.css$/.test(name));
if (!script || !style) {
  console.log("bundle size: dist/view holds no view script or stylesheet");
  process.exit(1);
}

const scriptBytes = gzipSync(readFileSync(join(distView, script))).length;
const styleBytes = gzipSync(readFileSync(join(distView, style))).length;
const total = scriptBytes + styleBytes;
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
console.log(
  `view bundle: ${kib(total)} gzipped (script ${kib(scriptBytes)}, stylesheet ${kib(styleBytes)}) of ${kib(BUDGET_BYTES)} budget`,
);
if (total > BUDGET_BYTES) {
  console.log("bundle size: over the budget in ADR-0027");
  process.exit(1);
}
