// The storage summary: the session picker's retention line reads it.
/** GET /api/storage — sessions stored and database size. */
export function storageSummary(storage) {
    return {
        sessions: storage.countSessions(),
        databaseBytes: storage.databaseBytes(),
    };
}
