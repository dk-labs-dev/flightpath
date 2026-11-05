// The fixture program: it seeds through the daemon's
// TypeScript test support, so the runner beside it
// bundles this file and calls the function below.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSessionData, tokenHistory } from "../src/api/index.js";
import { openStorage } from "../src/storage/index.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { seedPlantedSession } from "../test/support/seed.js";

const header = `// Generated from the planted seed by the daemon's own
// token history builder — do not edit by hand.
// Regenerate with scripts/regenerate-tokens-fixture.mjs
// in the daemon package; the daemon's token tests compare
// this fixture against the builder, so a change to either
// fails until the two agree again.

import type { TokenHistory } from "@flightpath/flightpath/api/payloads";

`;

/** Seed the planted session in a scratch data folder, build its token history
 * with the daemon's own builder, and write the view's planted fixture at the
 * given path, so the fixture is the payload the daemon actually produces. */
export function regenerateTokensFixture(target: string): void {
  const dir = mkdtempSync(join(tmpdir(), "flightpath-fixture-"));
  try {
    const storage = openStorage({ dataDir: dir });
    const db = new DatabaseSync(storage.dbPath);
    const sessionId = seedPlantedSession(db);
    const data = loadSessionData(storage, sessionId);
    if (data === undefined) throw new Error("the planted session did not load");
    const history = tokenHistory(data, {
      autoCompactWindow: null,
      storePromptText: true,
    });
    db.close();
    storage.close();
    const body = `export const plantedTokenHistory: TokenHistory = ${JSON.stringify(history, null, 2)};\n`;
    writeFileSync(target, header + body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
