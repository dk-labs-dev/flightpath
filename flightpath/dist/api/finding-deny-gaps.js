// Reads of places that are rarely worth the space, such as
// dependencies, build output and lockfiles, when no deny rule
// covers them. Only paths and the rule strings of the settings
// are read (ADR-0004); nothing is written to a settings file.
import { estimatedTokens } from "../format.js";
import { managedPaths } from "../setup/index.js";
import { readDenyRules } from "../settings-files.js";
import { parseRecord, str } from "../util/json.js";
import { measuredStepSizes } from "./context-at-step.js";
import { denyGapWording } from "./finding-wording.js";
import { stepChars } from "./tokens.js";
// `vendor`, `target` and `out` are left out: projects use those
// names for source folders.
const DENY_PATTERNS = {
    folders: new Set([
        "node_modules",
        ".venv",
        "venv",
        "dist",
        "build",
        ".next",
        ".nuxt",
        "__pycache__",
        "coverage",
    ]),
    lockfiles: new Set([
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "poetry.lock",
        "Pipfile.lock",
        "Gemfile.lock",
        "composer.lock",
        "Cargo.lock",
        "go.sum",
    ]),
    suffixes: [".min.js", ".min.css", ".map"],
};
const WORTH_A_LOOK = 5_000;
const WORTH_FIXING = 25_000;
function gapOf(relativePath) {
    const file = relativePath.at(-1) ?? "";
    const folder = relativePath
        .slice(0, -1)
        .find((segment) => DENY_PATTERNS.folders.has(segment));
    if (folder !== undefined) {
        return { group: folder, name: folder, rule: `Read(**/${folder}/**)` };
    }
    if (DENY_PATTERNS.lockfiles.has(file)) {
        return { group: "lockfiles", name: file, rule: `Read(**/${file})` };
    }
    const suffix = DENY_PATTERNS.suffixes.find((ending) => file.endsWith(ending));
    if (suffix !== undefined) {
        return {
            group: "minified files and source maps",
            name: suffix,
            rule: `Read(**/*${suffix})`,
        };
    }
    return null;
}
// Both separators count: a recording made on Windows keeps its
// backslashes.
function pathBelow(project, filePath) {
    const root = project.replaceAll("\\", "/").replace(/\/+$/, "");
    const file = filePath.replaceAll("\\", "/");
    return file.startsWith(`${root}/`)
        ? file.slice(root.length + 1).split("/")
        : null;
}
function readsInGaps(data, project) {
    const reads = [];
    for (const step of data.steps) {
        if (step.toolName !== "Read" || step.outcome === "failed")
            continue;
        const filePath = str(parseRecord(step.inputSummary), "file_path");
        const relativePath = filePath === undefined ? null : pathBelow(project, filePath);
        const gap = relativePath === null ? null : gapOf(relativePath);
        if (gap !== null)
            reads.push({ step, gap });
    }
    return reads;
}
// A rule counts as covering a place when its text names it; when
// unsure, the finding stays silent rather than suggest a rule
// that is already there.
function isCovered(gap, rules) {
    return rules.some((rule) => {
        const text = rule.trim();
        return text === "Read" || text === "Read(*)" || text.includes(gap.name);
    });
}
function tokensRead(data, reads) {
    const measured = measuredStepSizes(data);
    const total = { tokens: 0, basis: "measured" };
    for (const { step } of reads) {
        const size = measured.get(step.id);
        if (size !== undefined) {
            total.tokens += size;
        }
        else {
            total.tokens += estimatedTokens(stepChars(step)) ?? 0;
            total.basis = "estimated";
        }
    }
    return total;
}
function gradeFor(tokens) {
    if (tokens >= WORTH_FIXING)
        return "Worth fixing";
    return tokens >= WORTH_A_LOOK ? "Worth a look" : null;
}
function unique(values) {
    return [...new Set(values)];
}
export function denyGapFindings(data) {
    const project = data.session.projectPath;
    if (project === null)
        return [];
    const candidates = readsInGaps(data, project);
    if (candidates.length === 0)
        return [];
    // Settings are read now, not kept, so a rule added since the
    // last look counts.
    const rules = readDenyRules(project, managedPaths(process.platform));
    if (rules === undefined)
        return [];
    const reads = candidates.filter(({ gap }) => !isCovered(gap, rules));
    const [first] = reads;
    if (first === undefined)
        return [];
    const measure = tokensRead(data, reads);
    const grade = gradeFor(measure.tokens);
    if (grade === null)
        return [];
    return [
        {
            id: "deny-gaps",
            kind: "deny-gap",
            grade,
            at: first.step.startedAt ?? data.session.firstSeenAt,
            requestId: null,
            turnId: null,
            measure,
            ...denyGapWording({
                ...measure,
                groups: unique(reads.map(({ gap }) => gap.group)),
                names: unique(reads.map(({ gap }) => gap.name)),
                rules: unique(reads.map(({ gap }) => gap.rule)),
            }),
        },
    ];
}
