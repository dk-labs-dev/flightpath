// What the coach has to say about one session, computed from
// its stored rows on every read. No generated text is stored,
// only the ids a person dismissed; a read adds nothing to the
// model's context (ADR-0021).
import { denyGapFindings } from "./finding-deny-gaps.js";
import { instructionFindings } from "./finding-instructions.js";
import { rebuildFindings } from "./finding-rebuilds.js";
import { skillFindings } from "./finding-skills.js";
import { loadSessionData } from "./session-data.js";
import { terminalLine } from "./terminal-line.js";
const GRADE_RANK = {
    "Worth fixing": 0,
    "Worth a look": 1,
    "Did you know": 2,
};
// Each detector reads the loaded session and returns its own
// findings; a later detector's are appended here.
function detectFindings(data) {
    return [
        ...rebuildFindings(data),
        ...instructionFindings(data),
        ...skillFindings(data),
        ...denyGapFindings(data),
    ];
}
function byWorth(a, b) {
    return (GRADE_RANK[a.grade] - GRADE_RANK[b.grade] ||
        b.measure.tokens - a.measure.tokens ||
        a.at - b.at);
}
/** The findings of a session not dismissed, most worth acting
 * on first; undefined when the session is unknown. */
export function sessionFindings(storage, sessionId) {
    const data = loadSessionData(storage, sessionId);
    if (data === undefined)
        return undefined;
    const dismissed = new Set(storage.listDismissals(sessionId));
    return detectFindings(data)
        .filter((finding) => !dismissed.has(finding.id))
        .sort(byWorth);
}
/** What the terminal prints when the session's turn with this
 * prompt id ends; undefined when the session is unknown. A turn
 * the journey has not recorded gets no line. */
export function sessionTerminalLine(storage, sessionId, promptId) {
    const findings = sessionFindings(storage, sessionId);
    if (findings === undefined)
        return undefined;
    const turnId = storage.turnIdForPrompt(sessionId, promptId);
    return { line: turnId === undefined ? null : terminalLine(findings, turnId) };
}
/** Dismiss a finding the session currently produces. False when
 * the session is unknown or no such finding exists; dismissing
 * one again changes nothing. */
export function dismissFinding(storage, sessionId, findingId) {
    const data = loadSessionData(storage, sessionId);
    if (data === undefined)
        return false;
    if (!detectFindings(data).some((finding) => finding.id === findingId)) {
        return false;
    }
    storage.dismissFinding(sessionId, findingId);
    return true;
}
