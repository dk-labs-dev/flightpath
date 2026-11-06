// The only place finding sentences and doc links live. The
// panel and the terminal line read these strings from the API
// and write none of their own. Every suggestion says "could":
// whether a change would have saved the write is not known.

import { formatDuration, formatTokens } from "../format.js";
import type { Finding } from "./payloads.js";

type FindingWording = Pick<
  Finding,
  "headline" | "body" | "list" | "more" | "doc" | "copy"
>;

const EXPIRED_DOC = {
  label: "Prompt caching: how long the cache lasts",
  url: "https://code.claude.com/docs/en/prompt-caching#cache-lifetime",
};
const MODEL_DOC = {
  label: "Prompt caching: switching models",
  url: "https://code.claude.com/docs/en/prompt-caching#switching-models",
};
const EFFORT_DOC = {
  label: "Prompt caching: changing the effort level",
  url: "https://code.claude.com/docs/en/prompt-caching#changing-effort-level",
};
const TOOLS_DOC = {
  label: "Prompt caching: connecting or removing an MCP server",
  url: "https://code.claude.com/docs/en/prompt-caching#connecting-or-removing-an-mcp-server",
};

const INSTRUCTIONS_DOC = {
  label: "Costs: move instructions from CLAUDE.md to skills",
  url: "https://code.claude.com/docs/en/costs#move-instructions-from-claude-md-to-skills",
};

const SKILLS_DOC = {
  label: "Skills: find unused skills",
  url: "https://code.claude.com/docs/en/skills#find-unused-skills",
};

// Past this many, the rest wait behind a control, so the card
// stays one a person reads at a glance.
const MAX_NAMED_SKILLS = 10;

export function expiredWording(rebuild: {
  tokens: number;
  gapMinutes: number;
}): FindingWording {
  const written = formatTokens(rebuild.tokens);
  const gap = formatDuration(rebuild.gapMinutes * 60_000);
  return {
    headline: `Compact before a long break · ${written} written again after ${gap} away`,
    body: "The cache had expired, so the next message wrote the conversation again. You could run /compact before stepping away, or start a fresh session if you are not coming back to this work.",
    list: [],
    more: [],
    doc: EXPIRED_DOC,
    copy: null,
  };
}

export function modelWording(rebuild: {
  tokens: number;
  from: string;
  to: string;
}): FindingWording {
  return {
    headline: `Pick your model at the start of a session · ${formatTokens(rebuild.tokens)} written again after the switch`,
    body: `Switching from ${rebuild.from} to ${rebuild.to} could not reuse the cache, so the conversation was written again. You could choose the model before the first message.`,
    list: [],
    more: [],
    doc: MODEL_DOC,
    copy: null,
  };
}

export function effortWording(rebuild: {
  tokens: number;
  from: string;
  to: string;
  model: string;
}): FindingWording {
  return {
    headline: `Set effort at the start of a session · ${formatTokens(rebuild.tokens)} written again after the change`,
    body: `Changing effort from ${rebuild.from} to ${rebuild.to} on ${rebuild.model} started the cache over. You could pick it before the first message.`,
    list: [],
    more: [],
    doc: EFFORT_DOC,
    copy: null,
  };
}

export function toolsWording(rebuild: {
  tokens: number;
  servers: string[];
}): FindingWording {
  const servers = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(rebuild.servers);
  return {
    headline: `Add or remove tool servers at the start of a session · ${formatTokens(rebuild.tokens)} written again after ${servers} changed`,
    body: "Changing the tool list started the cache over. You could connect the servers you need before the first message.",
    list: [],
    more: [],
    doc: TOOLS_DOC,
    copy: null,
  };
}

/** One instruction file in a finding's list; null when its size
 * was not recorded. */
export interface ListedFile {
  path: string;
  tokens: number | null;
}

function listedFile({ path, tokens }: ListedFile): string {
  return tokens === null
    ? `${path} · size not recorded`
    : `${path} · about ${formatTokens(tokens)}`;
}

export function instructionsWording(startup: {
  tokens: number;
  estimated: boolean;
  files: ListedFile[];
  rest: ListedFile[];
}): FindingWording {
  const count = startup.files.length + startup.rest.length;
  const size = `${startup.estimated ? "about " : ""}${formatTokens(startup.tokens)}`;
  return {
    headline: `Trim the files Claude reads at the start of every session · ${size} across ${count} ${count === 1 ? "file" : "files"}`,
    body: "Always-loaded instruction files are sent with every request. You could move rarely needed parts into skills, which load only when used.",
    list: startup.files.map(listedFile),
    more: startup.rest.map(listedFile),
    doc: INSTRUCTIONS_DOC,
    copy: null,
  };
}

// With no names to show, the count is a floor: a used skill
// that matched no listed name may be a listed one under another form.
export function skillsWording(listing: {
  tokens: number;
  estimated: boolean;
  total: number;
  unused: string[] | { atLeast: number };
}): FindingWording {
  const { total, unused } = listing;
  const count = Array.isArray(unused) ? unused.length : unused.atLeast;
  const lead = Array.isArray(unused) ? `${count}` : `At least ${count}`;
  const subject = `${lead} of ${total} listed ${total === 1 ? "skill" : "skills"}`;
  const names = Array.isArray(unused) ? unused : [];
  return {
    headline: `Turn off skills you don't use · ${listing.estimated ? "about " : ""}${formatTokens(listing.tokens)} per request`,
    body: `${subject} ${count === 1 ? "was" : "were"} never used this session. You could turn off the ones you don't need; /skill-doctor shows each skill's cost and use.`,
    list: names.slice(0, MAX_NAMED_SKILLS),
    more: names.slice(MAX_NAMED_SKILLS),
    doc: SKILLS_DOC,
    copy: null,
  };
}

const DENY_DOC = {
  label: "Permissions: read and edit rules",
  url: "https://code.claude.com/docs/en/permissions#read-and-edit",
};

const NAMES = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

// The copy is the lines of a settings file's deny array, so
// the person pastes them in as they are.
export function denyGapWording(gap: {
  tokens: number;
  basis: Finding["measure"]["basis"];
  groups: string[];
  names: string[];
  rules: string[];
}): FindingWording {
  const read = formatTokens(gap.tokens);
  const size = gap.basis === "estimated" ? `about ${read}` : read;
  return {
    headline: `Block reads of ${NAMES.format(gap.groups)} · ${size} read in this session`,
    body: "Claude read files here that are rarely worth the space. You could add a deny rule so it skips them. A Read deny also blocks edits and writes in those places.",
    list: gap.names,
    more: [],
    doc: DENY_DOC,
    copy: gap.rules.map((rule) => `"${rule}"`).join(",\n"),
  };
}
