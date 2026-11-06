// Extracts one version's section from CHANGELOG.md, for the GitHub
// release notes. A pre-release version with no section of its own
// falls back to its base version's section: `1.0.0-rc.1` releases
// carry the `1.0.0` notes until the plain release writes its own.

import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function notesForVersion(changelog, version) {
  const sections = splitSections(changelog);
  const exact = sections.get(version);
  if (exact !== undefined && exact !== "") {
    return exact;
  }
  const base = version.split("-")[0];
  if (base !== version) {
    const fallback = sections.get(base);
    if (fallback !== undefined && fallback !== "") {
      return fallback;
    }
  }
  throw new Error(`CHANGELOG.md has no section for ${version}`);
}

function splitSections(changelog) {
  const sections = new Map();
  let current = null;
  for (const line of changelog.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = headingVersion(heading[1]);
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  for (const [version, lines] of sections) {
    sections.set(version, lines.join("\n").trim());
  }
  return sections;
}

// Headings are written as `## 1.0.0` or `## [1.0.0] - 2026-11-07`;
// both name the version first.
function headingVersion(text) {
  const bracketed = /^\[(.+?)\]/.exec(text);
  if (bracketed !== null) {
    return bracketed[1];
  }
  return text.split(/\s+/)[0];
}

// Run directly, prints the section for the version named.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  const file = process.argv[3] ?? "CHANGELOG.md";
  if (version === undefined) {
    console.error(
      "usage: node scripts/release-notes.mjs <version> [changelog]",
    );
    process.exit(2);
  }
  console.log(notesForVersion(readFileSync(file, "utf8"), version));
}
