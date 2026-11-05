import { describe, expect, it } from "vitest";

import { countLine, countWord } from "../src/counts.js";

// The shared count wording: a count agrees with its
// number — the singular only for exactly one — and the
// number is written with its separators.

describe("the count wording", () => {
  it("agrees with its number at 0, 1 and 2", () => {
    expect(countLine(0, "item", "items")).toBe("0 items");
    expect(countLine(1, "item", "items")).toBe("1 item");
    expect(countLine(2, "item", "items")).toBe("2 items");
  });

  it("writes a large count with its separators", () => {
    expect(countLine(1_200, "item", "items")).toBe("1,200 items");
  });

  it("chooses the word alone, the singular only for exactly one", () => {
    expect(countWord(0, "item", "items")).toBe("items");
    expect(countWord(1, "item", "items")).toBe("item");
    expect(countWord(2, "item", "items")).toBe("items");
  });
});
