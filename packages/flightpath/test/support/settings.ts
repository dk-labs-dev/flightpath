import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSettings(dataDir: string, settings: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify(settings));
}
