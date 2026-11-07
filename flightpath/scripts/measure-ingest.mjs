// Measure the daemon's memory while it ingests 100,000 events.
//
// Run from this package's folder, after a build:
//
//   pnpm build
//   node --expose-gc scripts/measure-ingest.mjs
//
// The script starts the daemon from dist on a scratch data folder
// and posts 100,000 envelopes (~700 bytes each) to it over HTTP,
// the same path the recording hook uses. The daemon runs in this
// process, so the memory sampled is the daemon's own: RSS and heap
// used, after a forced garbage collection, before the first event,
// after every 25,000 events, and at the end. The scratch folder is
// deleted afterwards; nothing here touches a real data folder.

import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const { startDaemon } = await import("../dist/daemon/server.js");
const { openStorage } = await import("../dist/storage/index.js");

const TOTAL = 100_000;
const SAMPLE_EVERY = 25_000;
const IN_FLIGHT = 16;

const dataDir = mkdtempSync(join(tmpdir(), "flightpath-measure-"));
const daemon = await startDaemon({
  dataDir,
  version: "measure",
  idleMs: 10 * 60 * 1000,
});
if (daemon === null) {
  console.error("the daemon did not start (another one holds the lock)");
  process.exit(1);
}
const token = readFileSync(join(dataDir, "token"), "utf8").trim();

const filler = "the quick brown fox jumps over the lazy dog ".repeat(11);
function envelopeBody(i) {
  return JSON.stringify({
    id: `measure-${i}`,
    received_at: 1700000000000 + i,
    redaction_version: 1,
    plugin_version: "measure",
    event: {
      hook_event_name: "UserPromptSubmit",
      session_id: "measure-session",
      cwd: "/work/some/project",
      prompt: `${filler} ${i}`,
    },
  });
}

function sample(label) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const m = process.memoryUsage();
  console.log(
    `${label}: rss ${(m.rss / 1048576).toFixed(1)} MB, heap ${(m.heapUsed / 1048576).toFixed(1)} MB`,
  );
}

const agent = new Agent({ keepAlive: true, maxSockets: IN_FLIGHT });
function post(i) {
  return new Promise((resolvePromise, rejectPromise) => {
    const body = envelopeBody(i);
    const req = request(
      {
        host: "127.0.0.1",
        port: daemon.port,
        path: "/events/hook",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-flightpath-token": token,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode === 204) resolvePromise();
          else rejectPromise(new Error(`status ${res.statusCode}`));
        });
      },
    );
    req.on("error", rejectPromise);
    req.end(body);
  });
}

const started = Date.now();
sample("0 events");
let next = 1;
let done = 0;
async function worker() {
  while (next <= TOTAL) {
    const i = next;
    next += 1;
    await post(i);
    done += 1;
    if (done % SAMPLE_EVERY === 0) sample(`${done} events`);
  }
}
await Promise.all(Array.from({ length: IN_FLIGHT }, () => worker()));
console.log(
  `posted ${done} envelopes in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);

await daemon.shutdown();
const storage = openStorage({ dataDir });
console.log(`stored raw events: ${storage.countRawEvents()}`);
storage.close();
agent.destroy();
rmSync(dataDir, { recursive: true, force: true });
