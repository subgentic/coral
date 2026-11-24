package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A weekly reminder (#21085): a day of the week and a time, in the given zone.
func TestReminderWeeklyIsCreatedAndRefusesABadDay(t *testing.T) {
	rr := newRemRig(t)
	post := func(at string) int {
		code, _ := rr.call("POST", "/api/reminders", "person", map[string]any{"text": "Catch-up", "kind": "weekly", "at": at, "timezone": "Europe/Berlin", "board": "team-a", "to": "Dev"})
		return code
	}
	assert.Equal(t, 201, post("Mon 09:00"))
	for _, bad := range []string{"", "09:00", "Monday 09:00", "Mon 25:00", "Fun 09:00"} {
		assert.Equal(t, 400, post(bad), bad)
	}
}

// The next fire of a weekly one is the right Monday, in the zone's wall time, through the week the clocks change.
func TestNextFireOfAWeeklyReminder(t *testing.T) {
	c := store.ChiefCheck{ScheduleKind: "weekly", At: "Mon 09:00", Timezone: "Europe/Berlin"}
	// Sunday 2026-10-25 clocks go back; asked on Saturday the 24th, the next is Monday the 26th, 09:00 CET = 08:00 UTC
	assert.Equal(t, time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC), nextFire(c, time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)).UTC())
	// asked after this Monday's time, it is the Monday a week on
	assert.Equal(t, time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC), nextFire(c, time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)).UTC())
	// 8 days ahead is the longest wait
	assert.Equal(t, time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC), nextFire(c, time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC)).UTC())
	require.True(t, nextFire(store.ChiefCheck{ScheduleKind: "weekly", At: "09:00", Timezone: "UTC"}, time.Now()).IsZero(), "no day: no time")
}
