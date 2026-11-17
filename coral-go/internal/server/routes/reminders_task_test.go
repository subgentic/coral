package routes

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19350: a task's reminder time (task add --remind-at) goes out as a one-time reminder on the reminders machinery.

func TestATaskReminderIsAOneTimeReminderTheOperatorCanSeeSwitchOffAndCancel(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	require.NoError(t, SaveTaskReminder(ctx, rr.ch.sched, "team-a", sendSid(1), 77, "[Coral] Reminder for #77, set for 09:00. Run 'coral-board task detail 77'.", rr.now))

	_, out := rr.call("GET", "/api/reminders", "person", nil)
	rows, _ := out["reminders"].([]any)
	require.Len(t, rows, 1, "the Operator's list shows it")
	row := rows[0].(map[string]any)
	assert.Equal(t, "task", row["origin"])
	assert.Equal(t, "once", row["schedule_kind"])
	assert.Equal(t, "2026-11-17T09:01", row["at"], "the next minute")
	assert.Equal(t, "task #77", row["created_by"])

	// Switched off, it is not told; switched on, it is told once.
	path := "/api/reminders/agents/" + sendSid(1) + "/switch"
	code, _ := rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": false})
	require.Equal(t, 200, code)
	check, _ := rr.ch.sched.ChiefCheck(ctx, id64(row))
	job, _ := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	assert.Empty(t, rr.toDev(), "off: nothing is told")
	rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": true})
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 2))
	msgs := rr.toDev()
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0], "Reminder for #77")
	assert.Contains(t, msgs[0], "a task's reminder time", "the notice names who set it")

	// An agent cancels only its own; this one is the task's.
	code, _ = rr.call("DELETE", "/api/reminders/"+strconv.FormatInt(id64(row), 10), "agent:1", nil)
	assert.Equal(t, 403, code)
	code, _ = rr.call("DELETE", "/api/reminders/"+strconv.FormatInt(id64(row), 10), "person", nil)
	assert.Equal(t, 200, code)
}
