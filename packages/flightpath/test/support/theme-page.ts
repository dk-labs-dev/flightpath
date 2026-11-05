import type { Browser, Page } from "playwright";

type PageOptions = Pick<
  NonNullable<Parameters<Browser["newPage"]>[0]>,
  "viewport" | "colorScheme"
>;

// The choice is planted before any page script runs,
// because the page's before-paint read is what applies it.
// The options set the window and the computer's own setting.
export async function newThemedPage(
  browser: Browser,
  theme: "light" | "dark",
  options: PageOptions = {},
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ...options,
  });
  await page.addInitScript((value: string) => {
    window.localStorage.setItem("flightpath-theme", value);
  }, theme);
  return page;
}

export function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  );
}

// Every token the root declares, as the colour it draws in the
// page's current theme. A token's own computed value is the
// light-dark() pair as written, so each is resolved through an
// element that paints with it.
export function resolvedTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const names = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .flatMap((rule) =>
        rule instanceof CSSStyleRule && rule.selectorText === ":root"
          ? Array.from(rule.style)
          : [],
      )
      .filter((name) => name.startsWith("--"));
    const probe = document.body.appendChild(document.createElement("span"));
    const resolved: Record<string, string> = {};
    for (const name of names) {
      probe.style.color = `var(${name})`;
      resolved[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return resolved;
  });
}
