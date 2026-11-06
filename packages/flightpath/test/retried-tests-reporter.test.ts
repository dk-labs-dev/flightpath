import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, runCleanups } from "./support/cleanup.js";

// The reporter (scripts/retried-tests-reporter.mjs) is a plain
// module outside any TypeScript project, so the test loads it by
// URL and types what it uses, the way test/repo-path.test.ts loads
// its script.
const here = dirname(fileURLToPath(import.meta.url));
const reporterPath = join(
  here,
  "..",
  "..",
  "..",
  "scripts",
  "retried-tests-reporter.mjs",
);

type TaskResult = { state: string; retryCount?: number };
type Task = {
  type: string;
  name: string;
  result?: TaskResult;
  tasks?: Task[];
};
type ReporterInstance = { onFinished: (files: Task[]) => void };
const {
  default: RetriedTestsReporter,
}: { default: new () => ReporterInstance } = await import(
  pathToFileURL(reporterPath).href
);

const ENV_KEY = "FLIGHTPATH_RETRIED_TESTS_FILE";
const savedOut = process.env[ENV_KEY];

afterEach(async () => {
  if (savedOut === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedOut;
  }
  await runCleanups();
});

function testTask(name: string, result: TaskResult): Task {
  return { type: "test", name, result };
}

function suite(name: string, tasks: Task[]): Task {
  return { type: "suite", name, tasks };
}

function useOutFile(): string {
  const out = join(makeTempRoot("retried-tests-"), "retried-tests.txt");
  process.env[ENV_KEY] = out;
  return out;
}

describe("the retried-tests reporter", () => {
  it("lists a test that passed only on retry", () => {
    const out = useOutFile();
    new RetriedTestsReporter().onFinished([
      suite("test/example.test.ts", [
        testTask("passes on its retry", { state: "pass", retryCount: 1 }),
      ]),
    ]);
    expect(readFileSync(out, "utf8")).toBe(
      "- test/example.test.ts > passes on its retry\n",
    );
  });

  it("joins nested describe names into the listed name", () => {
    const out = useOutFile();
    new RetriedTestsReporter().onFinished([
      suite("test/example.test.ts", [
        suite("the outer describe", [
          suite("the inner describe", [
            testTask("passes on its retry", {
              state: "pass",
              retryCount: 2,
            }),
          ]),
        ]),
      ]),
    ]);
    expect(readFileSync(out, "utf8")).toBe(
      "- test/example.test.ts > the outer describe > the inner describe > passes on its retry\n",
    );
  });

  it("does not list a test that failed twice", () => {
    const out = useOutFile();
    new RetriedTestsReporter().onFinished([
      suite("test/example.test.ts", [
        testTask("fails on both attempts", { state: "fail", retryCount: 1 }),
      ]),
    ]);
    expect(existsSync(out)).toBe(false);
  });

  it("does not list a test that passed on its first attempt", () => {
    const out = useOutFile();
    new RetriedTestsReporter().onFinished([
      suite("test/example.test.ts", [
        testTask("passes at once", { state: "pass", retryCount: 0 }),
      ]),
    ]);
    expect(existsSync(out)).toBe(false);
  });

  it("writes nothing when the output variable is unset", () => {
    delete process.env[ENV_KEY];
    const reporter = new RetriedTestsReporter();
    expect(() =>
      reporter.onFinished([
        suite("test/example.test.ts", [
          testTask("passes on its retry", { state: "pass", retryCount: 1 }),
        ]),
      ]),
    ).not.toThrow();
  });

  it("names the retried test in a real run, and the run still fails when another test fails twice", () => {
    const root = writeFixture();
    const out = join(root, "retried-tests.txt");
    const vitest = join(here, "..", "node_modules", "vitest", "vitest.mjs");
    const result = spawnSync(process.execPath, [vitest, "run"], {
      cwd: root,
      env: {
        ...process.env,
        CI: "true",
        FIXTURE_DIR: root,
        FLIGHTPATH_RETRIED_TESTS_FILE: out,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const listed = readFileSync(out, "utf8");
    expect(listed).toContain("passes on its retry");
    expect(listed).not.toContain("fails on both attempts");
  }, 180_000);
});

// The fixture is a small suite of its own, run by a child Vitest
// with retry on: one test fails on its first attempt and passes on
// the retry, the other fails on both. It lives under the package's
// test folder while it runs so its "vitest" import resolves
// against the package's own modules.
function writeFixture(): string {
  const root = makeTempRoot("retried-tests-run-", here);
  writeFileSync(
    join(root, "vitest.config.mjs"),
    [
      "export default {",
      "  test: {",
      "    retry: 1,",
      `    reporters: ["default", ${JSON.stringify(reporterPath)}],`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "fixture.test.mjs"),
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import process from "node:process";',
      "",
      'import { describe, expect, test } from "vitest";',
      "",
      'const marker = join(process.env.FIXTURE_DIR, "attempted");',
      "",
      'describe("the demonstration suite", () => {',
      '  test("passes on its retry", () => {',
      "    if (!existsSync(marker)) {",
      '      writeFileSync(marker, "attempted");',
      '      expect("first attempt").toBe("the retry");',
      "    }",
      "  });",
      "",
      '  test("fails on both attempts", () => {',
      '    expect("first attempt").toBe("the retry");',
      "  });",
      "});",
      "",
    ].join("\n"),
  );
  return root;
}
