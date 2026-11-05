import { describe, expect, it, vi } from "vitest";

import { setupPaths } from "../src/setup/index.js";

// A Windows host joins with backslashes. Everything but `join`
// is the real module, so the setup module sees a host whose
// `join` is the Windows one, on any machine this runs on.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, join: actual.win32.join };
});

describe("setupPaths on a host that joins with backslashes", () => {
  const base = { dataDir: "/data", configDir: "/home/u/.claude" };

  it("keeps the macOS managed settings paths in forward slashes", () => {
    const paths = setupPaths({ ...base, platform: "darwin" });
    expect(paths.managedSettingsPath).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(paths.managedDropInDir).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.d",
    );
  });

  it("keeps the Linux managed settings paths in forward slashes", () => {
    const paths = setupPaths({ ...base, platform: "linux" });
    expect(paths.managedSettingsPath).toBe(
      "/etc/claude-code/managed-settings.json",
    );
    expect(paths.managedDropInDir).toBe("/etc/claude-code/managed-settings.d");
  });
});
