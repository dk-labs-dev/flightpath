// Secret scrubbing for strings that survive the allow-list.
//
// Kept strings (prompts, command lines, paths) can still carry
// credentials: a user pastes a key into a prompt, a command line has a
// password flag. Each pattern below replaces one credential shape with
// `[redacted:<kind>]`. The patterns are deliberately specific — anchored
// on a vendor prefix, a keyword, or a URL structure — so ordinary text
// with a similar shape (git SHAs, UUIDs, base64 hashes) is left alone.
const MYSQL_CLIENT = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/;
const PATTERNS = [
    // Private key blocks span lines; match the whole block first so the
    // base64 body can't trip other patterns on its own.
    {
        kind: "private-key",
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replace: "[redacted:private-key]",
    },
    {
        kind: "aws-access-key",
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replace: "[redacted:aws-access-key]",
    },
    {
        kind: "github-token",
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        replace: "[redacted:github-token]",
    },
    {
        kind: "anthropic-key",
        pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
        replace: "[redacted:anthropic-key]",
    },
    {
        kind: "openai-key",
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
        replace: "[redacted:openai-key]",
    },
    {
        kind: "slack-token",
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
        replace: "[redacted:slack-token]",
    },
    {
        kind: "google-api-key",
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        replace: "[redacted:google-api-key]",
    },
    {
        kind: "jwt",
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        replace: "[redacted:jwt]",
    },
    // Credentials embedded in a URL: scheme://user:password@host — keep
    // the user and the host, replace only the password.
    {
        kind: "url-password",
        pattern: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/g,
        replace: "$1[redacted:url-password]$2",
    },
    // Authorization headers and bearer tokens. The header form runs
    // first so "Authorization: Bearer x" is one replacement, not two.
    {
        kind: "authorization",
        pattern: /\b(Authorization\s*:\s*)(?:(?:Bearer|Basic|Token)\s+)?\S+/gi,
        replace: "$1[redacted:authorization]",
    },
    {
        kind: "bearer",
        pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
        replace: "$1[redacted:bearer]",
    },
    // Password and token flags: --password value, --token=value. The word
    // boundary plus the flag name keeps unrelated flags alone.
    {
        kind: "flag-value",
        pattern: /(--(?:password|passwd|token|api-key|apikey|secret|auth))(=|\s+)\S+/gi,
        replace: "$1$2[redacted:flag-value]",
    },
    // MySQL-family clients take the password as -p with the value
    // attached (mysql -psecret) or following it (mysql -p secret; the
    // spaced form requires a non-numeric value, so a port is left
    // alone). Both forms apply only to those clients (see MYSQL_CLIENT).
    {
        kind: "flag-value",
        pattern: /(^|\s)(-p)([^\s-]\S*)/g,
        replace: "$1$2[redacted:flag-value]",
        mysqlOnly: true,
    },
    {
        kind: "flag-value",
        pattern: /(^|\s)(-p\s+)(?!\d+\b)\S+/g,
        replace: "$1$2[redacted:flag-value]",
        mysqlOnly: true,
    },
    // Assignments whose name marks the value as a secret: API_KEY=...,
    // session_token: "...", DB_PASSWORD=hunter2. Runs last so a value
    // that is itself a known token shape has already been replaced by
    // kind.
    {
        kind: "env-secret",
        pattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
        replace: "$1[redacted:env-secret]",
    },
    // The bare names, PASSWORD=... and TOKEN=...: the pattern above
    // needs a character before the suffix, so these need their own.
    // Assignment form only, so prose like "password: required" is safe,
    // and the lookbehind keeps it out of --token=..., which the flag
    // pattern above already handles.
    {
        kind: "env-secret",
        pattern: /(?<![\w-])((?:PASSWORD|TOKEN)\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
        replace: "$1[redacted:env-secret]",
    },
];
/** Replace every credential shape in `text` with `[redacted:<kind>]`. */
export function scrubSecrets(text) {
    const mysql = MYSQL_CLIENT.test(text);
    let out = text;
    for (const { pattern, replace, mysqlOnly } of PATTERNS) {
        if (mysqlOnly && !mysql) {
            continue;
        }
        out = out.replace(pattern, replace);
    }
    return out;
}
