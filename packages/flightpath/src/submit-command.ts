// Entry for every UserPromptSubmit (hooks/hooks.json). Claude Code
// waits for it before each prompt, so the heavy handler loads
// only for a prompt that opens like an expanded Flightpath command.

import { readStdin } from "./util/fs.js";

const EXPANDED_OPENING = "<command-message>flightpath:";

function isExpandedCommand(raw: string): boolean {
  try {
    const { prompt } = JSON.parse(raw) as { prompt?: unknown };
    return typeof prompt === "string" && prompt.startsWith(EXPANDED_OPENING);
  } catch {
    // Not a payload we can read: it is not ours to answer.
    return false;
  }
}

const raw = readStdin();
if (isExpandedCommand(raw)) {
  const { answerCommand } = await import("./command-handler.js");
  await answerCommand(raw);
}
