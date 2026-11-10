// Prints the CI matrices as step outputs for the workflow's
// prepare job: the runner per system, the systems covered, and
// the main project's shards.

import console from "node:console";
import process from "node:process";

const runners = {
  linux: "ubuntu-latest",
  windows: "windows-latest",
  macos: "macos-latest",
};

// While the repository is private the lists cover Linux only;
// they widen to all three systems when it turns public.
const systems =
  process.env.REPO_PRIVATE === "true"
    ? ["linux"]
    : ["linux", "windows", "macos"];

const shardsPerSystem = { linux: 3, windows: 5, macos: 2 };
const mainMatrix = [];
for (const os of systems) {
  for (let shard = 1; shard <= shardsPerSystem[os]; shard += 1) {
    mainMatrix.push({ os, shard, total: shardsPerSystem[os] });
  }
}

console.log(`runners=${JSON.stringify(runners)}`);
console.log(`systems=${JSON.stringify(systems)}`);
console.log(`main-matrix=${JSON.stringify(mainMatrix)}`);
