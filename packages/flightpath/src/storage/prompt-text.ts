// What of a prompt is stored: its text is capped, and its full
// length and line count ride beside it, so a cut prompt still
// reports its true size.

import type { DatabaseSync } from "./sqlite.js";

const PROMPT_TEXT_LIMIT = 2_000;

export interface PromptTextColumns {
  text: string | null;
  chars: number | null;
  lines: number | null;
}

/** A prompt text as its three turns columns, cut after redaction. */
export function promptTextColumns(text: string | null): PromptTextColumns {
  if (text === null) {
    return { text: null, chars: null, lines: null };
  }
  let stored = text.slice(0, PROMPT_TEXT_LIMIT);
  if (text.length > PROMPT_TEXT_LIMIT) {
    // The cut can land inside an astral character, leaving a lone
    // high surrogate storage reads back as a replacement character.
    const last = stored.charCodeAt(stored.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      stored = stored.slice(0, -1);
    }
  }
  return {
    text: stored,
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split("\n").length,
  };
}

const UPDATE_TURN_PROMPT =
  "UPDATE turns SET prompt_text = ?, prompt_chars = ?, prompt_lines = ? WHERE id = ?";
const UPDATE_TURN_PROMPT_IF_UNSET = `${UPDATE_TURN_PROMPT} AND prompt_text IS NULL`;
const FILL_TURN_PROMPT_FIGURES =
  "UPDATE turns SET prompt_chars = ?, prompt_lines = ? WHERE id = ? AND prompt_chars IS NULL";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

export interface PromptTextStatements {
  setTurnPrompt: StatementSync;
  fillTurnPrompt: StatementSync;
  fillTurnFigures: StatementSync;
}

/** The prompt-text UPDATEs, prepared once per caller. */
export function preparePromptTextStatements(
  db: DatabaseSync,
): PromptTextStatements {
  return {
    setTurnPrompt: db.prepare(UPDATE_TURN_PROMPT),
    fillTurnPrompt: db.prepare(UPDATE_TURN_PROMPT_IF_UNSET),
    fillTurnFigures: db.prepare(FILL_TURN_PROMPT_FIGURES),
  };
}

/** Store a prompt's text on its turn, replacing any earlier text. */
export function setTurnPromptText(
  st: PromptTextStatements,
  turnId: number,
  text: string | null,
): void {
  const columns = promptTextColumns(text);
  st.setTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}

/** Store a prompt's text only where none is stored, keeping an earlier path's. */
export function fillTurnPromptText(
  st: PromptTextStatements,
  turnId: number,
  text: string | null,
): void {
  const columns = promptTextColumns(text);
  st.fillTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}

/**
 * Store a prompt's length only where none is stored: the fill
 * for a prompt whose text is not kept.
 */
export function fillTurnPromptFigures(
  st: PromptTextStatements,
  turnId: number,
  chars: number,
  lines: number,
): void {
  st.fillTurnFigures.run(chars, lines, turnId);
}
