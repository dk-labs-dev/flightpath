import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// A var() naming a token that does not exist draws nothing and fails no
// other check. These are set by a component's own style, not the stylesheet.
const SET_BY_SCRIPT = new Set([
  "--steps-basis",
  "--steps-reserve",
  "--tokens-tooltip-width",
]);

function names(css: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(css.matchAll(pattern), (match) => match[1] ?? ""));
}

describe("the stylesheet's custom properties", () => {
  const tokens = readFileSync("src/tokens.css", "utf8");
  const view = readFileSync("src/view.css", "utf8");
  const defined = names(`${tokens}\n${view}`, /(--[\w-]+)\s*:/g);
  const used = names(view, /var\((--[\w-]+)/g);

  it("finds the properties it checks", () => {
    expect(used.size).toBeGreaterThan(50);
    expect(defined.size).toBeGreaterThan(50);
  });

  it("names a defined property in every var()", () => {
    const missing = [...used].filter(
      (name) => !defined.has(name) && !SET_BY_SCRIPT.has(name),
    );
    expect(missing).toEqual([]);
  });
});
