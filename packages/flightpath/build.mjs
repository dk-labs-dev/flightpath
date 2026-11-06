// Rebundles the entry points as single files, over the tsc
// output the build script just produced (the per-file output
// stays for everything else). The hook runs on every Claude Code
// event, and Node opening one file instead of a tree of modules
// is measurably faster — most of all on Windows, where each open
// costs the most.
import { build } from "esbuild";

// Runs before any of our code. A Node older than 24 exits quietly, so
// the notice's own line is the only thing the person sees. The bundles
// import only node: built-ins, which every Node has.
const nodeVersionGate = `if (Number(process.versions.node.split(".")[0]) < 24) { if (/notice\\.js$/.test(process.argv[1])) process.stdout.write(\`{"systemMessage":"● flightpath needs Node 24 or later; this is Node \${process.versions.node} · see Install in the README"}\\n\`); process.exit(0); }`;

await build({
  entryPoints: [
    "src/hook.ts",
    "src/daemon.ts",
    "src/command.ts",
    "src/notice.ts",
    "src/line.ts",
  ],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: nodeVersionGate },
});

// The submit entry loads the command handler only for a command,
// so the handler stays its own file instead of being bundled in.
await build({
  entryPoints: ["src/submit-command.ts", "src/command-handler.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["./command-handler.js"],
  banner: { js: nodeVersionGate },
});
