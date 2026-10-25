package board

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func f64(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

func TestSummarizeTaskTimesGivesMediansPercentilesAndNeverAZeroForNothing(t *testing.T) {
	empty := SummarizeTaskTimes(nil)
	assert.Equal(t, 0, empty.Done)
	assert.Nil(t, empty.WorkMedian, "no task: not measured, never zero")
	assert.Nil(t, empty.ReviewMedian)
	assert.Nil(t, empty.RoundsMean)

	var tts []TaskTime
	for i := 1; i <= 10; i++ { // work times of 1..10 minutes, 2 minutes of waiting each
		tts = append(tts, TaskTime{ID: int64(i), CreatedAt: "2026-10-25T10:00:00Z", ClaimedAt: "2026-10-25T10:02:00Z", CompletedAt: fmt.Sprintf("2026-10-25T10:%02d:00Z", 2+i)})
	}
	st := SummarizeTaskTimes(tts)
	assert.Equal(t, 10, st.Done)
	assert.Equal(t, 5.0*60, f64(st.WorkMedian), "nearest rank: the 5th of 10")
	assert.Equal(t, 9.0*60, f64(st.WorkP90), "the 9th of 10")
	assert.Equal(t, 120.0, f64(st.WaitMedian))
	assert.Nil(t, st.ReviewMedian, "no review recorded: not measured")

	// review time is assignment to approval; rounds are counted, those sent back twice or more too
	tts = []TaskTime{
		{ID: 1, CreatedAt: "2026-10-25T10:00:00Z", ClaimedAt: "2026-10-25T10:01:00Z", CompletedAt: "2026-10-25T11:00:00Z", Rounds: 1, ReviewFrom: "2026-10-25T10:30:00Z", ReviewTo: "2026-10-25T10:40:00Z"},
		{ID: 2, CreatedAt: "2026-10-25T10:00:00Z", ClaimedAt: "2026-10-25T10:01:00Z", CompletedAt: "2026-10-25T12:00:00Z", Rounds: 3, RejectedRounds: 2, ReviewFrom: "2026-10-25T10:30:00Z", ReviewTo: "2026-10-25T11:30:00Z"},
		{ID: 3, CreatedAt: "2026-10-25T10:00:00Z", ClaimedAt: "", CompletedAt: "2026-10-25T10:10:00Z"}, // never claimed (made and completed): no work or wait time
	}
	st = SummarizeTaskTimes(tts)
	assert.Equal(t, 3, st.Done)
	assert.Equal(t, 2.0, f64(st.RoundsMean), "the mean over tasks that had reviews")
	assert.Equal(t, 1, st.WentBack2Plus)
	assert.Equal(t, 600.0, f64(st.ReviewMedian), "nearest rank of 10 and 60 minutes: the first")
	assert.InDelta(t, 3540.0, f64(st.WorkMedian), 0.1, "two tasks have a claim: 59 and 119 minutes, the median is the lower (nearest rank)")
}

func putWorkflow(t *testing.T, s *Store, id int64, data string) {
	t.Helper()
	_, err := s.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO task_workflows (task_id, data) VALUES (?, ?)`, id, data)
	require.NoError(t, err)
}

func TestTasksCompletedBetweenReadsTheWindowAndTheReviewRounds(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	mk := func(title, status, claimed, completed, by string) int64 {
		task, err := s.CreateTask(ctx, "alpha", title, "", "medium", "Lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ?, created_at = '2026-10-25T09:00:00Z', claimed_at = NULLIF(?, ''), completed_at = NULLIF(?, ''), completed_by = NULLIF(?, '') WHERE id = ?`, status, claimed, completed, by, task.ID)
		require.NoError(t, err)
		return task.ID
	}
	in := mk("in the window", "completed", "2026-10-25T09:30:00Z", "2026-10-25T10:30:00Z", "Backend Dev")
	mk("before", "completed", "2026-10-24T09:30:00Z", "2026-10-24T10:30:00Z", "QA Engineer")
	mk("at the end", "completed", "2026-10-25T11:30:00Z", "2026-10-25T12:00:00Z", "QA Engineer") // end is exclusive
	mk("skipped", "skipped", "", "2026-10-25T10:45:00Z", "Lead")                                 // not completed work
	mk("open", "in_progress", "2026-10-25T09:40:00Z", "", "")
	putWorkflow(t, s, in, `{"review_rounds":[{"round":1,"delegated_by":"Orchestrator","delegated_at":"2026-10-25T10:00:00Z","result":"rejected"},`+
		`{"round":2,"delegated_by":"Orchestrator","delegated_at":"2026-10-25T10:10:00Z","result":"approved","concluded_at":"2026-10-25T10:20:00Z"}]}`)

	got, err := s.TasksCompletedBetween(ctx, "alpha", "2026-10-25T10:00:00Z", "2026-10-25T12:00:00Z")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, in, got[0].ID)
	assert.Equal(t, "Backend Dev", got[0].CompletedBy)
	assert.Equal(t, 2, got[0].Rounds)
	assert.Equal(t, 1, got[0].RejectedRounds)
	assert.Equal(t, "2026-10-25T10:00:00Z", got[0].ReviewFrom, "the first round's assignment")
	assert.Equal(t, "2026-10-25T10:20:00Z", got[0].ReviewTo, "the last round's approval")
	none, err := s.TasksCompletedBetween(ctx, "beta", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")
	require.NoError(t, err)
	assert.Empty(t, none, "another board's tasks are not here")
}

func TestLandedSinceListsTheCommitsTheQueueMarkedLanded(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	task, err := s.CreateTask(ctx, "alpha", "queued work", "", "medium", "Lead")
	require.NoError(t, err)
	sha1, sha2 := strings.Repeat("a", 40), strings.Repeat("b", 40)
	putWorkflow(t, s, task.ID, `{"artifacts":[{"name":"landed-aaaa","kind":"landed-commit","revision":"`+sha1+`","landed_by":"Orchestrator","landed_at":"2026-10-25T10:00:00Z"},`+
		`{"name":"landed-bbbb","kind":"landed-commit","revision":"`+sha2+`","landed_by":"Orchestrator","landed_at":"2026-10-20T10:00:00Z"},`+
		`{"name":"p.patch","kind":"patch","landed_by":"Orchestrator","landed_at":"2026-10-25T10:00:00Z"},`+
		`{"name":"landed-bad","kind":"landed-commit","revision":"not-a-sha","landed_by":"X","landed_at":"2026-10-25T10:00:00Z"}]}`)
	got, err := s.LandedSince(ctx, "alpha", "2026-10-22T00:00:00Z", 0)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, LandedRecord{TaskID: task.ID, SHA: sha1, LandedBy: "Orchestrator", LandedAt: "2026-10-25T10:00:00Z"}, got[0])
	all, err := s.LandedSince(ctx, "alpha", "", 0)
	require.NoError(t, err)
	assert.Len(t, all, 2, "newest first, a patch row and a malformed sha are not commits")
	assert.Equal(t, sha1, all[0].SHA)
	other, err := s.LandedSince(ctx, "beta", "", 0)
	require.NoError(t, err)
	assert.Empty(t, other)
}
