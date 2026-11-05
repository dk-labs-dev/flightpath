// What kind of prompt a UserPromptSubmit carries. The hook
// classifies it once, before its text is dropped.

import { isFlightpathCommand } from "./commands.js";

export const AGENT_MESSAGE_OPENING = "<agent-message";
export const TASK_NOTIFICATION_OPENING = "<task-notification>";

export type PromptKind =
  "typed" | "flightpath-command" | "agent-message" | "task-notification";

/** A subagent's hand-back; only the opening counts. */
export function isAgentMessage(prompt: string): boolean {
  return prompt.trimStart().startsWith(`${AGENT_MESSAGE_OPENING} from="`);
}

function isTaskNotification(prompt: string): boolean {
  return prompt.trimStart().startsWith(TASK_NOTIFICATION_OPENING);
}

export function classifyPrompt(prompt: string): PromptKind {
  if (isFlightpathCommand(prompt)) return "flightpath-command";
  if (isAgentMessage(prompt)) return "agent-message";
  if (isTaskNotification(prompt)) return "task-notification";
  return "typed";
}
