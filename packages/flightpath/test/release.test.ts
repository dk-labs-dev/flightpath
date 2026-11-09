import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// These tests cover the release tooling at the repository root: the
// channel a tag builds, the notes a version gets, and the exact set
// of files a release ships. The scripts are plain .mjs so the
// release workflow can run them before anything is installed; they
// are imported here by file URL, the way test/repo-path.test.ts
// imports scripts/repo-path.mjs.

const scriptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
);

type ReleasePlan = {
  tag: string;
  version: string;
  channel: string;
  branch: string;
  prerelease: boolean;
  zipName: string;
  marketplaceName: string;
};

type Marketplace = {
  name: string;
  description: string;
  owner: { name: string; url: string };
  plugins: {
    name: string;
    source: unknown;
    description: string;
    keywords: string[];
    homepage: string;
  }[];
};

const { planForTag }: { planForTag: (tag: string) => ReleasePlan } =
  await import(pathToFileURL(join(scriptsDir, "release-plan.mjs")).href);

const {
  notesForVersion,
}: {
  notesForVersion: (changelog: string, version: string) => string;
} = await import(pathToFileURL(join(scriptsDir, "release-notes.mjs")).href);

type ShippedPackageJson = {
  name: string;
  version: string;
  type: string;
  license: string;
};

const {
  pluginFiles,
  copyPlugin,
  shippedPackageJson,
  channelMarketplace,
  packageRelease,
}: {
  pluginFiles: (pluginDir: string) => string[];
  copyPlugin: (root: string, target: string) => string[];
  shippedPackageJson: (pluginDir: string) => ShippedPackageJson;
  channelMarketplace: (channel: string) => Marketplace;
  packageRelease: (root: string, target: string, channel: string) => string[];
} = await import(pathToFileURL(join(scriptsDir, "package-plugin.mjs")).href);

describe("release plans", () => {
  it("sends a plain tag to the stable channel", () => {
    expect(planForTag("v1.0.0")).toEqual({
      tag: "v1.0.0",
      version: "1.0.0",
      channel: "release",
      branch: "release",
      prerelease: false,
      zipName: "flightpath-1.0.0.zip",
      marketplaceName: "flightpath",
    });
  });

  it("sends a pre-release tag to the next channel", () => {
    const plan = planForTag("v1.0.0-rc.1");
    expect(plan.channel).toBe("next");
    expect(plan.branch).toBe("next");
    expect(plan.prerelease).toBe(true);
    expect(plan.zipName).toBe("flightpath-1.0.0-rc.1.zip");
    expect(plan.marketplaceName).toBe("flightpath-next");
  });

  it("treats any pre-release suffix as the next channel", () => {
    expect(planForTag("v0.9.9-beta.2").channel).toBe("next");
    expect(planForTag("v2.3.4-rc.12").prerelease).toBe(true);
  });

  it("refuses tags that are not versions", () => {
    for (const tag of ["1.0.0", "v1.0", "v1.0.0.1", "v1.0.0-", "release", ""]) {
      expect(() => planForTag(tag)).toThrow(/not a release tag/);
    }
  });
});

const CHANGELOG = [
  "# Changelog",
  "",
  "## 1.1.0-rc.1",
  "",
  "- A look at what is coming.",
  "",
  "## [1.0.0] - 2026-11-07",
  "",
  "- The first thing.",
  "- The second thing.",
  "",
  "## 0.9.0",
  "",
  "- An older thing.",
  "",
].join("\n");

describe("changelog notes", () => {
  it("takes the version's own section", () => {
    expect(notesForVersion(CHANGELOG, "1.0.0")).toBe(
      "- The first thing.\n- The second thing.",
    );
  });

  it("prefers an exact pre-release section over the base version's", () => {
    expect(notesForVersion(CHANGELOG, "1.1.0-rc.1")).toBe(
      "- A look at what is coming.",
    );
  });

  it("falls back to the base version for a pre-release without a section", () => {
    expect(notesForVersion(CHANGELOG, "1.0.0-rc.2")).toBe(
      "- The first thing.\n- The second thing.",
    );
  });

  it("refuses a version the changelog does not name", () => {
    expect(() => notesForVersion(CHANGELOG, "2.0.0")).toThrow(
      /no section for 2\.0\.0/,
    );
  });
});

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixtureRepo(withDist: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "flightpath-release-"));
  const plugin = join(root, "packages", "flightpath");
  write(join(plugin, ".claude-plugin", "plugin.json"), "{}");
  write(join(plugin, ".claude-plugin", "icon.png"), "");
  write(join(plugin, "hooks", "hooks.json"), "{}");
  write(join(plugin, "commands", "stop.md"), "");
  write(join(plugin, "scripts", "tool.mjs"), "");
  write(join(plugin, "src", "main.ts"), "");
  write(join(plugin, "test", "own.test.ts"), "");
  write(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "@flightpath/flightpath",
      version: "9.9.9",
      type: "module",
      license: "Apache-2.0",
      private: true,
      scripts: { build: "tsc" },
      devDependencies: { typescript: "^5.7.2" },
    }),
  );
  write(join(plugin, "build.mjs"), "");
  if (withDist) {
    write(join(plugin, "dist", "hook.js"), "");
  }
  write(join(root, "LICENSE"), "");
  write(join(root, "NOTICE"), "");
  write(join(root, "THIRD-PARTY-NOTICES"), "");
  return root;
}

describe("the plugin package", () => {
  it("ships the built plugin and the licence files, nothing else", () => {
    const root = fixtureRepo(true);
    const target = join(root, "out");
    expect(copyPlugin(root, target)).toEqual([
      ".claude-plugin/icon.png",
      ".claude-plugin/plugin.json",
      "LICENSE",
      "NOTICE",
      "THIRD-PARTY-NOTICES",
      "commands/stop.md",
      "dist/hook.js",
      "hooks/hooks.json",
      "package.json",
    ]);
    expect(existsSync(join(target, "dist", "hook.js"))).toBe(true);
    expect(existsSync(join(target, "LICENSE"))).toBe(true);
    expect(existsSync(join(target, "NOTICE"))).toBe(true);
    expect(existsSync(join(target, "THIRD-PARTY-NOTICES"))).toBe(true);
    expect(existsSync(join(target, "src"))).toBe(false);
  });

  it("writes a package.json with the package's name, version and licence, as a module", () => {
    const root = fixtureRepo(true);
    const target = join(root, "out");
    copyPlugin(root, target);
    const shipped = JSON.parse(
      readFileSync(join(target, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(shipped).toEqual({
      name: "@flightpath/flightpath",
      version: "9.9.9",
      type: "module",
      license: "Apache-2.0",
    });
    expect(shippedPackageJson(join(root, "packages", "flightpath"))).toEqual(
      shipped,
    );
  });

  it("refuses to package a tree that has not been built", () => {
    const root = fixtureRepo(false);
    expect(() => copyPlugin(root, join(root, "out"))).toThrow(/dist/);
  });

  it("matches the marketplace this repository ships", () => {
    const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = pluginFiles(pluginDir);
    for (const expected of [
      ".claude-plugin/icon.png",
      ".claude-plugin/plugin.json",
      "README.md",
      "hooks/hooks.json",
      "commands/stop.md",
    ]) {
      expect(files).toContain(expected);
    }
    for (const file of files) {
      expect(file.startsWith("src/")).toBe(false);
      expect(file.startsWith("test/")).toBe(false);
      expect(file.startsWith("scripts/")).toBe(false);
      expect(file.startsWith("node_modules/")).toBe(false);
    }
    for (const left of [
      "package.json",
      "build.mjs",
      "tsconfig.json",
      "tsconfig.build.json",
      "vitest.config.ts",
    ]) {
      expect(files).not.toContain(left);
    }
  });
});

function shippedMarketplace(): Marketplace {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return JSON.parse(
    readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
  ) as Marketplace;
}

describe("channel marketplaces", () => {
  it("names the stable channel's marketplace after the plugin", () => {
    const marketplace = channelMarketplace("release");
    expect(marketplace.name).toBe("flightpath");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "flightpath", source: "./flightpath" }),
    ]);
  });

  it("gives the next channel its own marketplace name", () => {
    expect(channelMarketplace("next").name).toBe("flightpath-next");
  });

  it("names the same owner as the marketplace this repository ships", () => {
    const shipped = shippedMarketplace();
    expect(channelMarketplace("release").owner).toEqual(shipped.owner);
    expect(channelMarketplace("next").owner).toEqual(shipped.owner);
  });

  it("lists the same entry fields as the marketplace this repository ships", () => {
    const shipped = shippedMarketplace();
    const channel = channelMarketplace("release");
    expect(channel.description).toBe(shipped.description);
    const { source: channelSource, ...channelEntry } = channel.plugins[0]!;
    const { source: shippedSource, ...shippedEntry } = shipped.plugins[0]!;
    expect(channelSource).toBe("./flightpath");
    expect(shippedSource).toMatchObject({ source: "git-subdir" });
    expect(channelEntry).toEqual(shippedEntry);
  });

  it("gives the entry a description, keywords and a homepage", () => {
    const entry = channelMarketplace("release").plugins[0]!;
    expect(entry.description).not.toBe("");
    expect(entry.keywords).toContain("claude-code");
    expect(entry.homepage).toBe("https://github.com/dk-labs-dev/flightpath");
  });

  it("refuses a channel it does not know", () => {
    expect(() => channelMarketplace("beta")).toThrow(/unknown channel/);
  });
});

describe("the packaged release folder", () => {
  it("holds the channel's marketplace file and the plugin under flightpath/", () => {
    const root = fixtureRepo(true);
    const target = join(root, "release-folder");
    expect(packageRelease(root, target, "next")).toEqual([
      ".claude-plugin/marketplace.json",
      "flightpath/.claude-plugin/icon.png",
      "flightpath/.claude-plugin/plugin.json",
      "flightpath/LICENSE",
      "flightpath/NOTICE",
      "flightpath/THIRD-PARTY-NOTICES",
      "flightpath/commands/stop.md",
      "flightpath/dist/hook.js",
      "flightpath/hooks/hooks.json",
      "flightpath/package.json",
    ]);
    const written = JSON.parse(
      readFileSync(join(target, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as Marketplace;
    expect(written.name).toBe("flightpath-next");
    expect(written.plugins[0]?.source).toBe("./flightpath");
  });
});

// The tests above check the file list; these run the packaged
// folder the way a user's machine does. A packaged plugin without
// a `package.json` of its own still lists the same files, but Node
// reparses its ES modules with a warning on every hook (and fails
// them outright under a `commonjs` package above), and the version
// it reports reads "unknown". Packaging this repository for real
// and running its entries is the only check that sees either.
describe("the packaged plugin, run as shipped", () => {
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );

  it("carries the package's version as a module, and its command entry runs clean", () => {
    const target = mkdtempSync(join(tmpdir(), "flightpath-packaged-"));
    packageRelease(repoRoot, target, "release");
    const plugin = join(target, "flightpath");
    const source = JSON.parse(
      readFileSync(
        join(repoRoot, "packages", "flightpath", "package.json"),
        "utf8",
      ),
    ) as ShippedPackageJson;
    expect(
      JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")),
    ).toEqual({
      name: source.name,
      version: source.version,
      type: "module",
      license: source.license,
    });
    expect(readFileSync(join(plugin, "THIRD-PARTY-NOTICES"), "utf8")).toBe(
      readFileSync(join(repoRoot, "THIRD-PARTY-NOTICES"), "utf8"),
    );

    const home = mkdtempSync(join(tmpdir(), "flightpath-packaged-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.XDG_DATA_HOME;
    const command = spawnSync(
      process.execPath,
      [join(plugin, "dist", "command.js")],
      {
        input: JSON.stringify({
          hook_event_name: "UserPromptExpansion",
          session_id: "s1",
          command_name: "flightpath:status",
          command_args: "",
        }),
        env,
        encoding: "utf8",
      },
    );
    expect(command.stderr).toBe("");
    expect(command.status).toBe(0);
    expect(command.stdout).toContain("flightpath is recording");

    const version = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { pluginVersion } from ${JSON.stringify(
          pathToFileURL(join(plugin, "dist", "version.js")).href,
        )}; process.stdout.write(pluginVersion());`,
      ],
      { encoding: "utf8" },
    );
    expect(version.stderr).toBe("");
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(source.version);

    const manifest = JSON.parse(
      readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { version: string; privacyPolicyUrl: string };
    expect(manifest.version).toBe(source.version);
    expect(manifest.privacyPolicyUrl).toMatch(/^https:\/\/.+\/privacy\.md$/);
  }, 60_000);
});
