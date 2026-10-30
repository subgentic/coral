// The database's schema as one script: ensureSchema (connection.go) runs it. Moved out of connection.go (#8213), no code changed.

package store

const schemaSQL = `
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
-- Custom models (#5480): a model id the operator adds for a provider (family: claude, codex, agy, pi) with the thinking levels it takes (efforts, a JSON array). The set is
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
	deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact ON artifact_comments(artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent ON artifact_comments(parent_id);
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
	UNIQUE (comment_id, agent_session)
);
CREATE INDEX IF NOT EXISTS idx_artifact_comment_asks_artifact ON artifact_comment_asks(artifact_id);

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

-- Artifacts the Operator stars (#9819), to find them again: per artifact id (the object's digest) and per computer; no effect on what is stored or pruned.
CREATE TABLE IF NOT EXISTS artifact_stars (
    hex        TEXT PRIMARY KEY,
    starred_at TEXT NOT NULL
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
