import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page } from "playwright";
import { expect } from "vitest";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.js"),
  "utf8",
);

interface AxeViolation {
  id: string;
  help: string;
  impact?: string | null;
}

function seriousViolations(violations: readonly AxeViolation[]): string[] {
  return violations
    .filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    )
    .map((violation) => `${violation.id}: ${violation.help}`);
}

export async function expectAxeCleanOnPage(page: Page): Promise<void> {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    function hasAxeRun(
      value: unknown,
    ): value is { run: () => Promise<{ violations: AxeViolation[] }> } {
      return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "run") === "function"
      );
    }
    const axeValue: unknown = Reflect.get(window, "axe");
    if (!hasAxeRun(axeValue)) {
      throw new Error("axe-core did not load in the page");
    }
    const results = await axeValue.run();
    return results.violations;
  });
  expect(seriousViolations(violations)).toEqual([]);
}
