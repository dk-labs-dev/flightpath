import { describe, expect, it } from "vitest";

import { parseRoute, sessionHref } from "../src/route.js";

describe("the route parser", () => {
  it("opens the steps lens on the bare session address", () => {
    expect(parseRoute("#session/abc")).toEqual({
      screen: "session",
      id: "abc",
      lens: "steps",
      focus: {},
    });
  });

  it("reads each lens from its address", () => {
    expect(parseRoute("#session/abc/steps")).toMatchObject({ lens: "steps" });
    expect(parseRoute("#session/abc/tokens")).toMatchObject({
      lens: "tokens",
    });
    expect(parseRoute("#session/abc/snapshot")).toMatchObject({
      lens: "snapshot",
    });
  });

  it("reads a step focus from the query", () => {
    expect(parseRoute("#session/abc/tokens?step=12")).toMatchObject({
      lens: "tokens",
      focus: { step: 12 },
    });
  });

  it("ignores a step that isn't a number", () => {
    expect(parseRoute("#session/abc?step=x")).toMatchObject({ focus: {} });
    expect(parseRoute("#session/abc?step=")).toMatchObject({ focus: {} });
  });

  it("reads a request focus from the query, and ignores one that isn't a number", () => {
    expect(parseRoute("#session/abc/snapshot?request=41")).toMatchObject({
      lens: "snapshot",
      focus: { request: 41 },
    });
    expect(parseRoute("#session/abc/snapshot?request=x")).toMatchObject({
      focus: {},
    });
  });

  it("opens the steps lens for a lens it doesn't know", () => {
    expect(parseRoute("#session/abc/timeline")).toMatchObject({
      lens: "steps",
    });
  });

  it("keeps a rise and a rebuild in the route", () => {
    expect(parseRoute("#session/abc/steps?rise=rise-40")).toMatchObject({
      focus: { rise: "rise-40" },
    });
    expect(
      parseRoute("#session/abc/snapshot?step=3&rebuild=cmp-7"),
    ).toMatchObject({ focus: { step: 3, rebuild: "cmp-7" } });
  });

  it("parses the address with the access token still on it", () => {
    expect(parseRoute("#session/abc/tokens?step=12&token=sekret")).toEqual({
      screen: "session",
      id: "abc",
      lens: "tokens",
      focus: { step: 12 },
    });
    expect(parseRoute("#session/abc&token=sekret")).toMatchObject({
      screen: "session",
      id: "abc",
      lens: "steps",
    });
  });

  it("decodes the session id", () => {
    expect(parseRoute("#session/a%20b")).toMatchObject({ id: "a b" });
  });

  it("keeps the other screens' addresses", () => {
    expect(parseRoute("#sessions")).toEqual({ screen: "sessions" });
    expect(parseRoute("#settings")).toEqual({ screen: "settings" });
    expect(parseRoute("#settings?focus=port")).toEqual({
      screen: "settings",
    });
    expect(parseRoute("")).toEqual({ screen: "sessions" });
  });
});

describe("session addresses", () => {
  it("builds the bare address for the steps lens", () => {
    expect(sessionHref("abc")).toBe("#session/abc");
  });

  it("builds an address per lens", () => {
    expect(sessionHref("abc", "tokens")).toBe("#session/abc/tokens");
    expect(sessionHref("abc", "snapshot")).toBe("#session/abc/snapshot");
  });

  it("builds an address carrying a focus", () => {
    expect(sessionHref("abc", "steps", { step: 12 })).toBe(
      "#session/abc?step=12",
    );
    expect(sessionHref("abc", "snapshot", { step: 3, rise: "rise-40" })).toBe(
      "#session/abc/snapshot?step=3&rise=rise-40",
    );
  });

  it("builds addresses the parser reads back", () => {
    expect(parseRoute(sessionHref("a b", "tokens", { step: 7 }))).toEqual({
      screen: "session",
      id: "a b",
      lens: "tokens",
      focus: { step: 7 },
    });
    expect(
      parseRoute(sessionHref("abc", "snapshot", { request: 41 })),
    ).toMatchObject({ focus: { request: 41 } });
  });
});
