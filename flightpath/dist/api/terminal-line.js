// The one line printed in the terminal when a turn ends, and the only
// place it is worded. It carries no figure, no address and no token:
// the suggestion itself is in the browser, and what reaches the
// terminal is shown to the person only (ADR-0021, ADR-0024).
// "Did you know" is a note for the browser, not a reason to interrupt.
const LINE_GRADES = ["Worth fixing", "Worth a look"];
function countsPhrase(total, worthFixing) {
    if (total === 1) {
        const worth = worthFixing === 1 ? "fixing" : "a look";
        return `1 suggestion worth ${worth} from this turn`;
    }
    const worth = worthFixing === 0 ? "all worth a look" : `${worthFixing} worth fixing`;
    return `${total} suggestions from this turn, ${worth}`;
}
/** The line for a turn that ended, or null when none of its findings is worth one. */
export function terminalLine(findings, turnId) {
    const counted = findings.filter((finding) => finding.turnId === turnId && LINE_GRADES.includes(finding.grade));
    if (counted.length === 0)
        return null;
    const worthFixing = counted.filter((finding) => finding.grade === "Worth fixing").length;
    const pointer = counted.length === 1 ? "it" : "them";
    return `● flightpath has ${countsPhrase(counted.length, worthFixing)} · /flightpath:open to see ${pointer}`;
}
