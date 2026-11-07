// The live stream's wire contract (ADR-0009), typed once: every message
// the hub sends is one of these, its payload the very shape the snapshot
// would show. Every message carries `id: <epoch>:<n>` on the wire, the
// epoch minted when the daemon starts, so a reconnect after a restart
// can never be mistaken for a replay. `reset`, `sync` and `stopping` are
// per-connection, never buffered: reset says the gap is too old and the
// page reloads; sync closes a replay; stopping is the daemon's last
// word, written straight to the open connections as it stops.
export {};
