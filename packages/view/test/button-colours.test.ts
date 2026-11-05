import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface Rule {
  selectors: string[];
  properties: Set<string>;
  comment: string;
}

// A browser draws a button's text in its own colour, which follows
// the operating system rather than the theme, so every button that
// sets a background has to set its text colour too.
const NO_TEXT_REASON = /holds no text/;

function readRules(css: string): Rule[] {
  const pattern = /(?:\/\*([\s\S]*?)\*\/\s*)?([^{}/][^{}]*)\{([^{}]*)\}/g;
  return Array.from(css.matchAll(pattern), ([, comment, selector, body]) => ({
    selectors: (selector ?? "").split(",").map((part) => part.trim()),
    properties: new Set(
      (body ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(";")
        .map((declaration) => declaration.split(":")[0]?.trim() ?? ""),
    ),
    comment: comment ?? "",
  }));
}

// Only the literal class lists: the dynamic ones (a dialog's
// actions) are built from `btn` variants in their own module.
function buttonClassLists(source: string): string[] {
  const lists: string[] = [];
  for (const start of source.matchAll(/<button\b/g)) {
    let depth = 0;
    let end = start.index + start[0].length;
    while (depth > 0 || source[end] !== ">") {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
      end += 1;
    }
    const tag = source.slice(start.index, end);
    const literal = /className="([^"]*)"/.exec(tag);
    if (literal?.[1] !== undefined) lists.push(literal[1]);
  }
  return lists;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function rulesFor(rules: Rule[], className: string): Rule[] {
  const selectors = [`.${className}`, `button.${className}`];
  return rules.filter((rule) =>
    rule.selectors.some((selector) => selectors.includes(selector)),
  );
}

function paintsWithoutTextColour(rules: Rule[], classList: string): boolean {
  const own = classList
    .split(/\s+/)
    .flatMap((className) => rulesFor(rules, className));
  const has = (property: string): boolean =>
    own.some((rule) => rule.properties.has(property));
  const excused = own.some((rule) => NO_TEXT_REASON.test(rule.comment));
  return (
    (has("background") || has("background-color")) && !has("color") && !excused
  );
}

describe("button text colour", () => {
  const rules = readRules(readFileSync("src/view.css", "utf8"));
  const classLists = new Set(
    sourceFiles("src").flatMap((file) =>
      buttonClassLists(readFileSync(file, "utf8")),
    ),
  );

  it("finds the buttons it sweeps", () => {
    expect(classLists).toContain("btn");
    expect(classLists).toContain("btn snapshot-show-all");
    expect(classLists).toContain("switch");
  });

  it("gives every button with a background a text colour", () => {
    const offenders = [...classLists].filter((classList) =>
      paintsWithoutTextColour(rules, classList),
    );
    expect(offenders).toEqual([]);
  });
});
