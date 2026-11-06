// Prints the CI matrices as step outputs for the workflow's
// prepare job: which runner each system gets, the systems the
// plain matrices cover, and the main project's shard list. While
// the repository is private (REPO_PRIVATE=true) the lists cover
// Linux only; they widen to all three systems when it turns
// public. Every matrix job in .github/workflows/ci.yml reads these
// outputs, so the lists live in exactly one place.

import process from "node:process";

const runners = {
  linux: "ubuntu-latest",
  windows: "windows-latest",
  macos: "macos-latest",
};

const systems =
  process.env.REPO_PRIVATE === "true"
    ? ["linux"]
    : ["linux", "windows", "macos"];

const shardsPerSystem = { linux: 3, windows: 3, macos: 2 };
const mainMatrix = [];
for (const os of systems) {
  for (let shard = 1; shard <= shardsPerSystem[os]; shard += 1) {
    mainMatrix.push({ os, shard, total: shardsPerSystem[os] });
  }
}

console.log(`runners=${JSON.stringify(runners)}`);
console.log(`systems=${JSON.stringify(systems)}`);
console.log(`main-matrix=${JSON.stringify(mainMatrix)}`);
