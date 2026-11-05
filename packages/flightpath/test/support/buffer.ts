import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { daemonPromptEnvelope } from "./events.js";

/** Write one buffered hook event the way the hook writes it:
 * a file in the data folder's buffer, named for its arrival. */
export function writeBufferEvent(
  dataDir: string,
  receivedAt: number,
  id: string,
  sessionId = "s-health",
): void {
  const buffer = join(dataDir, "buffer");
  mkdirSync(buffer, { recursive: true });
  writeFileSync(
    join(buffer, `${receivedAt}-${id}.json`),
    daemonPromptEnvelope(id, receivedAt, "0.0.0", sessionId),
  );
}
