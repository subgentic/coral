package store

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestChiefChecksCoalesceAndPersistSnapshot(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	spec := ChiefCheck{Name: "Mail", Instruction: "Check for the contract", TargetBoard: "chief", TargetSession: "session", NotifyMode: "only_if_found", ScheduleKind: "interval", EveryMinutes: 5, Timezone: "UTC", Enabled: true}
	c, err := s.SaveChiefCheck(ctx, spec)
	require.NoError(t, err)
	require.False(t, c.WakeIfAsleep)
	one, err := s.BeginChiefTrigger(ctx, c.ID, 0, "request-one", now)
	require.NoError(t, err)
	two, err := s.BeginChiefTrigger(ctx, c.ID, 0, "request-two", now)
	require.NoError(t, err)
	require.Equal(t, one.ID, two.ID)
	c.Instruction = "New instruction"
	c, err = s.SaveChiefCheck(ctx, *c)
	require.NoError(t, err)
	old, err := s.ChiefTrigger(ctx, one.ID)
	require.NoError(t, err)
	require.Equal(t, spec.Instruction, old.Instruction)
	require.NoError(t, s.UpdateChiefTriggerState(ctx, one.ID, "done", "Nothing new", 0, 0, 0, now))
	retry, err := s.BeginChiefTrigger(ctx, c.ID, 0, "request-one", now)
	require.NoError(t, err)
	require.Equal(t, one.ID, retry.ID)
	fresh, err := s.BeginChiefTrigger(ctx, c.ID, 0, "request-three", now)
	require.NoError(t, err)
	require.NotEqual(t, one.ID, fresh.ID)
	require.Equal(t, "New instruction", fresh.Instruction)
	stale := *c
	stale.Revision--
	_, err = s.SaveChiefCheck(ctx, stale)
	require.ErrorIs(t, err, ErrChiefConflict)
}
func TestChiefReminderIsClaimedOnlyOnceAndFailuresStayVisible(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "CI", Instruction: "Check CI", TargetBoard: "chief", TargetSession: "s", NotifyMode: "every_time", ScheduleKind: "daily", At: "08:00", Timezone: "UTC"})
	require.NoError(t, err)
	tr, err := s.BeginChiefTrigger(ctx, c.ID, 0, "", now.Add(-16*time.Minute))
	require.NoError(t, err)
	require.NoError(t, s.FinishChiefDelivery(ctx, tr.ID, "delivery", "delivered", "", 4, now))
	ok, err := s.ClaimChiefDelivery(ctx, tr.ID, "reminder", now)
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = s.ClaimChiefDelivery(ctx, tr.ID, "reminder", now)
	require.NoError(t, err)
	require.False(t, ok)
	require.NoError(t, s.FinishChiefDelivery(ctx, tr.ID, "reminder", "failed", "target_gone", 0, now))
	ok, err = s.ClaimChiefDelivery(ctx, tr.ID, "reminder", now.Add(2*time.Minute))
	require.NoError(t, err)
	require.False(t, ok)
	got, err := s.ChiefTrigger(ctx, tr.ID)
	require.NoError(t, err)
	require.Equal(t, "failed", got.Reminder)
	require.Equal(t, "target_gone", got.ReminderError)
}

func TestChiefCheckCapsPruningAndRunSnapshot(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	spec := ChiefCheck{Name: "bounded", Instruction: "Check CI", TargetBoard: "chief", TargetSession: "s", NotifyMode: "every_time", ScheduleKind: "interval", EveryMinutes: 15, Timezone: "UTC"}
	var first *ChiefCheck
	for i := 0; i < MaxChiefChecks; i++ {
		c, err := s.SaveChiefCheck(ctx, spec)
		require.NoError(t, err)
		if i == 0 {
			first = c
		}
	}
	_, err := s.SaveChiefCheck(ctx, spec)
	require.ErrorIs(t, err, ErrChiefCapacity)
	require.NoError(t, s.DeleteChiefCheck(ctx, first.ID, first.Revision))
	c, err := s.SaveChiefCheck(ctx, spec)
	require.NoError(t, err, "a deleted check with no trigger can be pruned")
	one, err := s.BeginChiefTrigger(ctx, c.ID, 0, "manual-key", now)
	require.NoError(t, err)
	same, err := s.BeginChiefTrigger(ctx, c.ID, 7, "slot-key", now)
	require.NoError(t, err)
	require.Equal(t, one.ID, same.ID)
	require.Equal(t, int64(7), same.RunID)
	require.NoError(t, s.UpdateChiefTriggerState(ctx, one.ID, "done", "done", 0, 0, 0, now.Add(-31*24*time.Hour)))
	require.NoError(t, s.PruneChiefHistory(ctx, now))
	_, err = s.ChiefTrigger(ctx, one.ID)
	require.ErrorIs(t, err, ErrChiefNotFound)
}
func TestChiefTriggerCapacityPrunesOldestResolvedOnly(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "history", Instruction: "Check CI", TargetBoard: "chief", TargetSession: "s", NotifyMode: "every_time", ScheduleKind: "interval", EveryMinutes: 5, Timezone: "UTC"})
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO chief_triggers(check_id,delivery_key,check_name,instruction,target_board,target_session,notify_mode,wake_if_asleep,state,created_at,updated_at) SELECT ?,printf('%032x',x),'history','Check CI','chief','s','every_time',0,'done',?,? FROM n`, MaxChiefTriggers, c.ID, now.Unix(), now.Unix())
	require.NoError(t, err)
	fresh, err := s.BeginChiefTrigger(ctx, c.ID, 0, "new-key", now)
	require.NoError(t, err)
	require.Equal(t, "open", fresh.State)
	_, err = s.ChiefTrigger(ctx, 1)
	require.ErrorIs(t, err, ErrChiefNotFound)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM chief_triggers`))
	require.Equal(t, MaxChiefTriggers, n)
}

func TestChiefCheckResumeResetsFailureWindowAndExposesPause(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "Mail", Instruction: "Check mail", TargetBoard: "chief", TargetSession: "session", NotifyMode: "only_if_found", ScheduleKind: "interval", EveryMinutes: 15, Timezone: "UTC", Enabled: true})
	require.NoError(t, err)
	_, err = s.UpdateScheduledJob(ctx, c.JobID, map[string]interface{}{"enabled": 0, "paused_reason": "Repeated failures"})
	require.NoError(t, err)
	c, err = s.ChiefCheck(ctx, c.ID)
	require.NoError(t, err)
	require.False(t, c.Enabled)
	require.Equal(t, "Repeated failures", c.PausedReason)
	c.Enabled = true
	c, err = s.SaveChiefCheck(ctx, *c)
	require.NoError(t, err)
	require.Empty(t, c.PausedReason)
	job, err := s.GetScheduledJob(ctx, c.JobID)
	require.NoError(t, err)
	require.NotEmpty(t, job.ResumedAt)
}

func TestChiefScheduleRefusesUnsupportedTimesAndIntervals(t *testing.T) {
	base := ChiefCheck{Name: "Mail", Instruction: "Check mail", TargetBoard: "chief", TargetSession: "session", NotifyMode: "only_if_found", ScheduleKind: "interval", EveryMinutes: 15, Timezone: "UTC"}
	for _, minutes := range []int{0, 1, 7, 45, 90} {
		c := base
		c.EveryMinutes = minutes
		_, err := ChiefCron(c)
		require.Error(t, err)
	}
	for _, zone := range []string{"", "Local", "not/a/timezone"} {
		c := base
		c.Timezone = zone
		_, err := ChiefCron(c)
		require.Error(t, err)
	}
	for _, at := range []string{"", "9:00", "24:00", "12:60", "12:00:00"} {
		c := base
		c.ScheduleKind = "daily"
		c.At = at
		_, err := ChiefCron(c)
		require.Error(t, err)
	}
	c := base
	c.ScheduleKind = "weekdays"
	c.At = "09:30"
	c.Timezone = "America/Los_Angeles"
	cron, err := ChiefCron(c)
	require.NoError(t, err)
	require.Equal(t, "30 9 * * 1-5", cron)
	c = base
	c.EveryMinutes = 60
	cron, err = ChiefCron(c)
	require.NoError(t, err)
	require.Equal(t, "0 * * * *", cron)
	c.NotifyMode = "invented"
	_, err = ChiefCron(c)
	require.Error(t, err)
}
