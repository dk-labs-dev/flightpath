import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDataDir } from "../src/data-dir.js";

describe("resolveDataDir", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveDataDir(
        { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        "win32",
        "C:\\Users\\a",
      ),
    ).toBe(join("C:\\Users\\a\\AppData\\Local", "Flightpath"));
  });

  it("falls back to the profile's AppData on Windows", () => {
    expect(resolveDataDir({}, "win32", "C:\\Users\\a")).toBe(
      join("C:\\Users\\a", "AppData", "Local", "Flightpath"),
    );
  });

  it("uses Application Support on macOS", () => {
    expect(resolveDataDir({}, "darwin", "/Users/a")).toBe(
      join("/Users/a", "Library", "Application Support", "Flightpath"),
    );
  });

  it("uses XDG_DATA_HOME on Linux when set", () => {
    expect(resolveDataDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/a")).toBe(
      join("/data", "flightpath"),
    );
  });

  it("uses ~/.local/share on Linux otherwise", () => {
    expect(resolveDataDir({}, "linux", "/home/a")).toBe(
      join("/home/a", ".local", "share", "flightpath"),
    );
    expect(resolveDataDir({ XDG_DATA_HOME: "" }, "linux", "/home/a")).toBe(
      join("/home/a", ".local", "share", "flightpath"),
    );
  });

  it("ignores a relative XDG_DATA_HOME, as the XDG spec requires", () => {
    expect(
      resolveDataDir({ XDG_DATA_HOME: "relative/dir" }, "linux", "/home/a"),
    ).toBe(join("/home/a", ".local", "share", "flightpath"));
  });
});
