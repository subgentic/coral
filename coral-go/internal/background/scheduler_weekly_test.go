package background

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A weekly reminder (#21085) is the cron line "0 9 * * 1" in the computer's zone: Monday 09:00 local, also in the week the clocks change.
func TestWeeklyFiresAtTheLocalTimeThroughADSTWeek(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	require.NoError(t, err)
	// Berlin goes back to winter time on Sunday 2026-10-25: the Monday before is UTC+2, the Monday after UTC+1.
	next, err := NextFireTime("0 9 * * 1", "Europe/Berlin", time.Date(2026, 10, 19, 6, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	assert.Equal(t, time.Date(2026, 10, 19, 7, 0, 0, 0, time.UTC), next, "Monday 09:00 CEST is 07:00 UTC")
	next, err = NextFireTime("0 9 * * 1", "Europe/Berlin", next)
	require.NoError(t, err)
	assert.Equal(t, time.Date(2026, 10, 26, 9, 0, 0, 0, berlin).UTC(), next)
	assert.Equal(t, time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC), next, "after the change Monday 09:00 CET is 08:00 UTC: still 09:00 on the wall")
	// and the spring week (Sunday 2026-03-29)
	next, err = NextFireTime("0 9 * * 1", "Europe/Berlin", time.Date(2026, 3, 23, 9, 0, 0, 0, berlin))
	require.NoError(t, err)
	assert.Equal(t, time.Date(2026, 3, 30, 7, 0, 0, 0, time.UTC), next, "Monday after the spring change: 09:00 CEST")
}

// A Monday slot missed while Coral was not running fires once when it starts, like a daily one (#21085); a run that already happened does not fire again.
func TestWeeklyMissedWhileAsleepFiresOnceOnWake(t *testing.T) {
	// the daily helper's job is "0 9 * * *"; the weekly one is the same machinery with a day, so a Monday 2026-10-12 is checked directly
	mon := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	lastRun := mon.AddDate(0, 0, -7)
	assert.True(t, weeklyEvaluateAt(t, "0 9 * * 1", mon.AddDate(0, 0, -20), &lastRun, mon.Add(26*time.Hour)), "Monday's 09:00 was missed: it fires once when Coral is back on Tuesday")
	assert.False(t, weeklyEvaluateAt(t, "0 9 * * 1", mon.AddDate(0, 0, -20), &mon, mon.Add(26*time.Hour)), "it ran Monday: nothing is due on Tuesday")
	assert.False(t, weeklyEvaluateAt(t, "0 9 * * 1", mon.Add(10*time.Hour), nil, mon.Add(26*time.Hour)), "made after Monday's slot: it waits for next Monday")
}
