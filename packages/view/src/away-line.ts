import type { StreamMessage } from "@flightpath/flightpath/daemon/stream-messages";

import { countLine } from "./counts.js";

// The "while you were away" line: what a reconnect's replay
// adds up to, in one short sentence for the banner.

export function awayLine(entries: StreamMessage[]): string | null {
  const failures = new Set<number>();
  const compactions = new Set<number>();
  const interrupts = new Set<number>();
  let question = false;
  for (const entry of entries) {
    if (entry.event === "step") {
      const step = entry.data.step;
      if (step.outcome === "failed") failures.add(step.id);
      if (step.toolName === "AskUserQuestion") question = true;
    }
    if (entry.event === "segment") {
      const sessionEvent = entry.data.event;
      if (sessionEvent.segmentKind === "compact") {
        compactions.add(sessionEvent.id);
      }
    }
    if (entry.event === "human") {
      const human = entry.data.human;
      if (human.kind === "question_answered") question = true;
      if (human.kind === "interrupt") interrupts.add(human.id);
    }
  }
  const parts: string[] = [];
  if (failures.size > 0)
    parts.push(countLine(failures.size, "failure", "failures"));
  if (compactions.size > 0) {
    parts.push(countLine(compactions.size, "compaction", "compactions"));
  }
  if (question) parts.push("you were asked a question");
  if (interrupts.size > 0) {
    parts.push(countLine(interrupts.size, "interrupt", "interrupts"));
  }
  return parts.length === 0 ? null : parts.join(", ");
}
