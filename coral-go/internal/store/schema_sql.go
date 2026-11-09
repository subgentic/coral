// The database's schema as one script: ensureSchema (connection.go) runs it. Moved out of connection.go (#8213), no code changed.

package store

const schemaSQL = `
CREATE TABLE IF NOT EXISTS chief_checks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL UNIQUE REFERENCES scheduled_jobs(id),
 revision INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, instruction TEXT NOT NULL,
 target_board TEXT NOT NULL,target_session TEXT NOT NULL,notify_mode TEXT NOT NULL,
 source_key TEXT NOT NULL DEFAULT '',wake_if_asleep INTEGER NOT NULL DEFAULT 0,
 schedule_kind TEXT NOT NULL,every_minutes INTEGER NOT NULL DEFAULT 0,at_time TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chief_triggers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,check_id INTEGER NOT NULL REFERENCES chief_checks(id),run_id INTEGER NOT NULL DEFAULT 0,
 delivery_key TEXT NOT NULL UNIQUE,check_name TEXT NOT NULL,instruction TEXT NOT NULL,target_board TEXT NOT NULL,target_session TEXT NOT NULL,notify_mode TEXT NOT NULL,wake_if_asleep INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'open',delivery TEXT NOT NULL DEFAULT 'pending',delivery_error TEXT NOT NULL DEFAULT '',
 reminder TEXT NOT NULL DEFAULT 'none',reminder_error TEXT NOT NULL DEFAULT '',message_id INTEGER NOT NULL DEFAULT 0,
 summary TEXT NOT NULL DEFAULT '',task_id INTEGER NOT NULL DEFAULT 0,ask_id INTEGER NOT NULL DEFAULT 0,brief_id INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reminded_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS chief_one_open ON chief_triggers(check_id) WHERE state!='done';
CREATE INDEX IF NOT EXISTS chief_trigger_outbox ON chief_triggers(delivery,lease_until,id);
CREATE TABLE IF NOT EXISTS chief_run_keys (check_id INTEGER NOT NULL,request_key TEXT NOT NULL,trigger_id INTEGER NOT NULL REFERENCES chief_triggers(id),PRIMARY KEY(check_id,request_key));

CREATE TABLE IF NOT EXISTS agent_ui_panels (
 session_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
 html TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);
CREATE TABLE IF NOT EXISTS agent_ui_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
 panel_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL,
 payload TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(session_id,panel_id) REFERENCES agent_ui_panels(session_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_ui_events ON agent_ui_events(session_id,panel_id,id);

-- The Operator's "Keep Full access when this agent restarts" choice for a Codex agent (#14061): a row is the choice being on. A table of its own, as auto_sleep_state is: a live_sessions row that is
-- registered again does not lose it, and only the Operator's route writes it.
CREATE TABLE IF NOT EXISTS keep_full_access (
	session_id TEXT PRIMARY KEY,
	set_at     INTEGER NOT NULL,
	source     TEXT NOT NULL DEFAULT 'local' -- 'local' (the dashboard, the command line, the API key) or 'hub' (the Hub owner, through the tunnel): a choice the hub made ends with the hub's switch, as a hub-enabled auto-accept does (#14193)
);

CREATE TABLE IF NOT EXISTS auto_sleep_state (
	session_id TEXT PRIMARY KEY,
	off        INTEGER NOT NULL DEFAULT 0,
	slept_at   INTEGER,
	woken_at   INTEGER,
	first_turn_logged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_meta (
	session_id   TEXT PRIMARY KEY,
	notes_md     TEXT DEFAULT '',
	auto_summary TEXT DEFAULT '',
	is_user_edited INTEGER DEFAULT 0,
	display_name TEXT,
	created_at   TEXT NOT NULL,
	updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
	id    INTEGER PRIMARY KEY AUTOINCREMENT,
	name  TEXT UNIQUE NOT NULL,
	color TEXT NOT NULL DEFAULT '#58a6ff'
);

CREATE TABLE IF NOT EXISTS session_tags (
	session_id TEXT NOT NULL,
	tag_id     INTEGER NOT NULL,
	PRIMARY KEY (session_id, tag_id),
	FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folder_tags (
	folder_name TEXT NOT NULL,
	tag_id      INTEGER NOT NULL,
	PRIMARY KEY (folder_name, tag_id),
	FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Folders the Operator pinned to the Agents list (#3630): shown even with no agents in them.
CREATE TABLE IF NOT EXISTS pinned_folders (
	path      TEXT PRIMARY KEY,
	pinned_at TEXT NOT NULL
);

-- Messages the Operator saved for later (#4510): a bookmark on one message of an agent's chat or a board, with a snippet, until it is removed.
-- msg_key is the message's stable key (the chat route's "key", a board message's id), so a bookmark survives a reload and transcript paging.
-- Custom models (#5480): a model id the operator adds for a provider (family: claude, codex, agy, pi, opencode) with the thinking levels it takes (efforts, a JSON array). The set is
-- replaced as a whole (position keeps the order sent); validation is agentmodels.ValidateCustomSet, and a row read back is checked again.
CREATE TABLE IF NOT EXISTS custom_models (
	family       TEXT NOT NULL,
	value        TEXT NOT NULL,
	display_name TEXT NOT NULL DEFAULT '',
	efforts      TEXT NOT NULL DEFAULT '[]',
	position     INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (family, value)
);

CREATE TABLE IF NOT EXISTS saved_messages (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	kind       TEXT NOT NULL,
	ref        TEXT NOT NULL,
	msg_key    TEXT NOT NULL,
	agent_type TEXT NOT NULL DEFAULT '',
	title      TEXT NOT NULL DEFAULT '',
	snippet    TEXT NOT NULL DEFAULT '',
	said_at    TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	done_at    TEXT,
	UNIQUE (kind, ref, msg_key)
);

-- Comments on an artifact (#5176): a comment belongs to that exact artifact id (content-addressed, so its text never changes). parent_id is one level of replies. anchor_json is the
-- quote, its context and line range (or whole-document), kept as sent. The author is (author_issuer, author_subject): who vouches for the identity and who it is, so ownership is one
-- comparison: 'local' and the local user for the owner not signed in to Coral Hub, the hub's origin and its account for a hub identity (today a hub viewer's hub-user id), an agent's
-- session for an agent; author_kind is owner, hub or agent and author_name an optional display name (text, capped, empty until the hub sends one).
-- A deleted comment is a tombstone (deleted_at, an empty body) so its replies keep their place. The owner's lock switch is per artifact or per board (artifact_comment_locks).
CREATE TABLE IF NOT EXISTS artifact_comments (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	artifact_id TEXT NOT NULL,
	board       TEXT NOT NULL DEFAULT '',
	parent_id   INTEGER,
	anchor_json TEXT NOT NULL DEFAULT '',
 at_s REAL,
 end_s REAL,
	body        TEXT NOT NULL,
	author_issuer  TEXT NOT NULL,
	author_subject TEXT NOT NULL,
	author_name    TEXT NOT NULL DEFAULT '',
	author_kind    TEXT NOT NULL,
	created_at  TEXT NOT NULL,
	edited_at   TEXT,
	resolved_by_issuer  TEXT,
	resolved_by_subject TEXT,
	resolved_at TEXT,
	deleted_at  TEXT,
	images_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact ON artifact_comments(artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent ON artifact_comments(parent_id);
-- When the Operator last opened the threads of an artifact (#12026): one row per thread (its first comment). An agent's reply made after that is "new comments" on the file's row; opening the thread clears it.
CREATE TABLE IF NOT EXISTS artifact_comment_seen (
	comment_id INTEGER PRIMARY KEY,
	seen_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_comment_locks (
	scope TEXT NOT NULL,
	key   TEXT NOT NULL,
	PRIMARY KEY (scope, key)
);

-- Send to agent (#6357, #6443): the owner asked one agent into one comment's thread. An agent may reply only into a thread it was asked into, so a reply is checked against this row in
-- one step (open, not expired, under its reply cap, the session still the one asked). One row per (comment, agent session); asking again after it ended or expired starts it anew.
-- No text is kept here (the comment is its own row); version_id is the exact artifact the owner sent the comment for.
CREATE TABLE IF NOT EXISTS artifact_comment_asks (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	comment_id    INTEGER NOT NULL,
	artifact_id   TEXT NOT NULL,
	board         TEXT NOT NULL,
	agent_session TEXT NOT NULL,
	agent_name    TEXT NOT NULL DEFAULT '',
	created_at    TEXT NOT NULL,
	expires_at    TEXT NOT NULL,
	closed_at     TEXT,
	replies       INTEGER NOT NULL DEFAULT 0,
	seen_at       TEXT,
	nudged_at     TEXT,
	read_at       TEXT,
	UNIQUE (comment_id, agent_session)
);
CREATE INDEX IF NOT EXISTS idx_artifact_comment_asks_artifact ON artifact_comment_asks(artifact_id);

-- The board message that delivered a comment to one agent (#14130): coral-board read of that message by that agent is when the agent read the comment (artifact_comment_asks.read_at). One row per (board,
-- message); the agent session is the one the message was for, so another member reading the message (an orchestrator reads every message) stamps nothing. No text is kept.
CREATE TABLE IF NOT EXISTS artifact_comment_messages (
	board         TEXT NOT NULL,
	message_id    INTEGER NOT NULL,
	comment_id    INTEGER NOT NULL,
	agent_session TEXT NOT NULL,
	PRIMARY KEY (board, message_id)
);

-- Agents that published a claude.ai artifact (#6583): one reminder per artifact. key is the kind and the sha256 of the rest (never a path or url): "tool:<session>:<artifact key>" for a publish seen in an agent's tool call,
-- or "link:<claude.ai artifact id>" for a link on the board or in an agent's reply (one row for the whole board, so a link passed along nudges nobody twice).
-- No text of the page or the link beyond its id is kept; rows are deleted after 30 days.
CREATE TABLE IF NOT EXISTS claude_artifact_nudges (
	key        TEXT PRIMARY KEY,
	session_id TEXT NOT NULL DEFAULT '',
	seen_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claude_artifact_nudges_seen ON claude_artifact_nudges(seen_at);

-- Operator mailbox flags survive transcript reindexing; board chats use their history id (board:<id>).
CREATE TABLE IF NOT EXISTS chat_flags (
    session_id TEXT PRIMARY KEY,
    starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);

-- A request of an agent that the Operator hid from Needs you with Dismiss (#11946): one row per agent, naming the request (when it began); a different request is not hidden by it.
CREATE TABLE IF NOT EXISTS agent_wait_ignored (
    session_id  TEXT PRIMARY KEY,
    request_key TEXT NOT NULL,
    ignored_at  TEXT NOT NULL,
    removed_at  TEXT
);

CREATE TABLE IF NOT EXISTS session_index (
	session_id      TEXT PRIMARY KEY,
	source_type     TEXT NOT NULL,
	source_file     TEXT NOT NULL,
	first_timestamp TEXT,
	last_timestamp  TEXT,
	message_count   INTEGER DEFAULT 0,
	display_summary TEXT DEFAULT '',
	indexed_at      TEXT NOT NULL,
	file_mtime      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_index_last_ts
	ON session_index(last_timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS session_fts
	USING fts5(session_id, body, tokenize='porter');

-- The Skills Store (#12020, goal #191): one row per version of a skill (the zip is an artifact, named here by its digest), its parsed fields, and where it stands with the Operator. A removed skill keeps
-- a tombstone (no text) so a pinned agent is told it was removed. skills_fts holds only approved skills; skills_log records who published, approved, rejected or removed which digest.
CREATE TABLE IF NOT EXISTS skills (
	id              TEXT PRIMARY KEY,
	name            TEXT NOT NULL,
	version         INTEGER NOT NULL,
	digest          TEXT NOT NULL,
	description     TEXT NOT NULL DEFAULT '',
	metadata_json   TEXT NOT NULL DEFAULT '{}',
	files_json      TEXT NOT NULL DEFAULT '[]',
	has_scripts     INTEGER NOT NULL DEFAULT 0,
	not_reviewable  INTEGER NOT NULL DEFAULT 0,
	status          TEXT NOT NULL,
	publisher_kind  TEXT NOT NULL,
	publisher_agent TEXT NOT NULL DEFAULT '',
	publisher_team  TEXT NOT NULL DEFAULT '',
	scripts_acked   INTEGER NOT NULL DEFAULT 0,
	created_at      TEXT NOT NULL,
	decided_at      TEXT NOT NULL DEFAULT '',
	UNIQUE (name, version),
	UNIQUE (name, digest)
);

CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts
	USING fts5(skill_id UNINDEXED, name, description, tags, body, tokenize='porter');

-- What the Operator rejected or removed, by the zip's digest: an agent cannot publish those bytes again. Its own table, not the access log, which is trimmed to 10,000 rows and could not be
-- made to forget it by searching.
-- The skills attached to a launched agent, pinned to the version and digest approved when it was launched (#12023): a newer approved version is shown as an update, never swapped in under a running agent.
CREATE TABLE IF NOT EXISTS skills_attached (
	session_id  TEXT NOT NULL,
	skill_id    TEXT NOT NULL,
	name        TEXT NOT NULL,
	version     INTEGER NOT NULL,
	digest      TEXT NOT NULL,
	attached_at TEXT NOT NULL,
	PRIMARY KEY (session_id, skill_id)
);

-- What an agent LOADED through the Skills Store (#13208, goal #218): one row per session and skill, kept when the agent reads the skill with skills get (a search or a list is not a load). Names, versions and times only: no skill text, no caller words.
CREATE TABLE IF NOT EXISTS skills_loaded (
	session_id TEXT NOT NULL,
	skill_id   TEXT NOT NULL,
	name       TEXT NOT NULL,
	version    INTEGER NOT NULL,
	digest     TEXT NOT NULL,
	first_at   TEXT NOT NULL,
	last_at    TEXT NOT NULL,
	loads      INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (session_id, skill_id)
);

-- RecordSkillLoad's age sweep reads by last_at on every load: an index, so it is a range scan and not a walk of the table.
CREATE INDEX IF NOT EXISTS idx_skills_loaded_last_at ON skills_loaded(last_at);

CREATE TABLE IF NOT EXISTS skills_refused (
	digest TEXT PRIMARY KEY,
	at     TEXT NOT NULL,
	event  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	at         TEXT NOT NULL,
	event      TEXT NOT NULL,
	skill_id   TEXT NOT NULL,
	digest     TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	actor      TEXT NOT NULL DEFAULT '',
	detail     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_skills_log_at ON skills_log(at);

CREATE TABLE IF NOT EXISTS summarizer_queue (
	session_id   TEXT PRIMARY KEY,
	status       TEXT NOT NULL DEFAULT 'pending',
	attempted_at TEXT,
	error_msg    TEXT
);

CREATE TABLE IF NOT EXISTS git_snapshots (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_name        TEXT NOT NULL,
	agent_type        TEXT NOT NULL,
	working_directory TEXT NOT NULL,
	branch            TEXT NOT NULL,
	commit_hash       TEXT NOT NULL,
	commit_subject    TEXT DEFAULT '',
	commit_timestamp  TEXT,
	session_id        TEXT,
	remote_url        TEXT,
	recorded_at       TEXT NOT NULL,
	UNIQUE(session_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS agent_tasks (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_name  TEXT NOT NULL,
	session_id  TEXT,
	title       TEXT NOT NULL,
	completed   INTEGER DEFAULT 0,
	sort_order  INTEGER DEFAULT 0,
	created_at  TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notes (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_name  TEXT NOT NULL,
	session_id  TEXT,
	content     TEXT NOT NULL,
	created_at  TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_events (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_name  TEXT NOT NULL,
	session_id  TEXT,
	event_type  TEXT NOT NULL,
	tool_name   TEXT,
	summary     TEXT NOT NULL,
	detail_json TEXT,
	created_at  TEXT NOT NULL,
	duration_ms INTEGER,
	ref_id      TEXT
);

CREATE TABLE IF NOT EXISTS live_sessions (
	session_id    TEXT PRIMARY KEY,
	agent_type    TEXT NOT NULL,
	agent_name    TEXT NOT NULL,
	working_dir   TEXT NOT NULL,
	display_name  TEXT,
	resume_from_id TEXT,
	flags         TEXT,
	is_job        INTEGER NOT NULL DEFAULT 0,
	created_at    TEXT NOT NULL
);

-- Derived metadata only: excluded rollout files still stay on disk.
CREATE TABLE IF NOT EXISTS history_exclusions (
 source_type TEXT NOT NULL,
 source_file TEXT NOT NULL,
 file_mtime REAL NOT NULL,
 index_version INTEGER NOT NULL,
 PRIMARY KEY (source_type, source_file)
);

-- Chats Coral did not start, found on this computer and held back until the person imports them (#11970). Metadata only (where the file is, its mtime, its session id and CLI):
-- no text is kept, and the file's mtime is here so a pass does not read it again.
CREATE TABLE IF NOT EXISTS history_unimported (
 source_type TEXT NOT NULL,
 source_file TEXT NOT NULL,
 file_mtime REAL NOT NULL,
 session_id TEXT NOT NULL,
 PRIMARY KEY (source_type, source_file)
);

-- When a live session's model or thinking level was last set by Coral and the CLI took it: confirmed from its own entry, or put on its command line at a wake (#6225). A turn the transcript
-- recorded before that is older than the setting.
CREATE TABLE IF NOT EXISTS live_session_settings (
 session_id TEXT PRIMARY KEY,
 set_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	name            TEXT NOT NULL,
	description     TEXT DEFAULT '',
	cron_expr       TEXT NOT NULL,
	timezone        TEXT NOT NULL DEFAULT 'UTC',
	agent_type      TEXT NOT NULL DEFAULT 'claude',
	repo_path       TEXT NOT NULL,
	base_branch     TEXT DEFAULT 'main',
	prompt          TEXT NOT NULL,
	enabled         INTEGER NOT NULL DEFAULT 1,
	max_duration_s  INTEGER NOT NULL DEFAULT 3600,
	cleanup_worktree INTEGER NOT NULL DEFAULT 1,
	no_worktree     INTEGER NOT NULL DEFAULT 0,
	flags           TEXT DEFAULT '',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled
	ON scheduled_jobs(enabled, id);

CREATE TABLE IF NOT EXISTS scheduled_runs (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	job_id          INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
	session_id      TEXT,
	worktree_path   TEXT,
	status          TEXT NOT NULL DEFAULT 'pending',
	scheduled_at    TEXT NOT NULL,
	started_at      TEXT,
	finished_at     TEXT,
	exit_reason     TEXT,
	error_msg       TEXT,
	created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_job
	ON scheduled_runs(job_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_session
	ON scheduled_runs(session_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_status
	ON scheduled_runs(status, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS git_changed_files (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_name        TEXT NOT NULL,
	session_id        TEXT,
	working_directory TEXT NOT NULL,
	filepath          TEXT NOT NULL,
	additions         INTEGER NOT NULL DEFAULT 0,
	deletions         INTEGER NOT NULL DEFAULT 0,
	status            TEXT NOT NULL DEFAULT 'M',
	recorded_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_git_changed_files_session
	ON git_changed_files(session_id);

CREATE INDEX IF NOT EXISTS idx_git_changed_files_agent
	ON git_changed_files(agent_name);

CREATE TABLE IF NOT EXISTS workflows (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	name               TEXT NOT NULL UNIQUE,
	description        TEXT DEFAULT '',
	steps_json         TEXT NOT NULL DEFAULT '[]',
	default_agent_json TEXT DEFAULT '',
	repo_path          TEXT DEFAULT '',
	base_branch        TEXT DEFAULT 'main',
	max_duration_s     INTEGER NOT NULL DEFAULT 3600,
	cleanup_worktree   INTEGER NOT NULL DEFAULT 1,
	enabled            INTEGER NOT NULL DEFAULT 1,
	created_at         TEXT NOT NULL,
	updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	workflow_id     INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
	trigger_type    TEXT NOT NULL DEFAULT 'api',
	trigger_context TEXT,
	status          TEXT NOT NULL DEFAULT 'pending',
	current_step    INTEGER NOT NULL DEFAULT 0,
	step_results    TEXT NOT NULL DEFAULT '[]',
	worktree_path   TEXT DEFAULT '',
	started_at      TEXT,
	finished_at     TEXT,
	error_msg       TEXT,
	created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
	ON workflow_runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
	ON workflow_runs(status);

-- Retained remote-board subscriptions used by the background poller and
-- remote-board API. This table is intentionally separate from retired
-- provider credentials and proxy state.
CREATE TABLE IF NOT EXISTS remote_board_subscriptions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id           TEXT NOT NULL,
    remote_server        TEXT NOT NULL,
    project              TEXT NOT NULL,
    job_title            TEXT NOT NULL,
    last_notified_unread INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    UNIQUE(session_id, remote_server, project)
);

-- Registered remote Coral servers for the multi-server hub. api_key holds a
-- "v1:" AES-256-GCM envelope (see internal/secretbox), never plaintext.
CREATE TABLE IF NOT EXISTS remote_servers (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    url           TEXT NOT NULL,
    api_key       TEXT NOT NULL,
    allow_private INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'unknown',
    created_at    TEXT NOT NULL,
    last_seen     TEXT,
    last_error    TEXT
);

-- This server's single Cloud Hub enrollment. token holds a "v1:" secretbox
-- envelope (see pkg/secretbox), never plaintext.
CREATE TABLE IF NOT EXISTS cloud_connection (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    hub_url    TEXT NOT NULL,
    server_id  TEXT NOT NULL,
    label      TEXT NOT NULL,
    token      TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_error TEXT
);

-- This database's Dropbox sign-in (#14609, Dropbox stage 3a). One row, made the first time the server id is asked for, and kept through a
-- disconnect: server_id belongs to the database (a restored copy keeps it). refresh_token holds a "v1:" secretbox envelope bound to
-- account_id as AAD, never plaintext; NULL when not connected. fingerprint is SHA-256 of fp_salt, the machine id and the data folder (never
-- the machine id itself). last_account_id is the account of the last connection, so a connect to another account is a confirmed switch.
CREATE TABLE IF NOT EXISTS dropbox_connection (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    server_id       TEXT NOT NULL,
    fp_salt         TEXT NOT NULL,
    account_id      TEXT,
    last_account_id TEXT,
    refresh_token   TEXT,
    fingerprint     TEXT,
    state           TEXT NOT NULL DEFAULT 'disconnected',
    connected_at    TEXT,
    filter_types    TEXT NOT NULL DEFAULT '',  -- stage 4 (#14655): the chosen extensions, comma-separated; '' is every type
    max_age_days    INTEGER NOT NULL DEFAULT 0, -- only artifacts newer than this many days; 0 is no limit
    retention_days      INTEGER NOT NULL DEFAULT 0, -- stage 4b (#14703): delete the Dropbox copies older than this many days; 0 is off (the default)
    retention_since     TEXT,                       -- when the Operator confirmed it
    retention_last_pass TEXT,                       -- the last retention pass (a local clock earlier than this refuses a pass)
    list_cursor         TEXT,                       -- stage 5a (#14714): the listing cursor of /v1 for the account connected now; cleared by any new sign-in
    autosync_off        INTEGER NOT NULL DEFAULT 0, -- 5a auto-sync (#14714, the Operator): 1 when the Operator turned off "Take edits made in Dropbox as new versions"
    autosync_paused     TEXT NOT NULL DEFAULT ''    -- why auto-sync is paused ('' runs): signin (another account, a disconnect, a re-key) or breaker (too many in an hour)
);

-- Dropbox stage 4's outbox (#14655): one row per file to back up (an artifact version or its item_data sidecar), by its Dropbox path (ids only,
-- never a name). artifact_at is the artifact's own time (newest first). Rows hold no names, request ids or bytes. state: queued (handed out when
-- next_try_at has passed), done (file_id, rev and content_hash from Dropbox), conflict and skipped (parked, never handed out again), failed.
CREATE TABLE IF NOT EXISTS dropbox_outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    digest       TEXT NOT NULL,
    doc_id       TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    path         TEXT NOT NULL UNIQUE,
    artifact_at  TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'queued',
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_try_at  TEXT NOT NULL DEFAULT '',
    file_id      TEXT,
    rev          TEXT,
    content_hash TEXT,
    secret_flag  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    done_at      TEXT,
    account_id   TEXT,                      -- stage 4b (#14703): the Dropbox account the file was stored in (retention reads only the current one's)
    size         INTEGER NOT NULL DEFAULT 0, -- its bytes, for retention's dry-run count
    delete_job   TEXT                       -- a retention delete job still running for this row (state deleting)
);
CREATE INDEX IF NOT EXISTS idx_dropbox_outbox_due ON dropbox_outbox(state, next_try_at, artifact_at);

-- Dropbox stage 5a (#14714): edits made in Dropbox, held for the Operator. The edited bytes are an object (digest) with NO upload record until a
-- decision, so nothing that lists, searches, links, grants or serves uploads can show them. One pending row a document (a newer edit replaces it).
-- path is the ledger's own path (a Coral-made string), never anything from a listing. state: pending, deciding (a decision being written: retention
-- still holds it), promoted, separate.
CREATE TABLE IF NOT EXISTS dropbox_edits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    version     INTEGER NOT NULL,
    orig_digest TEXT NOT NULL,
    path        TEXT NOT NULL,
    digest      TEXT NOT NULL,
    media_type  TEXT NOT NULL,
    size        INTEGER NOT NULL,
    rev         TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'pending',
    seen_at     TEXT NOT NULL,
    decided_at  TEXT,
    result      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dropbox_edits_open ON dropbox_edits(doc_id) WHERE state IN ('pending', 'deciding');

-- Removals from Dropbox after the Operator deleted an artifact here (#14814, the Operator's answer 3 and Security's conditions on it): one row an
-- object, queued by the Operator's own delete only, run by the backup worker once due_at has passed (a 24-hour grace), retried with backoff,
-- cancelled by an upload of the same bytes. state: waiting; held (many deletes at once: nothing goes until the Operator confirms in Settings);
-- kept (another Coral keeps it only in Dropbox, or its markers could not be read: left alone, listed); edited (edited in Dropbox: listed with
-- Remove anyway). A finished removal leaves no row (the outbox rows say removed). name is the file's name when it was deleted, for Settings only.
CREATE TABLE IF NOT EXISTS dropbox_removals (
    digest      TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL,
    queued_at   TEXT NOT NULL,
    due_at      TEXT NOT NULL,
    next_try_at TEXT NOT NULL DEFAULT '',
    attempts    INTEGER NOT NULL DEFAULT 0,
    reason      TEXT NOT NULL DEFAULT '',
    others      TEXT NOT NULL DEFAULT '',
    unknown     INTEGER NOT NULL DEFAULT 0,
    edited      TEXT NOT NULL DEFAULT ''
);

-- Dropbox stage 4b's audit (#14703): each retention setting change (who, old and new days, the dry-run count the page showed) and each retention
-- pass (counts and bytes). Never a name, path, digest or token. The newest 500 rows are kept.
CREATE TABLE IF NOT EXISTS dropbox_audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT NOT NULL,
    kind     TEXT NOT NULL,              -- setting or pass
    who      TEXT NOT NULL DEFAULT '',   -- operator (the person at this computer) for a setting; '' for a pass
    old_days INTEGER NOT NULL DEFAULT 0,
    new_days INTEGER NOT NULL DEFAULT 0,
    count    INTEGER NOT NULL DEFAULT 0, -- a setting: the dry-run count shown; a pass: files deleted
    bytes    INTEGER NOT NULL DEFAULT 0,
    held     INTEGER NOT NULL DEFAULT 0, -- a pass: due files left for later by the ceiling
    reason   TEXT NOT NULL DEFAULT ''    -- a pass that deleted nothing: the reason word (clock_behind, clock_skew, ...); an edit decision: promoted or separate
);
CREATE INDEX IF NOT EXISTS idx_dropbox_outbox_digest ON dropbox_outbox(digest);

-- Coral Hub enrollment in progress, and its rate limit (one row). The device code is
-- sealed like the server token. Kept across restarts so a restart loop reuses one code
-- instead of asking the hub for a new one each time.
CREATE TABLE IF NOT EXISTS cloud_enrollment (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    hub_url          TEXT NOT NULL,
    device_code      TEXT NOT NULL DEFAULT '',
    user_code        TEXT NOT NULL DEFAULT '',
    verification_url TEXT NOT NULL DEFAULT '',
    interval_s       INTEGER NOT NULL DEFAULT 5,
    expires_at       TEXT NOT NULL DEFAULT '',
    next_start_at    TEXT NOT NULL DEFAULT '',
    failures         INTEGER NOT NULL DEFAULT 0
);

-- Artifacts the Operator keeps (#3554): never pruned, whatever their age or references.
CREATE TABLE IF NOT EXISTS artifact_keep (
    hex     TEXT PRIMARY KEY,
    kept_at TEXT NOT NULL
);

-- HTML files whose preview the owner trusted to run its scripts (#14730, design v3): per EXACT bytes (the object's digest) on this computer; a new version has a new digest and is untrusted again; undone by deleting the row.
CREATE TABLE IF NOT EXISTS artifact_preview_trust (
    hex        TEXT PRIMARY KEY,
    trusted_at TEXT NOT NULL
);

-- Artifacts the Operator stars (#9819), to find them again: per artifact id (the object's digest) and per computer; no effect on what is stored or pruned.
CREATE TABLE IF NOT EXISTS artifact_stars (
    hex        TEXT PRIMARY KEY,
    starred_at TEXT NOT NULL
);

-- The newest version of a series the Operator has opened (#13910, the row's "New version v3"): one row per person, team (board id) and series, only ever raised. The person is the owner's constant key on a
-- personal computer, and the verified Hub user on a team's computer. It follows a series when the series is deleted.
-- The stars of any person other than the machine's owner key (#13910): on an organisation's computer each Hub user pins their own. The owner key's stars stay in artifact_stars above, so an upgrade loses none.
CREATE TABLE IF NOT EXISTS artifact_person_stars (
    person     TEXT NOT NULL,
    hex        TEXT NOT NULL,
    starred_at TEXT NOT NULL,
    PRIMARY KEY (person, hex)
);

CREATE TABLE IF NOT EXISTS artifact_series_opened (
    person    TEXT NOT NULL,
    board_id  TEXT NOT NULL,
    series_id TEXT NOT NULL,
    version   INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (person, board_id, series_id)
);

CREATE TABLE IF NOT EXISTS custom_views (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT NOT NULL,
	prompt     TEXT NOT NULL DEFAULT '',
	html       TEXT NOT NULL DEFAULT '',
	tab_order  INTEGER NOT NULL DEFAULT 0,
	scope      TEXT NOT NULL DEFAULT 'global',
	created_via TEXT NOT NULL DEFAULT 'api',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    config_json     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'sleeping', 'stopped')),
    working_dir     TEXT NOT NULL,
    is_worktree     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    stopped_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);

CREATE TABLE IF NOT EXISTS team_members (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    agent_name        TEXT NOT NULL,
    agent_config_json TEXT NOT NULL,
    session_id        TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'sleeping', 'stopped')),
    created_at        TEXT NOT NULL,
    stopped_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id, status);

-- What an agent's chat search may reach (#11048): own (its one board), team, all, operator. Only the Operator raises it; kind 'raise' rows record the change, 'read' rows a search above own (counts, never text).
CREATE TABLE IF NOT EXISTS search_access_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    action     TEXT NOT NULL DEFAULT '',
    target     TEXT NOT NULL DEFAULT '',
    team       TEXT NOT NULL DEFAULT '',
    agent      TEXT NOT NULL DEFAULT '',
    from_level TEXT NOT NULL DEFAULT '',
    to_level   TEXT NOT NULL DEFAULT '',
    set_by     TEXT NOT NULL DEFAULT '',
    via        TEXT NOT NULL DEFAULT '',
    outcome    TEXT NOT NULL DEFAULT '',
    results    INTEGER NOT NULL DEFAULT 0,
    at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_access_log_at ON search_access_log(at);

-- Subagents launched by a main agent. Kept separate from live_sessions: a
-- subagent is not a Coral-managed agent (no tmux session, board, or prompt),
-- it is work a main agent delegated. session_id is the relational tie back to
-- the main agent that launched it.
CREATE TABLE IF NOT EXISTS subagents (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES live_sessions(session_id) ON DELETE CASCADE,
    subagent_id        TEXT NOT NULL,
    subagent_type      TEXT,
    description        TEXT,
    tool_use_id        TEXT,
    model              TEXT,
    spawn_depth        INTEGER NOT NULL DEFAULT 0,
    api_calls          INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    finished           INTEGER NOT NULL DEFAULT 0,
    transcript_path    TEXT,
    started_at         TEXT,
    last_activity_at   TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE(session_id, subagent_id)
);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);

CREATE TABLE IF NOT EXISTS token_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    agent_name      TEXT NOT NULL,
    agent_type      TEXT NOT NULL DEFAULT 'claude',
    team_id         INTEGER,
    board_name      TEXT,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    num_turns       INTEGER NOT NULL DEFAULT 0,
    recorded_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_type TEXT NOT NULL,
    operation TEXT NOT NULL,
    agent_name TEXT,
    session_id TEXT,
    team_id INTEGER,
    board_name TEXT,
    method TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    is_error INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_metrics_created ON call_metrics(created_at);

-- Raw call metrics older than a day, one row per hour and kind of call (#4098).
CREATE TABLE IF NOT EXISTS call_metrics_hourly (
    hour TEXT NOT NULL,
    call_type TEXT NOT NULL,
    operation TEXT NOT NULL,
    agent_name TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    board_name TEXT NOT NULL DEFAULT '',
    calls INTEGER NOT NULL,
    errors INTEGER NOT NULL DEFAULT 0,
    duration_sum_ms INTEGER NOT NULL DEFAULT 0,
    duration_n INTEGER NOT NULL DEFAULT 0,
    p50_ms INTEGER NOT NULL DEFAULT 0,
    p95_ms INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hour, call_type, operation, agent_name, session_id, board_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_session_time ON token_usage(session_id, recorded_at);

-- The Cost view's breakdown by thinking level (#4969): the usage of the calls whose turn recorded a level, summed by UTC hour, agent type, model
-- (the call's model, as the By Model table has it; '' for a call that named none and for the rows kept from before the model was in the key, #5120) and
-- level, kept when a call is recorded (once: a repeated report of the same call is ignored, as the usage rows ignore it). Calls that
-- recorded no level are not here: the view shows them as "Not reported". It is small and kept as the usage history is.
CREATE TABLE IF NOT EXISTS token_usage_thinking (
    hour               TEXT NOT NULL,
    agent_type         TEXT NOT NULL,
    model              TEXT NOT NULL DEFAULT '',
    thinking           TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens       INTEGER NOT NULL DEFAULT 0,
    thinking_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    n_calls            INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, agent_type, model, thinking)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_token_usage_team ON token_usage(team_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(recorded_at);

-- One row per goal generation attempt (background GoalGenerator), kept for
-- GET /api/goals/metrics and pruned after GoalMetricsRetention.
CREATE TABLE IF NOT EXISTS goal_generations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL,
    agent_name         TEXT NOT NULL DEFAULT '',
    agent_type         TEXT NOT NULL DEFAULT '',
    trigger            TEXT NOT NULL,
    outcome            TEXT NOT NULL,
    goal               TEXT NOT NULL DEFAULT '',
    error              TEXT NOT NULL DEFAULT '',
    duration_ms        INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    transcript_bytes   INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_generations_time ON goal_generations(created_at);

-- Per-session agent tokens (#3387, identity phase 1). Only the SHA-256 of a token is
-- kept; minting for a session revokes its previous token.
CREATE TABLE IF NOT EXISTS session_tokens (
    token_hash   TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    session_name TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_tokens_session ON session_tokens(session_id);

-- Browser sign-ins (#3949): a sign-in link, the API-key form or the password. Only the
-- SHA-256 of the cookie value is kept; times are unix seconds; expires_at is absolute.
CREATE TABLE IF NOT EXISTS browser_sessions (
    id_hash     TEXT PRIMARY KEY,
    label       TEXT NOT NULL DEFAULT '',
    method      TEXT NOT NULL DEFAULT '',
    persistent  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_expires ON browser_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_goal_generations_session ON goal_generations(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_git_snap_session ON git_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag_id ON session_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_folder_tags_tag_id ON folder_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_session_index_first_ts ON session_index(first_timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_events_session_time ON agent_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_session_type_time ON agent_events(session_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_name, session_id);
-- An agent's events newest first without sorting all of them (the agent poll, #3846).
CREATE INDEX IF NOT EXISTS idx_agent_events_agent_time ON agent_events(agent_name, created_at);
-- Named by INDEXED BY in the edited-file queries; keep the WHERE in step with them.
-- json_valid keeps a malformed detail_json row out of the index: json_extract
-- would otherwise fail the CREATE (and so startup) and the row's INSERT.
CREATE INDEX IF NOT EXISTS idx_agent_events_edited_files ON agent_events(session_id, json_extract(detail_json, '$.file_path'))
	WHERE event_type = 'tool_use' AND tool_name IN ('Write', 'Edit') AND detail_json IS NOT NULL AND json_valid(detail_json);
CREATE INDEX IF NOT EXISTS idx_git_snap_session_time ON git_snapshots(session_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_git_snap_agent_time ON git_snapshots(agent_name, recorded_at DESC);
`
