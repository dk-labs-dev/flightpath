// Assembles what a release ships: a marketplace folder holding the
// built plugin. At its root, `.claude-plugin/marketplace.json` names
// the channel's marketplace and points at the plugin folder beside
// it, `flightpath/`, which holds `packages/flightpath` as built
// (with `dist/`), without the sources, tests and tooling a user
// never runs, plus LICENSE, NOTICE and THIRD-PARTY-NOTICES from
// the repository root and a `package.json` written for the folder.
//
// The release workflow zips this folder for the GitHub release and
// commits the same folder to the channel branch, so the zip and the
// branch carry the same files. Unzipped, the folder is a marketplace
// a user can add as a local folder; on the branch, it is the
// marketplace the branch is added as.

import console from "node:console";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Top-level entries of packages/flightpath that stay behind: the
// sources and tests, and the files only the build reads.
const LEFT_BEHIND = new Set([
  "src",
  "test",
  "node_modules",
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "vitest.config.ts",
  "build.mjs",
]);

const CHANNELS = {
  release: { marketplaceName: "flightpath" },
  next: { marketplaceName: "flightpath-next" },
};

const PLUGIN_DESCRIPTION =
  "Records every Claude Code session live, draws the journey as a map, and coaches the next session.";

// The package-relative paths the plugin folder holds, sorted. Walks
// `pluginDir` as it stands: a tree that hasn't been built simply has
// no `dist/` entries in its list.
export function pluginFiles(pluginDir) {
  const files = [];
  collect(pluginDir, pluginDir, files);
  return files.sort();
}

function collect(dir, pluginDir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    if (dir === pluginDir && LEFT_BEHIND.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, pluginDir, files);
    } else if (entry.isFile()) {
      files.push(relative(pluginDir, path).split("\\").join("/"));
    }
  }
}

// The `package.json` the plugin folder ships: the package's own
// name, version and licence, and `"type": "module"`. The folder
// needs it — the bundles are ES modules, so Node must see that
// type in scope, and the reported version is read from this file.
export function shippedPackageJson(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  return {
    name: pkg.name,
    version: pkg.version,
    type: "module",
    license: pkg.license,
  };
}

// Copies the plugin folder under `root` into `target`, with the
// LICENSE, NOTICE and THIRD-PARTY-NOTICES from the repository root and
// the shipped `package.json` written into it. The tree must have been
// built first: without `dist/` the hooks have nothing to run, and
// packaging anyway would ship a plugin that cannot start.
export function copyPlugin(root, target) {
  const pluginDir = join(root, "packages", "flightpath");
  if (!existsSync(join(pluginDir, "dist"))) {
    throw new Error(
      "packages/flightpath/dist is missing: build before packaging",
    );
  }
  const files = pluginFiles(pluginDir);
  for (const file of files) {
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(pluginDir, file), destination);
  }
  for (const file of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"]) {
    cpSync(join(root, file), join(target, file));
  }
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify(shippedPackageJson(pluginDir), null, 2) + "\n",
  );
  return [
    ...files,
    "LICENSE",
    "NOTICE",
    "THIRD-PARTY-NOTICES",
    "package.json",
  ].sort();
}

// The marketplace file a channel carries. Its one entry resolves to
// the plugin folder beside it, and its owner is the one the
// marketplace on `main` names.
export function channelMarketplace(channel) {
  const known = CHANNELS[channel];
  if (known === undefined) {
    throw new Error(`unknown channel: "${channel}" (release or next)`);
  }
  return {
    name: known.marketplaceName,
    owner: { name: "dk-labs-dev" },
    plugins: [
      {
        name: "flightpath",
        source: "./flightpath",
        description: PLUGIN_DESCRIPTION,
      },
    ],
  };
}

// Builds the whole release folder in `target`: the marketplace file
// for the channel, and the plugin under `flightpath/`. Returns the
// folder's file list, sorted.
export function packageRelease(root, target, channel) {
  const marketplace = channelMarketplace(channel);
  const dir = join(target, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "marketplace.json"),
    JSON.stringify(marketplace, null, 2) + "\n",
  );
  const plugin = copyPlugin(root, join(target, "flightpath"));
  const files = plugin.map((file) => `flightpath/${file}`);
  files.push(".claude-plugin/marketplace.json");
  return files.sort();
}

// Run directly: node scripts/package-plugin.mjs <target> --channel <name>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const channelAt = process.argv.indexOf("--channel");
  const channel = channelAt === -1 ? undefined : process.argv[channelAt + 1];
  if (target === undefined || channel === undefined) {
    console.error(
      "usage: node scripts/package-plugin.mjs <target> --channel <name>",
    );
    process.exit(2);
  }
  const files = packageRelease(repoRoot, target, channel);
  console.log(`packaged ${files.length} files into ${target}`);
}
