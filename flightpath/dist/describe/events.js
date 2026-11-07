// Session events: the segments a session is made of (start,
// resume, compaction) and the recording pauses between them.
import { formatClock, formatDuration, formatTokens } from "../format.js";
/**
 * How a branch is named in a sentence: its agent type when
 * recorded, its id when only that is, and an honest plain
 * name when neither is.
 */
export function describeBranch(agentType, agentId) {
    if (agentType !== null) {
        return `Subagent ${agentType}`;
    }
    if (agentId !== null) {
        return `Subagent ${agentId}`;
    }
    return "A subagent";
}
/** A session event's sentence and facts: a segment or a pause. */
export function describeSegment(segment, ctx = {}) {
    const facts = [
        { label: "When", value: formatClock(segment.startedAt) },
    ];
    if (segment.kind === "compact") {
        if (ctx.contextBefore != null && segment.contextTokens !== null) {
            facts.push({
                label: "Context",
                value: `${formatTokens(ctx.contextBefore)} before, ${formatTokens(segment.contextTokens)} after`,
            });
        }
        return { sentence: "Compacted the conversation", facts };
    }
    if (segment.kind === "resume") {
        return { sentence: "Session resumed", facts };
    }
    return { sentence: "Session started", facts };
}
export function describePause(pause) {
    const facts = [{ label: "When", value: formatClock(pause.pausedAt) }];
    if (pause.resumedAt !== null) {
        facts.push({
            label: "For",
            value: formatDuration(pause.resumedAt - pause.pausedAt),
        });
        return { sentence: "Recording paused, then resumed", facts };
    }
    return { sentence: "Recording paused", facts };
}
