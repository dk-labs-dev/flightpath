// Rebundles the entry points as single files, over the tsc
// output the build script just produced (the per-file output
// stays for everything else). The hook runs on every Claude Code
// event, and Node opening one file instead of a tree of modules
// is measurably faster — most of all on Windows, where each open
// costs the most.
import { build } from "esbuild";

await build({
  entryPoints: [
    "src/hook.ts",
    "src/daemon.ts",
    "src/command.ts",
    "src/notice.ts",
  ],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
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
});
