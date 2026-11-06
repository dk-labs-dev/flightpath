import { afterEach, describe, expect, it } from "vitest";

import { sessionFindings } from "../src/api/index.js";
import type { Finding } from "../src/api/payloads.js";
import { runCleanups } from "./support/cleanup.js";
import { seedLoad, seedSession, seedTurn } from "./support/seed.js";
import { makeSeedWorld } from "./support/storage.js";

afterEach(async () => {
  await runCleanups();
});

type World = ReturnType<typeof makeSeedWorld>;

const SESSION = "sess-skills";

// Thirty-one skills over 18,039 characters: a large listing,
// under example names.
const LISTED = Array.from({ length: 31 }, (_, i) => `example-skill-${i + 1}`);
const LISTING_CHARS = 18_039;

function seedListing(
  world: World,
  overrides: { names?: string[] | null; at?: number; sizeBytes?: number } = {},
): void {
  const names = overrides.names === undefined ? LISTED : overrides.names;
  seedLoad(world.db, {
    sessionId: SESSION,
    kind: "skill-listing",
    source: "transcript",
    occurredAt: overrides.at ?? 100,
    sizeBytes: overrides.sizeBytes ?? LISTING_CHARS,
    itemCount: names?.length ?? null,
    names,
  });
}

function seedUse(
  world: World,
  name: string,
  trigger: "agent" | "user_slash" | null,
): void {
  seedLoad(world.db, {
    sessionId: SESSION,
    kind: "skill",
    name,
    trigger,
    source: trigger === null ? "telemetry" : "hook",
    occurredAt: 500,
  });
}

/** An ended session of one turn, with the listing of 31 skills. */
function endedWorld(): World {
  const world = makeSeedWorld("flightpath-skill-findings-");
  seedSession(world.db, { id: SESSION, status: "ended" });
  seedTurn(world.db, { id: 1, sessionId: SESSION });
  seedListing(world);
  return world;
}

function skillsFinding(world: World): Finding | undefined {
  const found = sessionFindings(world.storage, SESSION);
  if (found === undefined) throw new Error("session did not seed");
  expect(found.filter((finding) => finding.kind !== "skills-unused")).toEqual(
    [],
  );
  return found[0];
}

function seedContextReport(world: World, skills: number | null): void {
  world.db
    .prepare(
      "INSERT INTO context_reports (session_id, model, window, skills, reported_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(SESSION, "claude-sonnet-4-5", 200_000, skills, 300);
}

describe("skills listed and never used", () => {
  it("is one finding for a large skill listing, worded exactly", () => {
    expect(skillsFinding(endedWorld())).toEqual({
      id: "skills-unused",
      kind: "skills-unused",
      grade: "Did you know",
      at: 100,
      requestId: null,
      turnId: null,
      headline: "Turn off skills you don't use · about 6.2K tokens per request",
      body: "31 of 31 listed skills were never used this session. You could turn off the ones you don't need; /skill-doctor shows each skill's cost and use.",
      list: [
        "example-skill-1",
        "example-skill-10",
        "example-skill-11",
        "example-skill-12",
        "example-skill-13",
        "example-skill-14",
        "example-skill-15",
        "example-skill-16",
        "example-skill-17",
        "example-skill-18",
        "and 21 more",
      ],
      doc: {
        label: "Skills: find unused skills",
        url: "https://code.claude.com/docs/en/skills#find-unused-skills",
      },
      measure: { tokens: 6_221, basis: "estimated" },
      copy: null,
    });
  });

  it("lists every skill when ten or fewer are unused, in alphabetical order", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: ["zeta", "alpha", "mid"] });
    expect(skillsFinding(world)).toMatchObject({
      body: expect.stringMatching(/^3 of 3 listed skills were never used /),
      list: ["alpha", "mid", "zeta"],
    });
  });

  it("lists ten and counts the rest when eleven are unused", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, {
      names: Array.from({ length: 11 }, (_, i) => `skill-${i}`).reverse(),
    });
    expect(skillsFinding(world)?.list).toEqual([
      "skill-0",
      "skill-1",
      "skill-10",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "skill-6",
      "skill-7",
      "skill-8",
      "and 1 more",
    ]);
  });

  it("agrees with one skill", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: ["only-skill"] });
    expect(skillsFinding(world)).toMatchObject({
      body: expect.stringMatching(/^1 of 1 listed skill was never used /),
      list: ["only-skill"],
    });
  });

  it("leaves out a skill the model chose to use", () => {
    const world = endedWorld();
    seedUse(world, "example-skill-1", "agent");
    expect(skillsFinding(world)).toMatchObject({
      body: expect.stringMatching(/^30 of 31 /),
      list: expect.not.arrayContaining(["example-skill-1"]),
    });
  });

  it("leaves out a skill the person ran as a slash command", () => {
    const world = endedWorld();
    seedUse(world, "example-skill-1", "user_slash");
    expect(skillsFinding(world)).toMatchObject({
      body: expect.stringMatching(/^30 of 31 /),
      list: expect.not.arrayContaining(["example-skill-1"]),
    });
  });

  it("counts a skill used only after a second listing as used", () => {
    const world = endedWorld();
    seedListing(world, { at: 400 });
    seedUse(world, "example-skill-1", "agent");
    expect(skillsFinding(world)?.body).toMatch(/^30 of 31 /);
  });

  it("is no finding when every listed skill was used", () => {
    const world = endedWorld();
    for (const name of LISTED) seedUse(world, name, "agent");
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("builds from the earliest listing when three were sent", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: ["first-a", "first-b"], at: 100 });
    seedListing(world, { names: ["subagent-a"], at: 200 });
    seedListing(world, { names: ["after-compact-a"], at: 300 });
    expect(skillsFinding(world)).toMatchObject({
      at: 100,
      list: ["first-a", "first-b"],
    });
  });
});

describe("skills listed under a name that cannot be matched", () => {
  it("is silent when telemetry withheld the name of a skill that was used", () => {
    const world = endedWorld();
    seedUse(world, "custom_skill", null);
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("shows counts alone when a used name is not in the listing", () => {
    const world = endedWorld();
    seedUse(world, "example-plugin:example-skill-1", "user_slash");
    expect(skillsFinding(world)).toMatchObject({
      body: "At least 30 of 31 listed skills were never used this session. You could turn off the ones you don't need; /skill-doctor shows each skill's cost and use.",
      list: [],
    });
  });

  it("is silent when the unmatched names could account for every skill", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: ["a", "b"] });
    seedUse(world, "plugin:a", "agent");
    seedUse(world, "plugin:b", "agent");
    expect(skillsFinding(world)).toBeUndefined();
  });
});

describe("when the session has a listing to judge", () => {
  it("is silent when no listing was recorded", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("is silent for a listing stored before its names were kept", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: null });
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("is silent when the listing named no skills", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "ended" });
    seedListing(world, { names: [] });
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("is silent for a session recording joined partway", () => {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, {
      id: SESSION,
      status: "ended",
      joinedPartway: true,
    });
    seedListing(world);
    expect(skillsFinding(world)).toBeUndefined();
  });
});

describe("when a live session is far enough along", () => {
  function liveWorld(turns: { count: number; flightpathCommand?: boolean }) {
    const world = makeSeedWorld("flightpath-skill-findings-");
    seedSession(world.db, { id: SESSION, status: "live" });
    for (let sequence = 1; sequence <= turns.count; sequence += 1) {
      seedTurn(world.db, {
        sessionId: SESSION,
        sequence,
        flightpathCommand: turns.flightpathCommand ?? false,
      });
    }
    seedListing(world);
    return world;
  }

  it("is hidden under ten turns", () => {
    expect(skillsFinding(liveWorld({ count: 9 }))).toBeUndefined();
  });

  it("is shown at ten turns", () => {
    expect(skillsFinding(liveWorld({ count: 10 }))).toBeDefined();
  });

  it("does not count Flightpath's own command turns", () => {
    const world = liveWorld({ count: 12, flightpathCommand: true });
    expect(skillsFinding(world)).toBeUndefined();
  });

  it("is shown for an ended session of one turn", () => {
    expect(skillsFinding(endedWorld())).toBeDefined();
  });
});

describe("the size of the listing", () => {
  it("is the /context report's Skills row when there is one", () => {
    const world = endedWorld();
    seedContextReport(world, 5_100);
    expect(skillsFinding(world)).toMatchObject({
      headline: "Turn off skills you don't use · 5.1K tokens per request",
      measure: { tokens: 5_100, basis: "from-context" },
    });
  });

  it("is worked out from characters when the report has no Skills row", () => {
    const world = endedWorld();
    seedContextReport(world, null);
    expect(skillsFinding(world)).toMatchObject({
      measure: { tokens: 6_221, basis: "estimated" },
    });
  });
});

describe("the suggestion's text", () => {
  it("offers nothing to copy, since a setting may not reach plugin skills", () => {
    expect(skillsFinding(endedWorld())?.copy).toBeNull();
  });
});
