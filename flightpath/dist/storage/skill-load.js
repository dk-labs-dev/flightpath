// A skill's hook and its text can arrive in either order, so
// both land on the one load by the skill's name and the time.
// The journey builder and the transcript ingest share this.
// A plugin's skill is `plugin:skill` in the hook and `skill` in
// its text, so a text's name also matches a load's after a colon.
/** How far apart, either way, a skill's load and its text may be. */
const MATCH_WINDOW_MS = 10_000;
const NEAREST = "ORDER BY ABS(occurred_at - ?), id LIMIT 1";
export function prepareSkillLoadStatements(db) {
    const inWindow = "session_id = ? AND kind = 'skill' AND (name = ? OR substr(name, -length(?) - 1) = ':' || ?) AND ABS(occurred_at - ?) <= ?";
    return {
        findUnsizedSkillLoad: db.prepare(`SELECT id FROM loads WHERE ${inWindow} AND size_bytes IS NULL ${NEAREST}`),
        findSizedSkillLoad: db.prepare(`SELECT id FROM loads WHERE ${inWindow} AND size_bytes IS NOT NULL ${NEAREST}`),
        findUntriggeredSkillLoad: db.prepare(`SELECT id FROM loads WHERE ${inWindow} AND source = 'transcript' AND trigger IS NULL ${NEAREST}`),
        setSkillTrigger: db.prepare("UPDATE loads SET trigger = ?, name = ? WHERE id = ?"),
    };
}
/**
 * The nearest load of that name still without a size, else the
 * nearest sized one, which is what a text read twice finds.
 */
export function findLoadForSkillText(st, sessionId, name, at) {
    const args = [sessionId, name, name, name, at, MATCH_WINDOW_MS, at];
    const row = st.findUnsizedSkillLoad.get(...args) ?? st.findSizedSkillLoad.get(...args);
    return row === undefined ? null : row.id;
}
/**
 * Give the trigger, and the hook's full name, to a load the
 * transcript recorded first; false when none.
 */
export function triggerTranscriptSkillLoad(st, sessionId, name, trigger, at) {
    const textName = name.slice(name.lastIndexOf(":") + 1);
    const row = st.findUntriggeredSkillLoad.get(sessionId, textName, textName, textName, at, MATCH_WINDOW_MS, at);
    if (row === undefined)
        return false;
    st.setSkillTrigger.run(trigger, name, row.id);
    return true;
}
