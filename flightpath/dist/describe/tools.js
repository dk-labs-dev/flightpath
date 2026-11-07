// Tool steps: one describer per tool family, each reading the
// step's stored input summary — paths, names and sizes only
// (ADR-0004) — and the facts every step shares.
import { formatClock, formatCount, formatDuration, formatSize, formatTokens, } from "../format.js";
import { bool, charsOf, isPlainObject, num, parseRecord, str, } from "../util/json.js";
import { firstLine, relativeToProject, truncate } from "./format.js";
/** The tools that spawn a subagent. The token history
 * reads the same set to name a branch's return. */
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
function outcomeWords(outcome) {
    switch (outcome) {
        case "succeeded":
            return "Succeeded";
        case "failed":
            return "Failed";
        case "rejected":
            return "Rejected";
        case "interrupted":
            return "Interrupted";
        case "open":
            return "Running";
        default:
            return "Not recorded";
    }
}
function baseFacts(step, ctx) {
    // When and Duration come from the tool hooks, so a missing
    // one is simply unknown — the telemetry wording belongs to
    // the facts only telemetry supplies (describe/requests.ts).
    const facts = [];
    facts.push({
        label: "When",
        value: step.startedAt !== null ? formatClock(step.startedAt) : "unknown",
    });
    facts.push({
        label: "Duration",
        value: step.durationMs !== null ? formatDuration(step.durationMs) : "unknown",
    });
    facts.push({ label: "Outcome", value: outcomeWords(step.outcome) });
    if (ctx.approvedBy !== undefined) {
        facts.push({ label: "Approved by", value: ctx.approvedBy });
    }
    if (ctx.contextBefore != null && ctx.contextAfter != null) {
        const added = ctx.contextAfter - ctx.contextBefore;
        facts.push({
            label: "Context",
            value: `${formatTokens(ctx.contextBefore)} before, ${formatTokens(ctx.contextAfter)} after (${added >= 0 ? "+" : ""}${formatTokens(added)} from this step)`,
        });
    }
    else if (ctx.contextBefore != null) {
        facts.push({
            label: "Context",
            value: `${formatTokens(ctx.contextBefore)} before`,
        });
    }
    if (step.savedOutputBytes !== null) {
        facts.push({
            label: "Saved output",
            value: `Output saved to a file (${formatSize(step.savedOutputBytes)}); only a short notice entered the context`,
        });
    }
    if (ctx.turnSequence !== undefined) {
        facts.push({ label: "Turn", value: `Turn ${ctx.turnSequence}` });
    }
    if (ctx.branchName !== undefined) {
        facts.push({ label: "Branch", value: ctx.branchName });
    }
    return facts;
}
/** How a step's target is named in a sentence about asking. */
export function shortTarget(step) {
    const input = parseRecord(step.inputSummary);
    const path = str(input, "file_path");
    switch (step.toolName) {
        case "Bash": {
            const command = str(input, "command");
            return command ? `\`${firstLine(command)}\`` : "a command";
        }
        case "Read":
        case "Edit":
        case "Write":
            return path ?? "a file";
        default:
            return path ?? step.toolName;
    }
}
function describeBash(step, input, facts, running) {
    const description = str(input, "description");
    const command = str(input, "command");
    const sentence = running
        ? `Running ${command ? `\`${truncate(firstLine(command), 60)}\`` : "a command"}`
        : (description ??
            (command
                ? `Ran \`${truncate(firstLine(command), 60)}\``
                : "Ran a command"));
    if (command) {
        facts.push({ label: "Command", value: command });
    }
    if (step.resultSize !== null) {
        facts.push({
            label: "Output",
            value: `printed ${formatCount(step.resultSize)} characters, not stored`,
        });
    }
    return { sentence, facts };
}
/**
 * The tool-use id of the step whose saved output a Read step
 * reads back: Claude Code saves a large output as
 * `<session folder>/tool-results/<tool-use id>.txt`, in the folder
 * named by the session's id. A file in a project's own
 * `tool-results` folder is not one. Null for any other step.
 */
export function savedOutputToolUseId(step, sessionId) {
    if (step.toolName !== "Read" || sessionId === undefined)
        return null;
    const path = str(parseRecord(step.inputSummary), "file_path");
    if (path === undefined)
        return null;
    const parts = path.split(/[\\/]/);
    const file = parts.pop() ?? "";
    return parts.pop() === "tool-results" &&
        parts.pop() === sessionId &&
        file.endsWith(".txt")
        ? file.slice(0, -".txt".length)
        : null;
}
function sentencePath(input, ctx) {
    const path = str(input, "file_path");
    if (path === undefined)
        return "a file";
    return ctx.projectPath === undefined
        ? path
        : relativeToProject(path, ctx.projectPath);
}
function describeRead(step, input, facts, running, ctx) {
    const path = sentencePath(input, ctx);
    const offset = num(input, "offset");
    const limit = num(input, "limit");
    if (offset !== undefined && limit !== undefined) {
        facts.push({
            label: "Lines",
            value: `lines ${offset} to ${offset + limit - 1} of the file`,
        });
    }
    if (step.resultSize !== null) {
        facts.push({
            label: "Size read",
            value: `${formatCount(step.resultSize)} characters`,
        });
    }
    const verb = running ? "Reading" : "Read";
    if (savedOutputToolUseId(step, ctx.sessionId) === null) {
        return { sentence: `${verb} ${path}`, facts };
    }
    const source = ctx.savedOutputOf === undefined
        ? "a saved tool output"
        : `the saved output of the step "${ctx.savedOutputOf}"`;
    return { sentence: `${verb} ${source}`, facts };
}
function describeEdit(step, input, facts, running, ctx) {
    const path = sentencePath(input, ctx);
    const oldChars = charsOf(input, "old_string");
    const newChars = charsOf(input, "new_string");
    if (bool(input, "replace_all")) {
        facts.push({ label: "Places changed", value: "all occurrences" });
    }
    else if (oldChars !== undefined) {
        facts.push({ label: "Places changed", value: "1 place" });
    }
    if (oldChars !== undefined && newChars !== undefined) {
        facts.push({
            label: "Characters",
            value: `replaced ${formatCount(oldChars)} characters with ${formatCount(newChars)} characters`,
        });
    }
    return { sentence: `${running ? "Editing" : "Edited"} ${path}`, facts };
}
function describeWrite(step, input, facts, running, ctx) {
    const path = sentencePath(input, ctx);
    const written = charsOf(input, "content");
    if (written !== undefined) {
        facts.push({
            label: "Size written",
            value: `${formatCount(written)} characters`,
        });
    }
    return { sentence: `${running ? "Writing" : "Wrote"} ${path}`, facts };
}
function describeGrep(step, input, facts, running) {
    const pattern = str(input, "pattern");
    const scope = str(input, "path") ?? "the project";
    if (pattern !== undefined) {
        facts.push({ label: "Pattern", value: pattern });
    }
    facts.push({ label: "Scope", value: scope });
    if (step.resultSize !== null) {
        facts.push({
            label: "Results",
            value: `${formatCount(step.resultSize)} characters of results`,
        });
    }
    return {
        sentence: pattern !== undefined
            ? `${running ? "Searching" : "Searched"} for \`${truncate(pattern, 40)}\` in ${scope}`
            : `${running ? "Searching" : "Searched"} in ${scope}`,
        facts,
    };
}
function describeGlob(step, input, facts, running) {
    const pattern = str(input, "pattern");
    if (pattern !== undefined) {
        facts.push({ label: "Pattern", value: pattern });
    }
    if (step.resultSize !== null) {
        facts.push({
            label: "Results",
            value: `${formatCount(step.resultSize)} characters of results`,
        });
    }
    return {
        sentence: pattern !== undefined
            ? `${running ? "Looking" : "Looked"} for files matching \`${truncate(pattern, 40)}\``
            : `${running ? "Looking" : "Looked"} for files`,
        facts,
    };
}
function describeAgent(step, input, facts, running, ctx) {
    const name = str(input, "subagent_type") ?? str(input, "description");
    const task = str(input, "description");
    if (task) {
        facts.push({ label: "Task", value: task });
    }
    if (ctx.branchTotals) {
        facts.push({
            label: "Its work",
            value: `${ctx.branchTotals.steps} steps, ${ctx.branchTotals.requests} requests${ctx.branchTotals.durationMs !== null ? `, ${formatDuration(ctx.branchTotals.durationMs)}` : ""}`,
        });
        if (ctx.branchTotals.coldStartTokens != null) {
            facts.push({
                label: "Cold start",
                value: `${formatCount(ctx.branchTotals.coldStartTokens)} tokens written to cache`,
            });
        }
    }
    return {
        sentence: name !== undefined
            ? `${running ? "Starting" : "Started"} a subagent: ${truncate(name, 60)}`
            : `${running ? "Starting" : "Started"} a subagent`,
        facts,
    };
}
/**
 * The questions in an AskUserQuestion input, read once for
 * every reader: the describer takes the question texts, the
 * snapshot takes the option labels.
 */
export function readQuestions(input) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return questions.flatMap((entry) => {
        if (!isPlainObject(entry)) {
            return [];
        }
        const options = Array.isArray(entry.options) ? entry.options : [];
        const labels = options.flatMap((option) => {
            if (!isPlainObject(option)) {
                return [];
            }
            const label = str(option, "label");
            return label === undefined ? [] : [label];
        });
        return [{ question: str(entry, "question") ?? null, options: labels }];
    });
}
function describeQuestion(input, facts, running) {
    const texts = readQuestions(input).flatMap((asked) => asked.question === null ? [] : [asked.question]);
    if (texts.length > 0) {
        facts.push({ label: "The question", value: texts.join(" ") });
    }
    return {
        sentence: running ? "Asking you a question" : "Asked you a question",
        facts,
    };
}
function describeSkill(input, facts, running) {
    const skill = str(input, "skill");
    return {
        sentence: skill !== undefined
            ? `${running ? "Loading" : "Loaded"} the ${skill} skill`
            : `${running ? "Loading" : "Loaded"} a skill`,
        facts,
    };
}
function describeWebFetch(step, input, facts, running) {
    const url = str(input, "url");
    if (url !== undefined) {
        facts.push({ label: "Address", value: url });
    }
    if (step.resultSize !== null) {
        facts.push({
            label: "Result",
            value: `${formatCount(step.resultSize)} characters`,
        });
    }
    return {
        sentence: url !== undefined
            ? `${running ? "Fetching" : "Fetched"} ${shownAddress(url)}`
            : `${running ? "Fetching" : "Fetched"} a page`,
        facts,
    };
}
/** An address shortened for a sentence: host and path, or the text as stored. */
function shownAddress(url) {
    try {
        const parsed = new URL(url);
        return truncate(`${parsed.host}${parsed.pathname}`, 60);
    }
    catch {
        return truncate(url, 60);
    }
}
function inputSizeWords(input, key) {
    const chars = charsOf(input, key);
    if (chars !== undefined) {
        return `${formatCount(chars)} characters`;
    }
    if (typeof input[key] === "number") {
        return "a number";
    }
    if (typeof input[key] === "boolean") {
        return "a yes/no";
    }
    return "a list or object";
}
function describeOtherTool(step, input, facts, running) {
    // MCP tools are named mcp__<server>__<tool>; anything else
    // is a tool with no row of its own, named plainly.
    const mcp = /^mcp__(.+?)__(.+)$/.exec(step.toolName);
    if (!mcp) {
        return {
            sentence: `${running ? "Running" : "Ran"} ${step.toolName}`,
            facts,
        };
    }
    const keys = Object.keys(input);
    if (keys.length > 0) {
        facts.push({
            label: "Inputs",
            value: keys
                .map((key) => `${key} (${inputSizeWords(input, key)})`)
                .join(", "),
        });
    }
    if (step.resultSize !== null) {
        facts.push({
            label: "Result",
            value: `${formatCount(step.resultSize)} characters`,
        });
    }
    return {
        sentence: `${running ? "Using" : "Used"} ${mcp[1]}: ${mcp[2]}`,
        facts,
    };
}
/** A step's one-line sentence and its panel facts. */
export function describeStep(step, ctx = {}) {
    const input = parseRecord(step.inputSummary);
    const facts = baseFacts(step, ctx);
    const running = step.outcome === "open";
    if (SUBAGENT_TOOLS.has(step.toolName)) {
        return describeAgent(step, input, facts, running, ctx);
    }
    switch (step.toolName) {
        case "Bash":
            return describeBash(step, input, facts, running);
        case "Read":
            return describeRead(step, input, facts, running, ctx);
        case "Edit":
            return describeEdit(step, input, facts, running, ctx);
        case "Write":
            return describeWrite(step, input, facts, running, ctx);
        case "Grep":
            return describeGrep(step, input, facts, running);
        case "Glob":
            return describeGlob(step, input, facts, running);
        case "SubagentHandback":
            return {
                sentence: running
                    ? "Handing its report back"
                    : "Handed its report back",
                facts,
            };
        case "AskUserQuestion":
            return describeQuestion(input, facts, running);
        case "Skill":
            return describeSkill(input, facts, running);
        case "WebFetch":
            return describeWebFetch(step, input, facts, running);
        default:
            return describeOtherTool(step, input, facts, running);
    }
}
