import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { terminalLine } from "../src/api/terminal-line.js";
import type { Finding, FindingGrade } from "../src/api/payloads.js";
import { runCleanups } from "./support/cleanup.js";
import { callDaemon, type StartedDaemon } from "./support/daemon.js";
import { LINE_WORLD, startLineDaemon } from "./support/line-world.js";

const TURN = 7;

function finding(grade: FindingGrade, turnId: number | null = TURN): Finding {
  return {
    id: "rebuild-1",
    kind: "expired",
    grade,
    at: 0,
    requestId: 1,
    turnId,
    headline: "",
    body: "",
    list: [],
    doc: { label: "", url: "" },
    measure: { tokens: 1, basis: "measured" },
    copy: null,
  };
}

const fix = finding("Worth fixing");
const look = finding("Worth a look");

describe("the end-of-turn line's wording", () => {
  const OPEN = "/flightpath:open";
  const rows: [string, Finding[], string][] = [
    [
      "one worth fixing",
      [fix],
      `● flightpath has 1 suggestion worth fixing from this turn · ${OPEN} to see it`,
    ],
    [
      "one worth a look",
      [look],
      `● flightpath has 1 suggestion worth a look from this turn · ${OPEN} to see it`,
    ],
    [
      "three, one worth fixing",
      [look, fix, look],
      `● flightpath has 3 suggestions from this turn, 1 worth fixing · ${OPEN} to see them`,
    ],
    [
      "two, both worth fixing",
      [fix, fix],
      `● flightpath has 2 suggestions from this turn, 2 worth fixing · ${OPEN} to see them`,
    ],
    [
      "two, none worth fixing",
      [look, look],
      `● flightpath has 2 suggestions from this turn, all worth a look · ${OPEN} to see them`,
    ],
  ];

  it.each(rows)("words %s", (_name, findings, line) => {
    expect(terminalLine(findings, TURN)).toBe(line);
  });

  it("says nothing when there are no findings", () => {
    expect(terminalLine([], TURN)).toBeNull();
  });
});

describe("the findings the end-of-turn line counts", () => {
  it("leaves out a Did you know finding", () => {
    expect(terminalLine([finding("Did you know")], TURN)).toBeNull();
    expect(terminalLine([finding("Did you know"), look], TURN)).toBe(
      terminalLine([look], TURN),
    );
  });

  it("leaves out a finding about another turn", () => {
    expect(terminalLine([finding("Worth fixing", TURN + 1)], TURN)).toBeNull();
  });

  it("leaves out a finding about the session as a whole", () => {
    expect(terminalLine([finding("Worth fixing", null)], TURN)).toBeNull();
  });
});

describe("the end-of-turn line's route", () => {
  let daemon: StartedDaemon;

  beforeAll(async () => {
    daemon = await startLineDaemon();
  }, 30_000);

  afterAll(async () => {
    await runCleanups();
  });

  const ask = (sessionId: string, query: string, token = daemon.token) =>
    callDaemon(daemon.port, {
      method: "GET",
      path: `/api/sessions/${sessionId}/terminal-line${query}`,
      token,
    });

  async function lineFor(sessionId: string, promptId: string) {
    const reply = await ask(sessionId, `?prompt=${promptId}`);
    expect(reply.status).toBe(200);
    return (JSON.parse(reply.body) as { line: string | null }).line;
  }

  const { mixed, several, outsideTurn } = LINE_WORLD;

  it("words the finding of the turn that ended", async () => {
    expect(await lineFor(mixed.id, mixed.lookPrompt)).toContain(
      "1 suggestion worth a look from this turn",
    );
    expect(await lineFor(mixed.id, mixed.fixPrompt)).toContain(
      "1 suggestion worth fixing from this turn",
    );
  });

  it("counts every finding of the turn", async () => {
    expect(await lineFor(several.id, several.prompt)).toContain(
      "2 suggestions from this turn, 1 worth fixing",
    );
  });

  it("answers null for a turn with no finding", async () => {
    expect(await lineFor(mixed.id, mixed.cleanPrompt)).toBeNull();
  });

  it("answers null for a prompt the session has no turn for, or none at all", async () => {
    expect(await lineFor(mixed.id, "prompt-unknown")).toBeNull();
    const reply = await ask(mixed.id, "");
    expect(JSON.parse(reply.body)).toEqual({ line: null });
  });

  it("answers null for a finding on a request outside any turn", async () => {
    expect(await lineFor(outsideTurn.id, outsideTurn.prompt)).toBeNull();
  });

  it("answers the same line when asked again", async () => {
    const first = await lineFor(mixed.id, mixed.fixPrompt);
    expect(await lineFor(mixed.id, mixed.fixPrompt)).toBe(first);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await ask("sess-nope", "?prompt=prompt-fix")).status).toBe(404);
  });

  it("requires the token", async () => {
    const query = `?prompt=${mixed.fixPrompt}`;
    expect((await ask(mixed.id, query, "not-the-token")).status).toBe(401);
    const reply = await callDaemon(daemon.port, {
      method: "GET",
      path: `/api/sessions/${mixed.id}/terminal-line${query}`,
    });
    expect(reply.status).toBe(401);
  });
});
