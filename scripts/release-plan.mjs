// Works out what a release tag builds. A plain version tag is the
// stable channel: it publishes to the `release` branch, which the
// marketplace entry in `.claude-plugin/marketplace.json` pins. A tag
// with a pre-release suffix (`v1.0.0-rc.1`) is the `next` channel: it
// publishes to the `next` branch and its GitHub release is a
// pre-release, so it never reaches a default install.

import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function planForTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(
      `not a release tag: "${tag}" (expected v<major>.<minor>.<patch>, with an optional pre-release suffix such as -rc.1)`,
    );
  }
  const version = tag.slice(1);
  const prerelease = match[4] !== undefined;
  const channel = prerelease ? "next" : "release";
  return {
    tag,
    version,
    channel,
    branch: channel,
    prerelease,
    zipName: `flightpath-${version}.zip`,
    marketplaceName: prerelease ? "flightpath-next" : "flightpath",
  };
}

// Run directly, prints the plan as JSON for the release workflow.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (tag === undefined) {
    console.error("usage: node scripts/release-plan.mjs <tag>");
    process.exit(2);
  }
  console.log(JSON.stringify(planForTag(tag), null, 2));
}
