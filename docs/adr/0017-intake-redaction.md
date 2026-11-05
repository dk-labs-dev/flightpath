# ADR-0017: Redact at intake, before anything touches disk

**Status:** Accepted · 2026-10-23

## Context

ADR-0004 says Flightpath stores paths, never file contents, and redacts secrets from everything written to disk. Recorded payloads show how much the raw events carry:

- `PostToolUse.tool_response` is the tool's actual output: command output, file text, search results.
- `tool_input` for Write, Edit and similar tools carries the file content being written.
- `PostCompact.compact_summary`, `SubagentStop.last_assistant_message` and `MessageDisplay.delta` carry generated text.
- Every telemetry event carries the user's email and account and organization IDs.
- Tools from other plugins and MCP servers have inputs we can't know in advance.

The hook script buffers payloads to a file when the daemon is down, so redaction can't wait until the daemon stores an event.

## Decision

**Redaction runs in the hook script before a payload is sent or buffered, and again in the daemon for every source.** One module does it, shared by both, so the rules can't drift.

**Keep by allow-list, not by deny-list.** For each known tool and event, a fixed list of fields is kept as text: paths, command lines, search patterns, URLs, skill names, agent types, the user's prompt, and the option the user picked in `AskUserQuestion`. Every other string is replaced by its length, and numbers and booleans are kept. Inputs of unknown tools, including MCP tools, keep their keys and the sizes of their values only.

**Generated and output text is reduced to its length,** including `tool_response`, file content in `tool_input`, `compact_summary`, `last_assistant_message`, `MessageDisplay.delta` and telemetry's response text.

**Identity is dropped.** Account, user and organization identifiers and email addresses are removed from telemetry attributes.

**Secrets are scrubbed from every kept string.** Known credential formats (cloud and API keys, access tokens, private key blocks, JWTs, credentials in URLs, and values passed as password or token flags and environment assignments) are replaced with `[redacted:<kind>]`.

**Each stored event records the redaction version** that processed it.

## Consequences

- No raw output, file content, generated text or account identity is written anywhere, including the buffer.
- The allow-list errs toward losing a useful field rather than storing a sensitive one. Adding a field means changing the list, and the change is reviewed against ADR-0004.
- Secret patterns can miss credentials in unusual formats. Users are told that prompts and command lines are stored, and `/flightpath forget` removes a session.
- Recording a new Claude Code tool in detail needs a list update. Until then, the tool is still recorded, with sizes only.
