// What kind of prompt a UserPromptSubmit carries. The hook
// classifies it once, before its text is dropped.
import { isFlightpathCommand } from "./commands.js";
export const AGENT_MESSAGE_OPENING = "<agent-message";
export const TASK_NOTIFICATION_OPENING = "<task-notification>";
/** A subagent's hand-back; only the opening counts. */
export function isAgentMessage(prompt) {
    return prompt.trimStart().startsWith(`${AGENT_MESSAGE_OPENING} from="`);
}
function isTaskNotification(prompt) {
    return prompt.trimStart().startsWith(TASK_NOTIFICATION_OPENING);
}
export function classifyPrompt(prompt) {
    if (isFlightpathCommand(prompt))
        return "flightpath-command";
    if (isAgentMessage(prompt))
        return "agent-message";
    if (isTaskNotification(prompt))
        return "task-notification";
    return "typed";
}
