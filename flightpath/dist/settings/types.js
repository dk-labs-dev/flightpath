// The settings contract as types alone (ADR-0022): the settings,
// the table describing them, and the settings route's payload.
// This module imports nothing — no Node builtins — so the view
// type-checks against it without Node's types in its program,
// where view code could use `process` or `Buffer` unchecked.
export {};
