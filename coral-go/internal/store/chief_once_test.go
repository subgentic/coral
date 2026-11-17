package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19162: a one-time reminder is a check whose cron line names that minute, day and month; it is switched off once it has fired; a check with no origin is Chief's.
func TestChiefCronOnce(t *testing.T) {
	c := ChiefCheck{Name: "n", Instruction: "i", TargetBoard: "b", TargetSession: "s", NotifyMode: "every_time", Timezone: "UTC", ScheduleKind: "once", At: "2026-11-17T10:05"}
	cron, err := ChiefCron(c)
	require.NoError(t, err)
	assert.Equal(t, "5 10 17 11 *", cron)

	c.Timezone = "Asia/Tokyo"
	cron, err = ChiefCron(c)
	require.NoError(t, err)
	assert.Equal(t, "5 10 17 11 *", cron, "the line is in the check's own zone, as the scheduler reads it")

	for _, bad := range []string{"", "10:05", "2026-11-17", "2026-13-17T10:05", "2026-11-17 10:05", "2026-11-17T10:5"} {
		c.At = bad
		_, err = ChiefCron(c)
		assert.Error(t, err, bad)
	}
}

func TestOnceCheckSwitchesOffAndOriginDefaultsToChief(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	s := NewScheduleStore(db)
	c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "n", Instruction: "i", TargetBoard: "b", TargetSession: "s", NotifyMode: "every_time", Timezone: "UTC", ScheduleKind: "once", At: "2026-11-17T10:05", Enabled: true, Origin: "agent", CreatedBy: "Dev"})
	require.NoError(t, err)
	assert.Equal(t, "agent", c.Origin)
	assert.Equal(t, "Dev", c.CreatedBy)
	assert.True(t, c.IsReminder())
	assert.True(t, c.Enabled)

	require.NoError(t, s.FinishOnceCheck(ctx, c.ID))
	after, err := s.ChiefCheck(ctx, c.ID)
	require.NoError(t, err)
	assert.False(t, after.Enabled, "switched off once it has fired")

	// a recurring check is not switched off by it
	r, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "r", Instruction: "i", TargetBoard: "b", TargetSession: "s", NotifyMode: "every_time", Timezone: "UTC", ScheduleKind: "interval", EveryMinutes: 15, Enabled: true})
	require.NoError(t, err)
	assert.Equal(t, "chief", r.Origin, "a check saved with no origin is Chief's")
	assert.False(t, r.IsReminder())
	require.NoError(t, s.FinishOnceCheck(ctx, r.ID))
	again, err := s.ChiefCheck(ctx, r.ID)
	require.NoError(t, err)
	assert.True(t, again.Enabled)
}
