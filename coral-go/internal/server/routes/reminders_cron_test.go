package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A Custom (cron) reminder (#21330): the line is kept as written (spaces collapsed), a bad or too-frequent one is refused with the reason.
func TestReminderCronIsCreatedAndRefusesABadLine(t *testing.T) {
	rr := newRemRig(t)
	post := func(as, at string) (int, map[string]any) {
		return rr.call("POST", "/api/reminders", as, map[string]any{"text": "Stand-up", "kind": "cron", "at": at, "timezone": "Europe/Berlin", "board": "team-a", "to": "Dev"})
	}
	code, out := post("person", " 0  9 * * 1-5 ")
	require.Equal(t, 201, code)
	assert.Equal(t, "cron", out["schedule_kind"])
	assert.Equal(t, "0 9 * * 1-5", out["at"], "the line is kept as the scheduler has it")
	for at, why := range map[string]string{"": "write a cron line", "@reboot": "@words", "0 0 9 * * *": "exactly 5 fields", "0 9 * * MON": "no names", "* * * * *": "at most every 5 minutes", "*/4 * * * *": "at most every 5 minutes"} {
		code, out := post("person", at)
		assert.Equal(t, 400, code, at)
		assert.Contains(t, out["error"], why, at)
	}
}

// An agent's own reminder keeps its 15-minute floor for a cron line as it does for Repeat; the person may go to 5.
func TestReminderCronAgentFloor(t *testing.T) {
	rr := newRemRig(t)
	set := func(as, at string) int {
		code, _ := rr.call("POST", "/api/reminders", as, map[string]any{"text": "Check", "kind": "cron", "at": at, "timezone": "UTC"})
		return code
	}
	assert.Equal(t, 400, set("agent:1", "*/10 * * * *"))
	assert.Equal(t, 201, set("agent:1", "*/15 * * * *"))
	code, _ := rr.call("POST", "/api/reminders", "person", map[string]any{"text": "Check", "kind": "cron", "at": "*/5 * * * *", "timezone": "UTC", "board": "team-a", "to": "Dev"})
	assert.Equal(t, 201, code)
}

func TestNextFireOfACronReminder(t *testing.T) {
	c := store.ChiefCheck{ScheduleKind: "cron", At: "0 9 * * 1-5", Timezone: "Europe/Berlin"}
	// Friday 2026-11-20 10:00 UTC is past 09:00 CET; the next is Monday the 23rd, 09:00 CET = 08:00 UTC
	assert.Equal(t, time.Date(2026, 11, 23, 8, 0, 0, 0, time.UTC), nextFire(c, time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)).UTC())
	require.True(t, nextFire(store.ChiefCheck{ScheduleKind: "cron", At: "nonsense", Timezone: "UTC"}, time.Now()).IsZero())
}
