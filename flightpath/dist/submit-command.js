if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\.js$/.test(process.argv[1])) process.stdout.write(`{"systemMessage":"● flightpath needs Node 24 or later; this is Node ${process.versions.node} · see Install in the README"}\n`); process.exit(0); }

// src/util/fs.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// src/submit-command.ts
var EXPANDED_OPENING = "<command-message>flightpath:";
function isExpandedCommand(raw2) {
  try {
    const { prompt } = JSON.parse(raw2);
    return typeof prompt === "string" && prompt.startsWith(EXPANDED_OPENING);
  } catch {
    return false;
  }
}
var raw = readStdin();
if (isExpandedCommand(raw)) {
  const { answerCommand } = await import("./command-handler.js");
  await answerCommand(raw);
}
