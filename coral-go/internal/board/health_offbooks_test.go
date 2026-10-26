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
