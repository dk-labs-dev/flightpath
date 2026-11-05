// Entry for a UserPromptExpansion of a Flightpath command
// (hooks/hooks.json). The handler is in command-handler.ts.

import { answerCommand } from "./command-handler.js";
import { readStdin } from "./util/fs.js";

const raw = readStdin();
if (raw.trim().length > 0) {
  await answerCommand(raw);
}
