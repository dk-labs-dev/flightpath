// The six Flightpath commands (ADR-0024, ADR-0026). One
// definition, shared by the command hook that answers them
// and by the journey builder, which keeps them out of the
// turns — the two cannot drift apart.

const COMMAND_ACTIONS = [
  "status",
  "stop",
  "start",
  "off",
  "forget",
  "open",
] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** The action a command name names, or null. A leading slash is optional. */
export function actionOf(commandName: string): CommandAction | null {
  const name = commandName.replace(/^\//, "");
  for (const action of COMMAND_ACTIONS) {
    if (name === `flightpath:${action}`) return action;
  }
  return null;
}

// Claude Code sometimes submits a command already expanded,
// with no UserPromptExpansion after it: the prompt is then two
// tags, and the name in the second one is the command.
const EXPANDED_FORM =
  /^<command-message>[^<]*<\/command-message>\s*<command-name>([^<\s]+)<\/command-name>/;

function expandedCommandName(prompt: string): string | null {
  return EXPANDED_FORM.exec(prompt)?.[1] ?? null;
}

/** The action an expanded prompt names, or null for any other text. */
export function expandedAction(prompt: string): CommandAction | null {
  const name = expandedCommandName(prompt);
  return name === null ? null : actionOf(name);
}

/**
 * Is this text exactly one of the six commands? It accepts a
 * command name, a whole submitted prompt or the expanded form:
 * after the command itself, only whitespace or arguments may
 * follow (the hook ignores any arguments).
 */
export function isFlightpathCommand(text: string): boolean {
  const name = (expandedCommandName(text) ?? text).replace(/^\//, "");
  for (const action of COMMAND_ACTIONS) {
    const command = `flightpath:${action}`;
    if (name === command) return true;
    if (name.startsWith(command) && /\s/.test(name.charAt(command.length))) {
      return true;
    }
  }
  return false;
}
