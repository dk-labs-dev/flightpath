// Builds the view into the plugin's dist/view: an entry script
// and the chunks it loads on demand, and one stylesheet, their
// names carrying a build hash so a reload after a rebuild picks
// up the new files without a hard refresh. The page is rendered
// from its template with the hashed names filled in, and the
// fonts and the favicon are copied beside them. The daemon
// serves that directory with no change to its routes.
import console from "node:console";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

const viewPackage = dirname(fileURLToPath(import.meta.url));
const distView = join(viewPackage, "..", "flightpath", "dist", "view");

// The view directory is rebuilt from scratch: hashed names
// would otherwise accumulate one stale bundle per build.
rmSync(distView, { recursive: true, force: true });
const viewBuild = await build({
  entryPoints: [join(viewPackage, "src", "main.tsx")],
  outdir: distView,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  // The bundle is served as built, so it ships the production
  // React and minified: the development builds are several
  // times larger and carry warnings meant for authoring, not
  // for the page.
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  // Splitting puts each lazy screen in its own chunk beside the
  // entry, loaded only when the screen opens (ADR-0027).
  splitting: true,
  entryNames: "view-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "fonts/[name]-[hash]",
  loader: { ".woff2": "file" },
  metafile: true,
});
const outputs = Object.entries(viewBuild.metafile.outputs).map(
  ([path, output]) => ({
    name: path.split("/").pop(),
    bytes: output.bytes,
    entryPoint: output.entryPoint,
  }),
);
const viewJs = outputs.find((output) =>
  output.entryPoint?.endsWith("src/main.tsx"),
)?.name;
const viewCss = outputs.find((output) => output.name?.endsWith(".css"))?.name;
if (!viewJs || !viewCss) {
  throw new Error("the view build produced no script or stylesheet");
}
writeFileSync(
  join(distView, "index.html"),
  readFileSync(join(viewPackage, "src", "index.html"), "utf8")
    .replace("__VIEW_JS__", viewJs)
    .replace("__VIEW_CSS__", viewCss),
);
cpSync(
  join(viewPackage, "src", "fonts", "OFL.txt"),
  join(distView, "fonts", "OFL.txt"),
);
cpSync(join(viewPackage, "src", "favicon.svg"), join(distView, "favicon.svg"));

// Every script the build wrote, with its size as served and
// gzipped: a lazy screen shows here as its own chunk, so its
// cost is visible in the build output, not found later.
console.log("view build outputs:");
for (const output of outputs) {
  if (!output.name?.endsWith(".js")) continue;
  const gz = gzipSync(readFileSync(join(distView, output.name))).length;
  const from = output.entryPoint
    ? output.entryPoint.split("/").slice(-2).join("/")
    : "shared";
  console.log(
    `  ${output.name}  ${(output.bytes / 1024).toFixed(1)} KB (${(gz / 1024).toFixed(1)} KB gz)  ${from}`,
  );
}

// The largest modules in the entry script, so a dependency that
// grows it is visible in the build output, not found later.
const scriptKey = Object.keys(viewBuild.metafile.outputs).find((key) =>
  key.endsWith(viewJs),
);
const scriptOutput = scriptKey
  ? viewBuild.metafile.outputs[scriptKey]
  : undefined;
const largest = Object.entries(scriptOutput?.inputs ?? {})
  .map(([path, input]) => ({ path, bytes: input.bytesInOutput }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 5);
console.log("largest modules in the view script:");
for (const entry of largest) {
  console.log(`  ${(entry.bytes / 1024).toFixed(1)} KB  ${entry.path}`);
}
