import { describe, expect, it } from "vitest";

import { versionIn } from "./support/version.js";

const MANIFESTS = [
  "package.json",
  "packages/flightpath/package.json",
  "packages/view/package.json",
  "packages/flightpath/.claude-plugin/plugin.json",
];

describe("version fields", () => {
  it.each(MANIFESTS)("%s has the version the plugin package has", (path) => {
    expect(versionIn(path)).toBe(versionIn("packages/flightpath/package.json"));
  });
});
