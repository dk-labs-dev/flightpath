import { readFileSync } from "node:fs";

// The plugin's version, from the package.json one level above
// this module's built output; "unknown" when it cannot be read.
export function pluginVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
