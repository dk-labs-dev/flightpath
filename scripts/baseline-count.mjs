// Baseline count: the structural rules have no per-file exceptions.
// A pre-existing violation is carried by an eslint-disable-next-line
// with a `-- baseline` reason on the exact line it exempts. This
// check counts those disables and fails when the count differs in
// either direction from the number recorded in baseline-count.json.
// The count only ever goes down — a cleanup removes disables, then
// lowers the recorded number in the same change.

import console from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scanDirs = [
  ...["src", "scripts", "test"].map((dir) =>
    join(root, "packages", "flightpath", dir),
  ),
  join(root, "packages", "view", "src"),
  // The gate's own scripts are linted too.
  join(root, "scripts"),
];
const recorded = JSON.parse(
  readFileSync(join(root, "scripts", "baseline-count.json"), "utf8"),
).count;

// Assembled from pieces so this file does not count itself.
const directive = "eslint-disable-next-" + "line";
const marker = "-- base" + "line";

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : listFiles(path);
    }
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

let count = 0;
for (const dir of scanDirs) {
  for (const file of listFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.includes(directive) && line.includes(marker)) count += 1;
    }
  }
}
if (count > recorded) {
  console.log(
    `Baseline disables: ${count} in the tree, ${recorded} recorded in scripts/baseline-count.json. ` +
      "The tree has more baseline disables than recorded: fix the violation instead of adding a baseline disable.",
  );
  process.exit(1);
}
if (count < recorded) {
  console.log(
    `Baseline disables: ${count} in the tree, ${recorded} recorded in scripts/baseline-count.json. ` +
      "The tree has fewer baseline disables than recorded: the cleanup worked, so lower the number in scripts/baseline-count.json in the same change.",
  );
  process.exit(1);
}
