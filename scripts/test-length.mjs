// Test length: fails any `it` or `test` body over 80 lines, because
// a test that long is checking more than one behavior. `describe`
// callbacks are exempt — they group, they don't assert.
//
// The check parses each test file with the TypeScript compiler and
// measures the line span of every `it`/`test` callback. The callback
// is found by type, not position, because a test may pass options
// before it or a timeout after it. A text scan would be shorter to
// write but miscounts braces inside strings and template literals,
// and a gate that cries wolf gets ignored; the compiler is already
// in the tree, so the parse costs nothing extra.
//
// Tests that already exceed the limit are listed in
// test-length-baseline.json with the line count they had when
// listed. A listed test fails only if it grows past that count; the
// list can only shrink.

import console from "node:console";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { toRepoPath } from "./repo-path.mjs";

const LIMIT = 80;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const testDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name, "test"))
  .filter((dir) => existsSync(dir));
const baseline = JSON.parse(
  readFileSync(join(root, "scripts", "test-length-baseline.json"), "utf8"),
);
const baselined = new Map(
  baseline.map((entry) => [`${entry.path}::${entry.name}`, entry.lines]),
);

function callbackSpan(node, source) {
  const name = node.expression.getText(source);
  if (!/^(it|test)(\.|$)/.test(name)) return;
  const callback = node.arguments
    .slice(1)
    .find((arg) => ts.isFunctionLike(arg));
  if (!callback) return;
  const title = node.arguments[0];
  const testName =
    ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)
      ? title.text
      : title.getText(source);
  const start = source.getLineAndCharacterOfPosition(callback.getStart(source));
  const end = source.getLineAndCharacterOfPosition(callback.getEnd());
  return { testName, lines: end.line - start.line + 1 };
}

let failures = 0;
for (const testDir of testDirs) {
  for (const file of readdirSync(testDir).sort()) {
    if (!file.endsWith(".test.ts")) continue;
    const path = join(testDir, file);
    const source = ts.createSourceFile(
      file,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const result = callbackSpan(node, source);
        if (result && result.lines > LIMIT) {
          const rel = toRepoPath(relative(root, path));
          const allowed = baselined.get(`${rel}::${result.testName}`);
          if (allowed === undefined || result.lines > allowed) {
            console.log(
              `${rel}: "${result.testName}" is ${result.lines} lines (limit ${LIMIT})`,
            );
            failures += 1;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
if (failures > 0) {
  console.log(
    "Test length: split the test so each one checks a single behavior.",
  );
  process.exit(1);
}
