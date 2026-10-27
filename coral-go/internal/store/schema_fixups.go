// The column additions run after the schema script and the one-time data fix-ups of an existing database, moved out of connection.go (#8213, no code changed).

package store

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/dbcrypt"
	"github.com/subgentic/coral/internal/gitutil"
)

var columnMigrations = []struct {
	table, column, definition string
}{
	// The thinking level a call ran at, kept on each usage row from now on (#8915): what the transcript recorded for the call, else the level the agent's session was set to when a live call was
	// recorded. NULL on every older row (the analytics show "Not recorded"); a rolled-up hourly row keeps it too (token_usage_hourly groups by it).
	{"token_usage", "thinking", "TEXT"},
	{"token_usage_hourly", "thinking", "TEXT"},
	// Why a run failed, as a fixed word, and the agent CLI it concerns (#5469): "not_signed_in" and "claude". NULL on every other run.
	{"workflow_runs", "error_code", "TEXT"},
	{"workflow_runs", "agent_type", "TEXT"},
	{"scheduled_runs", "error_code", "TEXT"},
	{"scheduled_runs", "agent_type", "TEXT"},
	// Existing views have unknown provenance, so they migrate as "api": the dashboard asks once before running them.
	{"custom_views", "created_via", "TEXT NOT NULL DEFAULT 'api'"},
	// Where a bookmark belongs (#4792): its team (the board), and for a board message who wrote it (NULL: not looked up yet).
	{"saved_messages", "team", "TEXT NOT NULL DEFAULT ''"},
	{"saved_messages", "author", "TEXT"},
	{"agent_notes", "session_id", "TEXT"},
	{"agent_tasks", "session_id", "TEXT"},
	{"session_meta", "display_name", "TEXT"},
	{"live_sessions", "resume_from_id", "TEXT"},
	{"live_sessions", "flags", "TEXT"},
	{"live_sessions", "is_job", "INTEGER NOT NULL DEFAULT 0"},
	{"live_sessions", "prompt", "TEXT"},
	{"live_sessions", "board_name", "TEXT"},
	{"live_sessions", "board_server", "TEXT"},
	{"live_sessions", "backend", "TEXT DEFAULT 'tmux'"},
	{"live_sessions", "icon", "TEXT"},
	{"scheduled_jobs", "flags", "TEXT DEFAULT ''"},
	{"scheduled_runs", "trigger_type", "TEXT DEFAULT 'cron'"},
	{"scheduled_runs", "webhook_url", "TEXT"},
	{"scheduled_runs", "display_name", "TEXT"},
	{"live_sessions", "is_sleeping", "INTEGER NOT NULL DEFAULT 0"},
	{"live_sessions", "board_type", "TEXT"},
	{"live_sessions", "git_diff_mode", "TEXT"},
	{"live_sessions", "capabilities", "TEXT"},
	{"live_sessions", "model", "TEXT"},
	{"live_sessions", "pid", "INTEGER NOT NULL DEFAULT 0"},
	{"live_sessions", "tools", "TEXT"},
	{"live_sessions", "list_at", "TEXT"},  // the time the agent's place in the list was taken; a replacement session keeps its predecessor's (#4943)
	{"live_sessions", "thinking", "TEXT"}, // the thinking level the agent was started with; NULL or "" is the CLI's default (#4969)
	{"live_sessions", "mcp_servers", "TEXT"},
	{"scheduled_jobs", "job_type", "TEXT DEFAULT 'prompt'"},
	{"scheduled_jobs", "workflow_id", "INTEGER"},
	// Why the scheduler paused a job itself (failing repeatedly); cleared when it is resumed (#3171).
	{"scheduled_jobs", "paused_reason", "TEXT DEFAULT ''"},
	// When the job was last enabled again (0 -> 1): the auto-pause counts only runs after it (#3171).
	{"scheduled_jobs", "resumed_at", "TEXT DEFAULT ''"},
	{"live_sessions", "worktree_path", "TEXT"},
	{"live_sessions", "worktree_repo", "TEXT"},
	{"live_sessions", "team_id", "INTEGER REFERENCES teams(id) ON DELETE SET NULL"},
	{"live_sessions", "status", "TEXT NOT NULL DEFAULT 'active'"},
	{"live_sessions", "context_window", "INTEGER NOT NULL DEFAULT 0"},
	// The model a CLI without a transcript model (agy) last reported in a hook payload. Kept apart from model, which a
	// restart passes back to the CLI as its --model: an observed id is for display only.
	{"live_sessions", "observed_model", "TEXT"},
	{"live_sessions", "stopped_at", "TEXT"},
	// User-chosen colour for the agent's name in the sidebar (#rrggbb); NULL = palette default.
	{"live_sessions", "name_color", "TEXT"},
	// Archived: put away by the operator. Always set together with is_sleeping=1 (so every "running" check already
	// excludes it); unlike plain sleeping it is left out of Wake All, team wake and orphan cleanup.
	{"live_sessions", "is_archived", "INTEGER NOT NULL DEFAULT 0"},
	// Why Coral put a sleeping agent to sleep, when it was not the user (#3344): 'terminal_gone'
	// when its terminal session no longer exists. NULL for a sleep the user asked for; cleared on wake.
	{"live_sessions", "sleep_reason", "TEXT"},
	// Auto-accept (#3182): answer this agent's approve-once permission prompts. A new row (launch, restart, resume)
	// starts off, and sleep/wake/archive clear it, so it is never on for a new agent run. The paused code is set when
	// Coral turns it off (loop guard, expiry, hub access withdrawn, Stop all); enabling again clears it.
	{"live_sessions", "auto_accept", "INTEGER NOT NULL DEFAULT 0"},
	{"live_sessions", "auto_accept_until", "INTEGER"},    // unix seconds; NULL = no time limit
	{"live_sessions", "auto_accept_source", "TEXT"},      // 'local' (dashboard) or 'hub' (Coral Hub)
	{"live_sessions", "auto_accept_paused_code", "TEXT"}, // why Coral turned it off (see store/auto_accept.go)
	// When Coral turned it off (#4521): unix seconds, set and cleared with the paused code. A client tells a pause it has
	// already shown from a new one by it (the code alone is the same on every reload).
	{"live_sessions", "auto_accept_paused_at", "INTEGER"},
	// The version of the CLI the agent was launched with (#3481), e.g. "2.1.300"; NULL = unknown.
	{"live_sessions", "cli_version", "TEXT"},
	// The hook set a Claude agent loaded at launch (#3665), e.g. 3; NULL = unknown.
	{"live_sessions", "hooks_rev", "INTEGER"},
	// The folder the agent was launched with its Coral tools (coral-board and the coral-hook-* programs) on its PATH, e.g. the app bundle (#6089); NULL or "" = none recorded.
	{"live_sessions", "hook_dir", "TEXT"},
	// The tag the processes of an agent started on tmux carry in their environment (CORAL_PTY_RUN, #6141): random, kept with the session (and handed on when it is restarted or resumed) so a Kill finds what an
	// earlier run of the same session left behind; NULL for an agent started before this or on the built-in terminal (which has a tag of its own per terminal).
	{"live_sessions", "run_tag", "TEXT"},
	// The proof key derived from a session token (#6103): Coral proves it is Coral to a tool holding the token before the tool sends it; NULL on a token minted before this (those tools do not ask).
	{"session_tokens", "proof_key", "TEXT"},
	{"live_sessions", "permission_mode", "TEXT"}, // the launch's effective permission mode (#5188)
	{"cloud_connection", "route_key", "TEXT"},    // the hub's routing hint for this enrollment (#3683)
	{"cloud_connection", "hub_owner", "TEXT"},    // the Coral Hub account that owns this enrollment (#3966)
	// The owner's hub-user-<8 hex> label as the hub stamps it, recorded at enrolment only (#5280); NULL = unknown.
	{"cloud_connection", "hub_owner_user", "TEXT"},
	// What the machine is enrolled as (#7061): "team" with the Hub organisation's id in hub_owner_org (a canonical lower-case UUID), recorded at enrolment only; NULL = personal, which is every
	// enrolment made before this existed. A new enrolment clears both.
	{"cloud_connection", "hub_owner_kind", "TEXT"},
	{"cloud_connection", "hub_owner_org", "TEXT"},
	{"cloud_connection", "hub_owner_adopted_at", "TEXT"}, // set only when the owner label was adopted locally by the person at this computer (#6108)
	// A Hub sign-in's grant (#3966): empty for every other browser session.
	{"browser_sessions", "hub_grant", "TEXT NOT NULL DEFAULT ''"},
	{"browser_sessions", "hub_account", "TEXT NOT NULL DEFAULT ''"},
	{"browser_sessions", "hub_display", "TEXT NOT NULL DEFAULT ''"},
	{"browser_sessions", "hub_last_ok", "INTEGER NOT NULL DEFAULT 0"},
	{"session_index", "agent_name", "TEXT"},
	{"session_index", "display_name", "TEXT"},
	{"session_index", "index_version", "INTEGER NOT NULL DEFAULT 0"},
	{"session_index", "first_user_message", "TEXT NOT NULL DEFAULT ''"}, // what the person typed first, for History titles (#6207)
	{"token_usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"token_usage", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"token_usage", "session_start_at", "TEXT"},
	{"token_usage", "last_activity_at", "TEXT"},
	{"token_usage", "source", "TEXT NOT NULL DEFAULT 'jsonl'"},
	// The model that produced the row's tokens, as reported by the agent. NULL
	// when it was not observed, and for every row written before this column
	// existed. Without it a stored cost cannot be re-derived from its tokens.
	{"token_usage", "model", "TEXT"},
	{"agent_tasks", "started_at", "TEXT"},
	{"agent_tasks", "completed_at", "TEXT"},
	{"agent_tasks", "cost_usd", "REAL NOT NULL DEFAULT 0"},
	{"agent_tasks", "input_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"agent_tasks", "output_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"agent_tasks", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"agent_tasks", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"agent_tasks", "display_name", "TEXT"},
	// The task's details, for tasks the operator gives an agent (shown when
	// the agent claims it).
	{"agent_tasks", "body", "TEXT"},
	// Board-task parity for the coral-agent CLI (task add --priority,
	// complete/cancel --message).
	{"agent_tasks", "priority", "TEXT DEFAULT 'medium'"},
	{"agent_tasks", "completion_message", "TEXT"},
	// Databases created before `finished` was part of the subagents table.
	{"subagents", "finished", "INTEGER NOT NULL DEFAULT 0"},
	{"subagents", "transcript_path", "TEXT"},
	{"git_snapshots", "pr_number", "INTEGER"},
	{"git_snapshots", "is_worktree", "INTEGER DEFAULT 0"},
	{"git_snapshots", "base_branch", "TEXT DEFAULT ''"},
	{"git_snapshots", "ahead", "INTEGER DEFAULT 0"},
	{"git_snapshots", "behind", "INTEGER DEFAULT 0"},
	{"git_snapshots", "dirty_count", "INTEGER DEFAULT 0"},
	// who made the commit, and the git identity of the checkout the snapshot was taken in (#8996): a name, and a short hash of the email (never the email), so the efficiency read credits a commit
	// only to a session whose identity it matches
	{"git_snapshots", "author_name", "TEXT DEFAULT ''"},
	{"git_snapshots", "author_hash", "TEXT DEFAULT ''"},
	{"git_snapshots", "ident_name", "TEXT DEFAULT ''"},
	{"git_snapshots", "ident_hash", "TEXT DEFAULT ''"},
	{"git_changed_files", "diff_mode", "TEXT DEFAULT ''"},
	// How long the activity took, and the id it is known by at its source
	// (tool_use_id for tool calls, API request id for thinking turns).
	{"agent_events", "duration_ms", "INTEGER"},
	{"agent_events", "ref_id", "TEXT"},
}

// reportForeignKeyOrphans logs rows of an encrypted database that break a foreign key
// (#3454). Until then encrypted databases ran with foreign keys OFF (the driver ignored
// the setting), so cascades didn't apply and orphans may exist. They are kept, never
// a reason to refuse to start; foreign keys are enforced from now on. The check runs on
// its own read-only connection, so it never holds the writer, within a time budget.
func reportForeignKeyOrphans(ctx context.Context, dbPath, key string) {
	ctx, cancel := context.WithTimeout(ctx, fkCheckBudget)
	defer cancel()
	db, err := sql.Open(dbcrypt.EncryptedDriver, dbcrypt.EncryptedDSN(dbPath, key, dbcrypt.DSNOptions{ReadOnly: true}))
	if err != nil {
		slog.Warn("[store] foreign key check skipped", "error", err)
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		slog.Warn("[store] foreign key check skipped", "error", err)
		return
	}
	defer rows.Close()
	byTable := map[string]int{}
	total := 0
	for rows.Next() {
		var table, parent string
		var rowid sql.NullInt64
		var fkid int
		if err := rows.Scan(&table, &rowid, &parent, &fkid); err != nil {
			slog.Warn("[store] foreign key check skipped", "error", err)
			return
		}
		byTable[table+"->"+parent]++
		total++
	}
	if err := rows.Err(); err != nil {
		slog.Warn("[store] foreign key check incomplete", "error", err, "rows_so_far", total)
		return
	}
	if total > 0 {
		slog.Warn("[store] rows that break a foreign key were found and kept; foreign keys are enforced from now on", "rows", total, "by_table", byTable)
	}
}

// fkCheckBudget bounds the startup foreign key check (a test seam).
var fkCheckBudget = 5 * time.Second

// detailJSONFixupKey marks, in store_meta, that agent_events' double-encoded detail_json rows
// (written before makeToolDetail was fixed) were repaired.
const detailJSONFixupKey = "agent_events_detail_json_fixed"

// fixDoubleEncodedDetailJSON repairs those rows once. New rows are never double-encoded, so the
// marker is set only after the update succeeded; a failure is retried at the next start.
func fixDoubleEncodedDetailJSON(ctx context.Context, d *DB) {
	var done int
	if err := d.GetContext(ctx, &done, `SELECT COUNT(*) FROM store_meta WHERE key = ?`, detailJSONFixupKey); err != nil || done > 0 {
		return
	}
	if _, err := d.ExecContext(ctx, `UPDATE agent_events SET detail_json = json_extract(detail_json, '$')
		WHERE detail_json IS NOT NULL AND typeof(json_extract(detail_json, '$')) = 'text'
		AND json_valid(json_extract(detail_json, '$'))`); err != nil {
		slog.Warn("[store] repairing double-encoded event details", "error", err)
		return
	}
	if _, err := d.ExecContext(ctx, `INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)`, detailJSONFixupKey, time.Now().UTC().Format(time.RFC3339)); err != nil {
		slog.Warn("[store] repairing double-encoded event details: write marker", "error", err)
	}
}

// remoteURLScrubKey marks, in store_meta, that remote URLs recorded before #3558 were cleaned.
// A new key makes the scrub run once more when it learns a new form: "_2" adds scp-style
// user:pass@host:path rows (#3561 (a)).
const remoteURLScrubKey = "remote_url_credentials_scrubbed_2"

// scrubRemoteURLCredentials removes credentials (and any ?query or #fragment) from remote URLs
// recorded before #3558 (https://user:TOKEN@host/...). Rows recorded now are stored without
// them, so this runs once: a store_meta row marks it done, and it is set only when every row
// was cleaned, so a failure is retried at the next start.
func scrubRemoteURLCredentials(ctx context.Context, d *DB) {
	var done int
	if err := d.GetContext(ctx, &done, `SELECT COUNT(*) FROM store_meta WHERE key = ?`, remoteURLScrubKey); err != nil {
		slog.Warn("[store] removing credentials from stored git remote URLs: read marker", "error", err)
		return
	}
	if done > 0 {
		return
	}
	var rows []struct {
		ID  int64  `db:"id"`
		URL string `db:"remote_url"`
	}
	if err := d.SelectContext(ctx, &rows, `SELECT id, remote_url FROM git_snapshots WHERE remote_url LIKE '%://%' OR remote_url LIKE '%@%'`); err != nil {
		slog.Warn("[store] removing credentials from stored git remote URLs: read rows", "error", err)
		return
	}
	n := 0
	for _, r := range rows {
		if clean := gitutil.StripURLCredentials(r.URL); clean != r.URL {
			if _, err := d.ExecContext(ctx, `UPDATE git_snapshots SET remote_url = ? WHERE id = ?`, clean, r.ID); err != nil {
				slog.Warn("[store] removing credentials from stored git remote URLs: update", "id", r.ID, "error", err)
				return
			}
			n++
		}
	}
	if _, err := d.ExecContext(ctx, `INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)`, remoteURLScrubKey, time.Now().UTC().Format(time.RFC3339)); err != nil {
		slog.Warn("[store] removing credentials from stored git remote URLs: write marker", "error", err)
	}
	if n > 0 {
		slog.Info("[store] removed credentials from stored git remote URLs", "rows", n)
	}
}
