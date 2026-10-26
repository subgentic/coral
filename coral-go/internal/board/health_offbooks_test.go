package board

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The off-the-books signals are health settings (#7793): on by default once the check is on, the busy one with a number of minutes, every number clamped, and a save keeps them.
func TestOffBooksSettingsDefaultsClampAndSave(t *testing.T) {
	d := DefaultHealthSettings()
	assert.Equal(t, HealthMentionNudge{On: true, AfterMin: 10}, d.BusyNoTask)
	assert.True(t, d.PostNoTask.On)
	assert.True(t, d.UploadNoTask.On)

	h := d
	h.BusyNoTask.AfterMin = 1
	assert.Equal(t, 5, h.Clamp().BusyNoTask.AfterMin)
	h.BusyNoTask.AfterMin = 100000
	assert.Equal(t, 1440, h.Clamp().BusyNoTask.AfterMin)

	raw, err := json.Marshal(d)
	require.NoError(t, err)
	var fields map[string]any
	require.NoError(t, json.Unmarshal(raw, &fields))
	assert.Equal(t, map[string]any{"on": true, "after_min": float64(10)}, fields["busy_no_task"], "the JSON names the Hub notice lists")
	assert.Equal(t, map[string]any{"on": true}, fields["post_no_task"])
	assert.Equal(t, map[string]any{"on": true}, fields["upload_no_task"])

	s := testStore(t)
	ctx := context.Background()
	assert.Equal(t, d.BusyNoTask, s.GetHealthSettings(ctx, "team").BusyNoTask, "a team with nothing stored has the defaults")
	h = d
	h.BusyNoTask = HealthMentionNudge{On: false, AfterMin: 25}
	h.PostNoTask.On = false
	require.NoError(t, s.SetHealthSettings(ctx, "team", h))
	got := s.GetHealthSettings(ctx, "team")
	assert.Equal(t, HealthMentionNudge{On: false, AfterMin: 25}, got.BusyNoTask)
	assert.False(t, got.PostNoTask.On)
	assert.True(t, got.UploadNoTask.On)
	// stored before these fields existed: they come back on
	require.NoError(t, s.SetBoardSetting(ctx, "old", settingHealth, `{"on":true,"interval_min":10}`))
	old := s.GetHealthSettings(ctx, "old")
	assert.True(t, old.On && old.PostNoTask.On && old.UploadNoTask.On && old.BusyNoTask.On)
}

func TestOffBooksOccurrencesAreKeptOnceAndShownOnce(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	all := map[string]bool{OffBooksBusy: true, OffBooksPost: true, OffBooksUpload: true}
	require.NoError(t, s.AddOffBooks(ctx, "team", OffBooksPost, "Dev", "41", "posted a commit (abc1234) with no task number and no task in progress", now))
	require.NoError(t, s.AddOffBooks(ctx, "team", OffBooksPost, "Dev", "41", "again", now), "the same occurrence is one")
	require.NoError(t, s.AddOffBooks(ctx, "team", OffBooksUpload, "Dev", "41", "an upload with the same ref is another kind", now))
	require.NoError(t, s.AddOffBooks(ctx, "other", OffBooksPost, "Dev", "41", "another board", now))

	got, err := s.PendingOffBooks(ctx, "team", now, all)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "posted a commit (abc1234) with no task number and no task in progress", got[0].Detail, "the first words are kept")

	only, err := s.PendingOffBooks(ctx, "team", now, map[string]bool{OffBooksUpload: true})
	require.NoError(t, err)
	assert.Len(t, only, 1, "a switch that is off leaves its kind out")
	none, err := s.PendingOffBooks(ctx, "team", now, nil)
	require.NoError(t, err)
	assert.Empty(t, none)

	require.NoError(t, s.MarkOffBooksShown(ctx, "team", []int64{got[0].ID}, now))
	left, err := s.PendingOffBooks(ctx, "team", now, all)
	require.NoError(t, err)
	require.Len(t, left, 1)
	assert.Equal(t, OffBooksUpload, left[0].Kind)
	require.NoError(t, s.AddOffBooks(ctx, "team", OffBooksPost, "Dev", "41", "a shown one is not added again", now))
	left, _ = s.PendingOffBooks(ctx, "team", now, all)
	assert.Len(t, left, 1, "a shown occurrence never comes back")
	other, _ := s.PendingOffBooks(ctx, "other", now, all)
	assert.Len(t, other, 1, "boards are apart")

	// an occurrence never shown is dropped after a week
	require.NoError(t, s.AddOffBooks(ctx, "team", OffBooksBusy, "Dev", "old", "old", now.Add(-OffBooksKeep-time.Hour)))
	left, _ = s.PendingOffBooks(ctx, "team", now, all)
	assert.Len(t, left, 1)
}

func TestHadTaskInProgressUsesTheTasksOwnTimes(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	tk, err := s.CreateTask(ctx, "team", "Work", "", "medium", "lead", "Dev")
	require.NoError(t, err)
	before := time.Now().Add(-time.Hour)
	had, err := s.HadTaskInProgress(ctx, "team", "Dev", time.Now(), time.Minute)
	require.NoError(t, err)
	assert.False(t, had, "assigned and waiting is not in progress")
	_, err = s.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(t, err)
	had, _ = s.HadTaskInProgress(ctx, "team", "Dev", time.Now().Add(time.Second), time.Minute)
	assert.True(t, had, "claimed and not completed")
	had, _ = s.HadTaskInProgress(ctx, "team", "Dev", before, time.Minute)
	assert.False(t, had, "before it was claimed")
	had, _ = s.HadTaskInProgress(ctx, "team", "Other", time.Now().Add(time.Second), time.Minute)
	assert.False(t, had, "another member's")
	_, err = s.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(t, err)
	had, _ = s.HadTaskInProgress(ctx, "team", "Dev", time.Now().Add(30*time.Second), time.Minute)
	assert.True(t, had, "half a minute after it was completed is within a minute's grace")
	had, _ = s.HadTaskInProgress(ctx, "team", "Dev", time.Now().Add(30*time.Second), 0)
	assert.False(t, had, "and past it with no grace")
	had, _ = s.HadTaskInProgress(ctx, "team", "Dev", time.Now().Add(time.Hour), time.Minute)
	assert.False(t, had, "long after it was completed")
}

func TestOffBooksPostCursorAndLatestMessage(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, known := s.OffBooksPostCursor(ctx, "team")
	assert.False(t, known, "before the first scan")
	latest, err := s.LatestMessageID(ctx, "team")
	require.NoError(t, err)
	assert.Zero(t, latest, "an empty board")
	require.NoError(t, s.SetOffBooksPostCursor(ctx, "team", 0))
	id, known := s.OffBooksPostCursor(ctx, "team")
	assert.True(t, known && id == 0, "a scan of an empty board is still a scan")
	_, err = s.Subscribe(ctx, "team", "Dev", "Developer", "dev-session", nil, "all")
	require.NoError(t, err)
	m, err := s.PostMessage(ctx, "team", "Dev", "hello", nil)
	require.NoError(t, err)
	latest, _ = s.LatestMessageID(ctx, "team")
	assert.Equal(t, m.ID, latest)
	require.NoError(t, s.SetOffBooksPostCursor(ctx, "team", latest))
	id, _ = s.OffBooksPostCursor(ctx, "team")
	assert.Equal(t, latest, id)
}

func TestGoalSizeSettingDefaultsAndClamp(t *testing.T) {
	d := DefaultHealthSettings()
	assert.Equal(t, HealthGoalSize{On: true, Limit: 15}, d.GoalSize, "15 tasks, the goal-size guidance")
	h := d
	h.GoalSize.Limit = 1
	assert.Equal(t, 5, h.Clamp().GoalSize.Limit)
	h.GoalSize.Limit = 100000
	assert.Equal(t, 500, h.Clamp().GoalSize.Limit)
	raw, err := json.Marshal(d)
	require.NoError(t, err)
	var fields map[string]any
	require.NoError(t, json.Unmarshal(raw, &fields))
	assert.Equal(t, map[string]any{"on": true, "limit": float64(15)}, fields["goal_size"], "the JSON names the Hub notice lists")
	s := testStore(t)
	ctx := context.Background()
	h.GoalSize = HealthGoalSize{On: false, Limit: 30}
	require.NoError(t, s.SetHealthSettings(ctx, "team", h))
	assert.Equal(t, HealthGoalSize{On: false, Limit: 30}, s.GetHealthSettings(ctx, "team").GoalSize)
}

func TestGoalLevelIsTheLimitsMultiplesPassed(t *testing.T) {
	for _, c := range [][3]int{{0, 15, 0}, {15, 15, 0}, {16, 15, 1}, {29, 15, 1}, {30, 15, 2}, {44, 15, 2}, {45, 15, 3}, {6, 5, 1}, {10, 5, 2}, {20, 0, 0}} {
		assert.Equal(t, c[2], goalLevel(c[0], c[1]), "%d tasks, limit %d", c[0], c[1])
	}
}

// goalWith makes a goal of the board and n tasks linked to it, a third of them completed.
func goalWith(t *testing.T, s *Store, project, title string, n int) *Goal {
	t.Helper()
	ctx := context.Background()
	g, err := s.CreateGoal(ctx, project, GoalInput{Title: title, Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	addTasks(t, s, project, g.ID, n)
	return g
}

func addTasks(t *testing.T, s *Store, project string, goal int64, n int) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		tk, err := s.CreateTaskWithOpts(ctx, project, "task", "", "medium", "Operator", &CreateTaskOpts{GoalID: &goal})
		require.NoError(t, err)
		if i%3 == 0 {
			_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'completed', completed_at = ? WHERE id = ?`, "2026-10-19T00:00:00Z", tk.ID)
			require.NoError(t, err)
		}
	}
}

func TestOpenGoalSizesCountOpenAndDoneTasksOfGoalsThatAreNotClosed(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	big := goalWith(t, s, "team", "big", 7)
	empty, err := s.CreateGoal(ctx, "team", GoalInput{Title: "empty", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	done := goalWith(t, s, "team", "done", 9)
	dropped := goalWith(t, s, "team", "dropped", 9)
	_, _, err = s.CloseGoal(ctx, "team", done.ID, "met", GoalDone)
	require.NoError(t, err)
	_, _, err = s.CloseGoal(ctx, "team", dropped.ID, "no", GoalDropped)
	require.NoError(t, err)
	other := goalWith(t, s, "other", "other board", 4)
	got, err := s.OpenGoalSizes(ctx, "team")
	require.NoError(t, err)
	assert.Equal(t, []GoalSize{{ID: big.ID, Total: 7}}, got, "open and done tasks together; a closed goal, a goal with no task and another board's goal are not there (%d, %d)", empty.ID, other.ID)
}

func TestNoteGoalSizesSaysACrossingOnceAndAgainAtEachStepAndAfterAReopen(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := goalWith(t, s, "team", "growing", 15)
	note := func() []int64 {
		sizes, err := s.OpenGoalSizes(ctx, "team")
		require.NoError(t, err)
		crossed, err := s.NoteGoalSizes(ctx, "team", sizes, 15)
		require.NoError(t, err)
		var ids []int64
		for _, c := range crossed {
			ids = append(ids, c.ID)
		}
		return ids
	}
	assert.Empty(t, note(), "15 tasks is the limit, not past it")
	addTasks(t, s, "team", g.ID, 1)
	assert.Equal(t, []int64{g.ID}, note(), "16 passes it")
	assert.Empty(t, note(), "once per crossing")
	addTasks(t, s, "team", g.ID, 13)
	assert.Empty(t, note(), "29 is not another step")
	addTasks(t, s, "team", g.ID, 1)
	assert.Equal(t, []int64{g.ID}, note(), "30 is the next step")
	assert.Empty(t, note())

	// it shrinks below the limit and grows back: a new crossing
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = NULL WHERE board_id = 'team' AND id IN (SELECT id FROM board_tasks WHERE board_id = 'team' AND goal_id = ? LIMIT 20)`, g.ID)
	require.NoError(t, err)
	assert.Empty(t, note(), "10 tasks: below")
	addTasks(t, s, "team", g.ID, 6)
	assert.Equal(t, []int64{g.ID}, note(), "16 again is a new crossing")

	// closed, then reopened: counted afresh
	_, _, err = s.CloseGoal(ctx, "team", g.ID, "done", GoalDone)
	require.NoError(t, err)
	assert.Empty(t, note(), "a closed goal is not counted")
	state := GoalActive
	_, err = s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{State: &state})
	require.NoError(t, err)
	assert.Equal(t, []int64{g.ID}, note(), "reopened and still big: said again")
}

func TestAGoalThatShrinksToALowerStepIsSaidAtTheSecondAgain(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := goalWith(t, s, "team", "g", 30)
	note := func() int {
		sizes, err := s.OpenGoalSizes(ctx, "team")
		require.NoError(t, err)
		crossed, err := s.NoteGoalSizes(ctx, "team", sizes, 15)
		require.NoError(t, err)
		return len(crossed)
	}
	assert.Equal(t, 1, note(), "30 tasks: the second step, said")
	assert.Equal(t, 0, note())
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = NULL WHERE board_id = 'team' AND id IN (SELECT id FROM board_tasks WHERE board_id = 'team' AND goal_id = ? LIMIT 10)`, g.ID)
	require.NoError(t, err)
	assert.Equal(t, 0, note(), "20 tasks: the first step, already said")
	addTasks(t, s, "team", g.ID, 10)
	assert.Equal(t, 1, note(), "30 again: the second step is said again, the level having come down with the goal")
}
