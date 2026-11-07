// The database schema, as numbered migrations.
//
// Each migration applies in order, in its own transaction, and the
// database records how far it has got in PRAGMA user_version. A
// database from a newer version than this build knows is refused, not
// modified. Times are milliseconds since the epoch; durations are
// milliseconds; booleans are 0/1. Text columns hold only what
// ADR-0004 allows — paths, names, the user's prompts and command
// lines (stored after intake redaction) — never file contents.
const MIGRATION_1 = `
-- One row per recorded session. A session may be joined partway
-- through (its first event is not SessionStart); joined_partway
-- records that, so a missing start is never mistaken for data loss.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'live', -- live | paused | ended
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  joined_partway INTEGER NOT NULL DEFAULT 0
);

-- A stretch of one session between boundaries: startup, resume and
-- compact each open a segment, inside the same session. Resume rows
-- carry the cache state SessionStart reports, for the cache-rebuild
-- detector.
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL, -- startup | resume | compact
  started_at INTEGER NOT NULL,
  context_tokens INTEGER,
  prompt_cache_likely_expired INTEGER
);
CREATE INDEX segments_session ON segments (session_id, started_at);

-- One turn per user prompt. prompt_id is shared by hooks and
-- telemetry, so the two sources join here. prompt_text is the user's
-- own prompt (stored by design; users are told prompts are stored).
CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt_id TEXT,
  sequence INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  prompt_text TEXT,
  from_command INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, sequence)
);
CREATE INDEX turns_prompt ON turns (session_id, prompt_id);

-- Session conditions seen while recording: permission mode(s) (a
-- session can switch), instruction files, enabled plugins, the
-- Claude Code version, and which capture sources actually delivered
-- (hooks, telemetry, transcript) — recordings reflect the setup that
-- produced them, so the setup is recorded with them.
CREATE TABLE session_conditions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  permission_modes TEXT, -- JSON array of mode names
  instruction_files TEXT, -- JSON array of paths
  enabled_plugins TEXT, -- JSON array of plugin names
  claude_code_version TEXT,
  sources_seen TEXT, -- JSON array: hook | telemetry | transcript
  updated_at INTEGER NOT NULL
);

-- Pauses: /flightpath stop and start. A row with no resumed_at is a
-- pause still in effect.
CREATE TABLE pauses (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  paused_at INTEGER NOT NULL,
  resumed_at INTEGER
);
CREATE INDEX pauses_session ON pauses (session_id, paused_at);

-- Subagent branches off the main line. Hooks give no parent id, so
-- the spawning step is linked by order and agent_type.
CREATE TABLE branches (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT,
  spawning_step_id INTEGER REFERENCES steps(id),
  agent_type TEXT,
  kind TEXT, -- user | internal (internal when agent_type is empty)
  started_at INTEGER,
  ended_at INTEGER,
  total_tokens INTEGER,
  token_source TEXT -- hook | telemetry | transcript
);
CREATE INDEX branches_session ON branches (session_id, agent_id);

-- One tool call. input_summary is JSON of the redacted input: paths,
-- commands and sizes, never file contents. outcome can be reported
-- by more than one source, so outcome_source says which one decided
-- the stored value.
CREATE TABLE steps (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER REFERENCES turns(id),
  branch_id INTEGER REFERENCES branches(id),
  tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT, -- JSON, post-redaction
  outcome TEXT, -- succeeded | failed | rejected | interrupted | open
  outcome_source TEXT, -- hook | telemetry | transcript | inferred | concluded | batch
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  result_size INTEGER
);
CREATE INDEX steps_session ON steps (session_id, tool_use_id);
CREATE INDEX steps_turn ON steps (turn_id);

-- One model request. Cache writes split 5-minute and 1-hour where
-- the source reports the split; token_source records where the
-- numbers came from (ADR-0012: every value records its source).
CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT,
  turn_id INTEGER REFERENCES turns(id),
  branch_id INTEGER REFERENCES branches(id),
  model TEXT,
  query_source TEXT, -- main | subagent | suggestion | title | compact
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  token_source TEXT, -- telemetry | transcript
  started_at INTEGER,
  duration_ms INTEGER
);
CREATE INDEX requests_session ON requests (session_id, request_id);

-- Moments the human acted: prompts, permission requests and their
-- decisions, rejections, interrupts, answers, waiting. A decision's
-- source is telemetry when it exists and inferred otherwise; which
-- one applies is stored, not implied.
CREATE TABLE human_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER REFERENCES turns(id),
  step_id INTEGER REFERENCES steps(id),
  kind TEXT NOT NULL, -- prompt | permission_request | permission_decision | rejection | interrupt | question_answered | waiting | command | handback | notice
  occurred_at INTEGER NOT NULL,
  decision TEXT, -- accept | reject | accept_permanent
  decision_source TEXT, -- telemetry | inferred
  detail TEXT -- JSON summary (e.g. the chosen option label)
);
CREATE INDEX human_events_session ON human_events (session_id, occurred_at);

-- Context size per request, for the Tokens lens.
CREATE TABLE context_samples (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id INTEGER REFERENCES requests(id),
  sampled_at INTEGER NOT NULL,
  context_tokens INTEGER NOT NULL,
  source TEXT NOT NULL -- telemetry | transcript
);
CREATE INDEX context_samples_session ON context_samples (session_id, sampled_at);

-- Things loaded into a session: skills (with what triggered them)
-- and instruction files (with their memory type).
CREATE TABLE loads (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL, -- skill | instructions
  name TEXT,
  trigger TEXT, -- user_slash | agent (skills)
  memory_type TEXT, -- User | Project (instruction files)
  file_path TEXT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL -- hook | telemetry | transcript
);
CREATE INDEX loads_session ON loads (session_id, occurred_at);

-- Coach findings: Flightpath's own text about a session, anchored
-- to the step(s) that evidence it.
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  detector TEXT NOT NULL,
  severity TEXT NOT NULL,
  step_id INTEGER REFERENCES steps(id),
  branch_id INTEGER REFERENCES branches(id),
  explanation TEXT,
  suggested_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | applied | dismissed
  created_at INTEGER NOT NULL
);
CREATE INDEX findings_session ON findings (session_id, status);

-- Every payload after intake redaction, retained so journey
-- processing can be re-run as it improves. session_id carries no
-- foreign key on purpose: intake writes raw events before journey
-- processing creates the session row. forgetSession deletes these
-- explicitly, like every other session table.
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL, -- hook | telemetry | transcript
  session_id TEXT,
  received_at INTEGER NOT NULL,
  event_at INTEGER,
  redaction_version INTEGER NOT NULL,
  body TEXT NOT NULL, -- JSON, post-redaction
  envelope_id TEXT -- the envelope's stable id, for hook payloads only
);
CREATE INDEX raw_events_session ON raw_events (session_id, received_at);
CREATE INDEX raw_events_source ON raw_events (source, received_at);
-- Storing the same envelope twice is stopped by this index
-- instead of a lookup over every stored body — and two writers
-- racing the same envelope cannot both store it. Rows of other
-- sources keep NULL, which the index treats as distinct.
CREATE UNIQUE INDEX raw_events_envelope ON raw_events (envelope_id);

-- Forgotten sessions: the id and the time only, so a session the
-- user forgot is never re-imported from a transcript or a buffer.
-- Deliberately no foreign key: this row must survive the session's
-- deletion — it is what the deletion leaves behind.
CREATE TABLE forgotten (
  session_id TEXT PRIMARY KEY,
  forgotten_at INTEGER NOT NULL
);
`;
const MIGRATION_2 = `
-- Token completeness (ADR-0019): set when a source skipped entries
-- that should have carried token usage, so the session's token data
-- is known incomplete rather than silently short.
ALTER TABLE sessions ADD COLUMN tokens_partial INTEGER NOT NULL DEFAULT 0;
`;
const MIGRATION_3 = `
-- Hook execution counts and timings from telemetry, as JSON.
ALTER TABLE session_conditions ADD COLUMN hook_stats TEXT;
`;
const MIGRATION_4 = `
-- Finding a session's open steps (turn end, branch end) is
-- served by this index instead of scanning every step the
-- session has: the cost is the number of open steps, not the
-- session's length.
CREATE INDEX steps_session_outcome ON steps (session_id, outcome);
`;
const MIGRATION_5 = `
-- Sessions the retention purge deleted (ADR-0025): the id and
-- the time only, so the transcript import never brings a purged
-- session back. Deliberately unlike "forgotten": if a purged id
-- is recorded live again, it is a new recording. No foreign
-- key: this row must survive the session's deletion — it is
-- what the deletion leaves behind.
CREATE TABLE purged (
  session_id TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL
);

-- One-row facts about the database itself, recorded by the
-- code that maintains it (for example, that the one-time
-- switch to incremental auto-vacuum has run).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
const MIGRATION_6 = `
-- A stored prompt's full size: its length and line count,
-- recorded before the stored text is cut to its first 2,000
-- characters. Rows already stored get theirs from the one-time
-- pass in storage/index.ts, which also redacts and caps their
-- text; it finds its rows by prompt_chars still being NULL.
ALTER TABLE turns ADD COLUMN prompt_chars INTEGER;
ALTER TABLE turns ADD COLUMN prompt_lines INTEGER;
`;
const MIGRATION_7 = `
-- How a session's end was learned, and where its Claude Code
-- process can be checked. end_seen is 1 when the session's own
-- end event arrived (or nothing has ended it yet) and 0 when the
-- daemon concluded the end itself, so the view can say "no exit
-- seen" instead of implying a clean exit. host_pid and
-- host_started_at identify the Claude Code process the session
-- runs in — its id and its start time, in milliseconds — so a
-- later check can tell "still running" from "gone", and a reused
-- id from the same process.
ALTER TABLE sessions ADD COLUMN end_seen INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN host_pid INTEGER;
ALTER TABLE sessions ADD COLUMN host_started_at INTEGER;
`;
const MIGRATION_8 = `
-- What each request was sent with, as sizes and names only
-- (ADR-0004): the system prompt's size and each tool
-- definition's name and size. A shape row is keyed by the
-- hash the transcript's own shape entries name their shape
-- by, and holds only what a shape entry carries; the cache
-- lifetime per block and any context-management edits are
-- per-request facts, stored on the request row below.
-- Deliberately no session column: a shape is a fact about a
-- request's construction, not about a session. Which
-- sessions named a shape is recorded separately, in
-- session_shapes below: a shape is live from the moment a
-- session's shape entry names it until its last request
-- lands, so forgetting a session deletes only the shapes
-- no remaining request references and no session names any
-- more (deleteSessionRows), MCP server names in tool names
-- included; a request read afterwards that names a deleted
-- shape records no shape.
CREATE TABLE request_shapes (
  hash TEXT PRIMARY KEY,
  system_bytes INTEGER,
  tools TEXT -- JSON array of {name, bytes, mcp}
);

-- The sessions that named each shape, one row per session
-- and shape, written when the session's shape entry is
-- read. A shape row goes only when no row here and no
-- request references it. Deleted with the session in
-- deleteSessionRows, which FORGET_ORDER places before the
-- session row itself, so the reference holds throughout.
CREATE TABLE session_shapes (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  hash TEXT NOT NULL REFERENCES request_shapes(hash),
  PRIMARY KEY (session_id, hash)
);

-- The request that first carried a step's result, read from
-- the transcript's tool-result link: the Tokens lens
-- attributes a context rise to the step whose result the
-- request took in.
ALTER TABLE steps ADD COLUMN result_request_id INTEGER REFERENCES requests(id);

-- An instruction file's size on disk, statted by the daemon
-- when InstructionsLoaded arrives; null when the file was
-- already gone.
ALTER TABLE loads ADD COLUMN size_bytes INTEGER;

-- The images in a turn's prompt: how many, and their total
-- encoded size. Null when no prompt entry was read for the
-- turn, so an unrecorded prompt never reads as imageless.
ALTER TABLE turns ADD COLUMN image_count INTEGER;
ALTER TABLE turns ADD COLUMN image_bytes INTEGER;

-- The effort a request ran at, and the shape it was sent
-- with. Both are facts the transcript's request entries
-- carry; effort also arrives on hook payloads and telemetry.
ALTER TABLE requests ADD COLUMN effort TEXT;
ALTER TABLE requests ADD COLUMN shape_hash TEXT REFERENCES request_shapes(hash);

-- The cache lifetime of each cached block in the request,
-- and the context-management edits it applied, by type:
-- facts of the one request, read from its request entry.
ALTER TABLE requests ADD COLUMN cache_lifetimes TEXT; -- JSON array of lifetimes, one per cached block
ALTER TABLE requests ADD COLUMN context_edits TEXT; -- JSON array of edit types

-- The hook effort fill updates a turn's requests by turn:
-- without this index it reads every request in the session
-- on every hook event.
CREATE INDEX requests_turn ON requests (turn_id);

-- What came with each prompt, as kind, name and size, never
-- contents (ADR-0004): the images (media type as the name),
-- attached files (the display path), and the prompt itself
-- (its byte size and line count). The reference capture
-- marks no paste and records no non-file attachment, so
-- neither is recorded yet.
CREATE TABLE prompt_attachments (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL, -- image | file | prompt
  name TEXT,
  size_bytes INTEGER,
  line_count INTEGER -- prompt only
);
-- Deleted by session (forget, purge) and restated by
-- turn: the index leads with the session, the turn within it.
CREATE INDEX prompt_attachments_turn ON prompt_attachments (session_id, turn_id);
`;
const MIGRATION_9 = `
-- Which closer ended a turn or a branch: 'concluded' when
-- the daemon's conclusion ended it, null for a real closing
-- (a stop, a new prompt, an end event). A revival reopens
-- exactly the rows the conclusion closed, so the mark has
-- to name the closer; steps carry the same distinction in
-- outcome_source.
ALTER TABLE turns ADD COLUMN end_source TEXT;
ALTER TABLE branches ADD COLUMN end_source TEXT;
`;
const MIGRATION_10 = `
-- Rows a writer changed after inserting them, one entry per
-- change: a live capture reads the entries past its mark and
-- re-reads those rows by id, so a late fact reaches the held
-- session without a full reload. Triggers do the recording,
-- so every writer is covered, including updates that name
-- their rows by turn or by tool use rather than by id.
CREATE TABLE row_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL
);
CREATE INDEX row_changes_session ON row_changes (session_id, seq);

CREATE TRIGGER requests_changed AFTER UPDATE ON requests BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'requests', NEW.id);
END;
CREATE TRIGGER turns_changed AFTER UPDATE ON turns BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'turns', NEW.id);
END;
CREATE TRIGGER branches_changed AFTER UPDATE ON branches BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'branches', NEW.id);
END;
CREATE TRIGGER steps_changed AFTER UPDATE ON steps BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'steps', NEW.id);
END;
-- A turn's attachments are replaced as a set (delete, then
-- insert), so both directions record the turn whose whole
-- set the capture must re-read.
CREATE TRIGGER prompt_attachments_inserted AFTER INSERT ON prompt_attachments BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'prompt_attachments', NEW.turn_id);
END;
CREATE TRIGGER prompt_attachments_deleted AFTER DELETE ON prompt_attachments BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (OLD.session_id, 'prompt_attachments', OLD.turn_id);
END;
-- A session naming a shape: the capture re-reads the
-- session's shapes, a handful of rows, when one lands.
CREATE TRIGGER session_shapes_inserted AFTER INSERT ON session_shapes BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'session_shapes', NEW.rowid);
END;
`;
const MIGRATION_11 = `
-- A step result's size as it entered context, beside its
-- raw size: the characters of the result's text as the
-- transcript carried it, and the count of its images
-- (counted, never read). Null until the transcript names
-- them: a result no transcript carried is unknown, never 0.
ALTER TABLE steps ADD COLUMN context_chars INTEGER;
ALTER TABLE steps ADD COLUMN context_images INTEGER;
`;
const MIGRATION_12 = `
-- What /context reported for one model in a session: the
-- window Claude Code says it is using, and its auto-compact
-- buffer when the report named one. One row per model; a
-- later report for the same model replaces the earlier one.
-- Written by the transcript follower only, and deleted with
-- the session (the cascade, and FORGET_ORDER below).
CREATE TABLE context_reports (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  window INTEGER NOT NULL,
  autocompact_buffer INTEGER,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, model)
);
`;
const MIGRATION_13 = `
-- How many of a thing a startup load names, when it counts
-- them: the skills in the listing, the servers that sent
-- instructions, the tool names loaded on demand. Null when
-- the load names no count.
ALTER TABLE loads ADD COLUMN item_count INTEGER;
-- A load's size can be filled in after the row lands — an
-- instruction file's size arrives with the transcript entry
-- when the hook could not stat the file — and the change
-- rides the same row-changes feed as the other tables'
-- updates, so a live view sees the filled size.
CREATE TRIGGER loads_changed AFTER UPDATE ON loads BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'loads', NEW.id);
END;
`;
const MIGRATION_14 = `
-- What a /context report gave for the system prompt, the MCP
-- server instructions and the skills listing, in tokens:
-- Claude Code's own count of each. Null where the report
-- listed no such row, and for reports stored before these
-- columns existed.
ALTER TABLE context_reports ADD COLUMN system_prompt INTEGER;
ALTER TABLE context_reports ADD COLUMN mcp_instructions INTEGER;
ALTER TABLE context_reports ADD COLUMN skills INTEGER;
`;
const MIGRATION_15 = `
-- Whether a step's result only announced a subagent started in
-- the background (1), as against carrying the answer (0). Null
-- until the transcript names the result. The subagent's report
-- arrives later, as a hand-back.
ALTER TABLE steps ADD COLUMN async_launch INTEGER;
`;
const MIGRATION_16 = `
-- What a /context report gave for the system tools, in
-- tokens: Claude Code's own count of the tool definitions.
-- Null where the report listed no such row, and for reports
-- stored before this column existed.
ALTER TABLE context_reports ADD COLUMN system_tools INTEGER;
`;
const MIGRATION_17 = `
-- The files Claude Code put back after a compaction: the
-- compaction's moment, the file's display path and size, and
-- whether it was read in full again (1) or only named (0).
-- Kept by time rather than by segment: telemetry, the hooks
-- and the transcript each open the compaction's segment, and
-- a replay deletes and rebuilds segments, so a row pointing at
-- one would be lost with it. A read pairs a file with the
-- segment nearest its moment. Written by the transcript
-- follower only, and deleted with the session (the cascade,
-- and FORGET_ORDER below).
CREATE TABLE compaction_files (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  size_bytes INTEGER,
  reread INTEGER NOT NULL,
  UNIQUE (session_id, at, name)
);
-- A session's files arrive after the compaction opened: the
-- capture re-reads the session's rows, a handful, when one lands.
CREATE TRIGGER compaction_files_inserted AFTER INSERT ON compaction_files BEGIN
  INSERT INTO row_changes (session_id, table_name, row_id)
  VALUES (NEW.session_id, 'compaction_files', NEW.id);
END;
`;
const MIGRATION_18 = `
-- What from_command marked is restated (ADR-0021): it flagged
-- other commands' turns, never Flightpath's, so every stored
-- value is cleared rather than carried into the new meaning —
-- keeping one would bill that command's cost to Flightpath.
ALTER TABLE turns RENAME COLUMN from_command TO flightpath_command;
UPDATE turns SET flightpath_command = 0;
`;
const MIGRATION_19 = `
-- The findings a person dismissed, by the finding's stable id.
-- Findings themselves are computed on every read and never
-- stored, so this is the only trace of them. Deleted with the
-- session (the cascade, and FORGET_ORDER below). The table
-- migration 1 created for stored findings was never written.
DROP INDEX findings_session;
DROP TABLE findings;
CREATE TABLE finding_dismissals (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, finding_id)
);
`;
const MIGRATION_20 = `
-- What a /context report gave for the memory files (the
-- instruction files loaded at session start), in tokens:
-- Claude Code's own count of them. Null where the report
-- listed no such row, and for reports stored before this
-- column existed.
ALTER TABLE context_reports ADD COLUMN memory_files INTEGER;
`;
const MIGRATION_21 = `
-- The names a startup listing carries, as a JSON array: the
-- skills Claude Code listed to the model. Names only (ADR-0004).
-- Null for every other load, and for listings stored before
-- this column existed.
ALTER TABLE loads ADD COLUMN names TEXT;
`;
const MIGRATION_22 = `
-- The subagent a startup listing belongs to: a subagent's
-- transcript re-sends the listings for its own context. Null
-- for the main thread's loads, and for every load stored
-- before this column existed.
ALTER TABLE loads ADD COLUMN branch_id INTEGER REFERENCES branches(id);
`;
const MIGRATION_23 = `
-- A file a skill attached when it loaded is a load of its own
-- (kind skill-file), pointing at the skill's load, with the
-- file's line count: paths and sizes only (ADR-0004). Null for
-- every other load.
ALTER TABLE loads ADD COLUMN parent_load_id INTEGER REFERENCES loads(id);
ALTER TABLE loads ADD COLUMN line_count INTEGER;
-- The size of a tool output Claude Code saved to a file, from
-- the notice that stood in for it. Null for every step whose
-- output was sent whole.
ALTER TABLE steps ADD COLUMN saved_output_bytes INTEGER;
`;
const MIGRATION_24 = `
-- A subagent's definition was never in its transcript: the
-- loads stored as agent-definition were the reminder or a
-- preloaded skill, mislabelled. Subagents' preloaded skills
-- are loads of kind preloaded-skill now.
DELETE FROM loads WHERE kind = 'agent-definition';
`;
export const MIGRATIONS = [
    { version: 1, sql: MIGRATION_1 },
    { version: 2, sql: MIGRATION_2 },
    { version: 3, sql: MIGRATION_3 },
    { version: 4, sql: MIGRATION_4 },
    { version: 5, sql: MIGRATION_5 },
    { version: 6, sql: MIGRATION_6 },
    { version: 7, sql: MIGRATION_7 },
    { version: 8, sql: MIGRATION_8 },
    { version: 9, sql: MIGRATION_9 },
    { version: 10, sql: MIGRATION_10 },
    { version: 11, sql: MIGRATION_11 },
    { version: 12, sql: MIGRATION_12 },
    { version: 13, sql: MIGRATION_13 },
    { version: 14, sql: MIGRATION_14 },
    { version: 15, sql: MIGRATION_15 },
    { version: 16, sql: MIGRATION_16 },
    { version: 17, sql: MIGRATION_17 },
    { version: 18, sql: MIGRATION_18 },
    { version: 19, sql: MIGRATION_19 },
    { version: 20, sql: MIGRATION_20 },
    { version: 21, sql: MIGRATION_21 },
    { version: 22, sql: MIGRATION_22 },
    { version: 23, sql: MIGRATION_23 },
    { version: 24, sql: MIGRATION_24 },
];
/**
 * The order in which a session's rows are deleted when it is
 * forgotten: children before parents, so no delete trips a foreign
 * key. (Branches and steps also point at each other; forgetSession
 * clears branches.spawning_step_id first to break that cycle.)
 * `sessions` itself and `forgotten` are handled separately. Kept
 * next to the schema so the order is reviewed with it.
 * `row_changes` goes last: the deletes before it write change
 * entries through the triggers, and its own delete ends them.
 */
export const FORGET_ORDER = [
    "human_events",
    "context_samples",
    "context_reports",
    "compaction_files",
    "finding_dismissals",
    "steps",
    "requests",
    "session_shapes",
    "branches",
    "prompt_attachments",
    "turns",
    "segments",
    "session_conditions",
    "pauses",
    "loads",
    "raw_events",
    "row_changes",
];
