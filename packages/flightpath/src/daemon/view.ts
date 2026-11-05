import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The built view lives in dist/view. Bundled, this module's code
// runs from dist/, so the view is ./view; from the source tree
// (the module's own tests), it is ../../dist/view. The first
// candidate that holds the built page wins.
export function viewDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "view"),
    join(here, "..", "..", "dist", "view"),
  ]) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

// A view file by its path under /view/: one file name, or one
// directory (fonts) and a file name. Anything else — parent
// references, nested paths, unknown extensions — is not served.
export function readViewFile(
  dir: string,
  name: string,
): { content: Buffer; contentType: string } | null {
  const parts = name.split("/");
  if (parts.length > 2) {
    return null;
  }
  for (const part of parts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) {
      return null;
    }
  }
  const extension = /\.[a-z0-9]+$/.exec(name)?.[0] ?? "";
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    return null;
  }
  const file = join(dir, ...parts);
  if (!existsSync(file)) {
    return null;
  }
  return { content: readFileSync(file), contentType };
}
