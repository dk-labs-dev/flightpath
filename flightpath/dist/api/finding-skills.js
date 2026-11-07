// The skills Claude Code listed to the model for the whole
// session and nobody used. The listing is sent on every request,
// so its size is what leaving them on costs. Names and sizes
// only (ADR-0004).
import { estimatedTokens } from "../format.js";
import { contextReportFor } from "./context-limit.js";
import { skillsWording } from "./finding-wording.js";
import { latestMainModel } from "./session-data.js";
// A shorter live session has not yet had the chance to use them.
const MIN_TURNS = 10;
// What telemetry calls a skill it will not name.
const WITHHELD_NAME = "custom_skill";
// The earliest listing is the main thread's own: a subagent's and
// the one re-sent after a compaction come later.
function firstListing(data) {
    const load = data.loads.find((row) => row.kind === "skill-listing");
    if (load === undefined || load.names === null)
        return undefined;
    return { ...load, names: load.names };
}
// Flightpath's own command turns do not count toward the ten.
function isSettled(data) {
    if (data.session.status !== "live")
        return true;
    return (data.turns.filter((turn) => !turn.flightpathCommand).length >= MIN_TURNS);
}
// Null when a skill was used under a name that was never given.
function usedSkillNames(loads) {
    const used = new Set();
    for (const load of loads) {
        if (load.kind !== "skill" || load.name === null)
            continue;
        if (load.name === WITHHELD_NAME)
            return null;
        if (load.trigger === "agent" || load.trigger === "user_slash") {
            used.add(load.name);
        }
    }
    return used;
}
// A used name that no listed name matches may be a listed skill
// under another form, so the names are not shown and the count
// is a floor.
function unusedSkills(listed, used) {
    if ([...used].some((name) => !listed.includes(name))) {
        const atLeast = listed.length - used.size;
        return atLeast > 0 ? { atLeast } : null;
    }
    const unused = listed
        .filter((name) => !used.has(name))
        .sort((a, b) => a.localeCompare(b, "en"));
    return unused.length > 0 ? unused : null;
}
function listingTokens(data, listing) {
    const report = contextReportFor(data.contextReports, latestMainModel(data));
    if (report !== null && report.skills !== null) {
        return { tokens: report.skills, estimated: false };
    }
    const tokens = estimatedTokens(listing.sizeBytes);
    return tokens === null ? null : { tokens, estimated: true };
}
export function skillFindings(data) {
    const listing = firstListing(data);
    if (listing === undefined || data.session.joinedPartway)
        return [];
    if (!isSettled(data))
        return [];
    const used = usedSkillNames(data.loads);
    if (used === null)
        return [];
    const unused = unusedSkills(listing.names, used);
    const size = listingTokens(data, listing);
    if (unused === null || size === null)
        return [];
    return [
        {
            id: "skills-unused",
            kind: "skills-unused",
            grade: "Did you know",
            at: listing.occurredAt,
            requestId: null,
            turnId: null,
            measure: {
                tokens: size.tokens,
                basis: size.estimated ? "estimated" : "from-context",
            },
            ...skillsWording({
                ...size,
                total: listing.names.length,
                unused,
            }),
        },
    ];
}
