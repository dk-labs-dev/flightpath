// Human moments: what the person did inside a session — asked,
// approved, rejected, stopped, answered, waited — one describer
// per kind of moment.
import { estimatedTokens, formatClock, formatCount, formatDuration, formatTokens, } from "../format.js";
import { num, parseRecord, str } from "../util/json.js";
import { firstLine, truncate } from "./format.js";
import { shortTarget } from "./tools.js";
function describePrompt(event, ctx, facts, detail) {
    if (ctx.sinceLastTurnMs != null) {
        facts.push({
            label: "Since the last turn",
            value: formatDuration(ctx.sinceLastTurnMs),
        });
    }
    if (ctx.promptText != null) {
        return {
            sentence: `You asked: ${truncate(firstLine(ctx.promptText), 80)}`,
            facts,
        };
    }
    const length = num(detail, "prompt_length") ?? ctx.promptLength ?? undefined;
    return {
        sentence: length !== undefined
            ? `You asked a question (${formatCount(length)} characters, wording not kept)`
            : "You asked a question (wording not kept)",
        facts,
    };
}
function describePermissionRequest(ctx, facts) {
    if (ctx.step === undefined) {
        return { sentence: "Claude asked to run an action", facts };
    }
    return {
        sentence: `Claude asked to use ${ctx.step.toolName} on ${shortTarget(ctx.step)}`,
        facts,
    };
}
function decisionWords(decision) {
    if (decision === "accept") {
        return "approved, once";
    }
    if (decision === "accept_permanent") {
        return "approved, always";
    }
    if (decision === "reject") {
        return "rejected";
    }
    return "not recorded";
}
function describePermissionDecision(event, ctx, facts, detail) {
    const asked = ctx.step
        ? `${ctx.step.toolName} ${shortTarget(ctx.step)}`
        : "an action";
    facts.push({ label: "What was asked", value: asked });
    facts.push({ label: "The answer", value: decisionWords(event.decision) });
    const rule = str(detail, "suggestedRule");
    if (rule) {
        facts.push({ label: "Rule suggested", value: rule });
    }
    return {
        sentence: decisionSentence(event.decision, asked),
        facts,
    };
}
/** The decision sentence: it claims only what the answer fact beside it says. */
function decisionSentence(decision, asked) {
    if (decision === "reject") {
        return `You rejected ${asked}`;
    }
    if (decision === "accept" || decision === "accept_permanent") {
        return `You approved ${asked}`;
    }
    return `The answer for ${asked} was not recorded`;
}
function describeRejection(ctx, facts) {
    const target = ctx.step
        ? `${ctx.step.toolName} ${shortTarget(ctx.step)}`
        : "an action";
    facts.push({ label: "What was asked", value: target });
    return { sentence: `You rejected ${target}`, facts };
}
function describeInterrupt(ctx, facts) {
    const target = ctx.step ? shortTarget(ctx.step) : "the running step";
    facts.push({ label: "What was running", value: target });
    const after = ctx.step?.durationMs != null
        ? ` after ${formatDuration(ctx.step.durationMs)}`
        : "";
    return { sentence: `You stopped ${target}${after}`, facts };
}
function answerLabels(detail) {
    // The stored detail is the answers map (question -> chosen
    // label), sometimes nested under "answers" when the whole
    // response was kept; the labels are its string values.
    const answers = typeof detail.answers === "object" && detail.answers !== null
        ? detail.answers
        : detail;
    return Object.values(answers).flatMap((value) => {
        if (typeof value === "string") {
            return [value];
        }
        if (Array.isArray(value)) {
            return value.filter((item) => typeof item === "string");
        }
        return [];
    });
}
function describeQuestionAnswered(ctx, facts, detail) {
    const labels = answerLabels(detail);
    const choice = str(detail, "choice") ??
        str(detail, "answer") ??
        (labels.length > 0 ? labels.join(", ") : undefined);
    const options = ctx.options ?? [];
    if (options.length > 0) {
        facts.push({ label: "The options", value: options.join(", ") });
    }
    if (choice) {
        facts.push({ label: "Your choice", value: choice });
    }
    return {
        sentence: choice ? `You answered: ${choice}` : "You answered a question",
        facts,
    };
}
function describeCommand(facts, detail) {
    const name = str(detail, "name");
    return {
        sentence: name === undefined ? "You ran a command" : `You ran \`${name}\``,
        facts,
    };
}
/** What a hand-back is called, wherever it is listed. */
export function handbackName(agentType) {
    return `${agentType ?? "A subagent"} reported back`;
}
// A hand-back's size is shown in tokens, estimated from its
// characters the way every other size is, and marked as an
// estimate.
function describeHandback(facts, detail) {
    const chars = num(detail, "chars");
    const size = chars === undefined
        ? ""
        : ` · about ${formatTokens(estimatedTokens(chars))} est.`;
    return {
        sentence: `${handbackName(str(detail, "agent_type"))}${size}`,
        facts,
    };
}
function describeNotice(facts, detail) {
    const chars = num(detail, "chars");
    const size = chars === undefined
        ? ""
        : ` · ${formatCount(chars)} ${chars === 1 ? "character" : "characters"}`;
    return { sentence: `Claude Code added a notice${size}`, facts };
}
/** A human moment's sentence and facts. */
export function describeHuman(event, ctx = {}) {
    const facts = [
        { label: "When", value: formatClock(event.occurredAt) },
    ];
    const detail = parseRecord(event.detail);
    switch (event.kind) {
        case "prompt":
            return describePrompt(event, ctx, facts, detail);
        case "permission_request":
            return describePermissionRequest(ctx, facts);
        case "permission_decision":
            return describePermissionDecision(event, ctx, facts, detail);
        case "rejection":
            return describeRejection(ctx, facts);
        case "interrupt":
            return describeInterrupt(ctx, facts);
        case "question_answered":
            return describeQuestionAnswered(ctx, facts, detail);
        case "waiting":
            return { sentence: "Claude is waiting for you", facts };
        case "command":
            return describeCommand(facts, detail);
        case "handback":
            return describeHandback(facts, detail);
        case "notice":
            return describeNotice(facts, detail);
        default:
            return { sentence: `A moment was recorded (${event.kind})`, facts };
    }
}
