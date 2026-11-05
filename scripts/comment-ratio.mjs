// Comment ratio: fails any file where comment lines exceed 20% of
// all lines. Comments exist to explain why, so a file that is mostly
// explanation next to little code is a file to restructure, not to
// narrate harder. The count is line-based — a line that is only a
// comment (or part of a block comment) counts, a trailing comment on
// a code line does not — which is imprecise at the edges and needs no
// parser. Files that legitimately carry more are listed in
// comment-ratio-allowlist.json, each with its reason.

import console from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { toRepoPath } from "./repo-path.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scanDirs = [
  ...["src", "scripts", "test"].map((dir) =>
    join(root, "packages", "flightpath", dir),
  ),
  join(root, "packages", "view", "src"),
  // The gate's own scripts are checked too.
  join(root, "scripts"),
];
const allowlist = JSON.parse(
  readFileSync(join(root, "scripts", "comment-ratio-allowlist.json"), "utf8"),
);
const allowed = new Map(allowlist.map((entry) => [entry.path, entry]));

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function countCommentLines(text) {
  let comments = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      comments += 1;
      if (line.includes("*/")) inBlock = false;
    } else if (line.startsWith("/*")) {
      comments += 1;
      if (!line.includes("*/")) inBlock = true;
    } else if (line.startsWith("//")) {
      comments += 1;
    }
  }
  return comments;
}

let failures = 0;
for (const dir of scanDirs) {
  for (const file of listFiles(dir)) {
    const path = toRepoPath(relative(root, file));
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n").length - 1;
    const comments = countCommentLines(text);
    const ratio = lines === 0 ? 0 : comments / lines;
    if (ratio > 0.2 && !allowed.has(path)) {
      console.log(
        `${path}: ${(ratio * 100).toFixed(0)}% comment lines (${comments}/${lines})`,
      );
      failures += 1;
    }
  }
}
if (failures > 0) {
  console.log(
    "Comment ratio: files over 20% need restructuring, or an allow-list entry with a reason.",
  );
  process.exit(1);
}
