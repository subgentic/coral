package board

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9114: the team artifacts read finds the tasks that have artifacts through an indexed flag the workflow save keeps, and the status, health and nudge reads of the open tasks leave their text out.

func perfStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s, context.Background()
}

func bestOf(n int, f func()) time.Duration {
	best := time.Duration(1<<63 - 1)
	for i := 0; i < n; i++ {
		t0 := time.Now()
		f()
		if d := time.Since(t0); d < best {
			best = d
		}
	}
	return best
}

func completeWith(t *testing.T, s *Store, ctx context.Context, who, title string, withArtifact bool) int64 {
	t.Helper()
	task, err := s.CreateTask(ctx, "team", title, "body", "medium", "Lead", who)
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "team", who, task.ID)
	require.NoError(t, err)
	var arts []TaskArtifact
	if withArtifact {
		arts = []TaskArtifact{{Name: "report.md", Content: "# report", MediaType: "text/markdown"}}
	}
	_, err = s.CompleteTaskWithArtifacts(ctx, "team", task.ID, who, nil, "success", arts)
	require.NoError(t, err)
	return task.ID
}

func TestTheTeamArtifactsReadFindsTasksThroughTheIndexedFlag(t *testing.T) {
	s, ctx := perfStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	var want []int64
	for i := 0; i < 12; i++ {
		id := completeWith(t, s, ctx, "Dev", fmt.Sprintf("t%d", i), i%3 == 0)
		if i%3 == 0 {
			want = append(want, id)
		}
	}
	tasks, _, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "team", Limit: MaxTeamArtifactTaskScan})
	require.NoError(t, err)
	var got []int64
	for _, tk := range tasks {
		got = append(got, tk.TaskID)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	assert.Equal(t, want, got, "exactly the tasks whose workflow lists an artifact")
	var flagged int
	require.NoError(t, s.db.GetContext(ctx, &flagged, `SELECT COUNT(*) FROM task_workflows WHERE has_artifacts = 1`))
	assert.Equal(t, len(want), flagged)

	// the query walks the partial index, not the workflow blobs
	var plan []string
	rows, err := s.db.QueryxContext(ctx, `EXPLAIN QUERY PLAN SELECT t.id, w.data FROM task_workflows w INDEXED BY idx_task_workflows_artifacts CROSS JOIN board_tasks t ON t.id = w.task_id WHERE t.board_id = ? AND w.has_artifacts = 1 ORDER BY w.task_id DESC LIMIT 501`, "team")
	require.NoError(t, err)
	for rows.Next() {
		var id, parent, notused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &notused, &detail))
		plan = append(plan, detail)
	}
	rows.Close()
	joined := strings.Join(plan, " | ")
	assert.Contains(t, joined, "idx_task_workflows_artifacts", "the plan: %v", plan)
	assert.NotContains(t, joined, "TEMP B-TREE", "the index order is the order asked for: no sort of the rows (the plan: %v)", plan)
}

// A task whose result is rewritten without its artifacts loses the flag, and one that gains them gets it (the flag follows every save).
func TestTheArtifactFlagFollowsEverySaveOfTheWorkflow(t *testing.T) {
	s, ctx := perfStore(t)
	require.NoError(t, saveWorkflow(ctx, s.db, 1, TaskWorkflow{Artifacts: []TaskArtifact{{Name: "a", Content: "x"}}}))
	flag := func() int {
		var n int
		require.NoError(t, s.db.GetContext(ctx, &n, `SELECT has_artifacts FROM task_workflows WHERE task_id = 1`))
		return n
	}
	assert.Equal(t, 1, flag())
	require.NoError(t, saveWorkflow(ctx, s.db, 1, TaskWorkflow{}))
	assert.Equal(t, 0, flag(), "no artifacts now")
	require.NoError(t, saveWorkflow(ctx, s.db, 1, TaskWorkflow{CompletionReview: &CompletionReview{Artifacts: []TaskArtifact{{Name: "r", Content: "y"}}}}))
	assert.Equal(t, 1, flag(), "an artifact in the review's result counts, as the old LIKE found it")
}

// A database from before the flag gets the column, the index and one backfill when the store opens, and finds the same tasks.
func TestAnOlderDatabaseGetsTheFlagBackfilledOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	ctx := context.Background()
	_, err = s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	withID := completeWith(t, s, ctx, "Dev", "has one", true)
	completeWith(t, s, ctx, "Dev", "has none", false)
	// make it the old shape: no index, no column
	_, err = s.db.ExecContext(ctx, `DROP INDEX idx_task_workflows_artifacts`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `ALTER TABLE task_workflows DROP COLUMN has_artifacts`)
	require.NoError(t, err)
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	tasks, _, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "team", Limit: MaxTeamArtifactTaskScan})
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, withID, tasks[0].TaskID)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_task_workflows_artifacts'`))
	assert.Equal(t, 1, n)
}

// #9138: a task saved by an older Coral (after a rollback and a second upgrade) has no flag; the next open flags it, so it is in the Team Artifacts list again.
func TestARowWrittenWithoutTheFlagIsFlaggedOnTheNextOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	ctx := context.Background()
	_, err = s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	flaggedID := completeWith(t, s, ctx, "Dev", "saved by this version", true)
	oldID := completeWith(t, s, ctx, "Dev", "saved by the older version", true)
	completeWith(t, s, ctx, "Dev", "no artifacts", false)
	// the older Coral wrote this result and knows no flag: the column's default, 0
	_, err = s.db.ExecContext(ctx, `UPDATE task_workflows SET has_artifacts = 0 WHERE task_id = ?`, oldID)
	require.NoError(t, err)
	before, _, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "team", Limit: MaxTeamArtifactTaskScan})
	require.NoError(t, err)
	require.Len(t, before, 1, "unflagged: missing from the list until the next open")
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	after, _, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "team", Limit: MaxTeamArtifactTaskScan})
	require.NoError(t, err)
	var got []int64
	for _, tk := range after {
		got = append(got, tk.TaskID)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	assert.Equal(t, []int64{flaggedID, oldID}, got, "both artifact-bearing tasks, and not the one without")
}

// With a board of thousands of tasks and a few with artifacts, the flagged read is much faster than the LIKE over every blob it replaced (the timings are logged).
func TestTheFlaggedReadBeatsTheScanOverEveryWorkflowBlob(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 3,000 tasks")
	}
	s, ctx := perfStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	big := strings.Repeat("Team working instructions repeated in every task's workflow. ", 60) // about 3.6 KB per blob
	for i := 0; i < 3000; i++ {
		task, err := s.CreateTask(ctx, "team", fmt.Sprintf("t%d", i), "body", "medium", "Lead", "Dev")
		require.NoError(t, err)
		w := TaskWorkflow{Instructions: big}
		if i%100 == 0 {
			w.Artifacts = []TaskArtifact{{Name: "r.md", Content: "x"}}
		}
		require.NoError(t, saveWorkflow(ctx, s.db, task.ID, w))
	}
	scan := func() {
		var rows []struct {
			ID   int64  `db:"id"`
			Data string `db:"data"`
		}
		require.NoError(t, s.db.SelectContext(ctx, &rows, `SELECT t.id, w.data FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id WHERE t.board_id = ? AND w.data LIKE '%"artifacts":[%' ORDER BY t.id DESC LIMIT 501`, "team"))
		require.Len(t, rows, 30)
	}
	flagged := func() {
		tasks, _, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "team", Limit: MaxTeamArtifactTaskScan})
		require.NoError(t, err)
		require.Len(t, tasks, 30)
	}
	before, after := bestOf(5, scan), bestOf(5, flagged)
	t.Logf("3,000 tasks, 30 with artifacts: the LIKE scan %v, the flagged read %v (%.1fx)", before, after, float64(before)/float64(after))
	// A timing is only a gross check here (a run on a loaded machine failed a strict ratio, #9235): the plan test above pins that the index is walked; this one fails only if the flagged read is not faster at all.
	assert.Less(t, after, before, "the flagged read is faster than the LIKE scan")
}

func TestOpenTaskStatesAreTheOpenTasksWithoutTheirText(t *testing.T) {
	s, ctx := perfStore(t)
	for _, who := range []string{"Dev", "QA"} {
		_, err := s.Subscribe(ctx, "team", who, who, who+"-session", nil, "mentions")
		require.NoError(t, err)
	}
	for i := 0; i < 8; i++ {
		who := []string{"Dev", "QA"}[i%2]
		task, err := s.CreateTask(ctx, "team", fmt.Sprintf("open %d", i), strings.Repeat("body text ", 200), []string{"low", "medium", "high", "critical"}[i%4], "Lead", who)
		require.NoError(t, err)
		if i == 0 {
			_, err = s.ClaimTask(ctx, "team", who, task.ID)
			require.NoError(t, err)
		}
	}
	completeWith(t, s, ctx, "QA", "done", false) // not open: in neither (QA has nothing in progress)
	// the statuses the open read includes (blocked, draft) and the one it leaves out (review_pending): both reads must agree on each, so adding a status to one of them fails here
	for status, title := range map[string]string{"blocked": "blocked one", "draft": "draft one", "review_pending": "waiting for its review"} {
		task, err := s.CreateTask(ctx, "team", title, "body", "medium", "Lead", "Dev")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ? WHERE id = ?`, status, task.ID)
		require.NoError(t, err)
	}
	wide, err := s.ListOpenTasks(ctx, "team")
	require.NoError(t, err)
	narrow, err := s.ListOpenTaskStates(ctx, "team")
	require.NoError(t, err)
	require.Len(t, narrow, len(wide))
	for _, tk := range narrow {
		assert.NotEqual(t, "review_pending", tk.Status, "a task waiting for its review is not an open task here")
	}
	for i := range wide {
		w, n := wide[i], narrow[i]
		assert.Equal(t, w.ID, n.ID)
		assert.Equal(t, w.Title, n.Title)
		assert.Equal(t, w.Status, n.Status)
		assert.Equal(t, w.Priority, n.Priority)
		assert.Equal(t, w.AssignedTo, n.AssignedTo)
		assert.Equal(t, w.CreatedAt, n.CreatedAt)
		assert.Equal(t, w.ClaimedAt, n.ClaimedAt)
		assert.Equal(t, w.UpdatedAt, n.UpdatedAt)
		assert.Equal(t, w.GoalID, n.GoalID)
		assert.Equal(t, w.BlockedBy, n.BlockedBy)
		assert.NotEmpty(t, w.Body)
		assert.Empty(t, n.Body, "no text")
	}
}

func TestOpenTaskStatesReadFarLessThanTheWholeRows(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 1,500 open tasks")
	}
	s, ctx := perfStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Dev", "dev-session", nil, "mentions")
	require.NoError(t, err)
	body := strings.Repeat("A task body explains what to do and how to check it, in a few sentences. ", 60) // about 4.4 KB
	for i := 0; i < 1500; i++ {
		_, err := s.CreateTask(ctx, "team", fmt.Sprintf("open %d", i), body, "medium", "Lead", "Dev")
		require.NoError(t, err)
	}
	wide := bestOf(5, func() { _, _ = s.ListOpenTasks(ctx, "team") })
	narrow := bestOf(5, func() { _, _ = s.ListOpenTaskStates(ctx, "team") })
	t.Logf("1,500 open tasks of 4.4 KB: whole rows %v, states only %v (%.1fx)", wide, narrow, float64(wide)/float64(narrow))
	// A gross check only (a loaded machine measured 0.9x once, #9235): the two reads' fields are compared exactly above; this fails only if the narrow read is much slower than the whole rows.
	assert.Less(t, narrow, wide*2, "the narrow read is not much slower than the whole rows")
}
