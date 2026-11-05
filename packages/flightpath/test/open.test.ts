import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import { sleeperPid } from "./support/daemon.js";

import {
  openLiveView,
  waitForLiveViewUrl,
  type SpawnOpener,
} from "../src/open.js";

// Unit tests for the live view opener (ADR-0026): the address
// comes only from the daemon's files, and each platform's
// opener is exercised with a recording spawn standing in for
// the real one. The command hook's own tests cover the real
// spawn on this platform.

afterEach(async () => {
  await runCleanups();
});

function scratchDir(): string {
  return makeTempRoot("flightpath-open-");
}

const url = "http://127.0.0.1:4799/#session/s1&token=test-token";

interface RecordedSpawn {
  calls: {
    file: string;
    args: string[];
    options: {
      detached: boolean;
      stdio: "ignore";
      windowsVerbatimArguments: boolean;
    };
  }[];
  errorListeners: number;
  unrefs: number;
}

function recordingSpawn(
  pid: number | undefined,
  recorded: RecordedSpawn,
): SpawnOpener {
  return (file, args, options) => {
    recorded.calls.push({ file, args: [...args], options });
    return {
      pid,
      on: () => {
        recorded.errorListeners += 1;
      },
      unref: () => {
        recorded.unrefs += 1;
      },
    };
  };
}

function blankRecord(): RecordedSpawn {
  return { calls: [], errorListeners: 0, unrefs: 0 };
}

describe("openLiveView", () => {
  it("opens through cmd's start on Windows, detached", () => {
    const recorded = blankRecord();
    const opened = openLiveView(url, "win32", {}, recordingSpawn(7, recorded));
    expect(opened).toBe(true);
    expect(recorded.calls).toEqual([
      {
        file: "cmd",
        args: ["/c", "start", '""', `"${url}"`],
        options: {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        },
      },
    ]);
    expect(recorded.unrefs).toBe(1);
    expect(recorded.errorListeners).toBe(1);
  });

  it("keeps the token inside the quotes on the command line cmd receives", () => {
    const recorded = blankRecord();
    openLiveView(url, "win32", {}, recordingSpawn(7, recorded));
    // Verbatim arguments are joined with spaces and nothing
    // is quoted on the way, so this is the line cmd parses:
    // the address's & must sit inside its quotes, or cmd
    // would split the address there and run token=… itself.
    const call = recorded.calls[0];
    if (!call) throw new Error("expected one recorded spawn");
    const line = [call.file, ...call.args].join(" ");
    expect(line).toBe(`cmd /c start "" "${url}"`);
    expect(line.replace(`"${url}"`, "")).not.toContain("&");
  });

  it("opens through open on macOS", () => {
    const recorded = blankRecord();
    const opened = openLiveView(url, "darwin", {}, recordingSpawn(7, recorded));
    expect(opened).toBe(true);
    expect(recorded.calls).toEqual([
      {
        file: "open",
        args: [url],
        options: {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: false,
        },
      },
    ]);
  });

  it("opens through xdg-open on Linux with a display", () => {
    const recorded = blankRecord();
    const opened = openLiveView(
      url,
      "linux",
      { DISPLAY: ":0" },
      recordingSpawn(7, recorded),
    );
    expect(opened).toBe(true);
    expect(recorded.calls).toEqual([
      {
        file: "xdg-open",
        args: [url],
        options: {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: false,
        },
      },
    ]);
  });

  it("opens on Linux with only a Wayland display", () => {
    const recorded = blankRecord();
    const opened = openLiveView(
      url,
      "linux",
      { WAYLAND_DISPLAY: "wayland-1" },
      recordingSpawn(7, recorded),
    );
    expect(opened).toBe(true);
    expect(recorded.calls).toHaveLength(1);
  });

  it("does not spawn on Linux with no display", () => {
    const recorded = blankRecord();
    const opened = openLiveView(url, "linux", {}, recordingSpawn(7, recorded));
    expect(opened).toBe(false);
    expect(recorded.calls).toEqual([]);
  });

  it("reports false when the spawn finds no program", () => {
    const recorded = blankRecord();
    const opened = openLiveView(
      url,
      "linux",
      { DISPLAY: ":0" },
      recordingSpawn(undefined, recorded),
    );
    expect(opened).toBe(false);
    expect(recorded.calls).toHaveLength(1);
  });

  it("reports false when the spawn throws", () => {
    const throwing: SpawnOpener = () => {
      throw new Error("cannot spawn");
    };
    expect(openLiveView(url, "linux", { DISPLAY: ":0" }, throwing)).toBe(false);
  });

  it("has no opener on other platforms", () => {
    const recorded = blankRecord();
    const opened = openLiveView(
      url,
      "freebsd",
      {},
      recordingSpawn(7, recorded),
    );
    expect(opened).toBe(false);
    expect(recorded.calls).toEqual([]);
  });
});

describe("waitForLiveViewUrl", () => {
  it("returns the address a live daemon vouches for", async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "daemon.lock"), String(sleeperPid()));
    writeFileSync(join(dir, "port"), "4799");
    writeFileSync(join(dir, "token"), "test-token");
    await expect(waitForLiveViewUrl(dir, "s1", 2000)).resolves.toBe(url);
  });

  it("encodes the session id and the token in the address", async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "daemon.lock"), String(sleeperPid()));
    writeFileSync(join(dir, "port"), "4799");
    writeFileSync(join(dir, "token"), "t&k|^n");
    await expect(waitForLiveViewUrl(dir, "s&1", 2000)).resolves.toBe(
      "http://127.0.0.1:4799/#session/s%261&token=t%26k%7C%5En",
    );
  });

  it("never hands out an address vouched for by a dead pid", async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "daemon.lock"), "999999");
    writeFileSync(join(dir, "port"), "4799");
    writeFileSync(join(dir, "token"), "test-token");
    await expect(waitForLiveViewUrl(dir, "s1", 200)).resolves.toBeNull();
  });

  it("is null when no daemon is running", async () => {
    const dir = scratchDir();
    await expect(waitForLiveViewUrl(dir, "s1", 200)).resolves.toBeNull();
  });
});
