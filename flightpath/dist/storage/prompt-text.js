// What of a prompt is stored: its text is capped, and its full
// length and line count ride beside it, so a cut prompt still
// reports its true size.
const PROMPT_TEXT_LIMIT = 2_000;
/** A prompt cut to the limit; call it on text that is already redacted. */
export function cutPromptText(text) {
    if (text.length <= PROMPT_TEXT_LIMIT) {
        return text;
    }
    const stored = text.slice(0, PROMPT_TEXT_LIMIT);
    // The cut can land inside an astral character, leaving a lone
    // high surrogate storage reads back as a replacement character.
    const last = stored.charCodeAt(stored.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? stored.slice(0, -1) : stored;
}
/** A prompt text as its three turns columns, cut after redaction. */
export function promptTextColumns(text) {
    if (text === null) {
        return { text: null, chars: null, lines: null };
    }
    return {
        text: cutPromptText(text),
        chars: text.length,
        lines: text.length === 0 ? 0 : text.split("\n").length,
    };
}
const UPDATE_TURN_PROMPT = "UPDATE turns SET prompt_text = ?, prompt_chars = ?, prompt_lines = ? WHERE id = ?";
const UPDATE_TURN_PROMPT_IF_UNSET = `${UPDATE_TURN_PROMPT} AND prompt_text IS NULL`;
const FILL_TURN_PROMPT_FIGURES = "UPDATE turns SET prompt_chars = ?, prompt_lines = ? WHERE id = ? AND prompt_chars IS NULL";
/** The prompt-text UPDATEs, prepared once per caller. */
export function preparePromptTextStatements(db) {
    return {
        setTurnPrompt: db.prepare(UPDATE_TURN_PROMPT),
        fillTurnPrompt: db.prepare(UPDATE_TURN_PROMPT_IF_UNSET),
        fillTurnFigures: db.prepare(FILL_TURN_PROMPT_FIGURES),
    };
}
/** Store a prompt's text and figures on its turn, replacing any earlier. */
export function setTurnPromptColumns(st, turnId, columns) {
    st.setTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}
/** Store a prompt's text only where none is stored, keeping an earlier path's. */
export function fillTurnPromptText(st, turnId, text) {
    const columns = promptTextColumns(text);
    st.fillTurnPrompt.run(columns.text, columns.chars, columns.lines, turnId);
}
/**
 * Store a prompt's length only where none is stored: the fill
 * for a prompt whose text is not kept.
 */
export function fillTurnPromptFigures(st, turnId, chars, lines) {
    st.fillTurnFigures.run(chars, lines, turnId);
}
