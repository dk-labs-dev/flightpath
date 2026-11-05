import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The palette is kept beside this test as three blocks: the light
// values on the root, the dark values under the dark theme, and
// the same dark values again for a computer set to dark. The
// stylesheet writes each colour once, as a light-dark() pair.

// Tokens the stylesheet adds that the palette does not name, with
// their pairs. The switch's on track has its own token because the
// accent can be as dark as the page. A suggestion's grade has one
// per grade, so its colour can move without moving the warning
// colour it starts from, and the suggestion card's filled button
// has its own fill and text.
const ADDED: Record<string, { light: string; dark: string }> = {
  "--switch-on": { light: "#111111", dark: "#a3e635" },
  "--grade-fix": { light: "#8a4e00", dark: "#f0b25c" },
  "--grade-look": { light: "#8a4e00", dark: "#f0b25c" },
  "--grade-know": { light: "#525252", dark: "#a3a3a3" },
  "--primary-button": { light: "#111111", dark: "#a3e635" },
  "--on-primary-button": { light: "#ffffff", dark: "#000000" },
};

type Tokens = Map<string, string>;

function declarationsIn(body: string): Tokens {
  const tokens: Tokens = new Map();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

function blockBody(css: string, selector: string): string {
  const open = css.indexOf(`${selector} {`);
  if (open < 0) throw new Error(`no block for ${selector}`);
  const start = css.indexOf("{", open) + 1;
  let depth = 1;
  let end = start;
  while (depth > 0) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  }
  return css.slice(start, end - 1);
}

function splitPair(value: string): [string, string] {
  const inner = /^light-dark\((.*)\)$/s.exec(value)?.[1];
  if (inner === undefined) return [value, value];
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === "(") depth += 1;
    if (inner[index] === ")") depth -= 1;
    if (inner[index] === "," && depth === 0) {
      return [inner.slice(0, index).trim(), inner.slice(index + 1).trim()];
    }
  }
  throw new Error(`light-dark() without two values: ${value}`);
}

function expectedPair(
  name: string,
  light: string | undefined,
  dark: string | undefined,
): { light: string; dark: string } {
  const added = ADDED[name];
  if (added !== undefined) return added;
  if (light === undefined || dark === undefined) {
    throw new Error(`${name} is not in every block of the palette`);
  }
  return { light, dark };
}

describe("the stylesheet's colours", () => {
  const stylesheet = declarationsIn(
    blockBody(readFileSync("src/tokens.css", "utf8"), ":root"),
  );
  const palette = readFileSync("test/palette/palette.tokens.css", "utf8");
  const light = declarationsIn(blockBody(palette, ":root"));
  const dark = declarationsIn(blockBody(palette, ':root[data-theme="dark"]'));
  const system = declarationsIn(
    blockBody(palette, ':root:not([data-theme="light"])'),
  );

  it("reads the palette it is compared with", () => {
    expect(light.size).toBeGreaterThan(60);
    expect(dark.size).toBe(light.size);
  });

  it("gives a computer set to dark the palette's dark values", () => {
    expect(system).toEqual(dark);
  });

  it("holds exactly the palette's tokens and the ones it adds", () => {
    expect([...stylesheet.keys()].sort()).toEqual(
      [...light.keys(), ...Object.keys(ADDED)].sort(),
    );
  });

  it("holds each token's light and dark value as the palette has them", () => {
    const actual = [...stylesheet].map(([name, value]) => {
      const [lightValue, darkValue] = splitPair(value);
      return [name, { light: lightValue, dark: darkValue }];
    });
    const expected = [...stylesheet.keys()].map((name) => [
      name,
      expectedPair(name, light.get(name), dark.get(name)),
    ]);
    expect(actual).toEqual(expected);
  });

  it("writes a colour that is the same in both themes as one plain value", () => {
    const needless = [...stylesheet]
      .filter(([, value]) => value.startsWith("light-dark("))
      .filter(([, value]) => {
        const [lightValue, darkValue] = splitPair(value);
        return lightValue === darkValue;
      })
      .map(([name]) => name);
    expect(needless).toEqual([]);
  });
});
