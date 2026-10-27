package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Everything a board has, with the table and key column it is in: DeleteProject must leave none of it for the deleted board and all of it for another.
var boardOwnedRows = []struct{ table, col string }{
	{"board_subscribers", "project"}, {"board_messages", "project"}, {"board_reminders", "project"}, {"board_groups", "project"},
	{"board_tasks", "board_id"}, {"board_settings", "project"}, {"board_waits", "project"}, {"board_working_modes", "board_id"},
	{"board_workflow_presets", "board_id"}, {"health_counters", "project"}, {"health_items", "project"}, {"health_offbooks", "project"}, {"health_goal_size", "project"}, {"boards", "id"},
	{"board_goals", "board_id"}, {"board_goal_meta", "board_id"}, {"board_goal_events", "board_id"}, {"board_settings_log", "board_id"}, // the goals tables were missing from this census until #7355
	{"board_goal_requests_in", "board_id"}, {"board_goal_requests_out", "board_id"}, // #7361: a goal request goes with either of its two boards
	{"board_asks", "project"}, {"board_replies", "project"}, // #7794: a question and the link of a reply go with their board
	{"artifact_tags", "board_id"}, // #8583: a team's tags of its artifacts
}

// Audit trails: what the Hub's operators did and what the health rules did are a record of what happened, not part of the board, so they stay.
var auditRows = []struct{ table, col string }{{"hub_operator_actions", "project"}, {"health_actions", "project"}}

// Rows that hang off a board's tasks, found through the task ids.
var taskOwnedRows = []struct{ table, sel string }{
	{"task_amendments", "task_id IN (SELECT id FROM board_tasks WHERE board_id = ?)"},
	{"task_dependencies", "task_id IN (SELECT id FROM board_tasks WHERE board_id = ?)"},
	{"task_workflows", "task_id IN (SELECT id FROM board_tasks WHERE board_id = ?)"},
	{"task_dependency_rules", "task_id IN (SELECT id FROM board_tasks WHERE board_id = ?)"},
	{"task_ready_notifications", "task_id IN (SELECT id FROM board_tasks WHERE board_id = ?)"},
}

// fillBoard gives a board one of everything a board has.
func fillBoard(t *testing.T, s *Store, project string) (taskIDs []int64) {
	t.Helper()
	ctx := context.Background()
	_, err := s.Subscribe(ctx, project, "Boss", "Orchestrator", "claude-"+project+"-boss", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, project, "Dev", "Developer", "claude-"+project+"-dev", nil, "all")
	require.NoError(t, err)
	hello, err := s.PostMessage(ctx, project, "Boss", "hello", nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordAsk(ctx, project, hello, []string{"Dev"}))
	require.NoError(t, s.RecordReply(ctx, project, hello.ID, hello.ID))
	first, err := s.CreateTask(ctx, project, "first", "body", "high", "Boss", "Dev")
	require.NoError(t, err)
	second, err := s.CreateTaskWithOpts(ctx, project, "second", "body", "high", "Boss", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: first.ID, BoardID: project}}}, "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, project, "Dev", first.ID)
	require.NoError(t, err)
	_, err = s.AmendTask(ctx, project, first.ID, "Boss", first.Revision, "wording", map[string]interface{}{"body": "body, corrected"})
	require.NoError(t, err)
	require.NoError(t, s.SetBoardSetting(ctx, project, "health", `{"on":true}`))
	_, err = s.RegisterWait(ctx, project, "Dev", "claude-"+project+"-dev", "task", "1", "waiting", time.Hour)
	require.NoError(t, err)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO board_reminders (project, subscriber_id, message, interval_seconds) VALUES (?, 'Dev', 'remind', 60)`, []any{project}},
		{`INSERT INTO board_groups (project, group_id, session_id) VALUES (?, 'g1', 'claude-x')`, []any{project}},
		{`INSERT INTO board_settings_log (board_id, at, kind, actor, field, old_value, new_value) VALUES (?, '2026-10-19T00:00:00Z', 'change', 'Boss', 'x', 'a', 'b')`, []any{project}},
		{`INSERT INTO health_actions (project, rule, target, at) VALUES (?, 'claim', 'Dev', '2026-10-19T00:00:00Z')`, []any{project}},
		{`INSERT INTO health_counters (project, rule, target, subject, count, last_at) VALUES (?, 'claim', 'Dev', '1', 1, '2026-10-19T00:00:00Z')`, []any{project}},
		{`INSERT INTO health_items (project, item, state, shown_at) VALUES (?, 'stuck:Dev', 'open', '2026-10-19T00:00:00Z')`, []any{project}},
		{`INSERT INTO health_goal_size (project, goal_id, said_level) VALUES (?, 1, 1)`, []any{project}},
		{`INSERT INTO health_offbooks (project, kind, agent, ref, detail, at) VALUES (?, 'post', 'Dev', '1', 'posted a commit', '2026-10-19T00:00:00.000Z')`, []any{project}},
		{`INSERT INTO hub_operator_actions (at, hub_user, method, path, project, status) VALUES ('2026-10-19T00:00:00Z', 'u', 'PUT', '/x', ?, 200)`, []any{project}},
		{`INSERT OR IGNORE INTO boards (id, label, created_at) VALUES (?, ?, '2026-10-19T00:00:00Z')`, []any{project, project}},
		{`INSERT INTO board_goal_requests_in (board_id, request_id, from_board, goal_uid, created_at) VALUES (?, 'in-' || ?, 'a-peer', 'u', '2026-10-19T00:00:00Z')`, []any{project, project}},
		{`INSERT INTO board_goal_requests_out (board_id, goal_id, request_id, to_board, created_at) VALUES (?, 1, 'out-' || ?, 'a-peer', '2026-10-19T00:00:00Z')`, []any{project, project}},
	} {
		_, err := s.db.ExecContext(ctx, q.sql, q.args...)
		require.NoError(t, err, q.sql)
	}
	for _, id := range []int64{first.ID, second.ID} {
		_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_workflows (task_id, data) VALUES (?, '{}')`, id)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_ready_notifications (task_id) VALUES (?)`, id)
		require.NoError(t, err)
	}
	_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_dependency_rules (task_id, upstream_id, condition, required_artifacts) VALUES (?, ?, 'completed', '[]')`, second.ID, first.ID)
	require.NoError(t, err)
	_, err = s.SaveWorkflowPreset(ctx, project, "p1", "Preset", "do it", true)
	require.NoError(t, err)
	_, err = s.SetWorkingMode(ctx, project, WorkingMode{Mode: "none"})
	require.NoError(t, err)
	// a goal with a task on it: the goal, its counter and its events (written by triggers) are the board's too
	goal, err := s.CreateGoal(ctx, project, GoalInput{Title: "Ship " + project, CreatedBy: "Boss"})
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, project, first.ID, &goal.ID))
	require.NoError(t, s.SetArtifactTags(ctx, project, strings.Repeat("a", 64), []string{"for review"})) // a tag the team put on an artifact
	return []int64{first.ID, second.ID}
}

func countRows(t *testing.T, s *Store, table, where string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, s.db.GetContext(context.Background(), &n, "SELECT COUNT(*) FROM "+table+" WHERE "+where, args...), table)
	return n
}

// #4966: deleting a board takes everything: its tasks, their amendments, workflow data and dependency links, its settings, health records and its
// row in the boards table, in one go, and leaves every other board as it was.
func TestDeleteProjectTakesTheWholeBoard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	fillBoard(t, s, "gone")
	fillBoard(t, s, "keep")

	for _, r := range boardOwnedRows {
		require.Greater(t, countRows(t, s, r.table, r.col+" = ?", "gone"), 0, "the fixture put a row in %s", r.table)
	}
	for _, r := range taskOwnedRows {
		require.Greater(t, countRows(t, s, r.table, r.sel, "gone"), 0, "the fixture put a row in %s", r.table)
	}
	keepBefore := map[string]int{}
	for _, r := range boardOwnedRows {
		keepBefore[r.table] = countRows(t, s, r.table, r.col+" = ?", "keep")
	}
	for _, r := range taskOwnedRows {
		keepBefore[r.table] = countRows(t, s, r.table, r.sel, "keep")
	}

	auditBefore := map[string]int{}
	for _, r := range auditRows {
		auditBefore[r.table] = countRows(t, s, r.table, r.col+" = ?", "gone")
		require.Greater(t, auditBefore[r.table], 0, "the fixture put a row in %s", r.table)
	}

	require.NoError(t, s.DeleteProject(ctx, "gone"))

	for _, r := range auditRows {
		assert.Equal(t, auditBefore[r.table], countRows(t, s, r.table, r.col+" = ?", "gone"), "%s: the audit trail of the deleted board stays", r.table)
	}

	for _, r := range boardOwnedRows {
		assert.Equal(t, 0, countRows(t, s, r.table, r.col+" = ?", "gone"), "%s: nothing of the deleted board is left", r.table)
		assert.Equal(t, keepBefore[r.table], countRows(t, s, r.table, r.col+" = ?", "keep"), "%s: the other board is untouched", r.table)
	}
	for _, r := range taskOwnedRows {
		assert.Equal(t, 0, countRows(t, s, r.table, "task_id NOT IN (SELECT id FROM board_tasks)"), "%s: no row is left for a task that is gone", r.table)
		assert.Equal(t, keepBefore[r.table], countRows(t, s, r.table, r.sel, "keep"), "%s: the other board's tasks keep theirs", r.table)
	}
	// A board made again under the name starts empty.
	_, err := s.Subscribe(ctx, "gone", "New", "Dev", "claude-new", nil, "all")
	require.NoError(t, err)
	assert.Equal(t, 0, countRows(t, s, "board_tasks", "board_id = ?", "gone"), "and has no tasks")
	assert.Equal(t, 0, countRows(t, s, "board_settings", "project = ?", "gone"), "and no settings")
}

// A task on another board that was blocked by a task of the deleted board is not left pointing at a task that no longer exists.
func TestDeleteProjectUnblocksTasksOnOtherBoards(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "a", "Boss", "Orchestrator", "claude-a", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "b", "Boss", "Orchestrator", "claude-b", nil, "all")
	require.NoError(t, err)
	upstream, err := s.CreateTask(ctx, "a", "upstream", "", "high", "Boss")
	require.NoError(t, err)
	downstream, err := s.CreateTaskWithOpts(ctx, "b", "downstream", "", "high", "Boss", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: upstream.ID, BoardID: "a"}}})
	require.NoError(t, err)
	require.Equal(t, 1, countRows(t, s, "task_dependencies", "task_id = ?", downstream.ID))

	require.NoError(t, s.DeleteProject(ctx, "a"))

	assert.Equal(t, 0, countRows(t, s, "task_dependencies", "task_id = ? OR blocked_by_task_id = ?", downstream.ID, upstream.ID), "no dependency row points at a deleted task")
	still, err := s.GetTask(ctx, "b", downstream.ID)
	require.NoError(t, err)
	require.NotNil(t, still, "the other board's task is still there")
}

// #5762: a team launch that started nobody takes back the board it made, but only while nothing else has used it: a member, a message, a task, a group,
// a reminder or a wait is someone else's, and the board stays with it. A board with only what the launch writes (settings, a working mode, presets) goes.
func TestDeleteProjectIfUnusedKeepsABoardSomethingElseUsed(t *testing.T) {
	ctx := context.Background()
	for _, use := range []struct {
		name string
		do   func(t *testing.T, s *Store)
	}{
		{"a member joined", func(t *testing.T, s *Store) {
			_, err := s.Subscribe(ctx, "made", "Dev", "Developer", "claude-made-dev", nil, "all")
			require.NoError(t, err)
		}},
		{"a message was posted", func(t *testing.T, s *Store) {
			_, err := s.Subscribe(ctx, "made", "Dev", "Developer", "claude-made-dev", nil, "all")
			require.NoError(t, err)
			_, err = s.Unsubscribe(ctx, "made", "Dev") // the member left again: the message stays
			require.NoError(t, err)
			_, err = s.PostMessage(ctx, "made", "Dev", "hello", nil)
			require.NoError(t, err)
		}},
		{"a task was made", func(t *testing.T, s *Store) {
			_, err := s.CreateTask(ctx, "made", "a task", "", "medium", "Boss")
			require.NoError(t, err)
		}},
		{"a group", func(t *testing.T, s *Store) {
			_, err := s.db.ExecContext(ctx, `INSERT INTO board_groups (project, group_id, session_id) VALUES ('made', 'g1', 'claude-x')`)
			require.NoError(t, err)
		}},
		{"a reminder", func(t *testing.T, s *Store) {
			_, err := s.db.ExecContext(ctx, `INSERT INTO board_reminders (project, subscriber_id, message, interval_seconds) VALUES ('made', 'Dev', 'remind', 60)`)
			require.NoError(t, err)
		}},
		{"a wait", func(t *testing.T, s *Store) {
			_, err := s.RegisterWait(ctx, "made", "Dev", "claude-made-dev", "task", "1", "waiting", time.Hour)
			require.NoError(t, err)
		}},
	} {
		t.Run(use.name, func(t *testing.T) {
			s := testStore(t)
			require.NoError(t, s.SetBoardSetting(ctx, "made", "health", `{"on":true}`)) // what the launch wrote
			_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO boards (id, label, created_at) VALUES ('made', 'made', '2026-10-19T00:00:00Z')`)
			require.NoError(t, err)
			use.do(t, s)
			deleted, err := s.DeleteProjectIfUnused(ctx, "made")
			require.NoError(t, err)
			assert.False(t, deleted, "the board is kept")
			assert.Equal(t, 1, countRows(t, s, "boards", "id = ?", "made"))
			assert.Equal(t, 1, countRows(t, s, "board_settings", "project = ?", "made"), "with everything on it")
		})
	}
}

func TestDeleteProjectIfUnusedTakesABoardNobodyUsed(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	require.NoError(t, s.SetBoardSetting(ctx, "made", "health", `{"on":true}`))
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO boards (id, label, created_at) VALUES ('made', 'made', '2026-10-19T00:00:00Z')`)
	require.NoError(t, err)
	fillBoard(t, s, "other")
	deleted, err := s.DeleteProjectIfUnused(ctx, "made")
	require.NoError(t, err)
	assert.True(t, deleted)
	assert.Equal(t, 0, countRows(t, s, "boards", "id = ?", "made"))
	assert.Equal(t, 0, countRows(t, s, "board_settings", "project = ?", "made"))
	assert.Greater(t, countRows(t, s, "board_tasks", "board_id = ?", "other"), 0, "another board is untouched")
}

// Every table of the board database that has a board key column is either cleaned by DeleteProject (boardOwnedRows), an audit trail that stays (auditRows), or named here with the reason it is neither: a new
// per-board table that is none of these fails this test, so it cannot be left behind by a deleted board (#7355: board_goal_events was, until Security's probe).
var notCleanedWithTheBoard = map[string]string{
	"board_message_counts":  "derived from board_messages by triggers (message_counts.go): DeleteProject deletes the board's messages and each delete takes its count down, so the row goes with them (checked in message_counts_test.go)",
	"cross_team_switch_log": "an audit trail of what the cross-team switches did, like the audit rows above: a record of what happened, not part of the board",
}

func TestEveryTableKeyedByABoardIsCleanedOrNamedAsKept(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	var tables []string
	require.NoError(t, s.db.SelectContext(ctx, &tables, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`))
	known := map[string]bool{}
	for _, r := range boardOwnedRows {
		known[r.table] = true
	}
	for _, r := range auditRows {
		known[r.table] = true
	}
	for tbl := range notCleanedWithTheBoard {
		known[tbl] = true
	}
	var unknown []string
	for _, tbl := range tables {
		var cols []string
		require.NoError(t, s.db.SelectContext(ctx, &cols, `SELECT name FROM pragma_table_info(?)`, tbl))
		for _, c := range cols {
			if (c == "board_id" || c == "project") && !known[tbl] {
				unknown = append(unknown, tbl+"."+c)
			}
		}
	}
	assert.Empty(t, unknown, "a table keyed by a board that DeleteProject neither cleans nor is named as kept: add it to boardOwnedRows (and the delete list) or to notCleanedWithTheBoard with the reason")
}
