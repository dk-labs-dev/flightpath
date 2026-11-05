import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// The quality scripts are plain modules outside any TypeScript project,
// so the test loads the one under test by URL and types what it uses.
const scripts = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
);
const { toRepoPath }: { toRepoPath: (relativePath: string) => string } =
  await import(pathToFileURL(join(scripts, "repo-path.mjs")).href);
const allowList: { path: string }[] = JSON.parse(
  readFileSync(join(scripts, "comment-ratio-allowlist.json"), "utf8"),
);

describe("the quality scripts' repository paths", () => {
  it("finds an allow-listed file again when its path is written with backslashes", () => {
    const listed = new Set(allowList.map((entry) => entry.path));
    const windowsPath = "packages\\flightpath\\src\\redact\\allowlist.ts";

    expect(listed.has(windowsPath)).toBe(false);
    expect(listed.has(toRepoPath(windowsPath))).toBe(true);
  });

  it("writes every allow-listed path the same way from its backslash form", () => {
    for (const { path } of allowList) {
      expect(toRepoPath(path.replaceAll("/", "\\"))).toBe(path);
    }
  });

  it("leaves a path that already uses forward slashes as it is", () => {
    expect(toRepoPath("packages/view/src/sessions/api.ts")).toBe(
      "packages/view/src/sessions/api.ts",
    );
  });
});
