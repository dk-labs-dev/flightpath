// The session_conditions statements every store module needs:
// the row's ensure-and-read pair, prepared once per module from
// this one copy of the SQL.
export function prepareConditionsStatements(db) {
    return {
        getConditions: db.prepare("SELECT * FROM session_conditions WHERE session_id = ?"),
        insertConditions: db.prepare("INSERT OR IGNORE INTO session_conditions (session_id, sources_seen, updated_at) VALUES (?, '[]', ?)"),
    };
}
