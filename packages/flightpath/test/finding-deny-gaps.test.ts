import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dismissFinding, sessionFindings } from "../src/api/index.js";
import { denyGapWording } from "../src/api/finding-wording.js";
import type { Finding } from "../src/api/payloads.js";
import { CHARS_PER_TOKEN } from "../src/format.js";
import * as settingsFiles from "../src/settings-files.js";
import { makeTempRoot, runCleanups } from "./support/cleanup.js";
import {
  RISE_READ,
  RISE_SESSION,
  seedRiseRead,
} from "./support/measured-rise.js";
import { seedBranch, seedSession, seedStep } from "./support/seed.js";
import { makeSeedWorld } from "./support/storage.js";

vi.mock("../src/settings-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof settingsFiles>();
  return { ...original, readDenyRules: vi.fn(original.readDenyRules) };
});

const SESSION = "sess-deny";

let config: string;
let project: string;

beforeEach(() => {
  config = makeTempRoot("flightpath-config-");
  project = makeTempRoot("flightpath-project-");
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.mocked(settingsFiles.readDenyRules).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await runCleanups();
});

type World = ReturnType<typeof makeSeedWorld>;

/** The characters of a result that estimate to `tokens`. */
function charsFor(tokens: number): number {
  return Math.ceil((tokens - 1) * CHARS_PER_TOKEN) + 1;
}

function newWorld(projectPath: string | null = project): World {
  const world = makeSeedWorld("flightpath-deny-gaps-");
  seedSession(world.db, { id: SESSION, projectPath });
  return world;
}

let nextStep = 1;

/** A Read of `path` whose result was `tokens` long by estimate. */
function seedRead(
  world: World,
  path: string,
  options: { tokens?: number; outcome?: string } = {},
): void {
  seedStep(world.db, {
    id: nextStep++,
    sessionId: SESSION,
    toolName: "Read",
    input: { file_path: path },
    outcome: options.outcome ?? "succeeded",
    startedAt: 1_000,
    resultSize: charsFor(options.tokens ?? 10_000),
  });
}

const inProject = (...parts: string[]) => join(project, ...parts);

function findingsOf(world: World): Finding[] {
  const found = sessionFindings(world.storage, SESSION);
  if (found === undefined) throw new Error("session did not seed");
  return found;
}

function writeProjectSettings(contents: string): void {
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), contents);
}

const denying = (...rules: string[]) =>
  JSON.stringify({ permissions: { deny: rules } });

describe("which reads are rarely worth the space", () => {
  it.each([
    ["node_modules/left-pad/index.js", "Read(**/node_modules/**)"],
    ["web/node_modules/left-pad/index.js", "Read(**/node_modules/**)"],
    [".venv/lib/site.py", "Read(**/.venv/**)"],
    ["venv/lib/site.py", "Read(**/venv/**)"],
    ["dist/main.js", "Read(**/dist/**)"],
    ["build/index.html", "Read(**/build/**)"],
    [".next/server/page.js", "Read(**/.next/**)"],
    [".nuxt/app.js", "Read(**/.nuxt/**)"],
    ["pkg/__pycache__/mod.pyc", "Read(**/__pycache__/**)"],
    ["coverage/lcov.info", "Read(**/coverage/**)"],
    ["package-lock.json", "Read(**/package-lock.json)"],
    ["pnpm-lock.yaml", "Read(**/pnpm-lock.yaml)"],
    ["yarn.lock", "Read(**/yarn.lock)"],
    ["bun.lock", "Read(**/bun.lock)"],
    ["poetry.lock", "Read(**/poetry.lock)"],
    ["Pipfile.lock", "Read(**/Pipfile.lock)"],
    ["Gemfile.lock", "Read(**/Gemfile.lock)"],
    ["composer.lock", "Read(**/composer.lock)"],
    ["Cargo.lock", "Read(**/Cargo.lock)"],
    ["go.sum", "Read(**/go.sum)"],
    ["static/app.min.js", "Read(**/*.min.js)"],
    ["static/app.min.css", "Read(**/*.min.css)"],
    ["static/app.js.map", "Read(**/*.map)"],
    ["packages/api/yarn.lock", "Read(**/yarn.lock)"],
  ])("%s is suggested as %s", (relative, rule) => {
    const world = newWorld();
    seedRead(world, inProject(...relative.split("/")));
    expect(findingsOf(world).map((finding) => finding.copy)).toEqual([
      `"${rule}"`,
    ]);
  });

  it.each([
    "vendor/lib/util.go",
    "target/debug/app.rs",
    "out/report.txt",
    "src/build.ts",
    "src/distance/route.js",
    "docs/lockfile.md",
    "static/app.js",
    "src/mapper.ts",
  ])("%s is not", (relative) => {
    const world = newWorld();
    seedRead(world, inProject(...relative.split("/")));
    expect(findingsOf(world)).toEqual([]);
  });

  it("looks only below the project, so a project inside a build folder is no gap", () => {
    const inBuild = join(makeTempRoot("flightpath-outer-"), "build", "app");
    mkdirSync(inBuild, { recursive: true });
    const world = newWorld(inBuild);
    seedRead(world, join(inBuild, "src", "main.ts"));
    expect(findingsOf(world)).toEqual([]);
  });

  it("reads Windows paths with backslashes", () => {
    const world = newWorld("C:\\work\\app");
    seedRead(world, "C:\\work\\app\\node_modules\\left-pad\\index.js");
    expect(findingsOf(world).map((finding) => finding.copy)).toEqual([
      '"Read(**/node_modules/**)"',
    ]);
  });
});

describe("which reads count", () => {
  it("counts a read below the project", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"));
    expect(findingsOf(world)).toHaveLength(1);
  });

  it("ignores a read outside the project", () => {
    const world = newWorld();
    seedRead(
      world,
      join(makeTempRoot("flightpath-other-"), "node_modules", "a.js"),
    );
    expect(findingsOf(world)).toEqual([]);
  });

  it("ignores a read in a folder whose name only starts like the project's", () => {
    const world = newWorld();
    seedRead(world, `${project}-copy/node_modules/a.js`);
    expect(findingsOf(world)).toEqual([]);
  });

  it("ignores a read that failed", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"), {
      outcome: "failed",
    });
    expect(findingsOf(world)).toEqual([]);
  });

  it("counts a file read twice both times", () => {
    const world = newWorld();
    seedRead(world, inProject("pnpm-lock.yaml"), { tokens: 3_000 });
    seedRead(world, inProject("pnpm-lock.yaml"), { tokens: 3_000 });
    expect(findingsOf(world).map((finding) => finding.measure.tokens)).toEqual([
      6_000,
    ]);
  });

  it("says nothing for a session with no project path", () => {
    const world = newWorld(null);
    seedRead(world, "/anywhere/node_modules/a.js");
    expect(findingsOf(world)).toEqual([]);
  });
});

describe("rules that cover a read", () => {
  const candidate = (world: World) =>
    seedRead(world, inProject("node_modules", "a", "index.js"));

  it("silence the folder they name", () => {
    const world = newWorld();
    candidate(world);
    writeProjectSettings(denying("Read(./node_modules/**)"));
    expect(findingsOf(world)).toEqual([]);
  });

  it("silence a file they name", () => {
    const world = newWorld();
    seedRead(world, inProject("yarn.lock"));
    writeProjectSettings(denying("Read(**/yarn.lock)"));
    expect(findingsOf(world)).toEqual([]);
  });

  it("silence a suffix they name", () => {
    const world = newWorld();
    seedRead(world, inProject("static", "app.js.map"));
    writeProjectSettings(denying("Read(**/*.map)"));
    expect(findingsOf(world)).toEqual([]);
  });

  it.each(["Read", "Read(*)"])(
    "silence every read when a rule is %s",
    (rule) => {
      const world = newWorld();
      candidate(world);
      seedRead(world, inProject("yarn.lock"));
      writeProjectSettings(denying(rule));
      expect(findingsOf(world)).toEqual([]);
    },
  );

  it("leave the places they do not name", () => {
    const world = newWorld();
    candidate(world);
    seedRead(world, inProject("dist", "main.js"));
    writeProjectSettings(denying("Read(**/dist/**)"));
    expect(findingsOf(world).map((finding) => finding.copy)).toEqual([
      '"Read(**/node_modules/**)"',
    ]);
  });

  it("count when they are in the user's settings", () => {
    const world = newWorld();
    candidate(world);
    writeFileSync(
      join(config, "settings.json"),
      denying("Read(**/node_modules/**)"),
    );
    expect(findingsOf(world)).toEqual([]);
  });

  it("count when they are added after the first look", () => {
    const world = newWorld();
    candidate(world);
    expect(findingsOf(world)).toHaveLength(1);
    writeProjectSettings(denying("Read(**/node_modules/**)"));
    expect(findingsOf(world)).toEqual([]);
  });

  it("are unknown when a settings file is malformed, so nothing is said", () => {
    const world = newWorld();
    candidate(world);
    writeProjectSettings("{ not json");
    expect(findingsOf(world)).toEqual([]);
  });
});

describe("reading the settings", () => {
  it("happens only when a read could be a gap", () => {
    const world = newWorld();
    seedRead(world, inProject("src", "main.ts"));
    findingsOf(world);
    expect(settingsFiles.readDenyRules).not.toHaveBeenCalled();
  });

  it("happens once for a read that could be", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"));
    findingsOf(world);
    expect(settingsFiles.readDenyRules).toHaveBeenCalledTimes(1);
  });
});

describe("how much was read", () => {
  const readOf = (world: World, tokens: number) =>
    seedRead(world, inProject("node_modules", "a", "index.js"), { tokens });

  it("gives nothing at 4,999 tokens", () => {
    const world = newWorld();
    readOf(world, 4_999);
    expect(findingsOf(world)).toEqual([]);
  });

  it("is Worth a look at 5,000 tokens", () => {
    const world = newWorld();
    readOf(world, 5_000);
    expect(findingsOf(world).map((f) => [f.grade, f.measure.tokens])).toEqual([
      ["Worth a look", 5_000],
    ]);
  });

  it("is still Worth a look at 24,999 tokens", () => {
    const world = newWorld();
    readOf(world, 24_999);
    expect(findingsOf(world).map((finding) => finding.grade)).toEqual([
      "Worth a look",
    ]);
  });

  it("is Worth fixing at 25,000 tokens", () => {
    const world = newWorld();
    readOf(world, 25_000);
    expect(findingsOf(world).map((finding) => finding.grade)).toEqual([
      "Worth fixing",
    ]);
  });

  it("adds up the reads of all places", () => {
    const world = newWorld();
    readOf(world, 3_000);
    seedRead(world, inProject("pnpm-lock.yaml"), { tokens: 2_000 });
    expect(findingsOf(world).map((finding) => finding.measure.tokens)).toEqual([
      5_000,
    ]);
  });

  it("does not count a read a rule covers", () => {
    const world = newWorld();
    readOf(world, 4_000);
    seedRead(world, inProject("pnpm-lock.yaml"), { tokens: 2_000 });
    writeProjectSettings(denying("Read(**/pnpm-lock.yaml)"));
    expect(findingsOf(world)).toEqual([]);
  });
});

describe("how the size is known", () => {
  function moveRiseReadIntoGap(world: World): void {
    world.db
      .prepare("UPDATE steps SET input_summary = ? WHERE id = 1")
      .run(
        JSON.stringify({ file_path: inProject("node_modules", "data.csv") }),
      );
  }

  function riseWorld(): World {
    const world = makeSeedWorld("flightpath-deny-gaps-");
    seedRiseRead(world.db, RISE_SESSION);
    world.db
      .prepare("UPDATE sessions SET project_path = ? WHERE id = ?")
      .run(project, RISE_SESSION);
    moveRiseReadIntoGap(world);
    return world;
  }

  it("is the measured rise when the read has one", () => {
    const world = riseWorld();
    const [finding] = sessionFindings(world.storage, RISE_SESSION) ?? [];
    expect(finding?.measure).toEqual({
      tokens: RISE_READ.measuredTokens,
      basis: "measured",
    });
    expect(finding?.headline).toBe(
      "Block reads of node_modules · 23.6K tokens read in this session",
    );
  });

  it("is the measured rise when a subagent made the read", () => {
    const world = riseWorld();
    seedBranch(world.db, { id: 1, sessionId: RISE_SESSION });
    world.db.prepare("UPDATE requests SET branch_id = 1").run();
    world.db.prepare("UPDATE steps SET branch_id = 1").run();
    const [finding] = sessionFindings(world.storage, RISE_SESSION) ?? [];
    expect(finding?.measure.basis).toBe("measured");
  });

  it("is an estimate, labelled about, when it was not measured", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"), {
      tokens: 12_693,
    });
    const [finding] = findingsOf(world);
    expect(finding?.measure).toEqual({ tokens: 12_693, basis: "estimated" });
    expect(finding?.headline).toBe(
      "Block reads of node_modules · about 12.7K tokens read in this session",
    );
  });

  it("is an estimate when only some of the reads were measured", () => {
    const world = riseWorld();
    seedStep(world.db, {
      id: 2,
      sessionId: RISE_SESSION,
      toolName: "Read",
      input: { file_path: inProject("dist", "main.js") },
      startedAt: 3_000,
      resultSize: charsFor(1_000),
    });
    const [finding] = sessionFindings(world.storage, RISE_SESSION) ?? [];
    expect(finding?.measure).toEqual({
      tokens: RISE_READ.measuredTokens + 1_000,
      basis: "estimated",
    });
  });
});

describe("the suggestion", () => {
  it("names each place and gives a line to paste for each", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"));
    seedRead(world, inProject("node_modules", "b", "index.js"));
    seedRead(world, inProject("pnpm-lock.yaml"));
    seedRead(world, inProject("dist", "main.js"));
    seedRead(world, inProject("static", "app.min.js"));
    seedRead(world, inProject("static", "app.js.map"));
    const [finding] = findingsOf(world);
    expect(finding?.headline).toBe(
      "Block reads of node_modules, lockfiles, dist, and minified files and source maps · about 60.0K tokens read in this session",
    );
    expect(finding?.list).toEqual([
      "node_modules",
      "pnpm-lock.yaml",
      "dist",
      ".min.js",
      ".map",
    ]);
    expect(finding?.copy).toBe(
      [
        '"Read(**/node_modules/**)"',
        '"Read(**/pnpm-lock.yaml)"',
        '"Read(**/dist/**)"',
        '"Read(**/*.min.js)"',
        '"Read(**/*.map)"',
      ].join(",\n"),
    );
  });

  it("says what was read, what could be done and what a deny also blocks", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"));
    expect(findingsOf(world)).toEqual([
      {
        id: "deny-gaps",
        kind: "deny-gap",
        grade: "Worth a look",
        at: 1_000,
        requestId: null,
        turnId: null,
        headline:
          "Block reads of node_modules · about 10.0K tokens read in this session",
        body: "Claude read files here that are rarely worth the space. You could add a deny rule so it skips them. A Read deny also blocks edits and writes in those places.",
        list: ["node_modules"],
        doc: {
          label: "Permissions: read and edit rules",
          url: "https://code.claude.com/docs/en/permissions#read-and-edit",
        },
        measure: { tokens: 10_000, basis: "estimated" },
        copy: '"Read(**/node_modules/**)"',
      },
    ]);
  });

  it("links the permissions page the wording was checked against", () => {
    const wording = denyGapWording({
      tokens: 10_000,
      basis: "measured",
      groups: ["dist"],
      names: ["dist"],
      rules: ["Read(**/dist/**)"],
    });
    expect(wording.doc.url).toBe(
      "https://code.claude.com/docs/en/permissions#read-and-edit",
    );
  });

  it("stays dismissed once dismissed", () => {
    const world = newWorld();
    seedRead(world, inProject("node_modules", "a", "index.js"));
    expect(dismissFinding(world.storage, SESSION, "deny-gaps")).toBe(true);
    expect(findingsOf(world)).toEqual([]);
  });
});
