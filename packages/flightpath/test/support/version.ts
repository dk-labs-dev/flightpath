import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export function versionIn(repoPath: string): string {
  const manifest = JSON.parse(
    readFileSync(`${repoRoot}${repoPath}`, "utf8"),
  ) as { version: string };
  return manifest.version;
}

export function packageVersion(): string {
  return versionIn("packages/flightpath/package.json");
}
